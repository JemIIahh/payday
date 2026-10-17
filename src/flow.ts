import { createPublicClient, encodeFunctionData, erc20Abi, fallback, formatUnits, getAddress, http, isAddress, parseAbi, type Address, type Hex } from "viem";
import { base } from "viem/chains";
import { atomicAmount, evmOutputSchema, proposeEvm } from "./paybox.js";
import * as z from "zod/v4";

export const CHAIN = "eip155:8453";
// Sablier Flow v3.0 on Base (docs.sablier.com/guides/flow/deployments).
export const FLOW: Address = getAddress("0x0cbfe6ce6f05c47d6243bb3818837971c6ccb46b");
export const RPC_HOSTS = ["mainnet.base.org", "base-rpc.publicnode.com"];

const KNOWN_TOKENS: Record<string, { address: Address; symbol: string; decimals: number }> = {
  USDC: { address: getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"), symbol: "USDC", decimals: 6 },
  EURC: { address: getAddress("0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42"), symbol: "EURC", decimals: 6 },
};

// UD21x18 rates are uint128 on the wire; IERC20 params are addresses.
export const flowAbi = parseAbi([
  "function createAndDeposit(address sender, address recipient, uint128 ratePerSecond, uint40 startTime, address token, bool transferable, uint128 amount) payable returns (uint256)",
  "function deposit(uint256 streamId, uint128 amount, address sender, address recipient) payable",
  "function pause(uint256 streamId) payable",
  "function restart(uint256 streamId, uint128 ratePerSecond) payable",
  "function adjustRatePerSecond(uint256 streamId, uint128 newRatePerSecond) payable",
  "function refundMax(uint256 streamId) payable returns (uint128)",
  "function withdrawMax(uint256 streamId, address to) payable returns (uint128)",
  "function batch(bytes[] calls) payable returns (bytes[])",
  "function nextStreamId() view returns (uint256)",
  "function isStream(uint256 streamId) view returns (bool)",
  "function getSender(uint256 streamId) view returns (address)",
  "function getRecipient(uint256 streamId) view returns (address)",
  "function getToken(uint256 streamId) view returns (address)",
  "function getTokenDecimals(uint256 streamId) view returns (uint8)",
  "function getRatePerSecond(uint256 streamId) view returns (uint128)",
  "function getBalance(uint256 streamId) view returns (uint128)",
  "function statusOf(uint256 streamId) view returns (uint8)",
  "function withdrawableAmountOf(uint256 streamId) view returns (uint128)",
  "function refundableAmountOf(uint256 streamId) view returns (uint128)",
  "function totalDebtOf(uint256 streamId) view returns (uint256)",
  "function uncoveredDebtOf(uint256 streamId) view returns (uint256)",
  "function depletionTimeOf(uint256 streamId) view returns (uint256)",
  "function getSnapshotTime(uint256 streamId) view returns (uint40)",
  "function calculateMinFeeWei(uint256 streamId) view returns (uint256)",
]);

// BASE_RPC_URL (optional portal variable) puts a private RPC ahead of the public ones.
const rpcUrls = [process.env.BASE_RPC_URL, ...RPC_HOSTS.map((host) => `https://${host}`)].filter((url): url is string => Boolean(url));

export const client = createPublicClient({
  chain: base,
  transport: fallback(rpcUrls.map((url) => http(url, { timeout: 3_500, retryCount: 0 }))),
});

// ---------- inputs ----------

export const PERIODS = { hour: 3_600, day: 86_400, week: 604_800, month: 2_592_000, year: 31_536_000 } as const;
export type Period = keyof typeof PERIODS;
export const periodSchema = z.enum(["hour", "day", "week", "month", "year"]).describe("Billing period. A month is 30 days, a year is 365 days.");
export const amountSchema = z.string().regex(/^(0|[1-9][0-9]{0,17})(\.[0-9]{1,18})?$/, "Use a decimal string such as \"2500\" or \"0.5\".");
export const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "Use a 0x-prefixed EVM address.");
export const streamIdSchema = z.string().regex(/^[1-9][0-9]{0,15}$/, "Use the numeric Sablier stream ID.");
export const tokenSchema = z.string().max(64).default("USDC").describe("USDC (default), EURC, or an ERC-20 token address on Base.");

export class UserError extends Error {}

export function checksum(address: string, label: string): Address {
  if (!isAddress(address, { strict: false })) throw new UserError(`${label} is not a valid EVM address.`);
  const value = getAddress(address);
  if (value === "0x0000000000000000000000000000000000000000") throw new UserError(`${label} cannot be the zero address.`);
  return value;
}

// ---------- amounts ----------

export const MAX_UINT128 = 2n ** 128n - 1n;

/**
 * Rate per second as an 18-decimal fixed-point number, as Sablier Flow stores it. Rounded up so the
 * recipient never receives less than the stated amount per period.
 */
export function ratePerSecond(amount: string, period: Period): bigint {
  const scaled = BigInt(atomicAmount(amount, 18));
  const seconds = BigInt(PERIODS[period]);
  const rate = (scaled + seconds - 1n) / seconds;
  if (rate === 0n) throw new UserError("That rate rounds to zero per second; use a larger amount or a shorter period.");
  if (rate > MAX_UINT128) throw new UserError("That rate is too large.");
  return rate;
}

/** Converts an 18-decimal scaled amount to token units. */
export function descale(scaled: bigint, decimals: number, rounding: "down" | "up" | "nearest" = "down"): bigint {
  const factor = 10n ** BigInt(18 - decimals);
  if (rounding === "up") return (scaled + factor - 1n) / factor;
  if (rounding === "nearest") return (scaled + factor / 2n) / factor;
  return scaled / factor;
}

export function display(amount: bigint, decimals: number, places = 6): string {
  const [whole = "0", fraction = ""] = formatUnits(amount, decimals).split(".");
  const trimmed = fraction.slice(0, places).replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole;
}

export function perPeriod(rate: bigint, decimals: number) {
  return Object.fromEntries(Object.entries(PERIODS).map(([name, seconds]) => [name, display(descale(rate * BigInt(seconds), decimals), decimals)])) as Record<Period, string>;
}

export function iso(seconds: number | bigint): string {
  return new Date(Number(seconds) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function duration(seconds: number): string {
  if (seconds <= 0) return "now";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${Math.max(minutes, 1)}m`;
}

// ---------- tokens ----------

export type Token = { address: Address; symbol: string; decimals: number };

export async function resolveToken(input: string): Promise<Token> {
  const known = KNOWN_TOKENS[input.trim().toUpperCase()];
  if (known) return known;
  const address = checksum(input.trim(), "token");
  const match = Object.values(KNOWN_TOKENS).find((token) => token.address === address);
  if (match) return match;
  const [symbol, decimals] = await client.multicall({
    contracts: [
      { address, abi: erc20Abi, functionName: "symbol" },
      { address, abi: erc20Abi, functionName: "decimals" },
    ],
    allowFailure: true,
  });
  if (decimals.status !== "success") throw new UserError(`${address} does not look like an ERC-20 token on Base.`);
  if (decimals.result > 18) throw new UserError("Sablier Flow supports tokens with at most 18 decimals.");
  return { address, symbol: symbol.status === "success" ? symbol.result : "TOKEN", decimals: decimals.result };
}

export function symbolFor(address: Address): string | undefined {
  return Object.values(KNOWN_TOKENS).find((token) => token.address === getAddress(address))?.symbol;
}

/** The wallet's token balance, its allowance to Sablier Flow, and its ETH for gas. */
export async function walletFunds(owner: Address, token: Token) {
  const [balance, allowance, eth] = await Promise.all([
    client.readContract({ address: token.address, abi: erc20Abi, functionName: "balanceOf", args: [owner] }),
    client.readContract({ address: token.address, abi: erc20Abi, functionName: "allowance", args: [owner, FLOW] }),
    client.getBalance({ address: owner }),
  ]);
  return { balance, allowance, eth };
}

// ---------- streams ----------

export const STATUS = ["pending", "streaming", "streaming_insolvent", "paused", "paused_insolvent", "voided"] as const;

const STREAM_FIELDS = [
  "isStream", "getSender", "getRecipient", "getToken", "getTokenDecimals", "getRatePerSecond", "getBalance",
  "statusOf", "withdrawableAmountOf", "refundableAmountOf", "totalDebtOf", "uncoveredDebtOf", "depletionTimeOf",
  "getSnapshotTime",
] as const;

export type StreamState = {
  id: bigint; sender: Address; recipient: Address; token: Address; decimals: number; rate: bigint; balance: bigint;
  status: (typeof STATUS)[number]; withdrawable: bigint; refundable: bigint; totalDebt: bigint; uncoveredDebt: bigint;
  depletionTime: bigint | null; snapshotTime: number;
};

export async function readStreams(ids: bigint[]): Promise<Map<bigint, StreamState>> {
  if (ids.length === 0) return new Map();
  const results = await client.multicall({
    contracts: ids.flatMap((id) => STREAM_FIELDS.map((functionName) => ({ address: FLOW, abi: flowAbi, functionName, args: [id] }) as const)),
    allowFailure: true,
  });
  const streams = new Map<bigint, StreamState>();
  ids.forEach((id, index) => {
    const row = results.slice(index * STREAM_FIELDS.length, (index + 1) * STREAM_FIELDS.length);
    const value = (field: (typeof STREAM_FIELDS)[number]) => {
      const entry = row[STREAM_FIELDS.indexOf(field)];
      return entry?.status === "success" ? entry.result : undefined;
    };
    if (value("isStream") !== true) return;
    const depletion = value("depletionTimeOf") as bigint | undefined;
    streams.set(id, {
      id,
      sender: value("getSender") as Address,
      recipient: value("getRecipient") as Address,
      token: value("getToken") as Address,
      decimals: Number(value("getTokenDecimals")),
      rate: value("getRatePerSecond") as bigint,
      balance: value("getBalance") as bigint,
      status: STATUS[Number(value("statusOf"))] ?? "pending",
      withdrawable: (value("withdrawableAmountOf") as bigint | undefined) ?? 0n,
      refundable: (value("refundableAmountOf") as bigint | undefined) ?? 0n,
      totalDebt: (value("totalDebtOf") as bigint | undefined) ?? 0n,
      uncoveredDebt: (value("uncoveredDebtOf") as bigint | undefined) ?? 0n,
      depletionTime: depletion && depletion > 0n ? depletion : null,
      snapshotTime: Number(value("getSnapshotTime") ?? 0),
    });
  });
  return streams;
}

export async function readStream(id: string): Promise<StreamState> {
  const streamId = BigInt(id);
  const stream = (await readStreams([streamId])).get(streamId);
  if (!stream) throw new UserError(`Stream ${id} does not exist on Sablier Flow (Base).`);
  return stream;
}

export async function tokenSymbols(addresses: Address[]): Promise<Map<Address, string>> {
  const unique = [...new Set(addresses.map((address) => getAddress(address)))];
  const unknown = unique.filter((address) => !symbolFor(address));
  const fetched = unknown.length
    ? await client.multicall({ contracts: unknown.map((address) => ({ address, abi: erc20Abi, functionName: "symbol" }) as const), allowFailure: true })
    : [];
  return new Map(unique.map((address) => {
    const index = unknown.indexOf(address);
    const fetchedSymbol = index >= 0 && fetched[index]?.status === "success" ? (fetched[index].result as string) : undefined;
    return [address, symbolFor(address) ?? fetchedSymbol ?? "TOKEN"];
  }));
}

export function sablierUrl(id: bigint): string {
  return `https://app.sablier.com/payments/stream/FL4-8453-${id}`;
}

export function describeStream(stream: StreamState, symbol: string, now = Math.floor(Date.now() / 1000)) {
  const d = stream.decimals;
  const live = stream.status === "streaming";
  const runsOut = live && stream.depletionTime ? Number(stream.depletionTime) : null;
  return {
    stream_id: stream.id.toString(),
    status: stream.status,
    sender: stream.sender,
    recipient: stream.recipient,
    token: symbol,
    token_address: stream.token,
    rate: perPeriod(stream.rate, d),
    balance: display(stream.balance, d),
    earned_unclaimed: display(stream.totalDebt, d),
    withdrawable_now: display(stream.withdrawable, d),
    refundable_to_sender: display(stream.refundable, d),
    unpaid_debt: display(stream.uncoveredDebt, d),
    runs_out_at: runsOut ? iso(runsOut) : null,
    runway: runsOut ? duration(runsOut - now) : live ? "out of funds" : "not streaming",
    starts_at: stream.status === "pending" ? iso(stream.snapshotTime) : null,
    sablier_url: sablierUrl(stream.id),
  };
}

export const streamSummarySchema = z.object({
  stream_id: z.string(),
  status: z.enum(STATUS),
  sender: z.string(),
  recipient: z.string(),
  token: z.string(),
  token_address: z.string(),
  rate: z.object({ hour: z.string(), day: z.string(), week: z.string(), month: z.string(), year: z.string() }).strict(),
  balance: z.string(),
  earned_unclaimed: z.string(),
  withdrawable_now: z.string(),
  refundable_to_sender: z.string(),
  unpaid_debt: z.string(),
  runs_out_at: z.string().nullable(),
  runway: z.string(),
  starts_at: z.string().nullable(),
  sablier_url: z.string(),
}).strict();

// ---------- proposals ----------

const PROPOSAL_KEY = "io.paybox/transactionProposal";

export const proposalOutputSchema = z.object({
  [PROPOSAL_KEY]: evmOutputSchema.shape[PROPOSAL_KEY],
  step: z.string(),
  summary: z.string(),
  details: z.record(z.string(), z.string()),
}).strict();

export function propose(input: { to: Address; data: Hex; value?: bigint; step: string; summary: string; details: Record<string, string> }) {
  const proposal = proposeEvm({ chain: CHAIN, to: input.to, value: (input.value ?? 0n).toString(), data: input.data });
  return {
    content: [{ type: "text" as const, text: `${input.summary}\n\nUnsigned proposal only: PayBox simulates it and asks for approval before anything is signed.` }],
    structuredContent: { ...proposal.structuredContent, step: input.step, summary: input.summary, details: input.details },
  };
}

/**
 * Returns an approve proposal for `needed` (plus optional headroom, capped at the wallet's balance) when
 * Sablier Flow cannot yet pull it, after checking the wallet holds it. Returns null when no approval is needed.
 */
export async function approvalIfNeeded(owner: Address, token: Token, needed: bigint, retry: string, headroom = 0n) {
  const funds = await walletFunds(owner, token);
  if (funds.balance < needed) {
    throw new UserError(`The wallet ${owner} holds ${display(funds.balance, token.decimals)} ${token.symbol}, but this needs ${display(needed, token.decimals)} ${token.symbol}.`);
  }
  if (funds.eth === 0n) throw new UserError(`The wallet ${owner} has no ETH on Base for network fees.`);
  if (funds.allowance >= needed) return null;
  // Headroom covers amounts that keep growing while the approval waits (e.g. runway top-ups).
  const approve = needed + headroom > funds.balance ? funds.balance : needed + headroom;
  return propose({
    to: token.address,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [FLOW, approve] }),
    step: "approve",
    summary: `Step 1 of 2: allow Sablier Flow to move up to ${display(approve, token.decimals)} ${token.symbol} from ${owner}. Nothing is streamed yet. Once PayBox confirms this approval, call ${retry} again with the same arguments.`,
    details: { token: token.symbol, spender: FLOW, amount: display(approve, token.decimals), current_allowance: display(funds.allowance, token.decimals) },
  });
}

export function requireSender(stream: StreamState, sender: Address) {
  if (stream.sender !== sender) {
    throw new UserError(`Only the stream's sender (${stream.sender}) can do this; ${sender} is not the sender of stream ${stream.id}.`);
  }
}
