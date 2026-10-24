// Statement math shared by the plugin (payment_statement) and the dashboard (payslips).
// Pure functions over Sablier's indexed stream history: no network, no viem, so both bundles import it.
//
// A Flow stream's rate is piecewise constant. It is set on Create, changed by Adjust, zeroed by Pause and
// Void, and set again by Restart. Pay accrues as rate x seconds (18-decimal fixed point, then descaled to the
// token's decimals). Void writes off whatever the stream could not cover.
//
// Accrued pay is only money once the stream holds the funds to back it. At any moment
//   covered = min(accrued so far, deposits - refunds so far)
// (withdrawals move covered pay out, they don't change how much was covered). A statement counts the covered
// part as earned or paid, and reports the rest as unfunded, so a payslip never shows income nobody paid for.
// Transfer moves the stream NFT, and with it the right to withdraw; pay covered while you held it counts as yours.

export type IndexedAction = {
  category: string;
  amountA: string | null;
  amountB: string | null;
  addressA: string | null;
  addressB: string | null;
  timestamp: string;
  hash: string;
};

export type IndexedStream = {
  tokenId: string;
  sender: string;
  recipient: string;
  startTime: string;
  asset: { address: string; symbol: string; decimals: string };
  actions: IndexedAction[];
};

export type Segment = { from: number; to: number | null; rate: bigint; holder: string };

export type StreamLine = {
  stream_id: string;
  side: "income" | "spending";
  counterparty: string;
  token: string;
  token_address: string;
  decimals: number;
  /** Accrued in the period and backed by funds: earned (income) or paid (spending). */
  covered: bigint;
  /** Accrued in the period but not (yet) backed by funds. */
  unfunded: bigint;
  /** One-off amount paid straight to the recipient when the stream was created (pay_now), if in the period. */
  upfront: bigint;
  withdrawn: bigint;
  deposited: bigint;
  refunded: bigint;
  events: { category: string; amount: bigint | null; timestamp: number; hash: string }[];
};

export type Totals = { covered: bigint; unfunded: bigint; upfront: bigint; withdrawn: bigint; deposited: bigint; refunded: bigint; decimals: number };

/** A pay_now payment: a plain token transfer made in the same transaction that created the stream. */
export type Upfront = { amount: bigint; timestamp: number; hash: string };
export type Log = { address: string; topics: readonly string[]; data: string };

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const topicAddress = (topic: string | undefined) => `0x${(topic ?? "").slice(-40)}`.toLowerCase();

/**
 * Sablier's indexer only sees stream actions, so a one-off payment made alongside a stream (Payday's pay_now,
 * sent with Flow's transferTokens in the same batch) is read from the creation transaction's own logs: an
 * ERC-20 transfer of the stream's token straight from the sender to the recipient. Deposits go to the Flow
 * contract and the stream NFT carries no amount, so neither can be mistaken for it.
 */
export function upfrontFromLogs(stream: IndexedStream, logs: Log[]): Upfront | null {
  const create = stream.actions.find((action) => action.category === "Create");
  if (!create) return null;
  const token = lower(stream.asset.address);
  const sender = lower(stream.sender);
  const recipient = lower(create.addressB ?? stream.recipient);
  let amount = 0n;
  for (const log of logs) {
    if (lower(log.address) !== token || log.topics[0] !== TRANSFER || log.data === "0x" || log.topics.length !== 3) continue;
    if (topicAddress(log.topics[1]) === sender && topicAddress(log.topics[2]) === recipient) amount += BigInt(log.data);
  }
  return amount > 0n ? { amount, timestamp: Number(create.timestamp), hash: create.hash } : null;
}

/** The creation transaction of each stream, for fetching receipts to pass to upfrontFromLogs. */
export function creationHashes(streams: IndexedStream[]): string[] {
  return [...new Set(streams.flatMap((stream) => stream.actions.filter((action) => action.category === "Create").map((action) => action.hash)))];
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// Tokens known by address. Anyone can deploy a token whose symbol() says "USDC", so symbols are never trusted.
const KNOWN_TOKENS: Record<string, string> = {
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": "USDC",
  "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42": "EURC",
};

/**
 * A safe display label for a token: "USDC" or "EURC" when the address is the real one, otherwise the
 * self-reported symbol (only if short and plain, else "TOKEN") with a short address, e.g. "WETH (0x4200…0006)".
 * Labels are unique per address in practice and can't smuggle text into what an agent reads.
 */
export function tokenLabel(address: string, symbol: string | null | undefined): string {
  const known = KNOWN_TOKENS[address.toLowerCase()];
  if (known) return known;
  const clean = symbol && /^[A-Za-z0-9.$_-]{1,12}$/.test(symbol) ? symbol : "TOKEN";
  return `${clean} (${address.slice(0, 6)}…${address.slice(-4)})`;
}
const lower = (value: string | null | undefined) => (value ?? "").toLowerCase();
const big = (value: string | null | undefined) => (value ? BigInt(value) : 0n);
const byTime = (actions: IndexedAction[]) => [...actions].sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
const isTransfer = (action: IndexedAction) => action.category === "Transfer" && lower(action.addressA) !== ZERO_ADDRESS && Boolean(action.addressB);

/** Rate and holder over time, from the stream's start to now (open-ended last piece). */
export function segments(stream: IndexedStream): Segment[] {
  const actions = byTime(stream.actions);
  const create = actions.find((action) => action.category === "Create");
  const start = Number(stream.startTime);
  let rate = big(create?.amountA);
  let holder = lower(create?.addressB ?? stream.recipient);
  let since = start;
  const out: Segment[] = [];
  const cut = (at: number) => {
    const t = Math.max(at, start);
    if (t > since) out.push({ from: since, to: t, rate, holder });
    since = Math.max(since, t);
  };
  for (const action of actions) {
    const at = Number(action.timestamp);
    switch (action.category) {
      case "Adjust": cut(at); rate = big(action.amountB); break;
      case "Pause": case "Void": cut(at); rate = 0n; break;
      case "Restart": cut(at); rate = big(action.amountA); break;
      case "Transfer": if (isTransfer(action)) { cut(at); holder = lower(action.addressB); } break;
    }
  }
  out.push({ from: since, to: null, rate, holder });
  return out;
}

/** Who held the stream NFT (and so its pay) at time `at`. */
export function holderAt(stream: IndexedStream, at: number): string {
  let holder = lower(stream.actions.find((action) => action.category === "Create")?.addressB ?? stream.recipient);
  for (const action of byTime(stream.actions)) {
    if (Number(action.timestamp) > at) break;
    if (isTransfer(action)) holder = lower(action.addressB);
  }
  return holder;
}

/** Accrued pay in [from, to), scaled to 18 decimals; restricted to time `holder` held the stream when given. */
export function accruedScaled(pieces: Segment[], from: number, to: number, holder?: string): bigint {
  let total = 0n;
  for (const piece of pieces) {
    if (holder && piece.holder !== holder) continue;
    const a = Math.max(piece.from, from);
    const b = Math.min(piece.to ?? to, to);
    if (b > a) total += piece.rate * BigInt(b - a);
  }
  return total;
}

export function descaled(scaled: bigint, decimals: number): bigint {
  return scaled / 10n ** BigInt(18 - decimals);
}

/** Cumulative accrued (net of write-offs) and covered pay of a stream at time `t`, in token units. */
export function position(stream: IndexedStream, t: number, pieces = segments(stream)) {
  const decimals = Number(stream.asset.decimals);
  let funded = 0n;
  let writtenOff = 0n;
  for (const action of stream.actions) {
    if (Number(action.timestamp) > t) continue;
    if (action.category === "Deposit") funded += big(action.amountA);
    else if (action.category === "Refund") funded -= big(action.amountA);
    else if (action.category === "Void") writtenOff += big(action.amountB);
  }
  let accrued = descaled(accruedScaled(pieces, 0, t), decimals) - writtenOff;
  if (accrued < 0n) accrued = 0n;
  const covered = funded < accrued ? (funded > 0n ? funded : 0n) : accrued;
  return { accrued, covered };
}

/** The [from, to) stretches of a period during which `holder` held the stream. */
function heldIntervals(pieces: Segment[], holder: string, from: number, to: number): [number, number][] {
  const out: [number, number][] = [];
  for (const piece of pieces) {
    if (piece.holder !== holder) continue;
    const a = Math.max(piece.from, from);
    const b = Math.min(piece.to ?? to, to);
    if (b <= a) continue;
    const last = out[out.length - 1];
    if (last && last[1] === a) last[1] = b;
    else out.push([a, b]);
  }
  return out;
}

/**
 * One stream's lines for `address` over [from, to): an income line if the address held the stream at any
 * point, a spending line if it is the sender. A self-stream yields both.
 */
export function streamLines(stream: IndexedStream, address: string, from: number, to: number, upfront: Upfront | null = null): StreamLine[] {
  const me = lower(address);
  const paidNow = upfront && upfront.timestamp >= from && upfront.timestamp < to ? upfront : null;
  const upfrontEvent = paidNow ? [{ category: "Upfront", amount: paidNow.amount, timestamp: paidNow.timestamp, hash: paidNow.hash }] : [];
  const decimals = Number(stream.asset.decimals);
  const pieces = segments(stream);
  const inPeriod = (action: IndexedAction) => Number(action.timestamp) >= from && Number(action.timestamp) < to;
  const base = { stream_id: stream.tokenId, token: tokenLabel(stream.asset.address, stream.asset.symbol), token_address: lower(stream.asset.address), decimals };
  const at = (t: number) => position(stream, t, pieces);
  const sum = (actions: IndexedAction[], category: string) => actions.filter((a) => a.category === category).reduce((total, a) => total + big(a.amountA), 0n);
  const event = (action: IndexedAction) => ({
    category: action.category,
    amount: ["Deposit", "Withdraw", "Refund"].includes(action.category) ? big(action.amountA) : null,
    timestamp: Number(action.timestamp),
    hash: action.hash,
  });
  const lines: StreamLine[] = [];

  if (pieces.some((piece) => piece.holder === me)) {
    let covered = 0n;
    let accrued = 0n;
    for (const [a, b] of heldIntervals(pieces, me, from, to)) {
      const start = at(a), end = at(b);
      covered += end.covered - start.covered;
      accrued += end.accrued - start.accrued;
    }
    const actions = stream.actions.filter((action) => inPeriod(action) && holderAt(stream, Number(action.timestamp)) === me);
    const mine = paidNow && holderAt(stream, paidNow.timestamp) === me;
    lines.push({
      ...base, side: "income", counterparty: lower(stream.sender),
      covered, unfunded: accrued > covered ? accrued - covered : 0n, upfront: mine ? paidNow.amount : 0n,
      withdrawn: sum(actions, "Withdraw"), deposited: 0n, refunded: 0n,
      events: [...actions.map(event), ...(mine ? upfrontEvent : [])],
    });
  }
  if (lower(stream.sender) === me) {
    const start = at(from), end = at(to);
    const covered = end.covered - start.covered;
    const accrued = end.accrued - start.accrued;
    const actions = stream.actions.filter(inPeriod);
    lines.push({
      ...base, side: "spending", counterparty: holderAt(stream, to),
      covered, unfunded: accrued > covered ? accrued - covered : 0n, upfront: paidNow?.amount ?? 0n,
      withdrawn: sum(actions, "Withdraw"), deposited: sum(actions, "Deposit"), refunded: sum(actions, "Refund"),
      events: [...actions.map(event), ...upfrontEvent],
    });
  }
  return lines;
}

/**
 * Sums lines per token, keyed by the token's display label. Grouping is by token address, so two different
 * tokens never merge; should two labels ever collide, the full address is used for the later one.
 */
export function totals(lines: StreamLine[]): Record<string, Totals> {
  const byAddress = new Map<string, Totals & { label: string }>();
  for (const line of lines) {
    let row = byAddress.get(line.token_address);
    if (!row) byAddress.set(line.token_address, row = { label: line.token, covered: 0n, unfunded: 0n, upfront: 0n, withdrawn: 0n, deposited: 0n, refunded: 0n, decimals: line.decimals });
    row.covered += line.covered;
    row.unfunded += line.unfunded;
    row.upfront += line.upfront;
    row.withdrawn += line.withdrawn;
    row.deposited += line.deposited;
    row.refunded += line.refunded;
  }
  const out: Record<string, Totals> = Object.create(null);
  for (const [address, { label, ...row }] of byAddress) out[label in out ? address : label] = row;
  return out;
}

/** UTC bounds of a calendar month "YYYY-MM": [start, start of next month). */
export function monthBounds(month: string): { from: number; to: number } {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!match) throw new Error("month must look like 2026-10");
  const year = Number(match[1]);
  const index = Number(match[2]) - 1;
  return { from: Date.UTC(year, index, 1) / 1000, to: Date.UTC(year, index + 1, 1) / 1000 };
}

export function currentMonth(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}
