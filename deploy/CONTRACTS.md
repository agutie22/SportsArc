# Deploying the contracts (testnet only)

How to put SportsArc's contracts on a chain and point the server at them.
Testnet only: the scripts refuse every chain id except Arc testnet
(5042002).

## What gets deployed

`contracts/script/DeployAll.s.sol`, in this order, each a plain `CREATE`
from the deployer:

| # | contract | constructor | env line | gas |
|---|---|---|---|---|
| 1 | SportsArcRecord | `(owner, relayer)`: the relayer is the only writer | `RECORD_CONTRACT_ADDRESS` | ~675,000 |
| 2 | EventVault | `(usdc, signer, treasury, payout router, FEE_BPS, GAS_FEE, CORRECTION_WINDOW, owner)`: the relayer is the signer; the payout router is a key of its own | `EVENT_VAULT_ADDRESS` | 4,147,345 |

EventVault was deployed on 2026-11-19 from commit `b4d277c`, with every
role on its own key. SportsArcRecord (`write(entry, kind)` /
`writtenAt(entry)`) was deployed alone on 2026-11-20, with the relayer as
its only writer; the server wrote every entry to it again. Addresses and
commits are in `deploy/deployments/arcTestnet.json`. The record's two
earlier contracts, both named RecordAnchor, stay on chain unused
(docs/verified-record.md, "History"). The retired GameEscrow is in that
file's git history only.

Writing one entry (`write`) is about 48,900 gas: about $0.0012 at
25 gwei, so a game of ten costs about 1.2¢ of the relayer's USDC.

A fresh SportsArcRecord alone, with EventVault left in place, is
`scripts/contracts.sh deploy record` (`DeployRecord.s.sol`).

EventVault is optional: add it with `DeployEvents.s.sol` on a chain that
already has SportsArcRecord, or redeploy everything with `DeployAll.s.sol`
(it deploys the vault too).

After deploying, the script reads every role back from the contracts and
fails if anything differs, then prints the env block:

```
---- SportsArc env (paste into .env) ----
WEB3_CHAIN=arcTestnet
WEB3_USDC_ADDRESS=0x3600000000000000000000000000000000000000
RECORD_CONTRACT_ADDRESS=0x…
EVENT_VAULT_ADDRESS=0x…
---- end SportsArc env ----
```

The names are the ones `api/web3/contracts.ts` reads.

EventVault's fee defaults are `DEPLOY_FEE_BPS=100` (1%),
`DEPLOY_GAS_FEE=20000` (2¢ an entry) and `DEPLOY_CORRECTION_WINDOW=3600`.
The flat part pays for the gas the relayer spends on an entry. Measured on
Arc testnet (25 gwei, 2026-11-19): `register` about 189,000 gas, and each
event's `createEvent`, `postResult`, the organizer's `claim` and
`payTreasury` about 465,000 together. That is 1.05¢ an entry with two
players, 0.76¢ with four and 0.59¢ with ten. Refunded events take no fee
and still cost the claims, so 2¢ leaves room for those and for gas rising
to about 40 gwei. Re-measure with `forge test --gas-report` before
changing it.

## Roles

| role | env | default | what it does |
|---|---|---|---|
| deployer | forge's `--account` or `--private-key` | none: refused without one | sends the deploy. It keeps no power afterwards unless it is also one of the roles below. |
| relayer | `DEPLOY_RELAYER`, else the address of `TESTNET_PRIVATE_KEY` | the deployer | the server key (`chains.ts` `relayer()`): writes records to SportsArcRecord, signs EventVault permits and results, and submits what players signed. If both variables are set and disagree, the script refuses. |
| payout router | `DEPLOY_PAYOUT_ROUTER`, else the address of `PAYOUT_PRIVATE_KEY` | the relayer, which is refused | the second server key (`chains.ts` `payoutWallet()`): receives a routed player's money and forwards it through Circle Gateway. Keep about $1 of test USDC in it for gas. Must not be the relayer. |
| owner | `DEPLOY_OWNER` | the deployer | owns both contracts: SportsArcRecord's list of writers, and EventVault's signer (replaced after a day's notice). Must not be a server key. |
| treasury | `DEPLOY_TREASURY` | the deployer | receives the platform fee on event entries. Must not be a server key. |
| USDC | `DEPLOY_USDC` | the chain's testnet USDC | must be a contract with 6 decimals. The scripts never deploy a token. |

Every role left to its default prints a `!! WARNING` line.

**Two keys live on the server, and nothing else does.** The relayer and
the payout router must differ, and the owner and treasury must be neither:
the script refuses with `SharedKey("payout router")`, `SharedKey("owner")`
or `SharedKey("treasury")` before sending anything. The owner and treasury
should be wallets you hold that never touch the server. Kept apart:

- the key that signs event results is not the one that is paid the fee;
- a leaked server key cannot collect what the treasury is owed;
- the key that signs is not the one holding routed payouts in transit;
- the owner can remove a leaked relayer from SportsArcRecord's writers, and
  replace EventVault's signer, with no redeploy.

**Replacing EventVault's signer.** The owner calls `proposeSigner(new)`;
after `SIGNER_DELAY` (one day) anyone calls `applySignerChange()`, and from
then on only the new key's permits and results are honoured. The owner can
`cancelSignerChange()` until it is applied. Events already open carry on
under the new key. The delay means a stolen owner key cannot quietly
install a signer that would attest attendance for an event that never
ran. Deploying *with* the server key is fine as long as `DEPLOY_OWNER` and
`DEPLOY_TREASURY` are set; the deployer keeps no power afterwards.

The script reads only addresses from env. It derives the relayer's and the
payout router's addresses from `TESTNET_PRIVATE_KEY` and
`PAYOUT_PRIVATE_KEY` when they are set, checks each key's format first so a
malformed key is never echoed, and never prints one. Forge does not read the
repository's `.env` from `contracts/`: export the variables in the shell
that runs the deploy.

## Arc testnet

```bash
pnpm contracts deploy all --private-key <key>                  # dry run (simulates; nothing is verified or sent)
pnpm contracts deploy all --private-key <key> --broadcast
# Or, if SportsArcRecord is already up, only add the vault:
pnpm contracts deploy events --private-key <key> --broadcast
```

`scripts/contracts.sh` runs the same `forge script` with `--verify` against
the Arc explorer (Blockscout, no API key), so every contract's source is
public and readable as soon as it is deployed. A broadcast also records
each address, its creation transaction and the commit it was built from in
`deploy/deployments/arcTestnet.json`. Commit `contracts/src` before a
broadcast: verification uses the files on disk, and the manifest names the
commit.

### Verifying a contract already deployed

The explorer only accepts the exact source that was deployed, comments
included, so an older contract needs the commit it was built from. The
manifest records it; `check` confirms a match without sending anything,
`verify` submits it.

```bash
pnpm contracts check EventVault 0x6748b294f0378a9d197138c452e4285195ca4204
pnpm contracts verify EventVault 0x6748b294f0378A9d197138c452e4285195Ca4204
pnpm contracts verify EventVault 0x… b4d277c   # or name the commit
```

Both build that commit in a throwaway checkout and refuse if its bytecode
is not what the address was created from. Constructor arguments are read
from the creation transaction.

Gas is paid in USDC: it is Arc's native token, reached as an ERC-20 at
`0x3600000000000000000000000000000000000000` (6 decimals there, 18 in gas
accounting), so the deployer needs a little testnet USDC and nothing else.
The server's contracts live on Arc (`WEB3_CHAIN=arcTestnet`).

## Checks

| command | what it covers |
|---|---|
| `cd contracts && forge test` | every contract, and `test/Deploy.t.sol` for the scripts: chain guard (fuzzed), roles and their defaults, the separate-key refusals, USDC checks, the env reader, deploy order and wiring |
