import { getAddress, namehash, parseAbi, type Address } from "viem";
import { normalize } from "viem/ens";
import * as z from "zod/v4";
import { UserError, checksum, client } from "./flow.js";

// Basenames live on Base itself (github.com/base/basenames), so they resolve with the same RPC as everything else.
const REGISTRY: Address = getAddress("0xb94704422c2a1e396835a571837aa5ae53285a95");
const ZERO = "0x0000000000000000000000000000000000000000";
const registryAbi = parseAbi(["function resolver(bytes32 node) view returns (address)"]);
const resolverAbi = parseAbi([
  "function addr(bytes32 node) view returns (address)",
  "function name(bytes32 node) view returns (string)",
]);

const BASENAME = /^(?:[^\s.]+\.)+base\.eth$/i;

// Any *.eth is let through the schema so other ENS names get a clear explanation rather than a pattern error.
export const partySchema = z.string().min(3).max(253)
  .regex(/^(0x[0-9a-fA-F]{40}|(?:[^\s.]+\.)+eth)$/i, "Use a 0x-prefixed EVM address or a Base name such as ada.base.eth.")
  .describe("A 0x address, or a Base name such as ada.base.eth. For a PayBox username, resolve it to an address with PayBox first.");

export type Party = { address: Address; name: string | null };

/** Resolves an address or a Base name (`ada.base.eth`) to a checksummed address. */
export async function resolveParty(input: string, label: string): Promise<Party> {
  const value = input.trim();
  if (/^0x/i.test(value)) return { address: checksum(value, label), name: null };
  if (!BASENAME.test(value)) {
    throw new UserError(`${label}: only Base names ending in .base.eth are supported. For other ENS names, give the 0x address.`);
  }
  let name: string;
  try {
    name = normalize(value);
  } catch {
    throw new UserError(`${label}: "${value}" is not a valid name.`);
  }
  const node = namehash(name);
  const resolver = await client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "resolver", args: [node] });
  if (resolver === ZERO) throw new UserError(`${label}: ${name} is not a registered Base name.`);
  const address = await client.readContract({ address: resolver, abi: resolverAbi, functionName: "addr", args: [node] }).catch(() => ZERO);
  if (address === ZERO) throw new UserError(`${label}: ${name} does not point to an address.`);
  return { address: checksum(address, label), name };
}

/**
 * Primary Base names for a set of addresses, verified forward: a reverse record only counts if the name
 * resolves back to the same address, so nobody can make their wallet display as someone else.
 * Best effort: any failure just means no name.
 */
export async function namesFor(addresses: Address[]): Promise<Map<Address, string>> {
  const unique = [...new Set(addresses.map((address) => getAddress(address)))];
  const names = new Map<Address, string>();
  if (unique.length === 0) return names;
  try {
    const reverseNodes = unique.map((address) => namehash(`${address.slice(2).toLowerCase()}.80002105.reverse`));
    const resolvers = await client.multicall({
      contracts: reverseNodes.map((node) => ({ address: REGISTRY, abi: registryAbi, functionName: "resolver", args: [node] }) as const),
      allowFailure: true,
    });
    const lookups = unique
      .map((address, index) => ({ address, node: reverseNodes[index]!, resolver: resolvers[index]?.status === "success" ? resolvers[index].result as Address : ZERO }))
      .filter((row) => row.resolver !== ZERO);
    if (lookups.length === 0) return names;
    const reverse = await client.multicall({
      contracts: lookups.map((row) => ({ address: row.resolver, abi: resolverAbi, functionName: "name", args: [row.node] }) as const),
      allowFailure: true,
    });
    const claimed = lookups.flatMap((row, index) => {
      const result = reverse[index];
      if (result?.status !== "success" || !BASENAME.test(result.result as string)) return [];
      try { return [{ address: row.address, name: normalize(result.result as string) }]; } catch { return []; }
    });
    if (claimed.length === 0) return names;
    const forwardResolvers = await client.multicall({
      contracts: claimed.map((row) => ({ address: REGISTRY, abi: registryAbi, functionName: "resolver", args: [namehash(row.name)] }) as const),
      allowFailure: true,
    });
    const forward = await client.multicall({
      contracts: claimed.map((row, index) => {
        const resolver = forwardResolvers[index]?.status === "success" ? forwardResolvers[index].result as Address : ZERO;
        return { address: resolver === ZERO ? REGISTRY : resolver, abi: resolverAbi, functionName: "addr", args: [namehash(row.name)] } as const;
      }),
      allowFailure: true,
    });
    claimed.forEach((row, index) => {
      const result = forward[index];
      if (result?.status === "success" && getAddress(result.result as Address) === row.address) names.set(row.address, row.name);
    });
  } catch (error) {
    console.error(`name lookup skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
  return names;
}

/** "ada.base.eth (0x1234…abcd)" when a name is known, else the full address. */
export function who(address: Address, names: Map<Address, string>): string {
  const name = names.get(getAddress(address));
  return name ? `${name} (${address})` : address;
}
