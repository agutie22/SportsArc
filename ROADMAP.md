# SportsArc Roadmap

Status as of 2026-11-18. Updated as phases close.

This file is a status snapshot and a suggested sequence. It is not the
source of truth for what may be built, and it does not defer or limit an
agent's work. How to work in this tree is `CLAUDE.md` (`AGENTS.md` only
points there). An unchecked item or a later phase is a planning
note. When that work lands, check the box here and update "What is real" in `CLAUDE.md`.

## Where the project actually is

**Update, 2026-11-17: the host.** Whoever creates a game is its host for
good: there is no separate organizer, no handover and no host election. The
host names co-hosts, sets the sides, starts the game and records the
result (correctable for an hour); players no longer record or vote, and
posting results is part of a host's record. Free games carry no money:
no-show deposits (GameEscrow) are retired, and a no-show costs reputation
("Shows up 9/10"). A charged game is a paid event (EventVault): the entry
fee goes to the host, and only the host puts up a prize. Sponsors, meaning
brands and organizations with their own accounts, are a separate idea and
are not in this tree. The rest of hosting is written up under Phase 1.5.

**Update, 2026-11-13: betting pools parked.** Betting pools on games were
removed and parked on the `parked/betting-pools` branch, with their
contracts (`ResultBook`, `OutcomePool`). Pickup games in this tree carry
no bets. Bringing pools or league markets back is ordinary feature work
when it is asked for.

**Update, 2026-11-11: the simple version.** Results assume people are
honest. The consensus, bond and challenge design that used to sit under
Phase 4 is retired (2026-11-17: the host records results instead); its code
stays on the `parked/results-registry-and-claims` and
`parked/markets-and-hyperliquid` branches.

**Update, 2026-11-16.** Pickup games, venues, check-in, the social feed,
recaps, and the result sheet are on main (`frontend/results.js`). User-created teams,
global rankings, push notifications, and SportsArc's own prediction markets
are not built (Pro markets trade Gemini's; see the next note).
`scripts/seed.ts` is a disposable pickup-game demo. The hardcoded school
rosters are on `feature/x402-research`, not in this tree.

**Update, 2026-11-16: Pro markets through Gemini.** Before SportsArc
lists markets of its own, the Games page shows Gemini's prediction markets
on pro and college games (docs/gemini-markets.md). Gemini lists, prices and
settles them, which is the trusted-results problem above solved by someone
else, for the leagues it covers. Adults only. Demos trade in practice mode at
live prices; real trading is each user's own Gemini account over OAuth.
Markets on SportsArc's own games are not in this tree yet. The phases
below are one way to sequence them.

## The sequencing principle

The phases below are written in an order that is easy to ship, because
**a prediction market is easier once results are trustworthy.** That order
is a planning preference. It is not a prerequisite chain, and it does not
hold later work until earlier phases are checked off.

A market needs an event with an unambiguous outcome, a resolution source
people believe, and two-sided interest. A pickup game has none of these by
default — there is no referee, and the players who report the score are the
same people with money on it. Solving that is an oracle and reputation
problem, not a smart-contract problem, and it can only be solved on top of a
real game history.

A sensible planning order is games, then verified results, then reputation,
then markets. Building any of them when asked is in scope.

---

## Phase 0 — Make the project shippable (this week)

Housekeeping that compounds. None of it is product, all of it is leverage.

- [x] The DB layer, OTP, sessions, entities, and compose file are committed.
- [x] Add a `typecheck` script (`tsc --noEmit`). Done — and the codebase
      passes clean today, so the gate is free to adopt. `tsx` strips types
      without checking them, so nothing catches a regression until CI runs it.
- [ ] Cover `otp.ts` and `session.ts`. `pnpm test` runs `node --test` over
      `api/**/*.test.ts`, and those two security-boundary modules are still
      untested. `pin-login.ts` and `games/lifecycle.ts` are untested too.
- [x] CI on push: install, `pnpm verify` (typecheck and the frontend check),
      `pnpm test`, and `forge test` (`.github/workflows/ci.yml`).
- [x] `scripts/seed.ts` fills a fresh database with a disposable pickup demo.
      `deploy/README.md` documents it.
- [x] Deploy target is the VPS stack in `deploy/`.

## Phase 1 — The core loop (~6 weeks)

The core loop: **someone posts a game, someone joins it, it gets played,
the result is recorded.**

The original cut was **one sport, one metro area** — the sport you can
personally fill a game in, often basketball at a specific set of parks.
The app now covers the sports in `GET /api/meta`.

New entities:

- [x] `Venue` — name, address, lat/lng, kind (park/gym/field/court), indoor.
- [x] `Game` — sport, venue, start, duration, capacity, skill level,
      visibility, host, status (open/full/cancelled/played).
- [x] `GameParticipant` — user, game, status (joined/waitlist/cancelled/
      no_show), joinedAt, checkedInAt.
- [ ] `Team` — user-created: name, sport, owner, home venue.
- [ ] `TeamMember` — user, team, role (owner/captain/member).
- [x] `GameResult` + `ResultSeat` — the host sets the sides; they lock when
      the host taps start or when check-in closes. The host records the
      outcome (win, draw, not played) and an optional score, correctable for
      an hour. The sheet is `frontend/results.js`.

API surface:

- [x] `POST /api/games` (venue inline or by id), `GET /api/games` with
      lat/lng/radius/sport/skill filters, `GET /api/games/:id`
- [x] `POST /api/games/:id/join` — capacity-aware, overflows to waitlist
- [x] `POST /api/games/:id/leave` — promotes the longest-waiting person
- [x] `POST /api/games/:id/cancel` — host only
- [x] `GET/POST /api/venues`, `GET /api/meta`
- [x] check-in (geofenced to 250 m, opens 60 min before start, closes
      15 min after )
- [ ] teams: create, invite, accept
- [x] results: the host records the outcome (`frontend/results.js`)

Two decisions worth making deliberately here:

- **Geo:** done as planned — plain `lat`/`lng`, a bounding-box prefilter in
  SQL, Haversine refinement and sort in JS. No PostGIS.
- **Router:** done. `api/router.ts` is a ~70-line route table with `:param`
  support, which keeps the zero-framework posture. Hono remains the move if
  middleware (auth, logging, validation) starts being copy-pasted per route.

Exit criterion: you and ten real people schedule and play a game through the
app, without you touching the database by hand.

## Phase 2 — The social layer (~4 weeks)

Now make it a network rather than a scheduling tool.

- [x] Real profiles: sport, position, school, class year, measurables,
      location, bio, highlight links, and an activity record where "games
      played" counts verified check-ins rather than RSVPs.
- [x] Follow graph, and a feed of real posts with inline game cards. Hosting
      a game writes a system post. `buildFeedPosts()` and the synthesized
      dashboard are deleted.
- [x] People directory — search by name, school or area.
- [ ] Availability on the profile.
- [x] Research extracted to a feature module and moved off main. See
      `feature/x402-research`. `scripts/seed.ts` remains as a disposable
      pickup demo.
- [ ] Notifications still missing: a game filling up, and a game tomorrow.
      Join, leave, recap, and a recorded result already show up in the app.
      Email is the login-code sender only.
- [x] Rate limits are Postgres `rate_limit_hits` (login codes, client
      errors, and the relayer).
- [ ] Authorization. Ingestion endpoints and, later, moderation need an admin
      role; right now any signed-in user can run an import.

The pages are already split out of `app.js` (`feed.js`, `games.js`,
`profile.js`, and the rest). It stays vanilla.

## Phase 1.5 — Hosting (in progress)

The host is any user who gets people together for a game and answers for it
happening: a regular at the park, a coach's weekly run, or someone with a
following charging fans to play with them or to use their own court. Hosts
are not sponsors (brands and organizations that add money, later, with
their own accounts) and not venues (places; they never hold money).

- [x] One host for good, co-hosts to help; host-recorded results; no
      handover, no election (2026-11-17).
- [x] No-show deposits retired; prizes come from the host (2026-11-17).
- [x] The verified record, one entry per record (2026-11-19): each check-in
      and missed game is hashed and written on its own to SportsArcRecord
      after check-in closes, by the relayer (about $0.0012 a record).
      Verifying is a lookup of that hash. What the game was (`game`)
      and each seat's final result (`result`) are written the same way.
      A player can download their record as one file, signed by their
      wallet, and anyone can check it against the chain with
      /verify-record.mjs, no SportsArc needed. The host also confirms who
      was there after check-in closes, a second source beside the phone,
      written as `presence` (docs/verified-record.md, Stage 4).
- [ ] The seat timeline: a cutoff the host picks (1, 3 or 24 hours before);
      "Still coming?" an hour before it; "Can't make it" before the cutoff
      frees the spot, after it is a late drop. The waitlist stops moving up
      silently after the cutoff: an open spot is offered, first to tap. The
      host can check a player in. Notifications when moved up and when a
      game is cancelled. `latedrop` written beside check-ins and
      no-shows.
- [ ] A minimum show-up rate to join (Anyone, 70%, 80%, 90%); new players
      may join unless the host picks "Regulars only".
- [ ] The host sheet, simplified: sport, where, when, players, price (Free
      or Charge), the rest under More. A game is a draft until a charged
      game's terms are signed, so a half-posted game never shows.
- [ ] Verified hosts: admins grant it in the beta; only a verified host
      charges. Nothing checks it yet (a stored flag on the account, read in
      `games/roles.ts`, when it lands).
- [ ] Private venues (a host's own court): the exact place shown only to
      people with a seat; adults only unless a guardian enters a minor.
- [ ] The host record on profiles: games run, late cancels, show-up rate,
      results posted.
- [ ] Repeat weekly: a series with a regulars list that gets first pick.

## Phase 2.5 — Real data (in progress)

- [x] Source-agnostic ingestion pipeline with per-source adapters, idempotent
      upserts on (source, sourceId), and a run log.
- [x] robots.txt enforcement for any network source, verified against real
      rules.
- [x] CSV import — the path that needs nobody's permission, and the one that
      fits the product: coaches and ADs upload their own rosters.
- [x] Athlete records are separate from accounts and can be claimed.
- [ ] **MaxPreps needs a licence.** Their robots.txt disallows /school/,
      /team/ and /scores/ for all crawlers and there is no public API, so the
      adapter is built against a licensed feed and refuses to run without one.
      Getting that agreement with CBS Sports is a business task, not an
      engineering one. Until then CSV carries the load.
- [ ] Verified claims. Claiming is self-service and unverified today, which is
      fine while it only decorates a profile and is not fine once records
      feed rankings.
- [ ] Consider state athletic association results (CIF in California) as a
      second network source — often permissible where MaxPreps is not.

## Phase 3 — The ladder (~6 weeks)

The part that makes the platform matter to an underdog.

- Ratings computed from *verified* results: attendance from geofenced
  check-ins, results recorded by hosts and weighed by the host's record. The
  anti-gaming design is the hard part and it is worth real time. Assume people
  will try to farm it, because once scouting is on the line, they will.
- Leaderboards by sport, region, age group, position.
- Scout/coach discovery: search and filter over real players with real
  histories. This is where the research tools (on `feature/x402-research`)
  would finally get real data behind them.
- Claimable/verified school and team affiliations.

Exit criterion: a player with no connections can be found by a scout purely
because of games they played through SportsArc. That is the founding promise.

## Phase 4 — Prediction markets (month 5+)

Easiest to trust once Phase 3 outcomes exist. That timing is a preference.
Three things govern the design of this phase; the first is decided.

**1. Minors — four rules.**
Minors may not wager (M1), a market's subject must be an institution or cohort
whose outcome depends on at least N athletes (M2), a minor's attestation never
settles money (M3), and minor wallets are receive-and-hold only (M4).

M2 is the interesting one: youth and high-school sport stays *in* the market
layer, via aggregate recruiting markets ("which region produces the most D1
signings") rather than markets on any named kid. Paired with no shorting a
named institution, this turns the market layer into a financial constituency
that promotes underdog programs — the founding mission, restated. It is also
the moat, since no general prediction market has data on unknown high-school
athletes.

This shapes the schema *now*. `audience` is self-declared today, which is fine
for UI and useless for gating money — markets need real age verification, a
vendor integration with a cost line attached. Jurisdiction needs to be on the
user record too. Retrofitting either is far more expensive than building them
in. **Talk to a gaming/securities lawyer before the first contract, not after** —
the aggregation threshold and the no-shorting rule are the first two things to
ask about.

**2. The oracle problem — open.** The roster-consensus design (players as
validators, bonds, `max_market_size <= k x total_validator_bond`) was
retired on 2026-11-17: results are recorded by the host, on the assumption
that hosts are honest. A market on SportsArc's own games needs a resolution
source people with money on it believe; verified hosts and partner venues
are the candidates, decided when this phase starts. Gemini's markets
(above) already cover pro and college games.

**3. Sequencing within the phase.** Free-play prediction (points, no money)
first. It tests whether anyone actually wants this, surfaces the gaming
vectors cheaply, and carries none of the legal weight.

Note that aggregate recruiting markets resolve from *public record* — signing
announcements, program rosters — rather than from what anyone in the game
records. They need a data feed, not a trusted recorder, which makes them likely
easier to ship than pickup-game markets despite sounding harder. Consider
leading with them.

Existing groundwork: Circle wallets and USDC reads are already in place, and
the x402 payment module was isolated out in commit `2e28b25` and can be
brought back when it is needed.

---

## The two strategic risks

**Two cold-starts at once.** Social networks and prediction markets both die
without density. A reasonable launch is one park, one sport, one city, then
expand. A prediction market over an empty game calendar has nothing to
trade on. That is launch advice. It does not block building both.

**Building for two audiences at once.** "People who just want to play" and
"people who want to get scouted" want genuinely different products. The bet —
that the casual players generate the activity record the ambitious ones need —
is a good one, but only if the casual experience is great on its own terms.
If scheduling a pickup game is anything less than excellent, there is no data
for the ladder and no ladder. Phase 1 quality is the whole company.
