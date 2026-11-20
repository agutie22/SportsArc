/**
 * Checks a SportsArc record file with no SportsArc involved: only the math
 * and the chain's public RPC. No dependencies; Node 18+ or a browser.
 *
 *   node verify-record.mjs my-record.json            # uses the file's RPC
 *   node verify-record.mjs my-record.json --rpc URL  # or another one
 *
 * For every entry it checks:
 *   1. the hash is keccak256(abi.encode(values)) in the kind's encoding,
 *      and values[0] is keccak256 of the kind's name;
 *   2. the game key is keccak256 of the game id the file names (a season
 *      entry: the season key is keccak256 of the season id);
 *   3. where the file has a salt, keccak256(abi.encode(playerKey, salt))
 *      is the commitment inside the entry: the entry is this player's;
 *   4. SportsArcRecord.writtenAt(hash) on the chain is not 0: it was written,
 *      and when;
 *   5. a standing's `cites` (the result hashes it counted, sorted) and a
 *      season's `table` (its standing hashes, in order) hash to the value
 *      inside the entry: keccak256 of them concatenated.
 * And, when the file carries one, that the ownership signature (EIP-712
 * RecordOwner) was made by the wallet it names, for this player key.
 *
 * What it cannot check: SportsArc's own details in `about` (sport, venue,
 * time, names). Those are the server's word; the hashes are the chain's.
 * The app's tests pin this file's math against viem
 * (api/web3/record/verify-record.test.ts).
 */

// ── keccak256 ─────────────────────────────────────────────────────────

const MASK = (1n << 64n) - 1n;
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
  0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
  0x000000000000800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const rotl = (x, n) => (n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK);

function keccakF(s) {
  for (let round = 0; round < 24; round++) {
    const c = [0, 1, 2, 3, 4].map((x) => s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20]);
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) s[x + y] ^= d;
    }
    const b = new Array(25);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], ROT[x + 5 * y]);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 25; y += 5) s[x + y] = b[x + y] ^ (~b[((x + 1) % 5) + y] & MASK & b[((x + 2) % 5) + y]);
    s[0] ^= RC[round];
  }
}

/** keccak256 of bytes, as 0x hex. */
export function keccak256(bytes) {
  const rate = 136;
  const padded = new Uint8Array(Math.ceil((bytes.length + 1) / rate) * rate);
  padded.set(bytes);
  padded[bytes.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const s = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let j = 7; j >= 0; j--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + j]);
      s[i] ^= lane;
    }
    keccakF(s);
  }
  let out = "0x";
  for (let i = 0; i < 4; i++) for (let j = 0; j < 8; j++) out += Number((s[i] >> BigInt(8 * j)) & 0xffn).toString(16).padStart(2, "0");
  return out;
}

const utf8 = (text) => new TextEncoder().encode(text);
export const keccakText = (text) => keccak256(utf8(text));

function hexBytes(hex) {
  const h = hex.replace(/^0x/, "");
  if (h.length % 2 || /[^0-9a-f]/i.test(h)) throw new Error(`not hex: ${hex}`);
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

// ── ABI encoding (static types only: what records use) ────────────────

function word(type, value) {
  const out = new Uint8Array(32);
  if (type === "bytes32") {
    const b = hexBytes(String(value));
    if (b.length !== 32) throw new Error(`bytes32 expected: ${value}`);
    return b;
  }
  let n;
  if (type === "address") n = BigInt(String(value));
  else if (/^uint\d+$/.test(type)) n = BigInt(String(value));
  else throw new Error(`unsupported type ${type}`);
  if (n < 0n || n >= 1n << 256n) throw new Error(`out of range: ${value}`);
  for (let i = 31; i >= 0; i--) { out[i] = Number(n & 0xffn); n >>= 8n; }
  return out;
}

/** abi.encode(...values) for static types. */
export function abiEncode(types, values) {
  if (types.length !== values.length) throw new Error("values do not match the encoding");
  return concat(...types.map((t, i) => word(t, values[i])));
}

// ── secp256k1 signature recovery ──────────────────────────────────────

const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const G = [0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n, 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n];
const mod = (a, m = P) => ((a % m) + m) % m;
function inv(a, m = P) {
  let [r0, r1, s0, s1] = [mod(a, m), m, 1n, 0n];
  while (r1) { const q = r0 / r1; [r0, r1] = [r1, r0 - q * r1]; [s0, s1] = [s1, s0 - q * s1]; }
  return mod(s0, m);
}
function powMod(b, e, m = P) {
  let r = 1n; b = mod(b, m);
  while (e > 0n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; }
  return r;
}
function add(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a[0] === b[0] && mod(a[1] + b[1]) === 0n) return null;
  const l = a[0] === b[0] && a[1] === b[1] ? mod(3n * a[0] * a[0] * inv(2n * a[1])) : mod((b[1] - a[1]) * inv(b[0] - a[0]));
  const x = mod(l * l - a[0] - b[0]);
  return [x, mod(l * (a[0] - x) - a[1])];
}
function mul(k, pt) {
  let r = null;
  for (let q = pt; k > 0n; k >>= 1n, q = add(q, q)) if (k & 1n) r = add(r, q);
  return r;
}

/** The address that made a 65-byte signature over a 32-byte digest, or null. */
export function recoverAddress(digest, signature) {
  const sig = hexBytes(signature);
  if (sig.length !== 65) return null;
  const r = BigInt(`0x${signature.slice(2, 66)}`);
  const s = BigInt(`0x${signature.slice(66, 130)}`);
  let v = sig[64];
  if (v >= 27) v -= 27;
  if (v > 1 || r === 0n || r >= N || s === 0n || s >= N) return null;
  const y2 = mod(r * r * r + 7n);
  let y = powMod(y2, (P + 1n) / 4n);
  if (mod(y * y) !== y2) return null;
  if ((y & 1n) !== BigInt(v)) y = P - y;
  const e = BigInt(digest);
  const q = mul(inv(r, N), add(mul(s, [r, y]), mul(mod(-e, N), G)));
  if (!q) return null;
  const pub = concat(word("uint256", q[0]), word("uint256", q[1]));
  return `0x${keccak256(pub).slice(-40)}`;
}

// ── EIP-712 RecordOwner ───────────────────────────────────────────────

const DOMAIN_TYPE = "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";

/** The EIP-712 digest of a typed-data object whose fields are static types. */
export function typedDataDigest(td) {
  const fields = td.types[td.primaryType];
  const typeString = `${td.primaryType}(${fields.map((f) => `${f.type} ${f.name}`).join(",")})`;
  const struct = keccak256(concat(hexBytes(keccakText(typeString)), ...fields.map((f) => word(f.type, td.message[f.name]))));
  const d = td.domain;
  const domain = keccak256(concat(
    hexBytes(keccakText(DOMAIN_TYPE)), hexBytes(keccakText(d.name)), hexBytes(keccakText(d.version)),
    word("uint256", d.chainId), word("address", d.verifyingContract),
  ));
  return keccak256(concat(new Uint8Array([0x19, 0x01]), hexBytes(domain), hexBytes(struct)));
}

// ── the file ──────────────────────────────────────────────────────────

const WRITTEN_AT = "0x9591a610";

async function writtenAt(rpcUrl, contract, hash) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: contract, data: `${WRITTEN_AT}${hash.slice(2).toLowerCase()}` }, "latest"] }),
  });
  const out = (await res.json()).result;
  if (typeof out !== "string" || !/^0x[0-9a-f]{64}$/i.test(out)) throw new Error("the chain gave no answer");
  return Number(BigInt(out));
}

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/** keccak256 of record hashes concatenated in order (RecordHash.listHash). */
const listHash = (hashes) => keccak256(concat(...hashes.map((h) => hexBytes(String(h)))));

/**
 * Check every entry of a record file. `rpcUrl` overrides the file's.
 * Returns { ok, ownership, entries: [{ kind, hash, checks: { name: true|false|null }, writtenAt }] }.
 */
export async function checkRecordFile(file, { rpcUrl, ask = writtenAt } = {}) {
  if (file?.format !== "sportsarc-record/1") throw new Error("This is not a SportsArc record file (format sportsarc-record/1).");
  const rpc = rpcUrl ?? file.chain?.rpcUrl;
  const key = file.player?.key;
  const entries = [];
  for (const r of file.records ?? []) {
    const checks = {};
    checks.hash = same(keccak256(abiEncode(r.encoding, r.values)), r.hash);
    checks.kind = same(r.values[0], keccakText(r.kind));
    checks.game = r.gameId ? same(r.values[1], keccakText(String(r.gameId).toLowerCase())) : null;
    checks.season = r.seasonId ? same(r.values[1], keccakText(String(r.seasonId).toLowerCase())) : null;
    checks.list = Array.isArray(r.cites) ? same(listHash(r.cites), r.values[7])
      : Array.isArray(r.table) ? same(listHash(r.table), r.values[3]) : null;
    checks.theirs = r.salt && Number.isInteger(r.opens) && key
      ? same(keccak256(abiEncode(["bytes32", "bytes32"], [key, r.salt])), r.values[r.opens])
      : null;
    let at = null;
    const contract = r.written?.contract ?? file.chain?.contract;
    try {
      at = rpc && contract ? await ask(rpc, contract, r.hash) : null;
      checks.onChain = at === null ? null : at > 0;
    } catch {
      checks.onChain = null;
    }
    entries.push({ kind: r.kind, hash: r.hash, about: r.about ?? null, checks, writtenAt: at ? new Date(at * 1000).toISOString() : null });
  }
  let ownership = null;
  if (file.ownership) {
    const o = file.ownership;
    const signer = recoverAddress(typedDataDigest(o.typedData), o.signature);
    ownership = {
      wallet: o.wallet,
      signedByWallet: Boolean(signer) && same(signer, o.wallet) && same(o.typedData.message.wallet, o.wallet),
      forThisPlayer: same(o.typedData.message.player, key),
    };
  }
  const failed = entries.some((e) => Object.values(e.checks).includes(false))
    || (ownership && (!ownership.signedByWallet || !ownership.forThisPlayer));
  return { ok: !failed, ownership, entries };
}

// ── command line ──────────────────────────────────────────────────────

async function main(argv) {
  const { readFile } = await import("node:fs/promises");
  const path = argv.find((a) => !a.startsWith("--"));
  if (!path) {
    console.log("Usage: node verify-record.mjs <record.json> [--rpc URL]");
    return 2;
  }
  const at = argv.indexOf("--rpc");
  const file = JSON.parse(await readFile(path, "utf8"));
  const report = await checkRecordFile(file, { rpcUrl: at >= 0 ? argv[at + 1] : undefined });
  const tick = (v) => (v === true ? "ok" : v === false ? "FAIL" : "-");
  console.log(`${file.player?.name ?? "Player"} · ${report.entries.length} entries · ${file.chain?.name ?? "chain"} ${file.chain?.contract ?? ""}\n`);
  for (const e of report.entries) {
    const c = e.checks;
    const about = !e.about ? ""
      : e.about.venue ? `${e.about.sport} at ${e.about.venue}, ${e.about.startsAt.slice(0, 10)}`
        : [e.about.league, e.about.season, e.about.team].filter(Boolean).join(" · ");
    const key = c.season === null ? `game ${tick(c.game)}` : `season ${tick(c.season)}`;
    const list = c.list === null ? "" : `  list ${tick(c.list)}`;
    console.log(`${e.kind.padEnd(12)} ${e.hash.slice(0, 10)}…  hash ${tick(c.hash)}  kind ${tick(c.kind)}  ${key}  theirs ${tick(c.theirs)}${list}  on chain ${tick(c.onChain)}${e.writtenAt ? ` (${e.writtenAt})` : ""}  ${about}`);
  }
  if (report.ownership) {
    const o = report.ownership;
    console.log(`\nwallet ${o.wallet}: signed ${tick(o.signedByWallet)}, for this player ${tick(o.forThisPlayer)}`);
  } else {
    console.log("\nNo wallet signature in this file.");
  }
  console.log(report.ok ? "\nEverything checks out." : "\nSomething does not check out (FAIL above).");
  console.log("Sport, venue, time and names come from SportsArc; the checks above rely on the chain alone.");
  return report.ok ? 0 : 1;
}

const isCli = typeof process !== "undefined" && process.argv?.[1] && /verify-record\.mjs$/.test(process.argv[1]);
if (isCli) main(process.argv.slice(2)).then((code) => process.exit(code), (err) => { console.error(err.message); process.exit(2); });
