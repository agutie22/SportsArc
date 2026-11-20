# The verified record

What SportsArc writes to a public chain, why, and how anyone can check it.
This is the design note. The deploy runbook is `deploy/CONTRACTS.md`.

## The idea in one sentence

> **A verified record is a list of games where each fact names who vouched
> for it, and a fingerprint of each fact is written to a public chain, so
> nobody (SportsArc included) can change it afterwards.**

"Verified" means *fixed, with its source named*. It does not mean "proven
true". A check-in says "this phone was inside the court's geofence", not
"this person definitely played".

## What gets written

Each fact is one **entry**. An entry has a **kind**, and the kind's name is
plain text, hashed into a 32-byte **kind tag** (`keccak256("checkin")`).

| Kind | The fact | Who vouches | Written when |
|---|---|---|---|
| `checkin` | A player's phone was inside the court's geofence during check-in | the phone, checked by SportsArc | check-in closes (start + 15 min) |
| `noshow` | A player held a spot and never checked in | SportsArc | check-in closes |
| `game` | What the game was: sport, venue, start, host | SportsArc | check-in closes |
| `result` | One player's side and how the game ended | the host or a co-host | the correction hour has passed |
| `presence` | The host says a player was here (or not) | the host or a co-host | an hour after the host confirms |
| `member` | A player was on a team for a season | the organizer | the organizer finishes the season |
| `standing` | A team's final W/L/T and place, citing its `result` entries | the organizer | the season is finished |
| `season` | Who ran a season and its whole table, citing its `standing` entries | the organizer | the season is finished |

A kind's layout never changes. If a fact ever needs a different layout,
it becomes a new kind with a new name, so an old entry can never be read
the wrong way.

## What an entry looks like on chain

On the explorer, every entry is one call:

```
SportsArcRecord.write(entry, kind)
  entry = 0x47b1…f185    the fingerprint of the fact
  kind  = 0x…            keccak256("result")
```

The contract keeps one thing per entry: **fingerprint → the block time it
was written**. No names, ids or scores are stored in readable form.

The fingerprint is a hash of the kind tag and the facts:

```
entry = keccak256(abi.encode(kindTag, game, player, …facts, time))

game   = keccak256(lowercase game UUID)
player = keccak256(abi.encode(keccak256(lowercase user UUID), salt))
```

The **player code** uses a fresh random 32-byte salt for each entry. Only
SportsArc and that player hold the salt, so nobody can hash a list of known
user ids to find out who played. A player can reveal the salt to prove an
entry is theirs (the portable record file does this).

## How anyone checks an entry

1. Rebuild the fingerprint from the facts (the app's "Check it yourself", or
   `node verify-record.mjs record.json`, which needs nothing from SportsArc).
2. Ask the contract `writtenAt(entry)`.
3. A time means the entry was written then and has not changed since.
   `0` means it was never written.

The browser asks the chain directly through Arc's public RPC
(`frontend/chain-check.js`), not through SportsArc, so the answer is the
network's word, not ours.

## The contract: `contracts/src/SportsArcRecord.sol`

```solidity
mapping(address writer => bool) public isWriter;       // the owner manages this list
mapping(bytes32 entry => uint64) private _writtenAt;   // one storage slot per entry

function write(bytes32 entry, bytes32 kind) external;  // writers only, once per entry
function writtenAt(bytes32 entry) external view returns (uint64);  // 0 = never written
function isWritten(bytes32 entry) external view returns (bool);
function checkInWrittenAt(bytes32 game, bytes32 player, uint64 checkedInAt) external view returns (uint64);
function noShowWrittenAt(bytes32 game, bytes32 player, uint64 closedAt) external view returns (uint64);

event Written(bytes32 indexed entry, bytes32 indexed kind, address indexed writer);
error NotWriter(address); error ZeroEntry(); error ZeroKind(); error AlreadyWritten(bytes32);
```

- **Who can write:** only addresses on the writer list. Today that is the
  server's relayer key. The owner (a wallet kept off the server) can remove
  a leaked key with no redeploy.
- **Write once:** writing an entry that exists reverts. Nothing can be
  edited or deleted, by anyone.
- **Any kind, no new code:** `writtenAt` answers for every kind. The kind
  is in the `Written` event for explorers; it is also inside the hash, so
  storage holds only the time.
- `RecordHash.sol` (Solidity) and `api/web3/record/hashes.ts` (TypeScript)
  build the same fingerprints. Test vectors pin both sides
  (`api/web3/record/check.ts`, `contracts/test/SportsArcRecord.t.sol`).

## Cost

Measured on Arc testnet: one `write` is about **48,900 gas**, about
**$0.0012** at 25 gwei. The relayer pays in USDC (Arc's gas token).

| What | Cost |
|---|---|
| one entry | ~$0.0012 |
| a game of ten (ten check-ins) | ~1.2¢ |
| a season: 10 teams × 10 players × 10 games, check-ins + results | ~$2.40 |

Keep `RELAYER_MIN_BALANCE` above a day's entries; `/health/ready` shows the
balance. One key sends about 2 entries a second.

## The server: `api/web3/record/`

```
RecordEntry.ts     one row per entry: kind, hash, the facts (values), salt, status
writer.ts          builds rows for closed games (checkin, noshow, game, result, presence)
season-writer.ts   builds rows for finished seasons (member, standing, season)
sender.ts          sends each pending row from the relayer and confirms it on chain
record.ts, lookups.ts, portable.ts   reads: by player, by game, by hash, the export file
timer.ts           the "record" job, every RECORD_INTERVAL_MIN (default 1)
```

A row goes `pending` → `sending` → `confirmed` (or `failed`, retried up to
five times). Each row has a unique `slot` naming the one fact it is
(`attendance:<seat>`, `result:<seat>`, `game:<game>`,
`standing:<season>:<team>`…), so a fact is written once. At most
`RECORD_MAX_IN_FLIGHT` (default 10) are unconfirmed at once, so players'
payments on the same key never wait behind a backlog. The first time a
check-in is confirmed, the player gets the "verified" notification.

Players never send transactions or need gas. They PIN-sign typed data and
the relayer submits it.

## Adding a kind

1. Add an entry to `RECORD_KINDS` in `api/web3/record/hashes.ts`: its tag
   (`keccak256("<name>")`) and an ABI encoding that starts with the tag.
2. Add the mirror function to `contracts/src/record/RecordHash.sol`.
3. Pin a vector in `check.ts` and `SportsArcRecord.t.sol`.
4. Write a row with `status: "pending"`; the timer sends it.

The contract, `RecordEntry`, the sender and the browser check need no
change. Rules: one fact per entry, no personal data (people as player
codes, ids as `keccak256(lowercase uuid)`, names off chain), and write a
fact only once it is final.

## Words in the app

"Verified", "record", "missed", "being verified". A check-in that is not
written yet is "checked in" or "being verified", never "verified". Hashes,
"on chain" and the network name stay inside Technical details. Money is
"$5", never "USDC".

## History

- **2026-11-19: first contract** (`RecordAnchor` "v1", deployed with
  EventVault from `b4d277c`). Entries were grouped into Merkle trees and
  only each tree's root was written, so checking one needed a proof.
- **2026-11-19: one entry, one write** (`RecordAnchor` "v2" at
  `0x8695…98cd`, from `ba52d88`).
  Every fact written on its own; checking is one lookup. A few hours of
  sending through a Circle Gas Station wallet were reverted the same day:
  it cost 3.7× the gas, sent one at a time, and stalled
  (`0x3CBAc23C…0733a` holds those entries).
- **2026-11-20: plain names** (`SportsArcRecord`). Same design, renamed:
  `anchor`/`anchoredAt` became `write`/`writtenAt`, "poster" became
  "writer", and kind names lost their `.v1` suffix. Every entry was written
  again to the new contract. The older contracts stay on chain, unchanged
  and unused.
