import type { Address, Hex } from "viem";
import { FLOW, client } from "./flow.js";
import { creationHashes, upfrontFromLogs, type IndexedStream, type Upfront } from "./statement.js";

// Sablier's public Envio indexer (docs.sablier.com/api/streams/indexers). It supplies history (who was paid,
// when, which transaction); live balances always come from Base itself. Its host must be allowed under the
// plugin's network access; SABLIER_INDEXER_URL overrides it.
export const INDEXER_URL = process.env.SABLIER_INDEXER_URL ?? "https://indexer.hyperindex.xyz/53b7e25/v1/graphql";

export class IndexerUnavailable extends Error {}

const STREAMS = `query Streams($contract: String!, $address: String!, $limit: Int!) {
  FlowStream(
    where: { chainId: { _eq: 8453 }, contract: { _eq: $contract }, _or: [
      { sender: { _eq: $address } },
      { recipient: { _eq: $address } },
      { actions: { category: { _eq: "Transfer" }, _or: [{ addressA: { _eq: $address } }, { addressB: { _eq: $address } }] } }
    ] }
    order_by: { tokenId: desc }
    limit: $limit
  ) {
    tokenId sender recipient startTime
    asset { address symbol decimals }
    actions(order_by: [{ timestamp: asc }, { subgraphId: asc }]) { category amountA amountB addressA addressB timestamp hash }
  }
}`;

/** Payday's Flow streams (Sablier Flow v3 on Base) that `address` pays, receives, or once held, newest first. */
export async function indexedStreams(address: Address, limit = 100): Promise<IndexedStream[]> {
  let body: { data?: { FlowStream?: IndexedStream[] }; errors?: { message: string }[] };
  try {
    const response = await fetch(INDEXER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: STREAMS, variables: { contract: FLOW.toLowerCase(), address: address.toLowerCase(), limit } }),
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) throw new Error(`indexer answered ${response.status}`);
    body = await response.json();
  } catch (error) {
    // Unreachable, slow, or not JSON: all mean "no history right now", never a failed tool.
    throw new IndexerUnavailable(error instanceof Error ? error.message : String(error));
  }
  const streams = body?.data?.FlowStream;
  if (!Array.isArray(streams)) throw new IndexerUnavailable(body?.errors?.[0]?.message ?? "indexer returned no data");
  return streams;
}

/**
 * pay_now payments made alongside these streams, read from their creation transactions on Base (the newest 25
 * creations, to stay inside the time budget). Best effort: a receipt that can't be read just means no upfront line.
 */
export async function upfrontPayments(streams: IndexedStream[]): Promise<Map<string, Upfront>> {
  const hashes = creationHashes(streams).slice(0, 25);
  const receipts = await Promise.all(hashes.map((hash) => client.getTransactionReceipt({ hash: hash as Hex }).catch(() => null)));
  const logs = new Map(hashes.map((hash, index) => [hash, receipts[index]?.logs ?? null]));
  const found = new Map<string, Upfront>();
  for (const stream of streams) {
    const hash = stream.actions.find((action) => action.category === "Create")?.hash;
    const entries = hash ? logs.get(hash) : null;
    const upfront = entries ? upfrontFromLogs(stream, entries) : null;
    if (upfront) found.set(stream.tokenId, upfront);
  }
  return found;
}
