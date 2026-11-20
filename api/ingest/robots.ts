/**
 * robots.txt fetch, parse and enforcement.
 *
 * Any network-fetching source adapter must clear this before requesting a
 * path. It is not decoration: MaxPreps disallows /school/, /team/, /scores/
 * and /discovery/ for User-agent: *, which is exactly where roster and stat
 * pages live. See api/ingest/sources.ts for what that means in practice.
 */

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

interface Rules {
  allow: string[];
  disallow: string[];
  crawlDelayMs: number;
  fetchedAt: number;
}

const cache = new Map<string, Rules>();

/** When each origin was last requested, or the slot the next request has reserved. */
const lastHit = new Map<string, number>();

/** Longest Crawl-delay we will sit through; imports wait inside an HTTP request. */
export const MAX_CRAWL_WAIT_MS = 30_000;

export const USER_AGENT =
  "SportsArcBot/0.1 (+https://github.com/4444Studios/SportsArc)";

/**
 * Parse for a specific agent, falling back to the `*` group. Longest matching
 * rule wins, and Allow beats Disallow at equal length — the de facto standard.
 */
export function parseRobots(text: string, agent: string): Rules {
  const groups = new Map<string, { allow: string[]; disallow: string[]; delay: number }>();
  let current: string[] = [];
  let lastWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) { lastWasAgent = false; continue; }
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === "user-agent") {
      if (!lastWasAgent) current = [];
      current.push(value.toLowerCase());
      for (const a of current) {
        if (!groups.has(a)) groups.set(a, { allow: [], disallow: [], delay: 0 });
      }
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (current.length === 0) continue;

    for (const a of current) {
      const g = groups.get(a);
      if (!g) continue;
      if (field === "allow" && value) g.allow.push(value);
      else if (field === "disallow") { if (value) g.disallow.push(value); }
      else if (field === "crawl-delay") {
        const n = Number(value);
        if (Number.isFinite(n) && n > 0) g.delay = n * 1000;
      }
    }
  }

  const lower = agent.toLowerCase();
  const chosen =
    [...groups.keys()].find((k) => k !== "*" && lower.includes(k)) ?? "*";
  const g = groups.get(chosen) ?? { allow: [], disallow: [], delay: 0 };
  return { allow: g.allow, disallow: g.disallow, crawlDelayMs: g.delay, fetchedAt: Date.now() };
}

/** robots.txt path matching: `*` is a wildcard, `$` anchors the end. */
function matches(pattern: string, path: string): boolean {
  const re = new RegExp(
    "^" +
      pattern
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\\\$$/, "$"),
  );
  return re.test(path);
}

function isAllowed(rules: Rules, path: string): boolean {
  const best = (list: string[]) =>
    list.filter((p) => matches(p, path)).reduce((m, p) => Math.max(m, p.length), -1);
  const allow = best(rules.allow);
  const disallow = best(rules.disallow);
  if (disallow < 0) return true;
  return allow >= disallow;
}

async function fetchRules(origin: string, agent = USER_AGENT): Promise<Rules> {
  const cached = cache.get(origin);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached;
  let rules: Rules;
  try {
    lastHit.set(origin, Date.now());
    const res = await fetch(`${origin}/robots.txt`, { headers: { "User-Agent": agent } });
    // A missing robots.txt means no restrictions; a 5xx means assume the worst.
    if (res.status === 404) {
      rules = { allow: [], disallow: [], crawlDelayMs: 0, fetchedAt: Date.now() };
    } else if (!res.ok) {
      rules = { allow: [], disallow: ["/"], crawlDelayMs: 0, fetchedAt: Date.now() };
    } else {
      rules = parseRobots(await res.text(), agent);
    }
  } catch {
    rules = { allow: [], disallow: ["/"], crawlDelayMs: 0, fetchedAt: Date.now() };
  }
  cache.set(origin, rules);
  return rules;
}

export interface CrawlCheck {
  allowed: boolean;
  reason: string;
  crawlDelayMs: number;
}

export async function checkUrl(url: string, agent = USER_AGENT): Promise<CrawlCheck> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: "Not a valid URL.", crawlDelayMs: 0 };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { allowed: false, reason: "Only http(s) URLs can be fetched.", crawlDelayMs: 0 };
  }
  const rules = await fetchRules(parsed.origin, agent);
  const path = parsed.pathname + parsed.search;
  const allowed = isAllowed(rules, path);
  return {
    allowed,
    reason: allowed
      ? "Allowed by robots.txt."
      : `robots.txt disallows ${path} for ${agent}.`,
    crawlDelayMs: Math.max(rules.crawlDelayMs, 1000),
  };
}

/**
 * Wait out the origin's Crawl-delay before a fetch, counting the robots.txt
 * request itself. Concurrent callers reserve successive slots, so they space
 * out rather than all waking at once. Returns false, without reserving a
 * slot, when the wait would exceed MAX_CRAWL_WAIT_MS.
 */
export async function waitTurn(url: string, crawlDelayMs: number): Promise<boolean> {
  const origin = new URL(url).origin;
  const now = Date.now();
  const slot = Math.max(now, (lastHit.get(origin) ?? 0) + crawlDelayMs);
  if (slot - now > MAX_CRAWL_WAIT_MS) return false;
  lastHit.set(origin, slot);
  if (slot > now) await new Promise((resolve) => setTimeout(resolve, slot - now));
  return true;
}
