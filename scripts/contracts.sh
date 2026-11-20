#!/usr/bin/env bash
# Deploy SportsArc's contracts with their source verified on the explorer,
# and verify ones already deployed. Testnet only (deploy/CONTRACTS.md).
#
#   scripts/contracts.sh deploy all|record|events [forge args...]
#       forge script DeployAll / DeployRecord / DeployEvents on Arc testnet
#       with --verify (record: SportsArcRecord alone, events: EventVault alone),
#       so the explorer shows each contract's source as soon as it is up.
#       Without --broadcast it is a dry run. A broadcast also writes
#       deploy/deployments/arcTestnet.json: each address, its creation
#       transaction and the commit it was built from.
#         scripts/contracts.sh deploy record --account <keystore> --broadcast
#
#   scripts/contracts.sh verify <Contract> <address> [commit]
#       Verify a contract that is already deployed, built from `commit`
#       (default: the one the manifest records for that address, else HEAD).
#       The source must be exactly what was deployed, comments included, so
#       an older deploy needs the commit it came from. Refuses before
#       submitting anything if that build does not match the chain.
#         scripts/contracts.sh verify EventVault 0x6748…4204 b4d277c
#
#   scripts/contracts.sh check <Contract> <address> [commit]
#       Everything verify does except submitting: says whether that commit's
#       build matches the deployed contract. Sends nothing to the explorer.
#
# ARC_EXPLORER_URL overrides the explorer (Blockscout), ARC_RPC_URL the RPC.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXPLORER="${ARC_EXPLORER_URL:-https://explorer.testnet.arc.io}"
EXPLORER="${EXPLORER%/}"
RPC="${ARC_RPC_URL:-https://rpc.testnet.arc.io}"
MANIFEST="$ROOT/deploy/deployments/arcTestnet.json"
FORGE="$(command -v forge || echo "$HOME/.foundry/bin/forge")"
CAST="$(command -v cast || echo "$HOME/.foundry/bin/cast")"

die() { echo "contracts.sh: $*" >&2; exit 1; }
verifier() { echo --verifier blockscout --verifier-url "$EXPLORER/api/"; }

deploy() {
  local which="${1:-}"; shift || true
  local script
  case "$which" in
    all) script="DeployAll.s.sol" ;;
    record) script="DeployRecord.s.sol" ;;
    events) script="DeployEvents.s.sol" ;;
    *) die "deploy all|record|events [forge args...]" ;;
  esac

  local commit dirty=false
  commit="$(git -C "$ROOT" rev-parse HEAD)"
  if [ -n "$(git -C "$ROOT" status --porcelain -- contracts/src contracts/lib)" ]; then
    dirty=true
    echo "!! contracts/src or contracts/lib has uncommitted changes: commit them first, or the" >&2
    echo "!! manifest will name a commit that does not hold the deployed source." >&2
  fi

  # forge refuses --verify without --broadcast, so a dry run simulates only.
  local verify=()
  case " $* " in *" --broadcast "*) read -ra verify <<< "--verify $(verifier)" ;; esac
  (cd "$ROOT/contracts" && "$FORGE" script "script/$script" --rpc-url "$RPC" "${verify[@]}" "$@")

  case " $* " in *" --broadcast "*) ;; *) return 0 ;; esac
  write_manifest "$script" "$commit" "$dirty"
}

# Merge this run's contracts into the manifest, keyed by contract name.
write_manifest() {
  local script="$1" commit="$2" dirty="$3"
  local run="$ROOT/contracts/broadcast/$script/5042002/run-latest.json"
  [ -f "$run" ] || die "no broadcast record at $run"
  mkdir -p "$(dirname "$MANIFEST")"
  [ -f "$MANIFEST" ] || echo '{"chain":"arcTestnet","chainId":5042002,"contracts":{}}' > "$MANIFEST"
  jq --slurpfile run "$run" --arg commit "$commit" --argjson dirty "$dirty" \
     --arg explorer "$EXPLORER" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
    .explorer = $explorer
    | .contracts += ([$run[0].transactions[]
        | select(.transactionType == "CREATE")
        | { (.contractName): {
              address: .contractAddress, tx: .hash,
              commit: $commit, uncommittedSource: $dirty, deployedAt: $at } }]
      | add // {})
  ' "$MANIFEST" > "$MANIFEST.tmp" && mv "$MANIFEST.tmp" "$MANIFEST"
  echo "Recorded in ${MANIFEST#"$ROOT"/}"
}

verify() {
  local submit="$1"; shift
  local name="${1:-}" address="${2:-}" commit="${3:-}"
  [ -n "$name" ] && [ -n "$address" ] || die "verify <Contract> <address> [commit]"
  if [ -z "$commit" ] && [ -f "$MANIFEST" ]; then
    commit="$(jq -r --arg a "${address,,}" \
      '[.contracts[] | select((.address | ascii_downcase) == $a) | .commit][0] // empty' "$MANIFEST")"
  fi
  commit="$(git -C "$ROOT" rev-parse "${commit:-HEAD}")"

  # Build that commit's contracts in a throwaway checkout.
  # Removed on any exit, a refusal included.
  tree="$(mktemp -d)"
  trap 'git -C "$ROOT" worktree remove --force "$tree" >/dev/null 2>&1 || true' EXIT
  git -C "$ROOT" worktree add -q --detach "$tree" "$commit"
  (cd "$tree/contracts" && "$FORGE" build -q)

  # Constructor arguments: the creation input after the contract's bytecode.
  local creation input code
  creation="$(curl -fsSL "$EXPLORER/api/v2/addresses/$address" | jq -r '.creation_transaction_hash // empty')"
  [ -n "$creation" ] || die "the explorer does not know how $address was created"
  # The RPC may have dropped an old transaction; the explorer keeps it.
  input="$("$CAST" tx "$creation" input --rpc-url "$RPC" 2>/dev/null \
    || curl -fsSL "$EXPLORER/api/v2/transactions/$creation" | jq -r '.raw_input // empty')"
  input="$(echo "$input" | tr 'A-F' 'a-f')"
  [ -n "$input" ] || die "could not read the creation transaction $creation"
  code="$(jq -r '.bytecode.object' "$tree/contracts/out/$name.sol/$name.json" | tr 'A-F' 'a-f')"
  [ "${input:0:${#code}}" = "$code" ] \
    || die "$name at ${commit:0:7} is not what $address was deployed from; try the commit of that deploy"
  if [ "$submit" != true ]; then
    echo "$name at ${commit:0:7} matches $address exactly. Nothing was sent."
    return 0
  fi

  # shellcheck disable=SC2046
  (cd "$tree/contracts" && "$FORGE" verify-contract "$address" "src/$name.sol:$name" \
    --rpc-url "$RPC" $(verifier) --constructor-args "0x${input:${#code}}" --watch)
  echo "$EXPLORER/address/$address"
}

case "${1:-}" in
  deploy) shift; deploy "$@" ;;
  verify) shift; verify true "$@" ;;
  check) shift; verify false "$@" ;;
  *) die "deploy all|record|events [forge args...] | verify|check <Contract> <address> [commit]" ;;
esac
