// Statement math shared by the plugin (payment_statement) and the dashboard (payslips).
// Pure functions over Sablier's indexed stream history: no network, no viem, so both bundles import it.
//
// A Flow stream's rate is piecewise constant. It is set on Create, changed by Adjust, zeroed by Pause and
// Void, and set again by Restart. What accrues between two times is the sum of rate x seconds over the
// pieces in between, in Sablier's 18-decimal fixed point, then descaled to the token's decimals.
// Transfer moves the stream NFT, and with it the right to everything that accrues afterwards.

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
  accrued: bigint;
  written_off: bigint;
  withdrawn: bigint;
  deposited: bigint;
  refunded: bigint;
  events: { category: string; amount: bigint | null; timestamp: number; hash: string }[];
};

export type Totals = { accrued: bigint; withdrawn: bigint; deposited: bigint; refunded: bigint; written_off: bigint; decimals: number };

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const lower = (value: string | null | undefined) => (value ?? "").toLowerCase();
const big = (value: string | null | undefined) => (value ? BigInt(value) : 0n);

/** Rate and holder over time, from the stream's start to now (open-ended last piece). */
export function segments(stream: IndexedStream): Segment[] {
  const actions = [...stream.actions].sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
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
      case "Transfer":
        if (lower(action.addressA) === ZERO_ADDRESS || !action.addressB) break;
        cut(at); holder = lower(action.addressB); break;
    }
  }
  out.push({ from: since, to: null, rate, holder });
  return out;
}

/** Who held the stream NFT (and so its pay) at time `at`. */
export function holderAt(stream: IndexedStream, at: number): string {
  let holder = lower(stream.actions.find((action) => action.category === "Create")?.addressB ?? stream.recipient);
  for (const action of [...stream.actions].sort((a, b) => Number(a.timestamp) - Number(b.timestamp))) {
    if (Number(action.timestamp) > at) break;
    if (action.category === "Transfer" && lower(action.addressA) !== ZERO_ADDRESS && action.addressB) holder = lower(action.addressB);
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

/**
 * One stream's lines for `address` over [from, to): an income line if the address held the stream at any
 * point, a spending line if it is the sender. A self-stream yields both.
 */
export function streamLines(stream: IndexedStream, address: string, from: number, to: number): StreamLine[] {
  const me = lower(address);
  const decimals = Number(stream.asset.decimals);
  const pieces = segments(stream);
  const inPeriod = (action: IndexedAction) => Number(action.timestamp) >= from && Number(action.timestamp) < to;
  const base = { stream_id: stream.tokenId, token: stream.asset.symbol, token_address: lower(stream.asset.address), decimals };
  const lines: StreamLine[] = [];
  const event = (action: IndexedAction) => ({
    category: action.category,
    amount: ["Deposit", "Withdraw", "Refund"].includes(action.category) ? big(action.amountA) : null,
    timestamp: Number(action.timestamp),
    hash: action.hash,
  });

  const held = pieces.some((piece) => piece.holder === me);
  if (held) {
    const mine = (action: IndexedAction) => holderAt(stream, Number(action.timestamp)) === me;
    const actions = stream.actions.filter((action) => inPeriod(action) && mine(action));
    lines.push({
      ...base,
      side: "income",
      counterparty: lower(stream.sender),
      accrued: descaled(accruedScaled(pieces, from, to, me), decimals),
      written_off: actions.filter((a) => a.category === "Void").reduce((sum, a) => sum + big(a.amountB), 0n),
      withdrawn: actions.filter((a) => a.category === "Withdraw").reduce((sum, a) => sum + big(a.amountA), 0n),
      deposited: 0n,
      refunded: 0n,
      events: actions.map(event),
    });
  }
  if (lower(stream.sender) === me) {
    const actions = stream.actions.filter(inPeriod);
    lines.push({
      ...base,
      side: "spending",
      counterparty: holderAt(stream, to),
      accrued: descaled(accruedScaled(pieces, from, to), decimals),
      written_off: actions.filter((a) => a.category === "Void").reduce((sum, a) => sum + big(a.amountB), 0n),
      withdrawn: actions.filter((a) => a.category === "Withdraw").reduce((sum, a) => sum + big(a.amountA), 0n),
      deposited: actions.filter((a) => a.category === "Deposit").reduce((sum, a) => sum + big(a.amountA), 0n),
      refunded: actions.filter((a) => a.category === "Refund").reduce((sum, a) => sum + big(a.amountA), 0n),
      events: actions.map(event),
    });
  }
  return lines;
}

/** Sums lines per token symbol (decimals carried along for display). */
export function totals(lines: StreamLine[]): Record<string, Totals> {
  const out: Record<string, Totals> = {};
  for (const line of lines) {
    const row = out[line.token] ??= { accrued: 0n, withdrawn: 0n, deposited: 0n, refunded: 0n, written_off: 0n, decimals: line.decimals };
    row.accrued += line.accrued - line.written_off;
    row.withdrawn += line.withdrawn;
    row.deposited += line.deposited;
    row.refunded += line.refunded;
    row.written_off += line.written_off;
  }
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
