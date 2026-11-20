/**
 * What the account card on a sport page shows: is there an account to trade
 * with, how much is in it, and the open positions.
 *
 *   practice  the practice account (practice.ts). Always "connected".
 *   oauth     the user's own Gemini account, if connected. Also turns
 *             positions Gemini settled since the last look into
 *             market_settled notifications.
 *   demo-key  the shared sandbox account.
 *
 * Gemini calls for one summary run in parallel; any one failing leaves its
 * part empty rather than failing the card.
 */

import type { EntityManager } from "@mikro-orm/postgresql";
import type { User } from "../entities/User.js";
import { notify } from "../social/notifications.js";
import { sideChance, type Catalog } from "./catalog.js";
import { config, SITE, type MarketsConfig } from "./config.js";
import type { GeminiAuth, GeminiClient } from "./gemini.js";
import { GeminiLink } from "./GeminiLink.js";
import { accountFor } from "./oauth.js";
import { practiceBalanceCents, practicePositions, settlePractice, type PublicPosition } from "./practice.js";

export interface AccountSummary {
  allowed: true;
  enabled: boolean;
  trading: MarketsConfig["trading"];
  env: MarketsConfig["env"];
  practice: boolean;
  connected: boolean;
  label: string | null;
  shared: boolean;
  usdAvailable: string | null;
  positions: PublicPosition[];
  termsAccepted: boolean;
  /** Where "Add money" and "Open Gemini" go. */
  siteUrl: string | null;
}

const money = (v: unknown): string | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : null;
};

/** Gemini's /v1/balances → available USD. */
export function usdAvailable(json: unknown): string | null {
  if (!Array.isArray(json)) return null;
  const usd = json.find((b) => b && typeof b === "object" && String((b as any).currency).toUpperCase() === "USD");
  return usd ? money((usd as any).available ?? (usd as any).amount) : "0.00";
}

/** Gemini's positions → ours, titled from the catalog when the event is cached. */
export async function readPositions(json: unknown, cat: Catalog): Promise<PublicPosition[]> {
  const rows = Array.isArray((json as any)?.positions) ? (json as any).positions as Record<string, any>[] : [];
  const out: PublicPosition[] = [];
  for (const p of rows) {
    const symbol = String(p.symbol ?? "");
    const qty = String(p.totalQuantity ?? p.quantity ?? "0");
    if (!symbol || Number(qty) === 0) continue;
    const meta = (p.contractMetadata ?? {}) as Record<string, any>;
    const found = await cat.contract(symbol);
    const avg = money(p.avgPrice) ?? "0";
    out.push({
      symbol,
      eventTicker: found.ok ? found.event.ticker : String(meta.eventTicker ?? ""),
      title: found.ok ? found.event.title : String(meta.eventName ?? meta.eventTitle ?? symbol),
      label: found.ok ? found.contract.short : String(meta.contractName ?? meta.label ?? ""),
      outcome: p.outcome === "no" ? "no" : "yes",
      qty,
      avgPrice: String(p.avgPrice ?? avg),
      cost: money(Number(qty) * Number(p.avgPrice ?? 0)) ?? "0.00",
      value: money(p.marketValue),
      pnl: money(p.unrealizedPnl),
      chanceNow: found.ok ? sideChance(found.contract, p.outcome === "no" ? "no" : "yes") : null,
      league: found.ok ? found.event.league : null,
      startsAt: found.ok ? found.event.startsAt : null,
    });
  }
  return out;
}

async function settledNotices(
  em: EntityManager,
  user: User,
  client: GeminiClient,
  auth: GeminiAuth,
  link: Pick<GeminiLink, "id" | "settledSeenAt"> | null,
): Promise<void> {
  if (!link) return;
  const res = await client.privatePost<{ positions?: Record<string, any>[] }>(
    auth, "/v1/prediction-markets/positions/settled", {}, { limit: 20, sort: "-date" },
  );
  if (!res.ok || !Array.isArray(res.data?.positions)) return;
  const since = link.settledSeenAt?.getTime() ?? Date.now();
  let newest = since;
  for (const p of res.data.positions) {
    const at = Date.parse(String(p.settledAt ?? ""));
    if (!Number.isFinite(at) || at <= since) continue;
    newest = Math.max(newest, at);
    const label = String(p.contractMetadata?.contractName ?? p.symbol ?? "A position");
    const payout = Number(p.payout ?? 0);
    await notify(em, {
      recipient: user,
      kind: "market_settled",
      detail: payout > 0 ? `${label} · paid $${payout.toFixed(2)}` : `${label} · settled at $0`,
    });
  }
  if (newest !== since || !link.settledSeenAt) {
    // The link was loaded inside accountFor's transaction, which has ended.
    await em.nativeUpdate(GeminiLink, { id: link.id }, { settledSeenAt: new Date(newest) });
  }
}

export async function accountSummary(
  em: EntityManager,
  user: User,
  cat: Catalog,
  client: GeminiClient,
  cfg: MarketsConfig = config(),
): Promise<AccountSummary> {
  const base = {
    allowed: true as const,
    enabled: cfg.enabled,
    trading: cfg.trading,
    env: cfg.env,
    practice: cfg.trading === "practice",
    shared: false,
    positions: [] as PublicPosition[],
    termsAccepted: false,
    siteUrl: null as string | null,
  };

  if (cfg.trading === "practice") {
    await settlePractice(em, user, cat);
    const [cents, positions] = await Promise.all([practiceBalanceCents(em, user), practicePositions(em, user, cat)]);
    return {
      ...base,
      connected: true,
      label: "Your account",
      usdAvailable: (cents / 100).toFixed(2),
      positions,
      termsAccepted: true,
    };
  }

  if (cfg.trading === "off") return { ...base, connected: false, label: null, usdAvailable: null };

  const account = await accountFor(em, user, cfg);
  if (!account.ok) return { ...base, connected: false, label: null, usdAvailable: null, siteUrl: SITE[cfg.env] };

  const [balances, positions, terms] = await Promise.all([
    client.privatePost(account.auth, "/v1/balances"),
    client.privatePost(account.auth, "/v1/prediction-markets/positions", {}, { limit: 50, sort: "-positionValue" }),
    client.privatePost<{ hasAcceptedLatest?: boolean; latestVersion?: string }>(account.auth, "/v1/prediction-markets/terms/status"),
  ]);
  await settledNotices(em, user, client, account.auth, account.link);

  return {
    ...base,
    connected: true,
    label: account.label,
    shared: account.shared,
    usdAvailable: balances.ok ? usdAvailable(balances.data) : null,
    positions: positions.ok ? await readPositions(positions.data, cat) : [],
    termsAccepted: terms.ok ? terms.data?.hasAcceptedLatest === true : false,
    siteUrl: SITE[cfg.env],
  };
}
