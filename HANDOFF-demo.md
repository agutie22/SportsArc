# Handoff: hackathon demo, videos and marketing

Written 2026-11-20 for a fresh session (another account, API key). Read this
and `CLAUDE.md`; do not reread the whole tree. Branch: `hackathon/arc-consumer`,
all work committed, `pnpm verify` and `pnpm test` (161) pass.

## Goal
Help ship the hackathon submission: a demo flow, video shots and scripts, a
README, and launch copy. No new product features unless asked.

## What SportsArc is (30 seconds)
Social network for pre-pro sports. Pickup games people actually show up to
become a **verified record**: each check-in, no-show and result is hashed and
written to **Arc testnet** (SportsArcRecord), so anyone can check it without
trusting SportsArc. Orgs (leagues, clubs, venues, sponsors, tryouts) sit on
top. Adults also get **Gemini prediction markets** (practice mode on real
prices).

## Targets
- **Best use of Arc** (chain award) and **Gemini Prediction Markets** bounty,
  each beside a main track. Confirm exact names, deadline and judging
  criteria with the user; they are not in the repo.

## Still open (do these first)
1. **No root `README.md`.** Arc's rules require one listing contract
   addresses and explaining how the project uses Arc. Draft it.
2. **Events e2e not run on the new vault** (`api/web3/events/e2e.ts`). Needs
   about $4 test USDC in the relayer, which held $2.74 after the deploy. Not
   required for the demo; skip unless the user asks.

## Facts for the README and videos
- Chain: Arc testnet, chainId 5042002, explorer https://explorer.testnet.arc.io
- SportsArcRecord: address in `deploy/deployments/arcTestnet.json`
- EventVault: `0x6748b294f0378a9d197138c452e4285195ca4204`
- Source of truth: `deploy/deployments/arcTestnet.json` (replaced more than
  once; re-read it, and the roles from the chain, before quoting).
- A record costs about $0.0012 (48,856 gas). Players never send
  transactions: they PIN-sign typed data and a relayer submits it, so no gas.
  Gas on Arc is USDC.
- The chain is a notary, not the database. Postgres serves the app and map;
  the chain holds hashes and salted commitments (no personal data).
  Claim "a player's record is a file anyone can check against Arc without
  SportsArc" (`frontend/verify-record.mjs`, also a node CLI). Do not claim
  the map reads from the chain, or that other platforms already write to it
  (only listed writers can write today; opening it is future work).
- Wording rule: the UI says "Verified" only once on chain, "checked in"
  before that, never "anchored"; money shows as "$5", never "USDC".
- Details: `docs/verified-record.md`, `docs/gemini-markets.md`,
  `deploy/CONTRACTS.md`.

## Run the demo locally
```bash
cp .env.example .env            # set SESSION_SECRET, DATABASE_URL
docker compose up -d postgres
pnpm migration:up
node --env-file=.env --import=tsx scripts/seed.ts --me you@example.com
pnpm run dev                    # http://localhost:3000
```
- OTP codes print in the API terminal (`[otp] email ... 123456`).
- Re-run the seed to refresh time-bound states (check-in open now, sides
  being picked); they only hold about an hour.
- `.env`: `TESTNET_PRIVATE_KEY` (throwaway relayer) and
  `RECORD_CONTRACT_ADDRESS` make the dev server write records to Arc testnet
  within a minute of check-in closing. Never use a key with real funds.
- `GEMINI_TRADING=practice` for markets; `SHOWCASE_RECORD=<adult user id>`
  adds a "See a verified record" link on the sign-in screen.
- Check UI at 390px wide for phone shots. Dark is the default theme.

## Suggested demo flow (about 2 minutes)
1. Sign-in screen, then the showcase verified record (signed out).
2. Home feed, then Map tab (Clusters / Night lights styles): where people play.
3. Host a game, join it, check in (geofence), host records the result.
4. After check-in closes, the record shows "Verified"; open the receipt, then
   the explorer link for the transaction.
5. Export the record file and run `node frontend/verify-record.mjs <file>` in
   a terminal: the "no SportsArc needed" moment.
6. Pro markets: "Tonight on Gemini", a practice pick, the odds line.
7. Org page: league season or tryout (SS&E / Spurs case study).

## Marketing ideas, in priority order
1. 60-90s demo video following the flow above, captions on, phone frame.
2. Short clip: record file verified in a terminal (strongest Arc story).
3. Thread/post: "Your sports record shouldn't live in one app's database."
4. Screenshots: map night lights, receipt, odds sparkline.
Keep claims to what is real (see Facts). Everything is testnet.

## Don'ts
- No personal data on chain; testnet only; adults only for markets.
- Do not commit `.env`, `output/` or `data/`.
- Stray untracked file `api/migrations/.snapshot-sq_apply.json` is not part
  of the project; leave it out of commits.
- Run `pnpm verify` after any `frontend/` edit.
