# SportsArc

SportsArc is the network and economic infrastructure for sports outside the professional leagues, built on Arc testnet. Organizers run pickup games, leagues, and seasons. Players keep a record that stays theirs when they leave. Smart contracts hold shared money and make results verifiable.

Personal data stays off the chain. A check-in or a result is written as a hash. Players PIN-sign typed data and a relayer submits it, so a player never sends a transaction or holds gas. The product says "$5" and "Verified".

## Contracts on Arc testnet

Chain id `5042002`. Explorer: <https://explorer.testnet.arc.io>

| Contract | Address | Role |
|---|---|---|
| SportsArcRecord | `0xb723f5461493942fa2f1dea7ebb5b0d9015b71df` | The verified record. Hashes only. The relayer is the only writer. |
| EventVault | `0x6748b294f0378a9d197138c452e4285195ca4204` | Entry fees, prizes, results, and refunds. |

Deploy transactions and earlier record contracts live in [`deploy/deployments/arcTestnet.json`](deploy/deployments/arcTestnet.json). How a deploy is run is [`deploy/CONTRACTS.md`](deploy/CONTRACTS.md). The record design is [`docs/verified-record.md`](docs/verified-record.md). Gemini markets for adults are [`docs/gemini-markets.md`](docs/gemini-markets.md).

## Run it

```bash
pnpm install
cp .env.example .env
docker compose up -d postgres
pnpm migration:up
pnpm run dev
```

The app is at <http://localhost:3000>. `SESSION_SECRET` and `DATABASE_URL` are required; the server exits at boot without them. In development, login codes print in the API terminal as `[otp] email you@example.com 123456`.

A disposable demo seed:

```bash
node --env-file=.env --import=tsx scripts/seed.ts --me you@example.com
```

`TESTNET_PRIVATE_KEY` is optional and must be a throwaway testnet key. With `RECORD_CONTRACT_ADDRESS` set to SportsArcRecord, the server writes a record to Arc after check-in closes.

## Checks

```bash
pnpm verify
pnpm test
```

Contract tests need the submodules, then Forge:

```bash
git submodule update --init
cd contracts && forge test
```
