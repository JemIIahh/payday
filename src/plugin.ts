import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { encodeFunctionData, getAddress, type Address, type Hex } from "viem";
import * as z from "zod/v4";
import { atomicAmount } from "./paybox.js";
import {
  FLOW, PERIODS, UserError, addressSchema, amountSchema, approvalIfNeeded, checksum, client, describeStream, descale,
  display, duration, flowAbi, iso, perPeriod, periodSchema, propose, proposalOutputSchema, ratePerSecond, readStream,
  readStreams, requireSender, resolveToken, sablierUrl, streamIdSchema, streamSummarySchema, tokenSchema, tokenSymbols,
  type Period, type Token,
} from "./flow.js";

const NAME = "payday";
const PROTOCOL_VERSION = "2026-07-28";

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const proposes = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

type ToolResult = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

/** Turns expected failures into readable tool errors instead of protocol errors. */
function guarded<A>(handler: (args: A) => Promise<ToolResult>) {
  return async (args: A): Promise<ToolResult> => {
    try {
      return await handler(args);
    } catch (error) {
      const text = error instanceof UserError
        ? error.message
        : "Base did not answer in time or rejected the read. Nothing was proposed; try again in a moment.";
      if (!(error instanceof UserError)) console.error(error instanceof Error ? error.message : String(error));
      return { content: [{ type: "text", text }], isError: true };
    }
  };
}

function data(text: string, structuredContent: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], structuredContent };
}

/** Funding for a new stream: an explicit deposit, or enough for `runway_days`, defaulting to one period. */
function initialDeposit(rate: bigint, token: Token, period: Period, deposit?: string, runwayDays?: number): bigint {
  if (deposit !== undefined && runwayDays !== undefined) throw new UserError("Give either deposit or runway_days, not both.");
  if (deposit !== undefined) return BigInt(atomicAmount(deposit, token.decimals));
  const seconds = runwayDays !== undefined ? Math.round(runwayDays * 86_400) : PERIODS[period];
  return descale(rate * BigInt(seconds), token.decimals, "nearest");
}

function startTime(startAt?: string): number {
  if (startAt === undefined) return 0;
  const seconds = Math.floor(Date.parse(startAt) / 1000);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(seconds)) throw new UserError("start_at must be an ISO 8601 date-time.");
  if (seconds <= now + 300) return 0;
  if (seconds > now + 366 * 86_400) throw new UserError("start_at must be within a year.");
  return seconds;
}

function runwayText(deposit: bigint, rate: bigint, decimals: number): string {
  return duration(Number((deposit * 10n ** BigInt(18 - decimals)) / rate));
}

const runwayDaysSchema = z.number().positive().max(3_650).describe("Fund this many days of streaming up front.");

function createServer() {
  const server = new McpServer({ name: NAME, version: "0.1.0" }, { supportedProtocolVersions: [PROTOCOL_VERSION] });

  server.registerTool("plan_stream", {
    title: "Plan a payment stream",
    description: "Converts a salary, allowance, rent or retainer (amount per period) into a Sablier per-second rate, shows what it pays per hour/day/week/month/year, and how much to deposit for a given runway. Read-only.",
    inputSchema: z.object({
      amount: amountSchema.describe("Amount paid per period, e.g. \"3000\"."),
      per: periodSchema,
      token: tokenSchema,
      runway_days: runwayDaysSchema.optional(),
    }).strict(),
    outputSchema: z.object({
      token: z.string(),
      rate_per_second_scaled: z.string(),
      pays: z.object({ hour: z.string(), day: z.string(), week: z.string(), month: z.string(), year: z.string() }).strict(),
      runway_days: z.number(),
      deposit_for_runway: z.string(),
    }).strict(),
    annotations: readOnly,
  }, guarded(async ({ amount, per, token, runway_days }) => {
    const resolved = await resolveToken(token);
    const rate = ratePerSecond(amount, per);
    const days = runway_days ?? PERIODS[per] / 86_400;
    const deposit = descale(rate * BigInt(Math.round(days * 86_400)), resolved.decimals, "nearest");
    const pays = perPeriod(rate, resolved.decimals);
    return data(
      `${amount} ${resolved.symbol} per ${per} streams ${pays.day} ${resolved.symbol}/day (${pays.hour}/hour). Funding ${days} days needs ${display(deposit, resolved.decimals)} ${resolved.symbol}.`,
      { token: resolved.symbol, rate_per_second_scaled: rate.toString(), pays, runway_days: days, deposit_for_runway: display(deposit, resolved.decimals) },
    );
  }));

  server.registerTool("start_stream", {
    title: "Start a payment stream",
    description: "Pays someone continuously, by the second, through Sablier Flow on Base (e.g. 3000 USDC per month). If Sablier cannot yet pull the deposit, returns an exact-amount approval first; call again after it confirms. sender is the public address of the PayBox wallet that pays.",
    inputSchema: z.object({
      sender: addressSchema.describe("Public address of the paying PayBox wallet."),
      recipient: addressSchema,
      amount: amountSchema.describe("Amount paid per period, e.g. \"3000\"."),
      per: periodSchema,
      token: tokenSchema,
      deposit: amountSchema.optional().describe("Tokens to fund now. Defaults to one period's worth."),
      runway_days: runwayDaysSchema.optional(),
      start_at: z.string().max(40).optional().describe("Optional ISO 8601 start time; defaults to now."),
      transferable: z.boolean().default(true).describe("Whether the recipient may transfer the stream NFT."),
    }).strict(),
    outputSchema: proposalOutputSchema,
    annotations: proposes,
  }, guarded(async (args) => {
    const sender = checksum(args.sender, "sender");
    const recipient = checksum(args.recipient, "recipient");
    if (sender === recipient) throw new UserError("sender and recipient must be different.");
    const token = await resolveToken(args.token);
    const rate = ratePerSecond(args.amount, args.per);
    const deposit = initialDeposit(rate, token, args.per, args.deposit, args.runway_days);
    const start = startTime(args.start_at);
    const approval = await approvalIfNeeded(sender, token, deposit, "start_stream");
    if (approval) return approval;
    const pays = perPeriod(rate, token.decimals);
    return propose({
      to: FLOW,
      data: encodeFunctionData({ abi: flowAbi, functionName: "createAndDeposit", args: [sender, recipient, rate, start, token.address, args.transferable, deposit] }),
      step: "create_stream",
      summary: `Stream ${args.amount} ${token.symbol} per ${args.per} (${pays.day}/day) from ${sender} to ${recipient}, funded with ${display(deposit, token.decimals)} ${token.symbol} (about ${runwayText(deposit, rate, token.decimals)} of runway)${start ? `, starting ${iso(start)}` : ", starting now"}. The recipient can withdraw what has accrued at any time; you can pause, top up, change the rate or end it.`,
      details: { token: token.symbol, rate_per_second_scaled: rate.toString(), per_month: pays.month, deposit: display(deposit, token.decimals), runway: runwayText(deposit, rate, token.decimals), contract: FLOW },
    });
  }));

  server.registerTool("start_payroll", {
    title: "Start payroll streams",
    description: "Starts per-second pay streams for up to 25 people in ONE transaction (one PayBox approval) via Sablier Flow batch on Base. Each person gets their own stream funded for the same runway. Returns a single exact-amount approval first if needed.",
    inputSchema: z.object({
      sender: addressSchema.describe("Public address of the paying PayBox wallet."),
      per: periodSchema,
      token: tokenSchema,
      runway_days: runwayDaysSchema.optional().describe("Days of pay to fund for everyone. Defaults to one period."),
      payees: z.array(z.object({
        recipient: addressSchema,
        amount: amountSchema.describe("Amount per period for this person."),
        label: z.string().max(40).optional(),
      }).strict()).min(1).max(25),
    }).strict(),
    outputSchema: proposalOutputSchema,
    annotations: proposes,
  }, guarded(async (args) => {
    const sender = checksum(args.sender, "sender");
    const token = await resolveToken(args.token);
    const seen = new Set<Address>();
    const rows = args.payees.map((payee, index) => {
      const recipient = checksum(payee.recipient, `payees[${index}].recipient`);
      if (recipient === sender) throw new UserError(`payees[${index}] is the sender.`);
      if (seen.has(recipient)) throw new UserError(`${recipient} appears twice in payees.`);
      seen.add(recipient);
      const rate = ratePerSecond(payee.amount, args.per);
      return { recipient, rate, label: payee.label ?? recipient.slice(0, 8), amount: payee.amount, deposit: initialDeposit(rate, token, args.per, undefined, args.runway_days) };
    });
    const total = rows.reduce((sum, row) => sum + row.deposit, 0n);
    const approval = await approvalIfNeeded(sender, token, total, "start_payroll");
    if (approval) return approval;
    const calls = rows.map((row) => encodeFunctionData({ abi: flowAbi, functionName: "createAndDeposit", args: [sender, row.recipient, row.rate, 0, token.address, true, row.deposit] }));
    const monthly = rows.reduce((sum, row) => sum + descale(row.rate * BigInt(PERIODS.month), token.decimals), 0n);
    const runway = args.runway_days ?? PERIODS[args.per] / 86_400;
    return propose({
      to: FLOW,
      data: encodeFunctionData({ abi: flowAbi, functionName: "batch", args: [calls] }),
      step: "create_payroll",
      summary: `Start ${rows.length} pay streams in one transaction: ${rows.map((row) => `${row.label} ${row.amount} ${token.symbol}/${args.per}`).join(", ")}. Total deposit ${display(total, token.decimals)} ${token.symbol} funds ${runway} days; payroll burn is ${display(monthly, token.decimals)} ${token.symbol} per 30 days.`,
      details: { token: token.symbol, streams: rows.length.toString(), total_deposit: display(total, token.decimals), monthly_burn: display(monthly, token.decimals), runway_days: runway.toString(), contract: FLOW },
    });
  }));

  server.registerTool("stream_status", {
    title: "Check payment streams",
    description: "Live state of up to 25 Sablier Flow streams on Base: status, rate, balance, what the recipient can withdraw now, what the sender could reclaim, unpaid debt and when funds run out.",
    inputSchema: z.object({ stream_ids: z.array(streamIdSchema).min(1).max(25) }).strict(),
    outputSchema: z.object({ streams: z.array(streamSummarySchema), missing: z.array(z.string()) }).strict(),
    annotations: readOnly,
  }, guarded(async ({ stream_ids }) => {
    const ids = [...new Set(stream_ids)].map((id) => BigInt(id));
    const streams = await readStreams(ids);
    const symbols = await tokenSymbols([...streams.values()].map((stream) => stream.token));
    const rows = [...streams.values()].map((stream) => describeStream(stream, symbols.get(getAddress(stream.token)) ?? "TOKEN"));
    const missing = ids.filter((id) => !streams.has(id)).map(String);
    const text = rows.map((row) => `#${row.stream_id} ${row.status}: ${row.rate.month} ${row.token}/month to ${row.recipient}; withdrawable ${row.withdrawable_now}, balance ${row.balance}, runway ${row.runway}.`).join("\n") || "No streams found.";
    return data(missing.length ? `${text}\nNot found: ${missing.join(", ")}` : text, { streams: rows, missing });
  }));

  server.registerTool("list_streams", {
    title: "Payroll and income overview",
    description: "Finds the Sablier Flow streams on Base that an address pays or receives, then summarises monthly outflow and inflow per token, the earliest run-out date, and streams that need a top-up. Scans the most recent streams (default 2000).",
    inputSchema: z.object({
      address: addressSchema,
      role: z.enum(["any", "sender", "recipient"]).default("any"),
      scan: z.number().int().min(1).max(5_000).default(2_000).describe("How many of the most recent stream IDs to scan."),
    }).strict(),
    outputSchema: z.object({
      address: z.string(),
      scanned_ids: z.string(),
      outgoing: z.array(streamSummarySchema),
      incoming: z.array(streamSummarySchema),
      monthly_out: z.record(z.string(), z.string()),
      monthly_in: z.record(z.string(), z.string()),
      needs_attention: z.array(z.object({ stream_id: z.string(), reason: z.string() }).strict()),
    }).strict(),
    annotations: readOnly,
  }, guarded(async ({ address, role, scan }) => {
    const owner = checksum(address, "address");
    const next = await client.readContract({ address: FLOW, abi: flowAbi, functionName: "nextStreamId" });
    const ids: bigint[] = [];
    for (let id = next - 1n; id >= 1n && ids.length < scan; id--) ids.push(id);
    const parties = await client.multicall({
      contracts: ids.flatMap((id) => [
        { address: FLOW, abi: flowAbi, functionName: "getSender", args: [id] } as const,
        { address: FLOW, abi: flowAbi, functionName: "getRecipient", args: [id] } as const,
      ]),
      allowFailure: true,
    });
    const matches = ids.filter((_, index) => {
      const sender = parties[index * 2];
      const recipient = parties[index * 2 + 1];
      const pays = sender?.status === "success" && getAddress(sender.result as Address) === owner;
      const gets = recipient?.status === "success" && getAddress(recipient.result as Address) === owner;
      return role === "sender" ? pays : role === "recipient" ? gets : pays || gets;
    }).slice(0, 25);
    const streams = [...(await readStreams(matches)).values()];
    const symbols = await tokenSymbols(streams.map((stream) => stream.token));
    const now = Math.floor(Date.now() / 1000);
    const monthlyOut: Record<string, bigint> = {};
    const monthlyIn: Record<string, bigint> = {};
    const decimalsFor: Record<string, number> = {};
    const needsAttention: { stream_id: string; reason: string }[] = [];
    const outgoing = [];
    const incoming = [];
    for (const stream of streams) {
      const symbol = symbols.get(getAddress(stream.token)) ?? "TOKEN";
      const row = describeStream(stream, symbol, now);
      const monthly = stream.status === "streaming" || stream.status === "streaming_insolvent" ? descale(stream.rate * BigInt(PERIODS.month), stream.decimals) : 0n;
      decimalsFor[symbol] = stream.decimals;
      if (stream.sender === owner) {
        outgoing.push(row);
        monthlyOut[symbol] = (monthlyOut[symbol] ?? 0n) + monthly;
        if (stream.status === "streaming_insolvent" || stream.status === "paused_insolvent") needsAttention.push({ stream_id: row.stream_id, reason: `out of funds; owes ${row.unpaid_debt} ${symbol} it cannot pay` });
        else if (stream.status === "streaming" && stream.depletionTime && Number(stream.depletionTime) - now < 7 * 86_400) needsAttention.push({ stream_id: row.stream_id, reason: `runs out in ${row.runway}` });
      }
      if (stream.recipient === owner) {
        incoming.push(row);
        monthlyIn[symbol] = (monthlyIn[symbol] ?? 0n) + monthly;
      }
    }
    const fmt = (totals: Record<string, bigint>) => Object.fromEntries(Object.entries(totals).map(([symbol, value]) => [symbol, display(value, decimalsFor[symbol] ?? 18)]));
    const scanned = ids.length ? `${ids[ids.length - 1]}-${ids[0]}` : "none";
    const out = fmt(monthlyOut);
    const inn = fmt(monthlyIn);
    const text = [
      `${owner}: pays ${outgoing.length} stream(s), receives ${incoming.length}.`,
      Object.keys(out).length ? `Monthly outflow: ${Object.entries(out).map(([s, v]) => `${v} ${s}`).join(", ")}.` : "",
      Object.keys(inn).length ? `Monthly inflow: ${Object.entries(inn).map(([s, v]) => `${v} ${s}`).join(", ")}.` : "",
      needsAttention.length ? `Needs attention: ${needsAttention.map((item) => `#${item.stream_id} ${item.reason}`).join("; ")}.` : "",
    ].filter(Boolean).join("\n");
    return data(text, { address: owner, scanned_ids: scanned, outgoing, incoming, monthly_out: out, monthly_in: inn, needs_attention: needsAttention });
  }));

  server.registerTool("top_up_stream", {
    title: "Top up a payment stream",
    description: "Adds funds to a Sablier Flow stream on Base, either a fixed amount or enough to cover unpaid debt plus runway_days of future pay. Anyone can fund a stream. Returns an exact-amount approval first if needed.",
    inputSchema: z.object({
      stream_id: streamIdSchema,
      funder: addressSchema.describe("Public address of the PayBox wallet that pays."),
      amount: amountSchema.optional(),
      runway_days: runwayDaysSchema.optional(),
    }).strict(),
    outputSchema: proposalOutputSchema,
    annotations: proposes,
  }, guarded(async (args) => {
    const funder = checksum(args.funder, "funder");
    const stream = await readStream(args.stream_id);
    if (stream.status === "voided") throw new UserError(`Stream ${args.stream_id} is voided and cannot be funded.`);
    if ((args.amount === undefined) === (args.runway_days === undefined)) throw new UserError("Give exactly one of amount or runway_days.");
    const [symbols] = await Promise.all([tokenSymbols([stream.token])]);
    const token: Token = { address: stream.token, decimals: stream.decimals, symbol: symbols.get(getAddress(stream.token)) ?? "TOKEN" };
    let amount: bigint;
    if (args.amount !== undefined) {
      amount = BigInt(atomicAmount(args.amount, token.decimals));
    } else {
      const target = stream.totalDebt + descale(stream.rate * BigInt(Math.round(args.runway_days! * 86_400)), token.decimals, "up");
      amount = target > stream.balance ? target - stream.balance : 0n;
      if (amount === 0n) throw new UserError(`Stream ${args.stream_id} is already funded beyond ${args.runway_days} days (runway ${describeStream(stream, token.symbol).runway}).`);
    }
    if (amount === 0n) throw new UserError("amount must be greater than zero.");
    const headroom = args.runway_days !== undefined ? descale(stream.rate * 3_600n, token.decimals, "up") : 0n;
    const approval = await approvalIfNeeded(funder, token, amount, "top_up_stream", headroom);
    if (approval) return approval;
    const after = { ...stream, balance: stream.balance + amount };
    const runway = stream.rate > 0n && after.balance > stream.totalDebt ? runwayText(after.balance - stream.totalDebt, stream.rate, token.decimals) : "n/a (not streaming)";
    return propose({
      to: FLOW,
      data: encodeFunctionData({ abi: flowAbi, functionName: "deposit", args: [stream.id, amount, stream.sender, stream.recipient] }),
      step: "deposit",
      summary: `Add ${display(amount, token.decimals)} ${token.symbol} to stream #${stream.id} (${stream.sender} → ${stream.recipient}).${stream.uncoveredDebt > 0n ? ` This first clears ${display(stream.uncoveredDebt, token.decimals)} ${token.symbol} of unpaid debt.` : ""} Runway afterwards: about ${runway}.`,
      details: { stream_id: stream.id.toString(), token: token.symbol, amount: display(amount, token.decimals), runway_after: runway, sablier_url: sablierUrl(stream.id) },
    });
  }));

  server.registerTool("pause_stream", {
    title: "Pause a payment stream",
    description: "Stops a Sablier Flow stream from accruing further pay. The recipient keeps everything already earned. Only the stream's sender can pause.",
    inputSchema: z.object({ stream_id: streamIdSchema, sender: addressSchema }).strict(),
    outputSchema: proposalOutputSchema,
    annotations: proposes,
  }, guarded(async (args) => {
    const sender = checksum(args.sender, "sender");
    const stream = await readStream(args.stream_id);
    requireSender(stream, sender);
    if (stream.status !== "streaming" && stream.status !== "streaming_insolvent") throw new UserError(`Stream ${args.stream_id} is ${stream.status}, not streaming.`);
    const symbol = (await tokenSymbols([stream.token])).get(getAddress(stream.token)) ?? "TOKEN";
    return propose({
      to: FLOW,
      data: encodeFunctionData({ abi: flowAbi, functionName: "pause", args: [stream.id] }),
      step: "pause",
      summary: `Pause stream #${stream.id} to ${stream.recipient}. They keep the ${display(stream.totalDebt, stream.decimals)} ${symbol} earned so far; ${display(stream.balance, stream.decimals)} ${symbol} stays in the stream until you resume, top up or end it.`,
      details: { stream_id: stream.id.toString(), earned: display(stream.totalDebt, stream.decimals), balance: display(stream.balance, stream.decimals) },
    });
  }));

  server.registerTool("resume_stream", {
    title: "Resume a paused stream",
    description: "Restarts a paused Sablier Flow stream at a new or the same rate (amount per period). Only the sender can resume.",
    inputSchema: z.object({ stream_id: streamIdSchema, sender: addressSchema, amount: amountSchema, per: periodSchema }).strict(),
    outputSchema: proposalOutputSchema,
    annotations: proposes,
  }, guarded(async (args) => {
    const sender = checksum(args.sender, "sender");
    const stream = await readStream(args.stream_id);
    requireSender(stream, sender);
    if (stream.status !== "paused" && stream.status !== "paused_insolvent") throw new UserError(`Stream ${args.stream_id} is ${stream.status}, not paused.`);
    const rate = ratePerSecond(args.amount, args.per);
    const symbol = (await tokenSymbols([stream.token])).get(getAddress(stream.token)) ?? "TOKEN";
    const runway = stream.balance > stream.totalDebt ? runwayText(stream.balance - stream.totalDebt, rate, stream.decimals) : "none: top up first or it accrues unpaid debt";
    return propose({
      to: FLOW,
      data: encodeFunctionData({ abi: flowAbi, functionName: "restart", args: [stream.id, rate] }),
      step: "resume",
      summary: `Resume stream #${stream.id} at ${args.amount} ${symbol} per ${args.per}. Current funds cover about ${runway}.`,
      details: { stream_id: stream.id.toString(), per_month: perPeriod(rate, stream.decimals).month, runway },
    });
  }));

  server.registerTool("change_stream_rate", {
    title: "Change a stream's pay rate",
    description: "Raises or lowers the rate of a running Sablier Flow stream (amount per period). Pay earned so far is locked in at the old rate. Only the sender can change it.",
    inputSchema: z.object({ stream_id: streamIdSchema, sender: addressSchema, amount: amountSchema, per: periodSchema }).strict(),
    outputSchema: proposalOutputSchema,
    annotations: proposes,
  }, guarded(async (args) => {
    const sender = checksum(args.sender, "sender");
    const stream = await readStream(args.stream_id);
    requireSender(stream, sender);
    if (stream.status !== "streaming" && stream.status !== "streaming_insolvent") throw new UserError(`Stream ${args.stream_id} is ${stream.status}; resume it instead.`);
    const rate = ratePerSecond(args.amount, args.per);
    if (rate === stream.rate) throw new UserError("That is already the stream's rate.");
    const symbol = (await tokenSymbols([stream.token])).get(getAddress(stream.token)) ?? "TOKEN";
    const before = perPeriod(stream.rate, stream.decimals).month;
    const after = perPeriod(rate, stream.decimals).month;
    return propose({
      to: FLOW,
      data: encodeFunctionData({ abi: flowAbi, functionName: "adjustRatePerSecond", args: [stream.id, rate] }),
      step: "change_rate",
      summary: `Change stream #${stream.id} from ${before} to ${after} ${symbol} per 30 days. The ${display(stream.totalDebt, stream.decimals)} ${symbol} already earned is unaffected.`,
      details: { stream_id: stream.id.toString(), per_month_before: before, per_month_after: after },
    });
  }));

  server.registerTool("end_stream", {
    title: "End a payment stream",
    description: "Pauses a Sablier Flow stream and returns every unearned token to the sender in one transaction. The recipient keeps, and can still withdraw, everything earned up to that moment. Only the sender can end it.",
    inputSchema: z.object({ stream_id: streamIdSchema, sender: addressSchema }).strict(),
    outputSchema: proposalOutputSchema,
    annotations: { ...proposes, destructiveHint: true },
  }, guarded(async (args) => {
    const sender = checksum(args.sender, "sender");
    const stream = await readStream(args.stream_id);
    requireSender(stream, sender);
    if (stream.status === "voided") throw new UserError(`Stream ${args.stream_id} is already voided.`);
    const streaming = stream.status === "streaming" || stream.status === "streaming_insolvent";
    if (!streaming && stream.refundable === 0n) throw new UserError(`Stream ${args.stream_id} is already paused with nothing left to refund.`);
    const calls: Hex[] = [];
    if (streaming) calls.push(encodeFunctionData({ abi: flowAbi, functionName: "pause", args: [stream.id] }));
    if (stream.refundable > 0n) calls.push(encodeFunctionData({ abi: flowAbi, functionName: "refundMax", args: [stream.id] }));
    const symbol = (await tokenSymbols([stream.token])).get(getAddress(stream.token)) ?? "TOKEN";
    return propose({
      to: FLOW,
      data: calls.length === 1 ? calls[0]! : encodeFunctionData({ abi: flowAbi, functionName: "batch", args: [calls] }),
      step: "end",
      summary: `End stream #${stream.id}: stop pay to ${stream.recipient} and return about ${display(stream.refundable, stream.decimals)} ${symbol} of unearned funds to ${sender} (slightly less if it confirms later). The recipient keeps ${display(stream.totalDebt, stream.decimals)} ${symbol} already earned.`,
      details: { stream_id: stream.id.toString(), refund_estimate: display(stream.refundable, stream.decimals), recipient_keeps: display(stream.totalDebt, stream.decimals) },
    });
  }));

  server.registerTool("withdraw_from_stream", {
    title: "Withdraw earned pay",
    description: "Sends everything a Sablier Flow stream's recipient has earned so far to the recipient's address. Anyone can trigger it; funds always go to the recipient. Includes Sablier's current withdrawal fee in ETH, if any.",
    inputSchema: z.object({ stream_id: streamIdSchema }).strict(),
    outputSchema: proposalOutputSchema,
    annotations: proposes,
  }, guarded(async ({ stream_id }) => {
    const stream = await readStream(stream_id);
    if (stream.withdrawable === 0n) throw new UserError(`Nothing to withdraw from stream ${stream_id} yet.`);
    const [fee, symbols] = await Promise.all([
      client.readContract({ address: FLOW, abi: flowAbi, functionName: "calculateMinFeeWei", args: [stream.id] }),
      tokenSymbols([stream.token]),
    ]);
    const symbol = symbols.get(getAddress(stream.token)) ?? "TOKEN";
    return propose({
      to: FLOW,
      value: fee,
      data: encodeFunctionData({ abi: flowAbi, functionName: "withdrawMax", args: [stream.id, stream.recipient] }),
      step: "withdraw",
      summary: `Withdraw at least ${display(stream.withdrawable, stream.decimals)} ${symbol} earned on stream #${stream.id} to ${stream.recipient}${fee > 0n ? `, paying Sablier's ${display(fee, 18)} ETH fee` : ""}.`,
      details: { stream_id: stream.id.toString(), withdrawable: display(stream.withdrawable, stream.decimals), fee_eth: display(fee, 18), to: stream.recipient },
    });
  }));

  return server;
}

serveStdio(createServer, { legacy: "reject" });
