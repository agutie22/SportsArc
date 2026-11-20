# SportsArc

Social network for the pre-pro sports world — players, coaches, and scouts.
Two audiences share one product: people who just want to play (schedule and
join pickup games, find others nearby) and people who want to get noticed
(a real activity record that coaches and scouts can discover).

This tree is pickup games, the social layer, the verified record, Gemini
markets for adults, and organizations (leagues, clubs, venues, sponsors,
schools, tryouts). User-created teams, a global ranked ladder, push
notifications and SportsArc's own prediction markets are not built. Build
them when a task asks, even if `ROADMAP.md` lists them as later: the roadmap
is a status snapshot, not a gate. When work lands, check its roadmap box and
update "What is real" below. `AGENTS.md` is only a pointer to this file; do
not edit it.

## Constraints

- **Testnet only.** A throwaway key may sit in `.env` as
  `TESTNET_PRIVATE_KEY`, never one that holds real funds.
- **No personal data on chain.** Hashes only: salted commitments for people,
  `keccak256` of ids for games.
- **The creator stays host for good.** No handover, no election. Co-hosts
  hold every host power except naming co-hosts (`api/games/roles.ts`). Free
  games carry no money; a no-show costs reputation, not a deposit.
- **A host's own prize is not a sponsorship.** Org sponsors and org venues
  are accounts (`api/orgs/`, and `verifiedGate` blocks unverified orgs from
  sponsoring or moving money); a pickup venue is only a place. EventVault's
  fields (`organizer`, `sponsor`) keep the contract's names.
- **Minors.** Profile views never name a minor and only name adult
  coaches/scouts (rule lives in `social/discovery.ts`). Staff and player
  pickers list adults only.
- **Markets are adults only.** Every market surface sits behind
  `canTradeMarkets` (`markets/access.ts`). Gemini tokens are sealed with
  `GEMINI_TOKEN_KEY` and never logged or sent to the browser.
- **Players never send transactions.** They PIN-sign typed data and the
  relayer submits it. UI copy says "$5", never "USDC"; the record says
  "Verified" only once on chain, "checked in" before that, never "anchored" or "on chain" outside Technical details.

## Run it

```bash
docker compose up -d postgres   # pnpm db:up
pnpm migration:up
pnpm run dev                    # http://localhost:3000, restarts on API changes
```

Copy `.env.example` to `.env` first. `SESSION_SECRET` and `DATABASE_URL` are
required; the server exits at boot without them. Circle keys are optional.
Postgres runs on `127.0.0.1:5435`. OTP codes print in the API terminal as
`[otp] email you@example.com 123456` in development.

Contracts live in `contracts/` (Foundry; submodules need
`git submodule update --init`). Deploy and verify with `pnpm contracts`;
the runbook, keys and signer rules are in `deploy/CONTRACTS.md`.

## Folder map

Deliberately dependency-light: no web framework, no frontend framework, no
build step for app code. File headers say what each file does; read them.

```
api/        Node http server, TypeScript run through tsx
  routes/     HTTP layer, one file per domain; status.ts maps error codes
  auth/       OTP, sessions, PIN accounts, invites, mailer
  games/      pickup games: lifecycle, check-in, roles, results, roster, recaps
  social/     profiles, follows, posts, feed, notifications, discovery, uploads
  orgs/       organizations: leagues, clubs, venues, sponsors, schools, staff
  leagues/    seasons, teams, registrations   tryouts/  tryouts and scout board
  insights/   a sponsor's insights, and the public map's data (GET /api/insights/map)
  markets/    Gemini markets (docs/gemini-markets.md)
  teams/      college football team colors (users.team_key, not user teams)
  circle/     Circle wallets            ingest/   CSV imports, robots.txt rules
  ops/        logger, jobs (advisory locks, one instance per tick), draining
  web3/       testnet: wallet, events (EventVault), pay, record (SportsArcRecord,
              docs/verified-record.md), cctp, gateway
  entities/, migrations/
frontend/   vanilla ES modules served by the API
  app.js      SPA shell, hash router, core tabs (Home, Games, Map, People,
              Notifications, Profile; People stays off the phone bar)
  modules.js / modules.enabled.js   optional modules; this build loads
              markets/ (Pro markets) and orgs/ (organizations)
  api.js      the one fetch client, loadMeta(), viewer location
  vendor/     Circle SDK (pnpm build:w3s), maplibre, deck.gl
```

## What is real

Backed by Postgres: OTP and PIN login, profiles, posts and feed,
notifications, pickup games (hosting, geo discovery, waitlists, geofenced
check-in, results, "Who was here"), the verified record on SportsArcRecord,
paid events, payments and CCTP withdrawals, the map, team colors,
organizations (leagues, tryouts, sponsors), CSV ingestion and athlete
records, and Pro markets (Gemini prices, practice trades, odds history).
Hyperliquid, the old share market, the result registry and betting pools are
parked on `parked/*` branches. Research rosters live on
`feature/x402-research`. `scripts/seed.ts` is a disposable demo seed.

## Feature modules

Optional surfaces attach through `frontend/modules.js` (id, label, hash path,
render function, optional stylesheet) rather than being woven into `app.js`.
`modules.enabled.js` is the manifest and should be the only file a feature
branch and main disagree about. Conflicts in `app.js`, `index.html` or
`styles.css` mean something leaked out of its module.

## Design system

`styles.css` is token-driven: every color is a variable on `:root`, and
light mode (`[data-theme="light"]`) only redefines tokens. Dark is the
default. Never hardcode a color in a component; use or add a token.

Breakpoints: >1200 three columns, 900–1200 two, <900 one column with the
rails inline in the feed, <760 phone chrome (bottom tab bar, drawer menu,
full-screen sheets). Check new UI at 390px wide.

## Conventions

- ESM throughout. TS files import each other with a `.js` extension
  (`./users.js` resolves to `users.ts` under tsx).
- Two-space indent, double quotes, semicolons.
- API handlers return result objects, never throw across a boundary:
  `{ ok: true, ... }` or `{ ok: false, error: { code, message } }`.
  `api/routes/status.ts` maps `error.code` to an HTTP status. (A handler that
  does throw is logged once and answers 500 `INTERNAL`.)
- New routes go in `api/routes/<domain>.ts` (web3: `api/web3/<stream>/routes.ts`).
  Wrap the handler in `authed(...)` unless it is public; a public route must
  also be added to `PUBLIC` in `api/route-access.test.ts`, which fails on any
  route that answers a signed-out caller with anything but 401.
- Every module starts with a short block comment saying what it is for.
- Entities use `@PrimaryKey({ type: "uuid" })` with `randomUUID()` defaults and
  `timestamptz` for `createdAt` / `updatedAt`.
- After changing an entity, run `pnpm migration:create` — never hand-edit the
  snapshot in `api/migrations/`.
- Secrets live only in `.env`. `output/` and `data/` are gitignored and hold
  local wallet artifacts — never commit them.
- Enum vocabularies (sports, skill levels, venue kinds, roles, audiences)
  come from `GET /api/meta`, chain details from `GET /api/config`. Read them
  through `loadMeta()` (`api.js`) and `loadPublicConfig()` (`shared.js`); do
  not restate them in the frontend.
- **Page state belongs to the page, not the module.** The tab cache
  (`swap()` in `app.js`) keeps a route marked `keep` alive, handlers and
  all, while other pages render. So a frontend module's top-level variables
  may hold only preferences (filters, the open tab) and caches by id. What
  one rendered page shows (its data, cursor, picked day, loads in flight)
  goes on a state object made by its render: passed around and found from
  the page root through a `WeakMap` where two copies can exist (`games.js`:
  `#/games` kept beside `#/games/<id>`), or a current-page pointer that
  late answers check where the route has one copy (`feed.js` `H`,
  `notifications.js` `P`). Look things up through that page's root, not
  `$()`, which cannot see a page the cache holds out of the document.
  Check this before marking another route `keep`.
- A page's `warm` (in `CORE_ROUTES`) must request exactly the URLs its first
  render does, or it quietly stops helping. A write clears every warmed
  answer unless it passes `stale` with the URL prefixes it changes (`apiSend`).
- Background work goes through `startJob` in `api/ops/jobs.ts`, so only one
  instance runs a tick. Join capacity is enforced in a transaction that locks
  the game row.

## Logs

Call `log.info(msg, fields)` etc. from `api/ops/log.ts` with fields; do not
use `console.*` in new code (the schema, redaction and request context are
documented in that file and `api/ops/request-context.ts`). Never log request
bodies, emails, phone numbers or names; log the userId. Redaction is a net,
not permission. Browser errors reach the server through `frontend/errors.js`
and `POST /api/client-errors`.

## Gaps that are still open

- **Nothing is enforced locally.** `pnpm verify` (typecheck and
  `check:frontend`) is what CI runs, with `pnpm test`, `pnpm check:vectors`
  and `forge test`. `tsx` strips types without checking, so a type error
  still starts the server. Run `pnpm verify` after editing `frontend/`: with
  no build step, nothing else catches a deleted function with call sites, an
  unresolved import, or a removed `$("#id")`; those leave every page blank.
- **`check-frontend` scans strings naively.** A quote inside a regex literal
  (`/[^"']/`) causes false "imported but never used" reports; avoid it. It
  also misreads method shorthand in object literals (`async visible() {}`);
  use `visible: async () => {}`.
- **Untested security modules:** `auth/otp.ts`, `auth/session.ts`, the PIN
  and session path of `auth/pin-login.ts` (its test covers username spelling
  only) and `games/lifecycle.ts`.
- **Uploads live on local disk** (`data/uploads/`): single instance only, and
  files are never garbage-collected when a post is deleted.
- **Claiming an athlete record is unverified.** Anyone signed in can claim any
  unclaimed record; fix this before records affect rankings.
- **Ingestion has no authorization.** Any signed-in user can POST an import;
  there is no admin role for it yet.
- **Hand-run checks** (`check.ts` in each web3 stream,
  `api/web3/record/check-e2e.ts`, `api/web3/events/e2e.ts`) say in their
  headers how to run them.
