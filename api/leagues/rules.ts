/**
 * League rules with no database: the round-robin schedule, standings from
 * results, and turning a local date and time into an instant. Tested in
 * rules.test.ts.
 */

/** Every venue so far is in Texas; fixtures are scheduled in its local time. */
export const LEAGUE_TIMEZONE = "America/Chicago";

/**
 * Round robin by the circle method: every team meets every other once, each
 * plays at most once a round, and home and away alternate. An odd number of
 * teams gives one team a bye each round.
 */
export function roundRobin<T>(teams: readonly T[]): [T, T][][] {
  const list: (T | null)[] = [...teams];
  if (list.length < 2) return [];
  if (list.length % 2) list.push(null);
  const n = list.length;
  const rounds: [T, T][][] = [];
  // Home goes to whichever of the two has hosted less so far.
  const home = new Map<T, number>();
  const hosted = (t: T) => home.get(t) ?? 0;
  for (let r = 0; r < n - 1; r++) {
    const pairs: [T, T][] = [];
    for (let i = 0; i < n / 2; i++) {
      const a = list[i];
      const b = list[n - 1 - i];
      if (a === null || b === null) continue;
      const aHome = hosted(a) !== hosted(b) ? hosted(a) < hosted(b) : (r + i) % 2 === 0;
      const pair: [T, T] = aHome ? [a, b] : [b, a];
      home.set(pair[0], hosted(pair[0]) + 1);
      pairs.push(pair);
    }
    rounds.push(pairs);
    // Keep the first team fixed and rotate the rest one place.
    list.splice(1, 0, list.pop()!);
  }
  return rounds;
}

/** A round robin played `legs` times, home and away swapped on each return leg. */
export function schedule<T>(teams: readonly T[], legs = 1): [T, T][][] {
  const once = roundRobin(teams);
  const out: [T, T][][] = [];
  for (let leg = 0; leg < legs; leg++) {
    for (const round of once) out.push(leg % 2 ? round.map(([h, a]) => [a, h] as [T, T]) : round);
  }
  return out;
}

export interface FixtureOutcome {
  home: string;
  away: string;
  /** null: not played or no result yet. */
  outcome: "win" | "draw" | "not_played" | null;
  /** 0 = home won, 1 = away won. */
  winningSide: number | null;
  score0: number | null;
  score1: number | null;
}

export interface StandingRow {
  team: string;
  place: number;
  played: number;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  pointsAgainst: number;
  /** (wins + ties / 2) ÷ played, 0 before a game. */
  pct: number;
}

/**
 * The table: by win percentage, then wins, then point difference. Teams
 * equal on all three share a place. `teams` comes in the order to keep
 * among equals (by name, say).
 */
export function standings(teams: readonly string[], fixtures: readonly FixtureOutcome[]): StandingRow[] {
  const rows = new Map<string, StandingRow>(teams.map((t) => [t, {
    team: t, place: 0, played: 0, wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0, pct: 0,
  }]));
  for (const f of fixtures) {
    if (f.outcome !== "win" && f.outcome !== "draw") continue;
    const home = rows.get(f.home);
    const away = rows.get(f.away);
    if (!home || !away) continue;
    home.played += 1;
    away.played += 1;
    if (f.outcome === "draw") {
      home.ties += 1;
      away.ties += 1;
    } else if (f.winningSide === 0) {
      home.wins += 1;
      away.losses += 1;
    } else if (f.winningSide === 1) {
      away.wins += 1;
      home.losses += 1;
    }
    if (f.score0 != null && f.score1 != null) {
      home.pointsFor += f.score0;
      home.pointsAgainst += f.score1;
      away.pointsFor += f.score1;
      away.pointsAgainst += f.score0;
    }
  }
  const list = [...rows.values()];
  for (const r of list) r.pct = r.played ? Math.round(((r.wins + r.ties / 2) / r.played) * 1000) / 1000 : 0;
  const diff = (r: StandingRow) => r.pointsFor - r.pointsAgainst;
  list.sort((a, b) => b.pct - a.pct || b.wins - a.wins || diff(b) - diff(a));
  list.forEach((r, i) => {
    const prev = list[i - 1];
    r.place = prev && prev.pct === r.pct && prev.wins === r.wins && diff(prev) === diff(r) ? prev.place : i + 1;
  });
  return list;
}

/** "2027-03-02" + "19:00" in `tz` → the instant. Handles daylight saving. */
export function zonedTime(date: string, time: string, tz = LEAGUE_TIMEZONE): Date | null {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const tm = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!dm || !tm) return null;
  const [y, mo, d, h, mi] = [Number(dm[1]), Number(dm[2]), Number(dm[3]), Number(tm[1]), Number(tm[2])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
  const offsetAt = (t: number) => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute)) - t;
  };
  let t = wall - offsetAt(wall);
  t = wall - offsetAt(t);
  return new Date(t);
}

/** "2027-03-02" plus n days. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
