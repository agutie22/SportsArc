# Pro markets: Gemini prediction markets in SportsArc

The Games page shows Gemini's prediction markets for the sport chosen in
its sport tabs (ALL, BASKETBALL, SOCCER …): a scoreboard strip under the
tabs, and a Games · Markets switch whose Markets view holds the market
cards beside the account and positions. Users
can buy a side, see their positions, and share a pick to the feed. Gemini
lists, prices and settles every market; SportsArc never makes markets of its
own here.

## What Gemini's APIs actually do (checked 2026-11-16)

These were observed by hand against the live services on 2026-11-16.
Recheck them before relying on them.

| Finding | What it means here |
|---|---|
| The **sandbox lists no sports markets at all** (102 events, all crypto and commodities). Production lists hundreds (basketball 126, football 147, soccer 37, hockey 7). | A demo cannot trade sports on test money at Gemini. Practice mode exists for this reason. |
| Market data is public: no account, no key. | Prices are always live production prices, even in practice mode. |
| A game is a `moneyline` event whose contracts are the teams (soccer adds a draw). Its `events` hold the spread, the total and player props. | The catalog keeps moneylines and their spread/total lines; props are dropped (most are `post_only`). |
| Instrument symbols are `GEMI-<event ticker>-<contract ticker>`; event tickers contain dashes, contract tickers do not. | `eventTickerOf()` splits on the last dash. |
| Filters take plain parameters (`sport=basketball`); bracketed ones (`sport[]=`) are silently ignored. | |
| Beside each game's moneyline, Gemini lists quarter and half moneylines as their own events (`scope.type` `quarter`, `half` …), most unpriced. The whole game is `full_contest`, or `regulation` (the 90 minutes) in soccer. | The catalog keeps whole-game markets that have a price. |
| A game stays `active` until it settles, often a day after it is played. | The catalog drops games that started over 4 hours ago. |
| A settled contract has `resolutionSide: "yes" \| "no"`. | Practice settlement pays from it. |
| One page of 100 games is about 4.5 MB, mostly props. | One fetch per sport is shared by every user through a 20 s cache. |
| Contracts carry their own `priceIncrement`, `quantityIncrement` and minimums (usually 0.01 and 0.01). | Quotes round to each contract's own steps, never a fixed grid. |
| Gemini Predictions is for US accounts only; others are refused with `ACCOUNT_GROUP_BLOCKED`. | Shown to the user as "available to US accounts only". |
| OAuth apps register self-serve; sandbox apps work immediately, production apps after Gemini's review. Access tokens last 24 hours; refresh tokens never expire but work **once**. | `oauth.ts` refreshes under a row lock and saves both new tokens together. |

Still unconfirmed, because it needs keys: whether prediction-market orders read their
parameters from `X-GEMINI-PAYLOAD` or a JSON body (`GEMINI_PM_BODY`), whether
the token endpoint takes a form or JSON body (`GEMINI_TOKEN_BODY`), whether a
confidential client may send PKCE, and the sandbox OAuth host
(`GEMINI_AUTH_URL`). Try each setting against the sandbox before relying on
it: a working order or token exchange confirms it, a refused one means
change it and try again.

## Modes

`GEMINI_TRADING` decides what a buy does. Market data needs no setting.

| Mode | What a buy does | Needs | Use it for |
|---|---|---|---|
| `practice` (default outside production) | Fills at the live Gemini price into a practice account in our database (`practice_fills`), starting at `GEMINI_PRACTICE_START` dollars (1000). No Gemini account, no money. Settles from Gemini's own results. | nothing | demos, the hackathon, development |
| `oauth` | A real order on the user's own Gemini account. | `GEMINI_CLIENT_ID`, `GEMINI_CLIENT_SECRET`, `GEMINI_REDIRECT_URI`, `GEMINI_TOKEN_KEY` (32 bytes, base64) | real trading |
| `demo-key` | A real order on one shared sandbox account. | `GEMINI_DEMO_KEY`, `GEMINI_DEMO_SECRET` (Trader role) | testing the real order path; refused in production |
| `off` (default in production) | Pro markets are hidden. | | |

With a real mode, data is read from the same Gemini environment the orders go
to (`GEMINI_ENV`, sandbox by default), or the symbols would not exist there.

## Who sees it

Adults only. `canTradeMarkets(user)` (`api/markets/access.ts`) is true for
`audience` `adult` or `guardian`. Every `/api/markets/*` route checks it;
`GET /api/markets/me` answers `{ allowed: false }` so the client hides every
market surface; posts lose their market card for anyone else, and only an
adult can post one. Gemini decides everything else about eligibility.

## How it is built

### API (`api/markets/`)

| File | Job |
|---|---|
| `config.ts` | The mode and every setting, read from `env` (pure, testable). |
| `gemini.ts` | REST client. Public reads; private calls signed with a Bearer token or HMAC-SHA384 over the base64 payload; a strictly increasing nonce; Gemini's refusals mapped to our codes, Gemini's words kept in `detail`. Never throws; `fetch` is injectable. |
| `catalog.ts` | `normalizeEvent()` turns a Gemini game into a `PublicMarketEvent` (teams in scoreboard order, short labels, chance, each child line). `createCatalog()` caches one list per sport for 20 s, shares an in-flight fetch, serves a stale list for 5 minutes through an outage. `headline()` picks the featured game: pro before college, close before lopsided, then volume. |
| `orders.ts` | `quote()`: dollars → contracts with bigint math scaled by 10^8; the price rounds up to its step (so an immediate order fills), the size down. `placeOrder()`: limit, immediate-or-cancel, filled amount read from `filledQuantity`; nothing filled is `PRICE_MOVED`. Duplicate taps return the first answer. |
| `practice.ts` | Practice buys (one at a time per user, under a lock on the user row), the balance, positions valued at the live sell price, and settlement: `settlementsFor()` (pure) pays $1 a contract to the side that won, each event is asked about at most every 2 minutes, and each fill is written only while still open (`settledAt IS NULL`), so the job and a user's own look never pay or notify twice. |
| `settle-job.ts` | Practice mode only: every 2 minutes (`startJob`, one instance per tick) settles everyone's open practice fills and sends `market_settled`, so a win is noticed without anyone opening the markets card. Real accounts still settle when their holder looks, since that needs each user's token. |
| `picks.ts` | `followingPicks()`: picks people the viewer follows posted in the last 3 days (side and price at posting, never size). `pickHistory()`: the viewer's settled picks (practice fills, or Gemini's settled positions) and a won–lost record. |
| `oauth.ts` | Authorize URL with PKCE, code exchange, `accountFor()` (refresh under `PESSIMISTIC_WRITE`, both tokens saved before the lock is released; a refused refresh removes the link), disconnect with revoke. |
| `account.ts` | What the account card shows, per mode; turns positions Gemini settled into `market_settled` notifications. |
| `seal.ts` | AES-256-GCM for tokens at rest (`v1.<iv>.<tag>.<ciphertext>`). |
| `state.ts` | The OAuth `state` cookie, HMAC-signed under its own prefix, bound to the user, 10 minutes. |
| `history.ts` | Odds over time. `recordOdds()` is the catalog's `onRefresh` listener (registered when the warmer starts): every whole-game moneyline contract, and each game's shown spread and total line, gets a `MarketTick` when its chance moved since the last one written. The key is (symbol, minute), so two instances record a change once. Points older than 7 days are pruned hourly. `oddsSeries()` reads the points for some symbols over the last N hours, plus the point just before the window so a line starts at its left edge. |
| `GeminiLink.ts`, `PracticeFill.ts`, `MarketTick.ts` | The three tables. |
| `warmer.ts` | Every 20 s, refreshes the sports someone listed in the last 15 minutes, and basketball always, so a click reads a warm cache (a few ms) instead of waiting on Gemini (about 1.6 s cold). A plain timer, not `startJob`: the cache is per process, so every instance warms its own. |
| `routes.ts` | The routes below. |

Routes (all signed in; all but `/me` adults only):

| Route | |
|---|---|
| `GET /api/markets/me` | account card: allowed, mode, connected, balance, positions |
| `GET /api/markets?sport=` | a sport's games (with one line per child market) and the headline |
| `GET /api/markets/featured` | each sport's featured game, its count and next games (Markets under ALL; Home's Tonight on Gemini) |
| `GET /api/markets/following` | picks people you follow posted (Home › Markets) |
| `GET /api/markets/history` | your settled picks and record (Home › Markets › Your picks) |
| `GET /api/markets/odds?symbols=&hours=` | odds over time for the cards on screen: up to 120 `GEMI-` symbols, 1–168 hours (default 24) |
| `GET /api/markets/event/:ticker` | one event |
| `POST /api/markets/quote` | `{ symbol, outcome, dollars }` → quote |
| `POST /api/markets/order` | `{ symbol, outcome, dollars, clientOrderId }` → fill; prices on fresh data |
| `GET /api/markets/terms`, `POST /api/markets/terms/accept` | Gemini's prediction market terms |
| `GET /api/markets/connect?sport=`, `GET /api/markets/callback` | connecting a Gemini account (302s) |
| `POST /api/markets/disconnect` | revoke and forget |

Error codes map to HTTP statuses in `api/routes/status.ts` (`marketsStatus`).
Whether markets are on reaches the client through `GET /api/markets/me`
(`enabled`, `trading`); `/api/meta` carries `marketSports`, the sports Gemini lists, so the client never restates
the mapping. Posts gained `sport` (from the game, the market, or the page it
was posted on) and `market`; `GET /api/feed?sport=` filters by either.

### Client

- `frontend/games.js`, core: the sport tabs filter the page. For a chosen
  sport with a module section it mounts the section's strip, and its tab
  and rail behind a Games · Markets switch. ALL, or a sport Gemini does not
  list, is the plain Games page. Old `#/sport/<sport>[?query]` links,
  including the Gemini connect return, land here with that sport chosen
  (`openSport`).
- `frontend/modules.js`: `registerSportSection({ id, tabLabel, visible,
  strip, tab, rail, onEnter, prefetch })`. Every function gets the sport,
  or `""` for ALL. Games works with none.
- Loading: hovering, focusing or touching a sport tab prefetches its open
  games and its markets, and the viewer's own sport is fetched while the
  browser is idle. The browser keeps each sport's markets as
  stale-while-revalidate (instant under 15 s, served while refreshing up to
  5 min). API answers over 1 KB are gzipped (a basketball list: 257 KB →
  12 KB).
- The strip under ALL mixes every sport's next games (from
  `/api/markets/featured`), taking turns between sports, each tile labelled
  with its league.
- Odds over time (`odds.js`): a game card shows the favorite's chance
  over the last 24 hours as a step line, with "▲ 6 pts in 24h" beside it;
  a line card shows its line's. The card leaves a placeholder and
  `watchOdds()` (started by `bindTrade()`) fills it after every repaint,
  one `/api/markets/odds` request per batch of new symbols, each answer
  kept a minute. The live chance on the card is the last point. Open
  positions say how far their side moved since the pick ("+8¢ since your
  pick"): the side's chance now (`chanceNow` on a position, the middle of
  the market, so the spread alone never reads as a drop) against the
  price paid.
- Markets under ALL (`all.js`): one featured game per sport, each with a
  link to that sport's full Markets view, beside positions across every
  sport.
- Home (`frontend/feed.js`, core) draws empty slots that a module fills
  through `registerHomeSection({ id, visible, widget, meCard, feedTab })`
  in `modules.js`; it never names markets. The markets module (`home.js`)
  fills them, for adults only:
  - "Tonight on Gemini", first in the right rail: the next four games
    (live or within 24 hours, taking turns between sports) with the
    favorite's chance, and your open picks' P&L;
  - a line on the me card: "Picks · 3 open · +$4.20", or the balance;
  - a Markets feed tab after Following · Latest, which replaces stories,
    composer and posts with two views on one switch. **Games**: the
    featured game, "From people you follow" (tap to take the same side),
    each other sport's featured game, and a link to Games › Markets for
    every game. **Your picks**: open picks with value and P&L, settled
    picks (won or lost, payout) and the record. Its rail is the account
    card and positions; on phones that becomes one line on the tab.
  - `#/markets` and `#/markets/picks` (module routes with `nav: false`)
    open that tab: they ask Home for it (`askHomeTab`) and land on `#/`,
    so Home stays one page with one kept copy. The picks links in
    Tonight on Gemini and on the me card, "See all your picks" on the positions card and
    the `market_settled` notification all go to `#/markets/picks`.
- `every()` and `onChanged()` (`client.js`) pause while their page is kept
  out of the document (app.js) and resume when it comes back; they stop for
  good only after 6 minutes away, longer than a page is ever kept.
- `frontend/markets/`, the module (enabled in `modules.enabled.js`):
  `strip.js` (scoreboard, pro games first), `card.js` (game, line and
  headline cards; any `[data-trade]` opens the sheet), `tab.js` (the
  featured game, then Games, Totals, Spreads), `rail.js` (account card, positions, the small print),
  `trade.js` (the trade sheet), `client.js` (calls and formatting),
  `markets.css` (tokens only; sides are `--side-a`/`--side-b`, a draw
  `--gold`).
- The trade sheet: connect panel → Gemini's terms → pick a side and an amount
  ($5/$10/$25/$50 or typed) → a server quote 300 ms after each change and
  every 15 s → buy with a fresh `clientOrderId` → "You're in" with Share to
  feed. `PRICE_MOVED` re-quotes; `INSUFFICIENT_FUNDS` links to Gemini.
- Share to feed opens the composer with the pick attached; the server fills
  in the market from Gemini, never the client's price, and never the
  author's position size.

## Running it

Practice mode needs nothing:

```bash
pnpm migration:up
pnpm run dev            # as an adult account: Home (Tonight on Gemini, Markets tab), or Games → BASKETBALL → Markets
```

Real accounts (`oauth`):

1. Create an OAuth app at exchange.sandbox.gemini.com → API Settings, with
   the scopes `orders:read`, `orders:create`, `balances:read`,
   `account:read` and the redirect `http://localhost:3000/api/markets/callback`.
2. Set `GEMINI_TRADING=oauth`, the client id and secret, the redirect and
   `GEMINI_TOKEN_KEY=$(openssl rand -base64 32)`.
3. Place a practice order and connect an account; adjust `GEMINI_PM_BODY`,
   `GEMINI_TOKEN_BODY` and `GEMINI_AUTH_URL` until both work.
4. Expect no sports markets in the sandbox. Real sports trading means
   `GEMINI_ENV=production`, Gemini's approval of the app, and US users.

## Selling

`POST /api/markets/sell` sells all of one side you hold, or half
(`part: "half"`), at the bid now; how much you hold always comes from the
server. Your picks offers Sell and Sell half on the selected pick: in the
rail on desktop, in a bottom sheet on phones. A pick you sold out of counts
in your net but not in the won–lost record, and never lands in Needs you;
one you sold part of and held to the end counts as Gemini settled it.

## Not built yet

- **Funding:** moving USDC from a SportsArc wallet on Arc to the user's
  Gemini account. Circle's CCTP reaches all eight networks Gemini accepts
  USDC on; Gemini trades from USD, so the deposit is converted on Gemini.
  "Add money" links to Gemini for now.
- A live price stream; prices poll every 15 s.
- Settling real (oauth) accounts in the background; they settle when their
  holder looks.

## Tests

`api/markets/markets.test.ts` (pure, no database, Gemini faked) covers the
settings, sealing, the state cookie, request signing, error mapping, the
catalog against a recorded Gemini game (`fixtures/events.sample.json`), the
cache, quoting at odd steps, fills, duplicate taps, token refresh, the
adults-only gate, practice settlement payouts and the pick history record. `api/route-access.test.ts` covers that every new route
answers 401 when signed out.
