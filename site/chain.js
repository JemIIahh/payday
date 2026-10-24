// Everything the dashboard reads: Base (Sablier Flow v3, Basenames) and Sablier's public indexer.
// All reads, no wallet: nothing here can sign or send.
import { createPublicClient, http, fallback, parseAbi, getAddress, isAddress, formatUnits, erc20Abi, namehash } from "viem";
import { normalize } from "viem/ens";
import { base } from "viem/chains";
import { tokenLabel } from "../src/statement.ts";

// Replaced at build time (site/build.mjs).
const RPCS = __RPCS__;
const INDEXER = __INDEXER__;

export const FLOW = "0x0cbfe6ce6f05c47d6243bb3818837971c6ccb46b";
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const REGISTRY = "0xb94704422c2a1e396835a571837aa5ae53285a95";
const ZERO = "0x0000000000000000000000000000000000000000";
const SCAN = 2000; // newest stream IDs to scan on chain; older ones come from the indexer
const MAX_STREAMS = 50;
export const KNOWN = new Map([
  ["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", { symbol: "USDC", decimals: 6 }],
  ["0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42", { symbol: "EURC", decimals: 6 }],
]);

const flowAbi = parseAbi([
  "function nextStreamId() view returns (uint256)",
  "function isStream(uint256 id) view returns (bool)",
  "function getSender(uint256 id) view returns (address)",
  "function getRecipient(uint256 id) view returns (address)",
  "function getToken(uint256 id) view returns (address)",
  "function getTokenDecimals(uint256 id) view returns (uint8)",
  "function getRatePerSecond(uint256 id) view returns (uint128)",
  "function getBalance(uint256 id) view returns (uint128)",
  "function statusOf(uint256 id) view returns (uint8)",
  "function totalDebtOf(uint256 id) view returns (uint256)",
  "function depletionTimeOf(uint256 id) view returns (uint256)",
  "function getSnapshotTime(uint256 id) view returns (uint40)",
]);
const clockAbi = parseAbi(["function getCurrentBlockTimestamp() view returns (uint256)"]);
const registryAbi = parseAbi(["function resolver(bytes32 node) view returns (address)"]);
const resolverAbi = parseAbi(["function addr(bytes32 node) view returns (address)", "function name(bytes32 node) view returns (string)"]);
const FIELDS = ["isStream", "getSender", "getRecipient", "getToken", "getTokenDecimals", "getRatePerSecond", "getBalance", "statusOf", "totalDebtOf", "depletionTimeOf", "getSnapshotTime"];
const STATUS = ["pending", "streaming", "streaming_insolvent", "paused", "paused_insolvent", "voided"];
const BASENAME = /^(?:[^\s.]+\.)+base\.eth$/i;

export const client = createPublicClient({
  chain: base,
  batch: { multicall: { batchSize: 100_000 } },
  transport: fallback(RPCS.map((url) => http(url, { timeout: 8000, retryCount: 1 }))),
});

export const same = (a, b) => a.toLowerCase() === b.toLowerCase();

// ---------- names ----------

/** An address, or a Base name resolved to one. Throws a sentence the page can show as is. */
export async function resolveInput(raw) {
  const value = raw.trim();
  if (isAddress(value.toLowerCase(), { strict: false })) return { address: getAddress(value.toLowerCase()), name: null };
  if (!BASENAME.test(value)) {
    throw new Error(/\.eth$/i.test(value)
      ? "Only Base names ending in .base.eth work here. For other ENS names, paste the 0x address."
      : "Enter a wallet address (0x… 42 characters) or a Base name like name.base.eth.");
  }
  let name;
  try { name = normalize(value); } catch { throw new Error(`"${value}" is not a valid name.`); }
  const node = namehash(name);
  const resolver = await client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "resolver", args: [node] });
  if (resolver === ZERO) throw new Error(`${name} is not a registered Base name.`);
  const address = await client.readContract({ address: resolver, abi: resolverAbi, functionName: "addr", args: [node] }).catch(() => ZERO);
  if (address === ZERO) throw new Error(`${name} does not point to an address.`);
  return { address: getAddress(address), name };
}

/** Primary Base names, kept only when the name resolves back to the same address. Never throws. */
export async function namesFor(addresses) {
  const unique = [...new Set(addresses.map((a) => getAddress(a)))];
  const names = new Map();
  if (!unique.length) return names;
  try {
    const nodes = unique.map((a) => namehash(`${a.slice(2).toLowerCase()}.80002105.reverse`));
    const resolvers = await Promise.all(nodes.map((node) => client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "resolver", args: [node] }).catch(() => ZERO)));
    const claimed = (await Promise.all(unique.map(async (address, i) => {
      if (resolvers[i] === ZERO) return null;
      const name = await client.readContract({ address: resolvers[i], abi: resolverAbi, functionName: "name", args: [nodes[i]] }).catch(() => "");
      try { return BASENAME.test(name) ? { address, name: normalize(name) } : null; } catch { return null; }
    }))).filter(Boolean);
    await Promise.all(claimed.map(async ({ address, name }) => {
      try {
        const resolved = await resolveInput(name);
        if (resolved.address === address) names.set(address, name);
      } catch { /* not verified, no name */ }
    }));
  } catch (err) {
    console.warn("name lookup skipped", err);
  }
  return names;
}

// ---------- indexer ----------

const STREAMS_QUERY = `query Streams($contract: String!, $address: String!) {
  FlowStream(
    where: { chainId: { _eq: 8453 }, contract: { _eq: $contract }, _or: [
      { sender: { _eq: $address } }, { recipient: { _eq: $address } },
      { actions: { category: { _eq: "Transfer" }, _or: [{ addressA: { _eq: $address } }, { addressB: { _eq: $address } }] } }
    ] }
    order_by: { tokenId: desc } limit: 200
  ) {
    tokenId sender recipient startTime
    asset { address symbol decimals }
    actions(order_by: [{ timestamp: asc }, { subgraphId: asc }]) { category amountA amountB addressA addressB timestamp hash }
  }
}`;

/** Indexed history of the address's Payday (Flow v3) streams, or null if the indexer can't be reached. */
export async function indexedStreams(address) {
  try {
    const res = await fetch(INDEXER, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: STREAMS_QUERY, variables: { contract: FLOW, address: address.toLowerCase() } }),
      signal: AbortSignal.timeout(8000),
    });
    const body = await res.json();
    return body?.data?.FlowStream ?? null;
  } catch (err) {
    console.warn("indexer unavailable", err);
    return null;
  }
}

// ---------- streams ----------

async function scanIds(owner) {
  const next = await client.readContract({ address: FLOW, abi: flowAbi, functionName: "nextStreamId" });
  const ids = [];
  for (let id = next - 1n; id >= 1n && ids.length < SCAN; id--) ids.push(id);
  const parties = ids.length
    ? await client.multicall({
        contracts: ids.flatMap((id) => [
          { address: FLOW, abi: flowAbi, functionName: "getSender", args: [id] },
          { address: FLOW, abi: flowAbi, functionName: "getRecipient", args: [id] },
        ]),
        allowFailure: true,
        batchSize: 100_000,
      })
    : [];
  const mine = ids.filter((_, i) => {
    const s = parties[i * 2], r = parties[i * 2 + 1];
    return (s?.status === "success" && same(s.result, owner)) || (r?.status === "success" && same(r.result, owner));
  });
  return { mine, scanned: ids.length };
}

/** Live state of the owner's streams plus their indexed history. Chain scan and indexer run side by side. */
export async function loadStreams(owner) {
  const [scan, history] = await Promise.all([scanIds(owner), indexedStreams(owner)]);
  const historyById = new Map((history ?? []).map((s) => [s.tokenId, s]));
  const ids = [...new Set([...scan.mine, ...(history ?? []).map((s) => BigInt(s.tokenId))])]
    .sort((a, b) => (b > a ? 1 : b < a ? -1 : 0))
    .slice(0, MAX_STREAMS);
  if (!ids.length) return { streams: [], offset: 0, scanned: scan.scanned, indexer: history !== null };

  const calls = ids.flatMap((id) => FIELDS.map((functionName) => ({ address: FLOW, abi: flowAbi, functionName, args: [id] })));
  calls.push({ address: MULTICALL3, abi: clockAbi, functionName: "getCurrentBlockTimestamp" });
  const res = await client.multicall({ contracts: calls, allowFailure: true, batchSize: 100_000 });
  const clock = res[res.length - 1];
  if (clock.status !== "success") throw new Error("no block timestamp");
  const readAt = Number(clock.result);
  const offset = readAt * 1000 - Date.now();

  const rows = ids.map((id, i) => {
    const cell = (f) => { const r = res[i * FIELDS.length + FIELDS.indexOf(f)]; return r?.status === "success" ? r.result : undefined; };
    return { id, cell };
  }).filter((r) => r.cell("isStream") === true && (same(r.cell("getSender"), owner) || same(r.cell("getRecipient"), owner)));

  const symbols = await tokenSymbols(rows.map((r) => r.cell("getToken")));
  const streams = rows.map(({ id, cell }) => {
    const decimals = Number(cell("getTokenDecimals"));
    const human = (v) => Number(formatUnits(v ?? 0n, decimals));
    const token = cell("getToken").toLowerCase();
    const depletion = cell("depletionTimeOf");
    return {
      id,
      sender: getAddress(cell("getSender")),
      recipient: getAddress(cell("getRecipient")),
      token,
      symbol: symbols.get(token) || "TOKEN",
      decimals,
      status: STATUS[Number(cell("statusOf"))] || "pending",
      ratePerSec: Number(cell("getRatePerSecond") ?? 0n) / 1e18,
      balance: human(cell("getBalance")),
      debt: human(cell("totalDebtOf")),
      depletion: depletion && depletion > 0n ? Number(depletion) : null,
      snapshot: Number(cell("getSnapshotTime") ?? 0),
      history: historyById.get(id.toString())?.actions ?? null,
      readAt,
    };
  });
  return { streams, offset, scanned: scan.scanned, indexer: history !== null };
}

export async function tokenSymbols(addresses) {
  const tokens = [...new Set(addresses.map((t) => t.toLowerCase()))];
  const symbols = new Map([...KNOWN].map(([a, t]) => [a, t.symbol]));
  const unknown = tokens.filter((t) => !symbols.has(t));
  if (unknown.length) {
    const sym = await client.multicall({ contracts: unknown.map((t) => ({ address: t, abi: erc20Abi, functionName: "symbol" })), allowFailure: true });
    // Never trust a self-reported symbol: unknown tokens are labelled with their address (see tokenLabel).
    unknown.forEach((t, i) => symbols.set(t, tokenLabel(t, sym[i]?.status === "success" ? String(sym[i].result) : null)));
  }
  return symbols;
}
