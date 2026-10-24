import { getAddress, type Address } from "viem";
import { FLOW, client, flowAbi, readStreams } from "./flow.js";
import { IndexerUnavailable, indexedStreams } from "./indexer.js";

export type Role = "any" | "sender" | "recipient";
type Parties = { id: bigint; sender: Address; recipient: Address };

/** The newest `scan` stream IDs, with their sender and recipient, where `owner` is either one. Read from Base. */
async function scanChain(owner: Address, scan: number): Promise<{ rows: Parties[]; range: string }> {
  const next = await client.readContract({ address: FLOW, abi: flowAbi, functionName: "nextStreamId" });
  const ids: bigint[] = [];
  for (let id = next - 1n; id >= 1n && ids.length < scan; id--) ids.push(id);
  if (ids.length === 0) return { rows: [], range: "none" };
  const parties = await client.multicall({
    contracts: ids.flatMap((id) => [
      { address: FLOW, abi: flowAbi, functionName: "getSender", args: [id] } as const,
      { address: FLOW, abi: flowAbi, functionName: "getRecipient", args: [id] } as const,
    ]),
    allowFailure: true,
  });
  const rows = ids.flatMap((id, index) => {
    const sender = parties[index * 2];
    const recipient = parties[index * 2 + 1];
    if (sender?.status !== "success" || recipient?.status !== "success") return [];
    const row = { id, sender: getAddress(sender.result as Address), recipient: getAddress(recipient.result as Address) };
    return row.sender === owner || row.recipient === owner ? [row] : [];
  });
  return { rows, range: `${ids[ids.length - 1]}-${ids[0]}` };
}

/** Stream IDs Sablier's indexer knows for `owner`, or none (with a note on stderr) when it cannot be reached. */
async function indexedIds(owner: Address): Promise<bigint[] | null> {
  try {
    return (await indexedStreams(owner)).map((stream) => BigInt(stream.tokenId));
  } catch (error) {
    if (!(error instanceof IndexerUnavailable)) throw error;
    console.error(`indexer skipped: ${error.message}`);
    return null;
  }
}

/**
 * Live state of the streams `owner` pays or receives, newest first. Scans the newest stream IDs on chain
 * (authoritative, and sees a stream the moment it confirms) and adds older ones from Sablier's indexer when
 * it is reachable, so nothing is missed as Flow grows past the scan window.
 */
export async function findStreams(owner: Address, role: Role = "any", scan = 2_000, limit = 25) {
  const [chain, indexed] = await Promise.all([scanChain(owner, scan), indexedIds(owner)]);
  const ids = [...new Set([...chain.rows.map((row) => row.id), ...(indexed ?? [])])];
  const streams = [...(await readStreams(ids)).values()]
    .filter((stream) => role === "sender" ? stream.sender === owner : role === "recipient" ? stream.recipient === owner : stream.sender === owner || stream.recipient === owner)
    .sort((a, b) => (b.id > a.id ? 1 : -1));
  return { streams: streams.slice(0, limit), total: streams.length, scannedIds: chain.range, indexer: indexed !== null };
}

/**
 * Everyone `sender` has streamed to through Sablier Flow: current recipients on chain plus, when the indexer
 * is reachable, everyone a stream was created for. Used only to flag first-time recipients, never to block.
 */
export async function pastRecipients(sender: Address): Promise<Set<Address>> {
  const seen = new Set<Address>();
  const [chain, history] = await Promise.all([
    scanChain(sender, 2_000),
    indexedStreams(sender).catch((error) => {
      if (!(error instanceof IndexerUnavailable)) throw error;
      return [];
    }),
  ]);
  for (const row of chain.rows) if (row.sender === sender) seen.add(row.recipient);
  for (const stream of history) {
    if (getAddress(stream.sender) !== sender) continue;
    for (const action of stream.actions) if (action.category === "Create" && action.addressB) seen.add(getAddress(action.addressB));
  }
  return seen;
}
