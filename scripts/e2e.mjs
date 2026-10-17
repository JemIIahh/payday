// End-to-end check against a local anvil fork of Base:
//   anvil --fork-url https://mainnet.base.org --port 8547
//   node scripts/e2e.mjs
// Calls every tool through the built bundle (the same stdio protocol PayBox uses), then sends each
// returned proposal as a real transaction from an impersonated USDC holder and checks it succeeds.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createPublicClient, createTestClient, createWalletClient, erc20Abi, http, parseEther } from "viem";
import { base } from "viem/chains";

const RPC = process.env.FORK_RPC ?? "http://127.0.0.1:8547";
const BUNDLE = new URL("../dist/plugin.mjs", import.meta.url).pathname;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const KEY = "io.paybox/transactionProposal";
const SENDER = process.env.E2E_SENDER ?? "0x3304E22DDaa22bCdC5fCa2269b418046aE7b566A";
const PAYEES = ["0x00000000000000000000000000000000000a11ce", "0x0000000000000000000000000000000000000b0b", "0x000000000000000000000000000000000000ca7e", "0x000000000000000000000000000000000000da7e"];

const transport = http(RPC);
const pub = createPublicClient({ chain: base, transport });
const test = createTestClient({ chain: base, mode: "anvil", transport });
const wallet = createWalletClient({ chain: base, transport });

let failures = 0;
const ok = (label, condition, extra = "") => {
  console.log(`${condition ? "PASS" : "FAIL"} ${label}${extra ? `: ${extra}` : ""}`);
  if (!condition) failures++;
};

function callTool(name, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BUNDLE], { env: { PATH: process.env.PATH, BASE_RPC_URL: RPC }, stdio: ["pipe", "pipe", "pipe"] });
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

/** Runs a proposal tool; if it asks for an approval first, executes that and calls again. */
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
  ok(`${label} / ${result.structuredContent.step}`, receipt.status === "success", result.structuredContent.summary.slice(0, 140));
  return receipt;
}

async function status(id) {
  const result = await callTool("stream_status", { stream_ids: [String(id)] });
  return result.structuredContent.streams[0];
}

const warp = async (seconds) => { await test.increaseTime({ seconds }); await test.mine({ blocks: 1 }); };

await test.impersonateAccount({ address: SENDER });
await test.setBalance({ address: SENDER, value: parseEther("10") });
const usdcBefore = await pub.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [SENDER] });
console.log(`sender ${SENDER} holds ${Number(usdcBefore) / 1e6} USDC on the fork`);

const nextId = await pub.readContract({ address: "0x0cbfe6ce6f05c47d6243bb3818837971c6ccb46b", abi: [{ type: "function", name: "nextStreamId", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }], functionName: "nextStreamId" });
const first = Number(nextId);

// plan
const plan = await callTool("plan_stream", { amount: "3000", per: "month", runway_days: 14 });
ok("plan_stream", !plan.isError && plan.structuredContent.pays.month === "3000" && plan.structuredContent.deposit_for_runway === "1400", JSON.stringify(plan.structuredContent.pays));

// single stream: 720 USDC/month (1 USDC per hour), funded with 24 USDC
await proposeAndRun("start_stream", "start_stream", { sender: SENDER, recipient: PAYEES[0], amount: "720", per: "month", deposit: "24" });
let s = await status(first);
ok("stream created", s?.status === "streaming" && s.recipient.toLowerCase() === PAYEES[0].toLowerCase(), `#${first} ${s?.rate.hour}/hour runway ${s?.runway}`);

await warp(3_600);
s = await status(first);
ok("accrues by the second", Number(s.withdrawable_now) >= 1 && Number(s.withdrawable_now) <= 1.01, `withdrawable after 1h = ${s.withdrawable_now}`);

// payroll: three people, one transaction
await proposeAndRun("start_payroll", "start_payroll", { sender: SENDER, per: "month", runway_days: 7, payees: [
  { recipient: PAYEES[1], amount: "300", label: "Ada" },
  { recipient: PAYEES[2], amount: "450", label: "Bayo" },
  { recipient: PAYEES[3], amount: "600", label: "Chi" },
] });
const payroll = await callTool("stream_status", { stream_ids: [String(first + 1), String(first + 2), String(first + 3)] });
ok("payroll streams live", payroll.structuredContent.streams.length === 3 && payroll.structuredContent.streams.every((row) => row.status === "streaming"), payroll.structuredContent.streams.map((row) => `${row.stream_id}:${row.rate.month}`).join(" "));

// overview
const overview = await callTool("list_streams", { address: SENDER });
ok("list_streams", !overview.isError && overview.structuredContent.outgoing.length >= 4, overview.content[0].text.replace(/\n/g, " | "));

// rate change, pause, resume
await proposeAndRun("change_stream_rate", "change_stream_rate", { stream_id: String(first), sender: SENDER, amount: "1440", per: "month" });
s = await status(first);
ok("rate changed", s.rate.hour === "2", `${s.rate.hour}/hour`);
await proposeAndRun("pause_stream", "pause_stream", { stream_id: String(first), sender: SENDER });
s = await status(first);
ok("paused", s.status === "paused", s.status);
await proposeAndRun("resume_stream", "resume_stream", { stream_id: String(first), sender: SENDER, amount: "720", per: "month" });
s = await status(first);
ok("resumed", s.status === "streaming", s.status);

// top up to 10 days of runway
await proposeAndRun("top_up_stream", "top_up_stream", { stream_id: String(first), funder: SENDER, runway_days: 10 });
s = await status(first);
ok("topped up", s.runway.startsWith("9d") || s.runway.startsWith("10d"), `runway ${s.runway}, balance ${s.balance}`);

// recipient payout (anyone can trigger; funds go to the recipient)
await warp(1_800);
const payeeBefore = await pub.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [PAYEES[0]] });
await proposeAndRun("withdraw_from_stream", "withdraw_from_stream", { stream_id: String(first) });
const payeeAfter = await pub.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [PAYEES[0]] });
ok("recipient paid", payeeAfter > payeeBefore, `+${Number(payeeAfter - payeeBefore) / 1e6} USDC`);

// end: pause + refund in one transaction
const senderMid = await pub.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [SENDER] });
await proposeAndRun("end_stream", "end_stream", { stream_id: String(first), sender: SENDER });
s = await status(first);
const senderEnd = await pub.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [SENDER] });
ok("ended + refunded", s.status === "paused" && s.refundable_to_sender === "0" && senderEnd > senderMid, `refund +${Number(senderEnd - senderMid) / 1e6} USDC, recipient still owed ${s.withdrawable_now}`);

// guard rails
const notSender = await callTool("pause_stream", { stream_id: String(first + 1), sender: PAYEES[0] });
ok("non-sender refused", notSender.isError === true, notSender.content[0].text);
const broke = await callTool("start_stream", { sender: PAYEES[0], recipient: PAYEES[1], amount: "100", per: "month" });
ok("insufficient funds refused", broke.isError === true, broke.content[0].text);

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
