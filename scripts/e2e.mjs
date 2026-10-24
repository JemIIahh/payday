// End-to-end check against a local anvil fork of Base:
//   anvil --fork-url https://mainnet.base.org --port 8547
//   node scripts/e2e.mjs
// Calls every tool through the built bundle (the same stdio protocol PayBox uses), then sends each
// returned proposal as a real transaction from an impersonated USDC holder and checks the outcome on chain.
// The fork has no indexer of its own, so the plugin runs with Sablier's indexer switched off here (its
// chain-scan fallback is what gets tested); payment_statement is checked read-only against Base mainnet.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createPublicClient, createTestClient, createWalletClient, erc20Abi, http, parseEther } from "viem";
import { base } from "viem/chains";

const RPC = process.env.FORK_RPC ?? "http://127.0.0.1:8547";
const BUNDLE = new URL("../dist/plugin.mjs", import.meta.url).pathname;
const FLOW = "0x0cbfe6ce6f05c47d6243bb3818837971c6ccb46b";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const KEY = "io.paybox/transactionProposal";
const SENDER = process.env.E2E_SENDER ?? "0x3304E22DDaa22bCdC5fCa2269b418046aE7b566A";
const PAYEES = ["0x00000000000000000000000000000000000a11ce", "0x0000000000000000000000000000000000000b0b", "0x000000000000000000000000000000000000ca7e", "0x000000000000000000000000000000000000da7e"];
// A real Base name, resolved on the fork exactly as on mainnet.
const NAME = "jesse.base.eth";
const NAMED = "0x2211d1D0020DAEA8039E46Cf1367962070d77DA9";
// The wallet behind Payday's verified mainnet run (17 Oct 2026), for the read-only statement check.
const MAINNET_PAYER = "0x5dae41fd8a0627e3e6d5a3b020696f8cc7c57550";

const transport = http(RPC);
const pub = createPublicClient({ chain: base, transport });
const test = createTestClient({ chain: base, mode: "anvil", transport });
const wallet = createWalletClient({ chain: base, transport });

let failures = 0;
const ok = (label, condition, extra = "") => {
  console.log(`${condition ? "PASS" : "FAIL"} ${label}${extra ? `: ${extra}` : ""}`);
  if (!condition) failures++;
};

const FORK_ENV = { BASE_RPC_URL: RPC, SABLIER_INDEXER_URL: "http://127.0.0.1:9/graphql" };

function callTool(name, args, env = FORK_ENV) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BUNDLE], { env: { PATH: process.env.PATH, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${name} timed out`)); }, 10_000);
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    createInterface({ input: child.stdout }).on("line", (line) => {
      const message = JSON.parse(line);
      if (message.id !== 1) return;
      clearTimeout(timer);
      child.kill();
      if (message.error) reject(new Error(`${name}: ${JSON.stringify(message.error)} ${stderr}`));
      else resolve(message.result);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args, _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "e2e", version: "0" },
      "io.modelcontextprotocol/clientCapabilities": {},
    } } })}\n`);
  });
}

async function execute(result, from = SENDER) {
  const proposal = result.structuredContent?.[KEY];
  if (!proposal) throw new Error(`no proposal: ${result.content?.[0]?.text}`);
  const { to, value, data } = proposal.transaction;
  const hash = await wallet.sendTransaction({ account: from, to, value: BigInt(value), data });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  return receipt;
}

/** Runs a proposal tool; if it asks for an approval first, executes that and calls again. Returns the final result. */
async function proposeAndRun(label, name, args, from = SENDER) {
  let result = await callTool(name, args);
  if (result.isError) { ok(label, false, result.content[0].text); return null; }
  if (result.structuredContent.step === "approve") {
    const approval = await execute(result, from);
    ok(`${label} / approve`, approval.status === "success", result.structuredContent.details.amount);
    result = await callTool(name, args);
    if (result.isError) { ok(label, false, result.content[0].text); return null; }
  }
  const receipt = await execute(result, from);
  ok(`${label} / ${result.structuredContent.step}`, receipt.status === "success", result.structuredContent.summary.slice(0, 160));
  return result;
}

async function statuses(ids) {
  const result = await callTool("stream_status", { stream_ids: ids.map(String) });
  return result.structuredContent.streams;
}
const status = async (id) => (await statuses([id]))[0];
const usdc = (address) => pub.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [address] });
const days = (runway) => Number(/^(\d+)d/.exec(runway)?.[1] ?? 0);

const warp = async (seconds) => { await test.increaseTime({ seconds }); await test.mine({ blocks: 1 }); };
const nextStreamId = async () => Number(await pub.readContract({ address: FLOW, abi: [{ type: "function", name: "nextStreamId", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }], functionName: "nextStreamId" }));

await test.impersonateAccount({ address: SENDER });
await test.setBalance({ address: SENDER, value: parseEther("10") });
console.log(`sender ${SENDER} holds ${Number(await usdc(SENDER)) / 1e6} USDC on the fork`);
const first = await nextStreamId();

// ---------- planning ----------
const plan = await callTool("plan_stream", { amount: "3000", per: "month", runway_days: 14 });
ok("plan_stream", !plan.isError && plan.structuredContent.pays.month === "3000" && plan.structuredContent.deposit_for_runway === "1400", JSON.stringify(plan.structuredContent.pays));
const afford = await callTool("plan_stream", { amount: "3000", per: "month", sender: SENDER });
ok("plan_stream affordability", !afford.isError && Number(afford.structuredContent.affordability?.months_covered) > 1, afford.content[0].text.split(". ").slice(-1)[0]);

// ---------- one stream: lifecycle ----------
await proposeAndRun("start_stream", "start_stream", { sender: SENDER, recipient: PAYEES[0], amount: "720", per: "month", deposit: "24" });
let s = await status(first);
ok("stream created", s?.status === "streaming" && s.recipient.toLowerCase() === PAYEES[0].toLowerCase(), `#${first} ${s?.rate.hour}/hour runway ${s?.runway}`);

await warp(3_600);
s = await status(first);
ok("accrues by the second", Number(s.withdrawable_now) >= 1 && Number(s.withdrawable_now) <= 1.01, `withdrawable after 1h = ${s.withdrawable_now}`);

// payroll: three people, one transaction, one of them paid something up front
const bobBefore = await usdc(PAYEES[1]);
await proposeAndRun("start_payroll", "start_payroll", { sender: SENDER, per: "month", runway_days: 7, payees: [
  { recipient: PAYEES[1], amount: "300", label: "Ada", pay_now: "50" },
  { recipient: PAYEES[2], amount: "450", label: "Bayo" },
  { recipient: PAYEES[3], amount: "600", label: "Chi" },
] });
const payroll = await statuses([first + 1, first + 2, first + 3]);
ok("payroll streams live", payroll.length === 3 && payroll.every((row) => row.status === "streaming"), payroll.map((row) => `${row.stream_id}:${row.rate.month}`).join(" "));
ok("payroll pay_now paid", (await usdc(PAYEES[1])) - bobBefore === 50_000_000n, "Ada got 50 USDC up front");

const overview = await callTool("list_streams", { address: SENDER });
const steps = overview.structuredContent?.next_steps?.map((step) => step.tool) ?? [];
ok("list_streams", !overview.isError && overview.structuredContent.outgoing.length >= 4 && steps.includes("top_up_streams"), overview.content[0].text.replace(/\n/g, " | ").slice(0, 200));

await proposeAndRun("change_stream_rate", "change_stream_rate", { stream_id: String(first), sender: SENDER, amount: "1440", per: "month" });
s = await status(first);
ok("rate changed", s.rate.hour === "2", `${s.rate.hour}/hour`);
await proposeAndRun("pause_stream", "pause_stream", { stream_id: String(first), sender: SENDER });
s = await status(first);
ok("paused", s.status === "paused", s.status);
await proposeAndRun("resume_stream", "resume_stream", { stream_id: String(first), sender: SENDER, amount: "720", per: "month" });
s = await status(first);
ok("resumed", s.status === "streaming", s.status);

await proposeAndRun("top_up_stream", "top_up_stream", { stream_id: String(first), funder: SENDER, runway_days: 10 });
s = await status(first);
ok("topped up", s.runway.startsWith("9d") || s.runway.startsWith("10d"), `runway ${s.runway}, balance ${s.balance}`);

// reclaim: keep 2 days, take the rest back, stream keeps running
const beforeReclaim = await usdc(SENDER);
await proposeAndRun("reclaim_funds", "reclaim_funds", { stream_id: String(first), sender: SENDER, keep_days: 2 });
s = await status(first);
ok("reclaimed, still streaming", s.status === "streaming" && (s.runway.startsWith("1d") || s.runway.startsWith("2d")) && (await usdc(SENDER)) > beforeReclaim, `runway ${s.runway}`);

// pause, then resume and refuel in the same transaction
await proposeAndRun("pause_stream (again)", "pause_stream", { stream_id: String(first), sender: SENDER });
await proposeAndRun("resume_stream + deposit", "resume_stream", { stream_id: String(first), sender: SENDER, amount: "720", per: "month", runway_days: 5 });
s = await status(first);
ok("resumed with runway", s.status === "streaming" && days(s.runway) >= 4, `runway ${s.runway}`);

// recipient payout (anyone can trigger; funds go to the recipient)
await warp(1_800);
const payeeBefore = await usdc(PAYEES[0]);
await proposeAndRun("withdraw_from_stream", "withdraw_from_stream", { stream_id: String(first) });
ok("recipient paid", (await usdc(PAYEES[0])) > payeeBefore, `+${Number((await usdc(PAYEES[0])) - payeeBefore) / 1e6} USDC`);

// end: pause + refund in one transaction
const senderMid = await usdc(SENDER);
await proposeAndRun("end_stream", "end_stream", { stream_id: String(first), sender: SENDER });
s = await status(first);
ok("ended + refunded", s.status === "paused" && s.refundable_to_sender === "0" && (await usdc(SENDER)) > senderMid, `refund +${Number((await usdc(SENDER)) - senderMid) / 1e6} USDC, recipient still owed ${s.withdrawable_now}`);

// ---------- names, pay_now, warnings ----------
const named = await nextStreamId();
const namedBefore = await usdc(NAMED);
const byName = await proposeAndRun("start_stream to a Base name", "start_stream", { sender: SENDER, recipient: NAME, amount: "100", per: "week", runway_days: 14, pay_now: "25" });
s = await status(named);
ok("Base name resolved", s?.recipient === NAMED && s.recipient_name === NAME, `${NAME} -> ${s?.recipient}`);
ok("pay_now paid in the same transaction", (await usdc(NAMED)) - namedBefore === 25_000_000n, "+25 USDC");
ok("first-time recipient flagged", byName?.structuredContent.warnings.some((warning) => warning.startsWith("First Sablier stream")), byName?.structuredContent.warnings.join(" / "));

const typo = await callTool("start_stream", { sender: SENDER, recipient: PAYEES[0], amount: "3000", per: "hour" });
ok("per-hour typo warned", !typo.isError && typo.structuredContent.warnings.some((warning) => warning.includes("more than ten times")), typo.structuredContent?.warnings?.[0]);

// ---------- payroll operations ----------
await warp(6 * 86_400); // payroll (7 days funded) is now close to running out
const tops = await proposeAndRun("top_up_streams", "top_up_streams", { funder: SENDER, runway_days: 30 });
const funded = await statuses([first + 1, first + 2, first + 3]);
ok("payroll refuelled in one transaction", Number(tops?.structuredContent.details.streams) >= 3 && funded.every((row) => days(row.runway) >= 29), funded.map((row) => `#${row.stream_id} ${row.runway}`).join(" "));

// a second stream to Ada so withdraw_all has two to collect
await proposeAndRun("second stream to Ada", "start_stream", { sender: SENDER, recipient: PAYEES[1], amount: "90", per: "month", runway_days: 30 });
await warp(86_400);
const adaBefore = await usdc(PAYEES[1]);
const collect = await proposeAndRun("withdraw_all", "withdraw_all", { recipient: PAYEES[1] });
const adaGain = (await usdc(PAYEES[1])) - adaBefore;
ok("withdraw_all collected both streams", collect?.structuredContent.details.streams === "2" && adaGain > 0n, `+${Number(adaGain) / 1e6} USDC from #${collect?.structuredContent.details.stream_ids}`);

const beforeEnd = await usdc(SENDER);
await proposeAndRun("end_streams", "end_streams", { sender: SENDER, stream_ids: [String(first + 1), String(first + 2), String(first + 3)] });
const ended = await statuses([first + 1, first + 2, first + 3]);
ok("payroll ended + refunded", ended.every((row) => row.status === "paused" && row.refundable_to_sender === "0") && (await usdc(SENDER)) > beforeEnd, `refund +${Number((await usdc(SENDER)) - beforeEnd) / 1e6} USDC`);

// ---------- pay-me link ----------
const request = await callTool("request_payment", { recipient: NAME, amount: "3000", per: "month", note: "Design retainer" });
const link = request.structuredContent ? new URL(request.structuredContent.link) : null;
ok("request_payment", !request.isError && link?.searchParams.get("pay") === NAMED && link.searchParams.get("name") === NAME && request.structuredContent.prompt.includes(NAME), request.structuredContent?.link);

// ---------- guard rails ----------
const notSender = await callTool("pause_stream", { stream_id: String(first + 1), sender: PAYEES[0] });
ok("non-sender refused", notSender.isError === true, notSender.content[0].text);
const broke = await callTool("start_stream", { sender: PAYEES[0], recipient: PAYEES[2], amount: "100", per: "month" });
ok("insufficient funds refused", broke.isError === true, broke.content[0].text);
const toToken = await callTool("start_stream", { sender: SENDER, recipient: USDC, amount: "100", per: "month" });
ok("token contract refused as recipient", toToken.isError === true, toToken.content[0].text);
const unknown = await callTool("start_stream", { sender: SENDER, recipient: "no-such-name-payday-e2e.base.eth", amount: "100", per: "month" });
ok("unregistered name refused", unknown.isError === true, unknown.content[0].text);
const ens = await callTool("start_stream", { sender: SENDER, recipient: "vitalik.eth", amount: "100", per: "month" });
ok("non-Base ENS refused", ens.isError === true, ens.content[0].text);
const nothing = await callTool("withdraw_all", { recipient: "0x00000000000000000000000000000000000e2e01" });
ok("withdraw_all with nothing waiting refused", nothing.isError === true, nothing.content[0].text);

// ---------- statement (read-only, Base mainnet + Sablier's indexer) ----------
const statement = await callTool("payment_statement", { address: MAINNET_PAYER, month: "2026-10" }, {});
const paid = statement.structuredContent?.spending.totals.USDC;
ok("payment_statement (mainnet)", !statement.isError && paid?.paid === "0.081666" && paid.deposited === "1" && paid.refunded === "0.918334", statement.content[0].text.replace(/\n/g, " | ").slice(0, 220));

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
