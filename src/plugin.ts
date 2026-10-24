import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { encodeFunctionData, getAddress, type Address, type Hex } from "viem";
import * as z from "zod/v4";
import { findStreams, pastRecipients } from "./discover.js";
import {
  FLOW, PERIODS, UserError, addressSchema, amountSchema, approvalIfNeeded, checksum, client, describeStream, descale,
  display, duration, flowAbi, flowCalls, foreignFundingWarning, fundingWarnings, iso, perPeriod, periodSchema, propose, proposalOutputSchema,
  ratePerSecond, readStream, readStreams, refuseContractRecipient, requireSender, resolveToken, sablierUrl,
  streamIdSchema, streamSummarySchema, symbolFor, tokenAmount, tokenSchema, tokenSymbols, walletFunds, type Period, type StreamState, type Token,
} from "./flow.js";
import { IndexerUnavailable, INDEXER_URL, indexedStreams, upfrontPayments } from "./indexer.js";
import { namesFor, partySchema, resolveParty, who } from "./names.js";
import { currentMonth, monthBounds, streamLines, totals, type StreamLine } from "./statement.js";

const NAME = "payday";
const VERSION = "0.2.1";
const PROTOCOL_VERSION = "2026-07-28";
// The companion dashboard: payslips, pay-me links and live counters. PAYDAY_SITE_URL overrides it.
const SITE = process.env.PAYDAY_SITE_URL ?? "https://jemiiahh.github.io/payday/";
const MONTH = BigInt(PERIODS.month);

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
  if (deposit !== undefined) return tokenAmount(deposit, token, "deposit");
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

function runwaySeconds(deposit: bigint, rate: bigint, decimals: number): number {
  return Number((deposit * 10n ** BigInt(18 - decimals)) / rate);
}

function runwayText(deposit: bigint, rate: bigint, decimals: number): string {
  return duration(runwaySeconds(deposit, rate, decimals));
}

function optionalAmount(amount: string | undefined, token: Token, label: string): bigint {
  if (amount === undefined) return 0n;
  const value = tokenAmount(amount, token, label);
  if (value === 0n) throw new UserError(`${label} must be greater than zero.`);
  return value;
}

// One transaction carries at most this many streams, to stay well inside PayBox's limits.
const MAX_BATCH = 25;

/** "… and 5 more" when a bulk tool had to leave some streams for a second call. */
function remainder(left: number, what: string): string {
  return left > 0 ? ` ${left} more ${what}; call again after this confirms.` : "";
}

/** A payee as the owner should see them before approving: their label, name and full address. */
function payee(label: string | undefined, address: Address, names: Map<Address, string>): string {
  const id = who(address, names);
  return label && label !== names.get(address) ? `${label}: ${id}` : id;
}

async function streamToken(stream: StreamState): Promise<Token> {
  const symbols = await tokenSymbols([stream.token]);
  return { address: stream.token, decimals: stream.decimals, symbol: symbols.get(getAddress(stream.token)) ?? "TOKEN" };
}

/** Funding a stream needs to cover what it owes now plus `days` more of pay. */
function shortfall(stream: StreamState, days: number): bigint {
  const target = stream.totalDebt + descale(stream.rate * BigInt(Math.round(days * 86_400)), stream.decimals, "up");
  return target > stream.balance ? target - stream.balance : 0n;
}

function newRecipientWarning(recipients: Address[], past: Set<Address>, names: Map<Address, string>): string[] {
  const fresh = recipients.filter((address) => !past.has(address));
  if (fresh.length === 0) return [];
  if (fresh.length === 1) return [`First Sablier stream from this wallet to ${who(fresh[0]!, names)}. Check the address is right.`];
  return [`First Sablier stream from this wallet to ${fresh.length} of these payees: ${fresh.map((address) => who(address, names)).join(", ")}. Check each address.`];
}

const runwayDaysSchema = z.number().positive().max(3_650).describe("Fund this many days of streaming up front.");
const payNowSchema = amountSchema.describe("Optional one-off amount paid immediately in the same transaction, e.g. a signing bonus, a deposit or back pay.");
const tokenTotalsSchema = z.record(z.string(), z.string());

function createServer() {
  const server = new McpServer({ name: NAME, version: VERSION }, { supportedProtocolVersions: [PROTOCOL_VERSION] });

  server.registerTool("plan_stream", {
    title: "Plan a payment stream",
    description: "Converts a salary, allowance, rent or retainer (amount per period) into a Sablier per-second rate, shows what it pays per hour/day/week/month/year, and how much to deposit for a given runway. Pass sender to also check affordability: the wallet's balance, what it already streams, and how long it can keep paying. Read-only.",
    inputSchema: z.object({
      amount: amountSchema.describe("Amount paid per period, e.g. \"3000\"."),
      per: periodSchema,
      token: tokenSchema,
      runway_days: runwayDaysSchema.optional(),
      sender: addressSchema.optional().describe("Public address of the paying PayBox wallet, to check affordability."),
    }).strict(),
    outputSchema: z.object({
      token: z.string(),
      rate_per_second_scaled: z.string(),
      pays: z.object({ hour: z.string(), day: z.string(), week: z.string(), month: z.string(), year: z.string() }).strict(),
      runway_days: z.number(),
      deposit_for_runway: z.string(),
      affordability: z.object({
        wallet_balance: z.string(),
        already_streaming_per_month: z.string(),
        per_month_with_this: z.string(),
        months_covered: z.string(),
      }).strict().nullable(),
    }).strict(),
    annotations: readOnly,
  }, guarded(async ({ amount, per, token, runway_days, sender }) => {
    const resolved = await resolveToken(token);
    const rate = ratePerSecond(amount, per);
    const days = runway_days ?? PERIODS[per] / 86_400;
    const deposit = descale(rate * BigInt(Math.round(days * 86_400)), resolved.decimals, "nearest");
    const pays = perPeriod(rate, resolved.decimals);
    let affordability = null;
    let afford = "";
    if (sender) {
      const owner = checksum(sender, "sender");
      const [funds, found] = await Promise.all([walletFunds(owner, resolved), findStreams(owner, "sender")]);
      const existing = found.streams
        .filter((stream) => stream.token === resolved.address && (stream.status === "streaming" || stream.status === "streaming_insolvent"))
        .reduce((sum, stream) => sum + descale(stream.rate * MONTH, resolved.decimals), 0n);
      const total = existing + descale(rate * MONTH, resolved.decimals);
      const months = total > 0n ? Number((funds.balance * 100n) / total) / 100 : 0;
      affordability = {
        wallet_balance: display(funds.balance, resolved.decimals),
        already_streaming_per_month: display(existing, resolved.decimals),
        per_month_with_this: display(total, resolved.decimals),
        months_covered: months.toFixed(2),
      };
      afford = ` The wallet holds ${display(funds.balance, resolved.decimals, 2)} ${resolved.symbol}${existing > 0n ? ` and already streams ${display(existing, resolved.decimals, 2)} ${resolved.symbol} per 30 days` : ""}; with this it would pay ${display(total, resolved.decimals, 2)} per 30 days, covered for about ${months.toFixed(1)} months.`;
    }
    return data(
      `${amount} ${resolved.symbol} per ${per} streams ${pays.day} ${resolved.symbol}/day (${pays.hour}/hour). Funding ${days} days needs ${display(deposit, resolved.decimals)} ${resolved.symbol}.${afford}`,
      { token: resolved.symbol, rate_per_second_scaled: rate.toString(), pays, runway_days: days, deposit_for_runway: display(deposit, resolved.decimals), affordability },
    );
  }));

  server.registerTool("start_stream", {
    title: "Start a payment stream",
    description: "Pays someone continuously, by the second, through Sablier Flow on Base (e.g. 3000 USDC per month). The recipient can be a 0x address or a Base name like name.base.eth. Optionally pays a one-off amount now in the same transaction (pay_now). If Sablier cannot yet pull the funds, returns an exact-amount approval first; call again after it confirms. sender is the public address of the PayBox wallet that pays. Relay any warnings to the owner.",
    inputSchema: z.object({
      sender: addressSchema.describe("Public address of the paying PayBox wallet (from PayBox list_credentials)."),
      recipient: partySchema,
      amount: amountSchema.describe("Amount paid per period, e.g. \"3000\"."),
      per: periodSchema,
      token: tokenSchema,
      deposit: amountSchema.optional().describe("Tokens to fund now. Defaults to one period's worth."),
      runway_days: runwayDaysSchema.optional(),
      pay_now: payNowSchema.optional(),
      start_at: z.string().max(40).optional().describe("Optional ISO 8601 start time; defaults to now."),
      transferable: z.boolean().default(true).describe("Whether the recipient may transfer the stream NFT."),
    }).strict(),
    outputSchema: proposalOutputSchema,
    annotations: proposes,
  }, guarded(async (args) => {
    const sender = checksum(args.sender, "sender");
    const [party, token] = await Promise.all([resolveParty(args.recipient, "recipient"), resolveToken(args.token)]);
    const recipient = party.address;
    if (sender === recipient) throw new UserError("sender and recipient must be different.");
    refuseContractRecipient(recipient, "recipient", token);
    const rate = ratePerSecond(args.amount, args.per);
    const deposit = initialDeposit(rate, token, args.per, args.deposit, args.runway_days);
    if (deposit === 0n) throw new UserError("The deposit rounds to zero; fund at least one token unit.");
    const payNow = optionalAmount(args.pay_now, token, "pay_now");
    const start = startTime(args.start_at);
    const [funds, reverse, past] = await Promise.all([walletFunds(sender, token), namesFor([recipient]), pastRecipients(sender)]);
    const names = party.name ? new Map([[recipient, party.name]]) : reverse;
    const monthly = descale(rate * MONTH, token.decimals);
    const warnings = [
      ...fundingWarnings({ token, balance: funds.balance, outlay: deposit + payNow, monthly, runwaySeconds: runwaySeconds(deposit, rate, token.decimals), per: args.per }),
      ...newRecipientWarning([recipient], past, names),
    ];
    const approval = await approvalIfNeeded(sender, token, deposit + payNow, "start_stream", 0n, warnings, funds);
    if (approval) return approval;
    const pays = perPeriod(rate, token.decimals);
    const calls: Hex[] = [encodeFunctionData({ abi: flowAbi, functionName: "createAndDeposit", args: [sender, recipient, rate, start, token.address, args.transferable, deposit] })];
    if (payNow > 0n) calls.push(encodeFunctionData({ abi: flowAbi, functionName: "transferTokens", args: [token.address, recipient, payNow] }));
    return propose({
      to: FLOW,
      data: flowCalls(calls),
      step: "create_stream",
      summary: `Stream ${args.amount} ${token.symbol} per ${args.per} (${pays.day}/day) from ${sender} to ${who(recipient, names)}, funded with ${display(deposit, token.decimals)} ${token.symbol} (about ${runwayText(deposit, rate, token.decimals)} of runway)${start ? `, starting ${iso(start)}` : ", starting now"}.${payNow > 0n ? ` Also pays ${display(payNow, token.decimals)} ${token.symbol} to them right away, in the same transaction.` : ""} The recipient can withdraw what has accrued at any time; you can pause, top up, change the rate or end it.`,
      details: { token: token.symbol, recipient, recipient_name: names.get(recipient) ?? "", rate_per_second_scaled: rate.toString(), per_month: pays.month, deposit: display(deposit, token.decimals), pay_now: display(payNow, token.decimals), runway: runwayText(deposit, rate, token.decimals), contract: FLOW },
      warnings,
      next: `Once PayBox confirms it, share ${SITE}?a=${recipient} with ${who(recipient, names)}: their pay counting up live, what is ready to withdraw, and monthly payslips.`,
    });
  }));

  server.registerTool("start_payroll", {
    title: "Start payroll streams",
    description: "Starts per-second pay streams for up to 25 people in ONE transaction (one PayBox approval) via Sablier Flow batch on Base. Each person gets their own stream funded for the same runway, and can also get a one-off amount now (pay_now). Recipients can be 0x addresses or Base names. Returns a single exact-amount approval first if needed. Relay any warnings to the owner.",
    inputSchema: z.object({
      sender: addressSchema.describe("Public address of the paying PayBox wallet (from PayBox list_credentials)."),
      per: periodSchema,
      token: tokenSchema,
      runway_days: runwayDaysSchema.optional().describe("Days of pay to fund for everyone. Defaults to one period."),
      payees: z.array(z.object({
        recipient: partySchema,
        amount: amountSchema.describe("Amount per period for this person."),
        label: z.string().max(40).optional(),
        pay_now: payNowSchema.optional(),
      }).strict()).min(1).max(25),
    }).strict(),
    outputSchema: proposalOutputSchema,
    annotations: proposes,
  }, guarded(async (args) => {
    const sender = checksum(args.sender, "sender");
    const [token, parties] = await Promise.all([
      resolveToken(args.token),
      Promise.all(args.payees.map((payee, index) => resolveParty(payee.recipient, `payees[${index}].recipient`))),
    ]);
    const seen = new Set<Address>();
    const rows = args.payees.map((payee, index) => {
      const { address: recipient, name } = parties[index]!;
      if (recipient === sender) throw new UserError(`payees[${index}] is the sender.`);
      refuseContractRecipient(recipient, `payees[${index}].recipient`, token);
      if (seen.has(recipient)) throw new UserError(`${name ?? recipient} appears twice in payees.`);
      seen.add(recipient);
      const rate = ratePerSecond(payee.amount, args.per);
      const deposit = initialDeposit(rate, token, args.per, undefined, args.runway_days);
      if (deposit === 0n) throw new UserError(`payees[${index}]'s deposit rounds to zero.`);
      return { recipient, name, rate, amount: payee.amount, deposit, payNow: optionalAmount(payee.pay_now, token, `payees[${index}].pay_now`), label: payee.label };
    });
    const total = rows.reduce((sum, row) => sum + row.deposit + row.payNow, 0n);
    const monthly = rows.reduce((sum, row) => sum + descale(row.rate * MONTH, token.decimals), 0n);
    const runway = args.runway_days ?? PERIODS[args.per] / 86_400;
    const [funds, reverse, past] = await Promise.all([walletFunds(sender, token), namesFor(rows.filter((row) => !row.name).map((row) => row.recipient)), pastRecipients(sender)]);
    const names = new Map(reverse);
    for (const row of rows) if (row.name) names.set(row.recipient, row.name);
    const warnings = [
      ...fundingWarnings({ token, balance: funds.balance, outlay: total, monthly, runwaySeconds: runway * 86_400, per: args.per }),
      ...newRecipientWarning(rows.map((row) => row.recipient), past, names),
    ];
    const approval = await approvalIfNeeded(sender, token, total, "start_payroll", 0n, warnings, funds);
    if (approval) return approval;
    const calls = rows.flatMap((row) => [
      encodeFunctionData({ abi: flowAbi, functionName: "createAndDeposit", args: [sender, row.recipient, row.rate, 0, token.address, true, row.deposit] }),
      ...(row.payNow > 0n ? [encodeFunctionData({ abi: flowAbi, functionName: "transferTokens", args: [token.address, row.recipient, row.payNow] })] : []),
    ]);
    const upfront = rows.reduce((sum, row) => sum + row.payNow, 0n);
    return propose({
      to: FLOW,
      data: encodeFunctionData({ abi: flowAbi, functionName: "batch", args: [calls] }),
      step: "create_payroll",
      // Every payee is shown with their full address: a label alone is whatever the agent typed.
      summary: `Start ${rows.length} pay streams in one transaction: ${rows.map((row) => `${payee(row.label, row.recipient, names)} ${row.amount} ${token.symbol}/${args.per}${row.payNow > 0n ? ` (+${display(row.payNow, token.decimals)} now)` : ""}`).join("; ")}. Total ${display(total, token.decimals)} ${token.symbol} funds ${runway} days${upfront > 0n ? `, including ${display(upfront, token.decimals)} paid up front` : ""}; payroll burn is ${display(monthly, token.decimals)} ${token.symbol} per 30 days.`,
      details: { token: token.symbol, streams: rows.length.toString(), recipients: rows.map((row) => row.recipient).join(","), total_deposit: display(total, token.decimals), paid_up_front: display(upfront, token.decimals), monthly_burn: display(monthly, token.decimals), runway_days: runway.toString(), contract: FLOW },
      warnings,
      next: `Once PayBox confirms it, the payroll is live at ${SITE}?a=${sender}. Each person can follow their own pay and payslips at ${SITE}?a= followed by their address.`,
    });
  }));

  server.registerTool("stream_status", {
    title: "Check payment streams",
    description: "Live state of up to 25 Sablier Flow streams on Base: status, rate, balance, what the recipient can withdraw now, what the sender could reclaim, unpaid debt, when funds run out, and Base names for both parties.",
    inputSchema: z.object({ stream_ids: z.array(streamIdSchema).min(1).max(25) }).strict(),
    outputSchema: z.object({ streams: z.array(streamSummarySchema), missing: z.array(z.string()) }).strict(),
    annotations: readOnly,
  }, guarded(async ({ stream_ids }) => {
    const ids = [...new Set(stream_ids)].map((id) => BigInt(id));
    const streams = [...(await readStreams(ids)).values()];
    const [symbols, names] = await Promise.all([
      tokenSymbols(streams.map((stream) => stream.token)),
      namesFor(streams.flatMap((stream) => [stream.sender, stream.recipient])),
    ]);
    const rows = streams.map((stream) => describeStream(stream, symbols.get(getAddress(stream.token)) ?? "TOKEN", names));
    const missing = ids.filter((id) => !streams.some((stream) => stream.id === id)).map(String);
    const text = rows.map((row) => `#${row.stream_id} ${row.status}: ${row.rate.month} ${row.token}/month to ${row.recipient_name ?? row.recipient}; withdrawable ${row.withdrawable_now}, balance ${row.balance}, runway ${row.runway}.`).join("\n") || "No streams found.";
    return data(missing.length ? `${text}\nNot found: ${missing.join(", ")}` : text, { streams: rows, missing });
  }));

  server.registerTool("list_streams", {
    title: "Payroll and income overview",
    description: "Finds the Sablier Flow streams on Base that an address (0x or Base name) pays or receives, then summarises monthly outflow and inflow per token, streams that need a top-up, pay waiting to be withdrawn, and ready-to-call next steps. Scans the newest streams on chain and, when reachable, Sablier's indexer for older ones.",
    inputSchema: z.object({
      address: partySchema,
      role: z.enum(["any", "sender", "recipient"]).default("any"),
      scan: z.number().int().min(1).max(5_000).default(2_000).describe("How many of the most recent stream IDs to scan on chain."),
    }).strict(),
    outputSchema: z.object({
      address: z.string(),
      name: z.string().nullable(),
      scanned_ids: z.string(),
      indexer: z.boolean(),
      outgoing: z.array(streamSummarySchema),
      incoming: z.array(streamSummarySchema),
      monthly_out: tokenTotalsSchema,
      monthly_in: tokenTotalsSchema,
      waiting_to_withdraw: tokenTotalsSchema,
      needs_attention: z.array(z.object({ stream_id: z.string(), reason: z.string() }).strict()),
      next_steps: z.array(z.object({ tool: z.string(), arguments: z.record(z.string(), z.union([z.string(), z.number()])), why: z.string() }).strict()),
    }).strict(),
    annotations: readOnly,
  }, guarded(async ({ address, role, scan }) => {
    const party = await resolveParty(address, "address");
    const owner = party.address;
    const found = await findStreams(owner, role, scan);
    const [symbols, names] = await Promise.all([
      tokenSymbols(found.streams.map((stream) => stream.token)),
      namesFor([owner, ...found.streams.flatMap((stream) => [stream.sender, stream.recipient])]),
    ]);
    if (party.name) names.set(owner, party.name);
    // Totals cover every stream found; the rows list the newest 25. Token labels (never raw symbols) key the totals.
    const monthlyOut: Record<string, bigint> = Object.create(null);
    const monthlyIn: Record<string, bigint> = Object.create(null);
    const waiting: Record<string, bigint> = Object.create(null);
    const decimalsFor: Record<string, number> = Object.create(null);
    const needsAttention: { stream_id: string; reason: string }[] = [];
    const outgoing = [];
    const incoming = [];
    for (const [index, stream] of found.streams.entries()) {
      const symbol = symbols.get(getAddress(stream.token)) ?? "TOKEN";
      const row = describeStream(stream, symbol, names);
      const listed = index < MAX_BATCH;
      const monthly = stream.status === "streaming" || stream.status === "streaming_insolvent" ? descale(stream.rate * MONTH, stream.decimals) : 0n;
      decimalsFor[symbol] = stream.decimals;
      if (stream.sender === owner) {
        if (listed) outgoing.push(row);
        monthlyOut[symbol] = (monthlyOut[symbol] ?? 0n) + monthly;
        if (stream.status === "streaming_insolvent" || stream.status === "paused_insolvent") needsAttention.push({ stream_id: row.stream_id, reason: `out of funds; owes ${row.unpaid_debt} ${symbol} it cannot pay` });
        else if (stream.status === "streaming" && stream.depletionTime && Number(stream.depletionTime) - stream.readAt < 7 * 86_400) needsAttention.push({ stream_id: row.stream_id, reason: `runs out in ${row.runway}` });
      }
      if (stream.recipient === owner) {
        if (listed) incoming.push(row);
        monthlyIn[symbol] = (monthlyIn[symbol] ?? 0n) + monthly;
        if (stream.withdrawable > 0n) waiting[symbol] = (waiting[symbol] ?? 0n) + stream.withdrawable;
      }
    }
    const fmt = (totals: Record<string, bigint>) => Object.fromEntries(Object.entries(totals).map(([symbol, value]) => [symbol, display(value, decimalsFor[symbol] ?? 18)]));
    const out = fmt(monthlyOut);
    const inn = fmt(monthlyIn);
    const ready = fmt(waiting);
    const nextSteps: { tool: string; arguments: Record<string, string | number>; why: string }[] = [];
    if (needsAttention.length) nextSteps.push({ tool: "top_up_streams", arguments: { funder: owner, runway_days: 30 }, why: `${needsAttention.length} stream(s) are out of funds or run out within a week; this funds them all for 30 days in one transaction.` });
    if (Object.keys(ready).length) nextSteps.push({ tool: "withdraw_all", arguments: { recipient: owner }, why: `${Object.entries(ready).map(([s, v]) => `${v} ${s}`).join(", ")} is ready to withdraw; this collects every stream in one transaction.` });
    if (found.streams.length) nextSteps.push({ tool: "payment_statement", arguments: { address: owner, month: currentMonth() }, why: "A statement of this month's pay with the transaction behind every number, plus a printable payslip link." });
    const label = party.name ?? names.get(owner) ?? owner;
    const text = [
      `${label}: pays ${found.streams.filter((stream) => stream.sender === owner).length} stream(s), receives ${found.streams.filter((stream) => stream.recipient === owner).length}.${found.streams.length > MAX_BATCH ? ` Listing the newest ${MAX_BATCH} of ${found.streams.length}; totals cover all of them.` : ""}`,
      Object.keys(out).length ? `Monthly outflow: ${Object.entries(out).map(([s, v]) => `${v} ${s}`).join(", ")}.` : "",
      Object.keys(inn).length ? `Monthly inflow: ${Object.entries(inn).map(([s, v]) => `${v} ${s}`).join(", ")}.` : "",
      Object.keys(ready).length ? `Ready to withdraw: ${Object.entries(ready).map(([s, v]) => `${v} ${s}`).join(", ")}.` : "",
      needsAttention.length ? `Needs attention: ${needsAttention.map((item) => `#${item.stream_id} ${item.reason}`).join("; ")}.` : "",
      `Live view: ${SITE}?a=${owner}`,
    ].filter(Boolean).join("\n");
    return data(text, {
      address: owner, name: names.get(owner) ?? null, scanned_ids: found.scannedIds, indexer: found.indexer, outgoing, incoming,
      monthly_out: out, monthly_in: inn, waiting_to_withdraw: ready, needs_attention: needsAttention, next_steps: nextSteps,
    });
  }));

  server.registerTool("top_up_stream", {
    title: "Top up a payment stream",
    description: "Adds funds to a Sablier Flow stream on Base, either a fixed amount or enough to cover unpaid debt plus runway_days of future pay. Anyone can fund a stream, but only its sender can refund unearned funds, so the proposal warns when the funder is not the sender. Returns an exact-amount approval first if needed.",
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
    const token = await streamToken(stream);
    let amount: bigint;
    if (args.amount !== undefined) {
      amount = tokenAmount(args.amount, token, "amount");
    } else {
      amount = shortfall(stream, args.runway_days!);
      if (amount === 0n) throw new UserError(`Stream ${args.stream_id} is already funded beyond ${args.runway_days} days (runway ${describeStream(stream, token.symbol).runway}).`);
    }
    if (amount === 0n) throw new UserError("amount must be greater than zero.");
    const headroom = args.runway_days !== undefined ? descale(stream.rate * 3_600n, token.decimals, "up") : 0n;
    const funds = await walletFunds(funder, token);
    const warnings = [...foreignFundingWarning(funder, [stream]), ...fundingWarnings({ token, balance: funds.balance, outlay: amount, monthly: descale(stream.rate * MONTH, token.decimals) })];
    const approval = await approvalIfNeeded(funder, token, amount, "top_up_stream", headroom, warnings, funds);
    if (approval) return approval;
    const after = { ...stream, balance: stream.balance + amount };
    const runway = stream.rate > 0n && after.balance > stream.totalDebt ? runwayText(after.balance - stream.totalDebt, stream.rate, token.decimals) : "n/a (not streaming)";
    return propose({
      to: FLOW,
      data: encodeFunctionData({ abi: flowAbi, functionName: "deposit", args: [stream.id, amount, stream.sender, stream.recipient] }),
      step: "deposit",
      summary: `Add ${display(amount, token.decimals)} ${token.symbol} to stream #${stream.id} (${stream.sender} → ${stream.recipient}).${stream.uncoveredDebt > 0n ? ` This first clears ${display(stream.uncoveredDebt, token.decimals)} ${token.symbol} of unpaid debt.` : ""} Runway afterwards: about ${runway}.`,
      details: { stream_id: stream.id.toString(), token: token.symbol, amount: display(amount, token.decimals), runway_after: runway, sablier_url: sablierUrl(stream.id) },
      warnings,
    });
  }));

  server.registerTool("top_up_streams", {
    title: "Keep payroll funded",
    description: "Tops up several Sablier Flow streams on Base in ONE transaction so each covers its unpaid debt plus runway_days of future pay. Without stream_ids it picks every stream the funder pays that is short of that runway. One exact-amount approval first if needed.",
    inputSchema: z.object({
      funder: addressSchema.describe("Public address of the PayBox wallet that pays (and, without stream_ids, the sender of the streams)."),
      runway_days: runwayDaysSchema.describe("Fund each stream for this many days from now."),
      stream_ids: z.array(streamIdSchema).min(1).max(25).optional().describe("Streams to fund. Defaults to every stream the funder pays that is short of runway_days."),
    }).strict(),
    outputSchema: proposalOutputSchema,
    annotations: proposes,
  }, guarded(async (args) => {
    const funder = checksum(args.funder, "funder");
    let streams: StreamState[];
    if (args.stream_ids) {
      const ids = [...new Set(args.stream_ids)].map((id) => BigInt(id));
      const found = await readStreams(ids);
      const missing = ids.filter((id) => !found.has(id));
      if (missing.length) throw new UserError(`Stream(s) ${missing.join(", ")} do not exist on Sablier Flow (Base).`);
      streams = [...found.values()];
    } else {
      streams = (await findStreams(funder, "sender")).streams;
    }
    const short = streams.filter((stream) => stream.status !== "voided" && shortfall(stream, args.runway_days) > 0n);
    if (short.length === 0) throw new UserError(`Every ${args.stream_ids ? "listed" : "running"} stream is already funded for ${args.runway_days} days.`);
    if (new Set(short.map((stream) => stream.token)).size > 1) {
      const labels = await tokenSymbols(short.map((stream) => stream.token));
      throw new UserError(`These streams use different tokens (${[...new Set(labels.values())].join(", ")}); top up one token at a time by passing stream_ids.`);
    }
    const token = await streamToken(short[0]!);
    const rows = short.slice(0, MAX_BATCH).map((stream) => ({ stream, amount: shortfall(stream, args.runway_days) }));
    const total = rows.reduce((sum, row) => sum + row.amount, 0n);
    const burn = rows.reduce((sum, row) => sum + row.stream.rate, 0n);
    const headroom = descale(burn * 3_600n, token.decimals, "up");
    const [funds, names] = await Promise.all([walletFunds(funder, token), namesFor(rows.map((row) => row.stream.recipient))]);
    const warnings = [...foreignFundingWarning(funder, rows.map((row) => row.stream)), ...fundingWarnings({ token, balance: funds.balance, outlay: total, monthly: descale(burn * MONTH, token.decimals) })];
    const approval = await approvalIfNeeded(funder, token, total, "top_up_streams", headroom, warnings, funds);
    if (approval) return approval;
    return propose({
      to: FLOW,
      data: flowCalls(rows.map((row) => encodeFunctionData({ abi: flowAbi, functionName: "deposit", args: [row.stream.id, row.amount, row.stream.sender, row.stream.recipient] }))),
      step: "deposit_many",
      summary: `Fund ${rows.length} stream(s) for ${args.runway_days} days in one transaction: ${rows.map((row) => `#${row.stream.id} to ${who(row.stream.recipient, names)} +${display(row.amount, token.decimals)}${row.stream.uncoveredDebt > 0n ? " (clears unpaid debt)" : ""}`).join("; ")}. Total ${display(total, token.decimals)} ${token.symbol}.${remainder(short.length - rows.length, "streams also need funding")}`,
      details: { token: token.symbol, streams: rows.length.toString(), total: display(total, token.decimals), runway_days: args.runway_days.toString(), stream_ids: rows.map((row) => row.stream.id.toString()).join(",") },
      warnings,
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
    const { symbol } = await streamToken(stream);
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
    description: "Restarts a paused Sablier Flow stream at a new or the same rate (amount per period), optionally adding funds in the same transaction (deposit or runway_days). Only the sender can resume. Returns an exact-amount approval first if new funds need one.",
    inputSchema: z.object({
      stream_id: streamIdSchema,
      sender: addressSchema,
      amount: amountSchema,
      per: periodSchema,
      deposit: amountSchema.optional().describe("Optional tokens to add while resuming."),
      runway_days: runwayDaysSchema.optional().describe("Optional: add enough to cover any unpaid debt plus this many days at the new rate."),
    }).strict(),
    outputSchema: proposalOutputSchema,
    annotations: proposes,
  }, guarded(async (args) => {
    const sender = checksum(args.sender, "sender");
    const stream = await readStream(args.stream_id);
    requireSender(stream, sender);
    if (stream.status !== "paused" && stream.status !== "paused_insolvent") throw new UserError(`Stream ${args.stream_id} is ${stream.status}, not paused.`);
    if (args.deposit !== undefined && args.runway_days !== undefined) throw new UserError("Give either deposit or runway_days, not both.");
    const rate = ratePerSecond(args.amount, args.per);
    const token = await streamToken(stream);
    let add = optionalAmount(args.deposit, token, "deposit");
    if (args.runway_days !== undefined) {
      add = shortfall({ ...stream, rate }, args.runway_days);
      if (add === 0n) throw new UserError(`Stream ${args.stream_id} already holds ${args.runway_days} days at that rate; resume without runway_days.`);
    }
    const balance = stream.balance + add;
    const runway = balance > stream.totalDebt ? runwayText(balance - stream.totalDebt, rate, stream.decimals) : "none: top up first or it accrues unpaid debt";
    let warnings: string[] = [];
    if (add > 0n) {
      const funds = await walletFunds(sender, token);
      warnings = fundingWarnings({ token, balance: funds.balance, outlay: add, monthly: descale(rate * MONTH, token.decimals), per: args.per });
      const approval = await approvalIfNeeded(sender, token, add, "resume_stream", descale(rate * 3_600n, token.decimals, "up"), warnings, funds);
      if (approval) return approval;
    }
    return propose({
      to: FLOW,
      data: add > 0n
        ? encodeFunctionData({ abi: flowAbi, functionName: "restartAndDeposit", args: [stream.id, rate, add] })
        : encodeFunctionData({ abi: flowAbi, functionName: "restart", args: [stream.id, rate] }),
      step: "resume",
      summary: `Resume stream #${stream.id} at ${args.amount} ${token.symbol} per ${args.per}${add > 0n ? `, adding ${display(add, token.decimals)} ${token.symbol}` : ""}. Funds then cover about ${runway}.`,
      details: { stream_id: stream.id.toString(), per_month: perPeriod(rate, stream.decimals).month, added: display(add, token.decimals), runway },
      warnings,
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
    const { symbol } = await streamToken(stream);
    const before = perPeriod(stream.rate, stream.decimals).month;
    const after = perPeriod(rate, stream.decimals).month;
    const available = stream.balance > stream.totalDebt ? stream.balance - stream.totalDebt : 0n;
    const warnings = rate > stream.rate && available > 0n && runwaySeconds(available, rate, stream.decimals) < 3 * 86_400
      ? [`At the new rate the current funds last only about ${runwayText(available, rate, stream.decimals)}. Top it up afterwards (top_up_stream).`]
      : [];
    return propose({
      to: FLOW,
      data: encodeFunctionData({ abi: flowAbi, functionName: "adjustRatePerSecond", args: [stream.id, rate] }),
      step: "change_rate",
      summary: `Change stream #${stream.id} from ${before} to ${after} ${symbol} per 30 days. The ${display(stream.totalDebt, stream.decimals)} ${symbol} already earned is unaffected.`,
      details: { stream_id: stream.id.toString(), per_month_before: before, per_month_after: after },
      warnings,
    });
  }));

  server.registerTool("end_stream", {
    title: "End a payment stream",
    description: "Pauses a Sablier Flow stream and returns every unearned token to the sender in one transaction. The recipient keeps, and can still withdraw, everything earned up to that moment. Only the stream's sender can end it.",
    inputSchema: z.object({ stream_id: streamIdSchema, sender: addressSchema }).strict(),
    outputSchema: proposalOutputSchema,
    annotations: { ...proposes, destructiveHint: true },
  }, guarded(async (args) => {
    const sender = checksum(args.sender, "sender");
    const stream = await readStream(args.stream_id);
    requireSender(stream, sender);
    const plan = endPlan(stream);
    if (!plan) throw new UserError(`Stream ${stream.id} is already stopped with nothing left to refund.`);
    const { symbol } = await streamToken(stream);
    return propose({
      to: FLOW,
      data: flowCalls(plan.calls),
      step: "end",
      summary: `End stream #${stream.id} to ${stream.recipient}: ${plan.what(symbol)} Refunds go to ${sender}.`,
      details: { stream_id: stream.id.toString(), refund_estimate: display(plan.refund, stream.decimals), recipient_keeps: display(stream.totalDebt, stream.decimals) },
    });
  }));

  server.registerTool("end_streams", {
    title: "End several payment streams",
    description: "Ends up to 25 Sablier Flow streams in ONE transaction: stops their pay and returns every unearned token to the sender. Each recipient keeps, and can still withdraw, everything earned so far. Only the sender can end them.",
    inputSchema: z.object({ sender: addressSchema, stream_ids: z.array(streamIdSchema).min(1).max(25) }).strict(),
    outputSchema: proposalOutputSchema,
    annotations: { ...proposes, destructiveHint: true },
  }, guarded(async (args) => {
    const sender = checksum(args.sender, "sender");
    const ids = [...new Set(args.stream_ids)].map((id) => BigInt(id));
    const found = await readStreams(ids);
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length) throw new UserError(`Stream(s) ${missing.join(", ")} do not exist on Sablier Flow (Base).`);
    const streams = [...found.values()];
    for (const stream of streams) requireSender(stream, sender);
    const rows = streams.flatMap((stream) => {
      const plan = endPlan(stream);
      return plan ? [{ stream, plan }] : [];
    });
    if (rows.length === 0) throw new UserError("Those streams are already stopped with nothing left to refund.");
    const [symbols, names] = await Promise.all([tokenSymbols(rows.map((row) => row.stream.token)), namesFor(rows.map((row) => row.stream.recipient))]);
    const symbolOf = (stream: StreamState) => symbols.get(getAddress(stream.token)) ?? "TOKEN";
    const skipped = streams.length - rows.length;
    return propose({
      to: FLOW,
      data: flowCalls(rows.flatMap((row) => row.plan.calls)),
      step: "end_many",
      summary: `End ${rows.length} stream(s) in one transaction. ${rows.map(({ stream, plan }) => `#${stream.id} to ${who(stream.recipient, names)}: ${plan.what(symbolOf(stream))}`).join(" ")}${skipped ? ` ${skipped} already stopped with nothing to refund.` : ""} Refunds go to ${sender}.`,
      details: { streams: rows.length.toString(), stream_ids: rows.map((row) => row.stream.id.toString()).join(","), sender },
    });
  }));

  server.registerTool("reclaim_funds", {
    title: "Take back extra funds",
    description: "Returns unearned money from a Sablier Flow stream to its sender while leaving keep_days of pay in it, so the stream keeps running. Use it after overfunding. Only the sender can reclaim.",
    inputSchema: z.object({
      stream_id: streamIdSchema,
      sender: addressSchema,
      keep_days: z.number().min(0).max(3_650).describe("Days of pay to leave in the stream at its current rate."),
    }).strict(),
    outputSchema: proposalOutputSchema,
    annotations: proposes,
  }, guarded(async (args) => {
    const sender = checksum(args.sender, "sender");
    const stream = await readStream(args.stream_id);
    requireSender(stream, sender);
    if (stream.status === "voided") throw new UserError(`Stream ${args.stream_id} has ended for good; end_stream returns whatever is left in it.`);
    if (stream.status === "paused" || stream.status === "paused_insolvent") {
      throw new UserError(`Stream ${args.stream_id} is paused, so it uses no pay and keep_days has nothing to measure. Use end_stream to take back all unearned funds, or resume it first.`);
    }
    // Leave keep_days of pay plus ten minutes of margin, because the refundable amount shrinks while the proposal waits.
    const keep = descale(stream.rate * BigInt(Math.round(args.keep_days * 86_400) + 600), stream.decimals, "up");
    const amount = stream.refundable > keep ? stream.refundable - keep : 0n;
    if (amount === 0n) throw new UserError(`Stream ${args.stream_id} holds no more than ${args.keep_days} days of pay; nothing to reclaim.`);
    const { symbol } = await streamToken(stream);
    const left = stream.balance - amount > stream.totalDebt ? stream.balance - amount - stream.totalDebt : 0n;
    const runway = runwayText(left, stream.rate, stream.decimals);
    const after = stream.status === "pending"
      ? `The stream still starts as planned, with about ${runway} of pay in it`
      : `The stream keeps running with about ${runway} of pay left`;
    return propose({
      to: FLOW,
      data: encodeFunctionData({ abi: flowAbi, functionName: "refund", args: [stream.id, amount] }),
      step: "refund",
      summary: `Return ${display(amount, stream.decimals)} ${symbol} of unearned funds from stream #${stream.id} to ${sender}. ${after}, and the recipient keeps the ${display(stream.totalDebt, stream.decimals)} ${symbol} already earned.`,
      details: { stream_id: stream.id.toString(), refund: display(amount, stream.decimals), runway_after: runway },
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
    const [minFee, token] = await Promise.all([
      client.readContract({ address: FLOW, abi: flowAbi, functionName: "calculateMinFeeWei", args: [stream.id] }),
      streamToken(stream),
    ]);
    const fee = withHeadroom(minFee);
    return propose({
      to: FLOW,
      value: fee,
      data: encodeFunctionData({ abi: flowAbi, functionName: "withdrawMax", args: [stream.id, stream.recipient] }),
      step: "withdraw",
      summary: `Withdraw at least ${display(stream.withdrawable, stream.decimals)} ${token.symbol} earned on stream #${stream.id} to ${stream.recipient}${fee > 0n ? `, paying Sablier's withdrawal fee of up to ${display(fee, 18)} ETH` : ""}.`,
      details: { stream_id: stream.id.toString(), withdrawable: display(stream.withdrawable, stream.decimals), fee_eth: display(fee, 18), to: stream.recipient },
    });
  }));

  server.registerTool("withdraw_all", {
    title: "Collect all earned pay",
    description: "Withdraws everything earned on every Sablier Flow stream that pays an address (0x or Base name), in ONE transaction. Anyone can trigger it; funds always go to the recipient. Includes Sablier's withdrawal fee in ETH, if any.",
    inputSchema: z.object({ recipient: partySchema }).strict(),
    outputSchema: proposalOutputSchema,
    annotations: proposes,
  }, guarded(async (args) => {
    const party = await resolveParty(args.recipient, "recipient");
    const recipient = party.address;
    const { streams } = await findStreams(recipient, "recipient");
    const waiting = streams.filter((stream) => stream.withdrawable > 0n);
    if (waiting.length === 0) throw new UserError(`Nothing to withdraw yet for ${party.name ?? recipient}${streams.length ? ` across ${streams.length} stream(s)` : ": no streams pay this address"}.`);
    const ready = waiting.slice(0, MAX_BATCH);
    const [fees, symbols] = await Promise.all([
      client.multicall({ contracts: ready.map((stream) => ({ address: FLOW, abi: flowAbi, functionName: "calculateMinFeeWei", args: [stream.id] }) as const), allowFailure: false }),
      tokenSymbols(ready.map((stream) => stream.token)),
    ]);
    // Inside Flow's batch every call sees the same msg.value, so the largest single fee covers them all.
    const fee = withHeadroom(fees.reduce((max, value) => (value > max ? value : max), 0n));
    const sums: Record<string, { amount: bigint; decimals: number }> = Object.create(null);
    for (const stream of ready) {
      const symbol = symbols.get(getAddress(stream.token)) ?? "TOKEN";
      const row = sums[symbol] ??= { amount: 0n, decimals: stream.decimals };
      row.amount += stream.withdrawable;
    }
    const total = Object.entries(sums).map(([symbol, row]) => `${display(row.amount, row.decimals)} ${symbol}`).join(" + ");
    return propose({
      to: FLOW,
      value: fee,
      data: flowCalls(ready.map((stream) => encodeFunctionData({ abi: flowAbi, functionName: "withdrawMax", args: [stream.id, recipient] }))),
      step: "withdraw_many",
      summary: `Collect at least ${total} earned on ${ready.length} stream(s) (${ready.map((stream) => `#${stream.id}`).join(", ")}) to ${who(recipient, party.name ? new Map([[recipient, party.name]]) : new Map())} in one transaction${fee > 0n ? `, paying Sablier's withdrawal fee of up to ${display(fee, 18)} ETH` : ""}.${remainder(waiting.length - ready.length, "streams also have pay waiting")}`,
      details: { recipient, streams: ready.length.toString(), stream_ids: ready.map((stream) => stream.id.toString()).join(","), total, fee_eth: display(fee, 18) },
    });
  }));

  const statementSide = z.object({
    totals: z.record(z.string(), z.record(z.string(), z.string())),
    year_to_date: z.record(z.string(), z.record(z.string(), z.string())),
    streams: z.array(z.object({
      stream_id: z.string(), counterparty: z.string(), counterparty_name: z.string().nullable(), token: z.string(),
      amounts: z.record(z.string(), z.string()), sablier_url: z.string(),
    }).strict()),
  }).strict();

  server.registerTool("payment_statement", {
    title: "Pay statement and payslip",
    description: "A monthly statement for an address (0x or Base name) from its Sablier Flow streams on Base: income earned and withdrawn, and pay sent, deposited and refunded, per stream and per token, with year-to-date totals, the transaction behind every movement, and a printable payslip link. Earned and paid count only pay the stream had funds for; pay that accrued without funds is listed separately as unfunded. Uses Sablier's public indexer for history. Read-only.",
    inputSchema: z.object({
      address: partySchema,
      month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use YYYY-MM, e.g. 2026-10.").optional().describe("Calendar month in UTC, e.g. 2026-10. Defaults to the current month."),
    }).strict(),
    outputSchema: z.object({
      address: z.string(),
      name: z.string().nullable(),
      month: z.string(),
      from: z.string(),
      to: z.string(),
      income: statementSide,
      spending: statementSide,
      transactions: z.array(z.object({ at: z.string(), stream_id: z.string(), side: z.string(), category: z.string(), amount: z.string().nullable(), token: z.string(), tx: z.string() }).strict()),
      payslip_url: z.string(),
    }).strict(),
    annotations: readOnly,
  }, guarded(async (args) => {
    const party = await resolveParty(args.address, "address");
    const owner = party.address;
    const month = args.month ?? currentMonth();
    const bounds = monthBounds(month);
    const now = Math.floor(Date.now() / 1000);
    if (bounds.from > now) throw new UserError(`${month} has not started yet.`);
    const to = Math.min(bounds.to, now);
    const yearStart = Date.UTC(Number(month.slice(0, 4)), 0, 1) / 1000;
    let history;
    try {
      history = await indexedStreams(owner);
    } catch (error) {
      if (!(error instanceof IndexerUnavailable)) throw error;
      throw new UserError(`Statements need Sablier's indexer, which did not answer (${error.message}). Allow ${new URL(INDEXER_URL).host} under the plugin's network access, or try again shortly.`);
    }
    const upfront = await upfrontPayments(history);
    const lines = history.flatMap((stream) => streamLines(stream, owner, bounds.from, to, upfront.get(stream.tokenId)));
    const ytd = history.flatMap((stream) => streamLines(stream, owner, yearStart, to, upfront.get(stream.tokenId)));
    const active = (line: StreamLine) => line.covered > 0n || line.unfunded > 0n || line.upfront > 0n || line.events.length > 0;
    const counterparties = lines.map((line) => getAddress(line.counterparty));
    const names = await namesFor([owner, ...counterparties]);
    if (party.name) names.set(owner, party.name);
    const amount = (value: bigint, decimals: number) => display(value, decimals);
    const side = (kind: "income" | "spending") => {
      const pick = (list: StreamLine[]) => list.filter((line) => line.side === kind);
      const fields = (row: { covered: bigint; unfunded: bigint; upfront: bigint; withdrawn: bigint; deposited: bigint; refunded: bigint; decimals: number }): Record<string, string> => kind === "income"
        ? { earned: amount(row.covered, row.decimals), received_up_front: amount(row.upfront, row.decimals), withdrawn: amount(row.withdrawn, row.decimals), unfunded: amount(row.unfunded, row.decimals) }
        : { paid: amount(row.covered, row.decimals), paid_up_front: amount(row.upfront, row.decimals), deposited: amount(row.deposited, row.decimals), refunded: amount(row.refunded, row.decimals), unfunded: amount(row.unfunded, row.decimals) };
      return {
        totals: Object.fromEntries(Object.entries(totals(pick(lines))).map(([symbol, row]) => [symbol, fields(row)])),
        year_to_date: Object.fromEntries(Object.entries(totals(pick(ytd))).map(([symbol, row]) => [symbol, fields(row)])),
        streams: pick(lines).filter(active).map((line) => ({
          stream_id: line.stream_id,
          counterparty: getAddress(line.counterparty),
          counterparty_name: names.get(getAddress(line.counterparty)) ?? null,
          token: line.token,
          amounts: fields(line),
          sablier_url: sablierUrl(BigInt(line.stream_id)),
        })),
      };
    };
    const income = side("income");
    const spending = side("spending");
    const seen = new Set<string>();
    const transactions = lines.flatMap((line) => line.events.map((event) => ({ line, event })))
      .filter(({ line, event }) => {
        const key = `${event.hash}-${line.stream_id}-${event.category}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => a.event.timestamp - b.event.timestamp)
      .slice(-60)
      .map(({ line, event }) => ({
        at: iso(event.timestamp), stream_id: line.stream_id, side: line.side, category: event.category,
        amount: event.amount === null ? null : display(event.amount, line.decimals), token: line.token, tx: `https://basescan.org/tx/${event.hash}`,
      }));
    const label = names.get(owner) ?? owner;
    const list = (record: Record<string, Record<string, string>>, key: string) => Object.entries(record).map(([symbol, row]) => `${row[key]} ${symbol}`).join(", ");
    const unfunded = (record: Record<string, Record<string, string>>) => Object.entries(record).filter(([, row]) => row.unfunded !== "0").map(([symbol, row]) => `${row.unfunded} ${symbol}`).join(", ");
    const payslip = `${SITE}?a=${owner}&statement=${month}`;
    const upfrontText = (record: Record<string, Record<string, string>>, key: string, words: string) => {
      const text = Object.entries(record).filter(([, row]) => row[key] !== "0").map(([symbol, row]) => `${row[key]} ${symbol}`).join(", ");
      return text ? `, plus ${text} ${words}` : "";
    };
    const owedIn = unfunded(income.totals);
    const owedOut = unfunded(spending.totals);
    const text = [
      `${month} statement for ${label} (${iso(bounds.from).slice(0, 10)} to ${iso(to).slice(0, 10)}).`,
      income.streams.length ? `Income: earned ${list(income.totals, "earned")} across ${income.streams.length} stream(s)${upfrontText(income.totals, "received_up_front", "received up front")}; withdrew ${list(income.totals, "withdrawn")}. Year to date: earned ${list(income.year_to_date, "earned")}.${owedIn ? ` A further ${owedIn} accrued without funds behind it and is not counted as earned.` : ""}` : "No stream income this month.",
      spending.streams.length ? `Paid out: ${list(spending.totals, "paid")} across ${spending.streams.length} stream(s)${upfrontText(spending.totals, "paid_up_front", "paid up front")}; deposited ${list(spending.totals, "deposited")}, refunded ${list(spending.totals, "refunded")}.${owedOut ? ` ${owedOut} more accrued that the streams could not cover; top them up to pay it.` : ""}` : "",
      `Printable payslip: ${payslip}`,
    ].filter(Boolean).join("\n");
    return data(text, {
      address: owner, name: names.get(owner) ?? null, month, from: iso(bounds.from), to: iso(to),
      income, spending, transactions, payslip_url: payslip,
    });
  }));

  server.registerTool("request_payment", {
    title: "Create a pay-me link",
    description: "Creates a shareable link asking someone to pay you by the second (e.g. 3000 USDC a month to name.base.eth), plus the exact sentence their agent needs. The link opens a Payday page with the request, a QR code and a live preview. Nothing is signed or sent. Read-only.",
    inputSchema: z.object({
      recipient: partySchema.describe("Who gets paid: a 0x address or a Base name such as name.base.eth."),
      amount: amountSchema.describe("Amount per period, e.g. \"3000\"."),
      per: periodSchema,
      token: tokenSchema,
      runway_days: runwayDaysSchema.optional().describe("Days of pay to ask the payer to fund up front. Defaults to one period."),
      note: z.string().max(80).optional().describe("Short note shown on the request, e.g. \"Design retainer, October\"."),
    }).strict(),
    outputSchema: z.object({
      link: z.string(),
      prompt: z.string(),
      recipient: z.string(),
      recipient_name: z.string().nullable(),
      pays: z.object({ hour: z.string(), day: z.string(), week: z.string(), month: z.string(), year: z.string() }).strict(),
    }).strict(),
    annotations: readOnly,
  }, guarded(async (args) => {
    const [party, token] = await Promise.all([resolveParty(args.recipient, "recipient"), resolveToken(args.token)]);
    refuseContractRecipient(party.address, "recipient", token);
    const rate = ratePerSecond(args.amount, args.per);
    const pays = perPeriod(rate, token.decimals);
    const days = args.runway_days ?? PERIODS[args.per] / 86_400;
    // Known tokens travel by symbol; anything else by address, so a token merely named "USDC" never passes as USDC.
    const params = new URLSearchParams({ pay: party.address, amount: args.amount, per: args.per, token: symbolFor(token.address) ?? token.address, days: String(days) });
    if (party.name) params.set("name", party.name);
    if (args.note) params.set("note", args.note);
    const link = `${SITE}?${params}`;
    const payee = party.name ?? party.address;
    // The note stays on the page and out of the sentence: whatever the requester typed must never read as an
    // instruction to the payer's agent. Tokens other than USDC/EURC are named by address so the agent can act on it.
    const what = symbolFor(token.address) ? `${args.amount} ${token.symbol}` : `${args.amount} of the token ${token.address}`;
    const prompt = `Using the Payday plugin, start paying ${payee}${party.name ? ` (${party.address})` : ""} ${what} per ${args.per} from my PayBox Base wallet, funded for ${days} days.`;
    return data(
      `Share this link: ${link}\nWhoever opens it sees the request (${args.amount} ${token.symbol} per ${args.per}, ${pays.day}/day) and can copy this sentence to their agent:\n"${prompt}"`,
      { link, prompt, recipient: party.address, recipient_name: party.name, pays },
    );
  }));

  return server;
}

/** Sablier's withdrawal fee is priced in USD through an oracle; 10% headroom survives ETH moving while a proposal waits. */
function withHeadroom(fee: bigint): bigint {
  return fee > 0n ? fee + fee / 10n : 0n;
}

/**
 * How to end a stream, or null when there is nothing to do:
 * - running: pause, then refund what's unearned (skipped if it would run dry before the proposal confirms,
 *   since refundMax reverts at zero and would take the pause down with it);
 * - not started yet: void it (pause reverts on pending streams), then refund the deposit;
 * - paused or already ended: refund whatever is left.
 */
function endPlan(stream: StreamState): { calls: Hex[]; refund: bigint; what: (symbol: string) => string } | null {
  const call = (functionName: "pause" | "void" | "refundMax") => encodeFunctionData({ abi: flowAbi, functionName, args: [stream.id] });
  const amount = (value: bigint, symbol: string) => `${display(value, stream.decimals)} ${symbol}`;
  const keeps = (symbol: string) => `They keep the ${amount(stream.totalDebt, symbol)} already earned.`;
  if (stream.status === "streaming" || stream.status === "streaming_insolvent") {
    const margin = descale(stream.rate * 600n, stream.decimals, "up");
    const refund = stream.refundable > margin ? stream.refundable : 0n;
    return {
      calls: refund > 0n ? [call("pause"), call("refundMax")] : [call("pause")],
      refund,
      what: (symbol) => refund > 0n
        ? `stop the pay and return about ${amount(refund, symbol)} of unearned funds (slightly less if it confirms later). ${keeps(symbol)}`
        : `stop the pay; it has under ten minutes of funds left, so there is nothing meaningful to refund. ${keeps(symbol)}`,
    };
  }
  if (stream.status === "pending") {
    return {
      calls: stream.refundable > 0n ? [call("void"), call("refundMax")] : [call("void")],
      refund: stream.refundable,
      what: (symbol) => `cancel it before it starts${stream.refundable > 0n ? ` and return the ${amount(stream.refundable, symbol)} deposited` : ""}. Nothing has been earned yet.`,
    };
  }
  if (stream.refundable === 0n) return null;
  return {
    calls: [call("refundMax")],
    refund: stream.refundable,
    what: (symbol) => `it is already ${stream.status === "voided" ? "ended" : "paused"}; return the ${amount(stream.refundable, symbol)} of unearned funds still in it. ${keeps(symbol)}`,
  };
}

serveStdio(createServer, { legacy: "reject" });
