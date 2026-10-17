# Payday

**Your AI agent pays people by the second.**

Tell your agent "pay Ada 3,000 USDC a month" and Payday turns it into a live payment stream on Base. The money accrues to Ada every second and she can withdraw whenever she likes. You can top up, pause, change the rate, or end the stream and take back whatever has not been earned. Payroll for up to 25 people takes one approval.

Payday is a [PayBox](https://paybox.sh) plugin. It never holds money or keys: every tool that moves funds only *proposes* a transaction, and PayBox simulates it and asks the owner to approve it with a passkey before anything is signed. Streams run on [Sablier Flow](https://docs.sablier.com/concepts/flow/overview) v3.

Built for MoonPay Hackathons: PayBox Chapter 1.

## For judges: a five-minute tour

You do not need to install anything to check what Payday does.

| # | Look at | Where | What you will see |
|---|---|---|---|
| 1 | The demo video (98 s) | [`docs/demo.mp4`](docs/demo.mp4), also at [jemiiahh.github.io/payday/demo.mp4](https://jemiiahh.github.io/payday/demo.mp4) | The problem, the idea, the real Claude and PayBox run, and the refund |
| 2 | The live dashboard | [jemiiahh.github.io/payday/?a=0x5dae41fd8a0627e3e6d5a3b020696f8cc7c57550](https://jemiiahh.github.io/payday/?a=0x5dae41fd8a0627e3e6d5a3b020696f8cc7c57550) | The payer's wallet, read live from Base: the ended stream, what the recipient earned, and the flip-clock counter. Paste any address to look up its streams. |
| 3 | The three real transactions | [Verified on Base mainnet](#verified-on-base-mainnet) below | Approve exactly 1 USDC, start a stream, end it and refund, all on Basescan |
| 4 | The code | [`src/plugin.ts`](src/plugin.ts) (the 11 tools), [`src/flow.ts`](src/flow.ts) (Sablier calls, amounts, checks) | Small and readable; the payment logic is in `flow.ts` |
| 5 | The tests | [`scripts/e2e.mjs`](scripts/e2e.mjs) | Every tool run against a fork of Base mainnet, with each proposal executed and checked on chain |

**Where the entry lives.** The plugin is submitted as the hackathon entry in the PayBox developer portal. Until PayBox reviews it, it is installed privately on the author's PayBox account, so it is not in the public marketplace yet. The video and the transactions above are a real run of that installed plugin. To run it yourself, see [Try it yourself](#try-it-yourself).

## What problem it solves

Pay is earned every second but usually arrives in lumps. Streaming it today means leaving the chat, opening another app and signing by hand, and few people want to give an AI the keys to a wallet. Payday keeps the agent in the loop without giving it custody: the agent plans and proposes, PayBox shows what will happen, and the human approves.

## How it works

```
you ──"pay Ada 3000 USDC a month"──▶ agent (Claude)
                                       │  use_plugin
                                       ▼
                              Payday plugin  ──reads──▶ Base (Sablier Flow)
                                       │ unsigned proposal (an approval, then a stream)
                                       ▼
                         PayBox: simulates it, asks for your passkey, signs, sends
                                       ▼
                           Sablier Flow streams USDC to Ada, by the second
```

A new stream takes two approvals: first an ERC-20 allowance for exactly the deposit, then the stream itself. Payday checks the wallet, proposes the allowance, and the agent calls it again once that confirms.

## Try it yourself

You need a PayBox account with a Base wallet holding a little USDC (a few cents is enough) and a few cents of ETH for gas. **This runs on Base mainnet with real money.** Keep amounts small.

1. `pnpm install --frozen-lockfile && pnpm test` (Node 24.21.0 and pnpm 11.11.0; see [Build and test](#build-and-test)).
2. Upload `dist/plugin.mjs` in the [PayBox developer portal](https://developer.paybox.sh), add the two network hosts under [Configure](#configure-in-the-paybox-developer-portal), and let the checks pass.
3. Enable it at [app.paybox.sh/plugins](https://app.paybox.sh/plugins), and connect Claude to PayBox with the connector URL `https://api.paybox.sh/mcp`.
4. In a new chat, try these. Replace the address with a wallet you own.
   - `Use the Payday plugin to plan paying someone 3000 USDC per month.` (read-only)
   - `Using the Payday plugin, start paying 0xYourWallet 1 USDC per hour from my PayBox Base wallet, funded with 1 USDC.` (two approvals)
   - `List my Payday streams and show me the status of the new one.`
   - `I authorize this. Using the Payday plugin, end the stream I just started and refund the unearned USDC to me.`

Notes from real use: PayBox proposals expire after about five minutes, so approve promptly. Claude may ask for an explicit go-ahead before a recurring payment; saying "I authorize this" in the prompt avoids the pause. The first approval asks you to connect a signing key once.

## What an agent can do

| Tool | What it does |
|---|---|
| `plan_stream` | Turns an amount per hour/day/week/month/year into Sablier's per-second rate, and works out the deposit for a given runway. Read-only. |
| `start_stream` | Starts one stream (salary, allowance, rent, retainer), funded for a chosen deposit or number of days. |
| `start_payroll` | Starts streams for up to 25 people in **one transaction and one approval**, using Sablier's `batch`. |
| `stream_status` | Live state of up to 25 streams: rate, balance, what the recipient can withdraw now, what the payer could reclaim, unpaid debt, and when funds run out. |
| `list_streams` | Payroll and income overview for an address: monthly outflow and inflow per token, plus streams that are out of funds or run out within 7 days. |
| `top_up_stream` | Adds a fixed amount, or exactly enough to clear unpaid debt and fund N more days. |
| `pause_stream` / `resume_stream` | Stops accrual; the recipient keeps everything earned so far. Resume at the same or a new rate. |
| `change_stream_rate` | Raises or lowers the rate. Pay already earned is locked in at the old rate. |
| `end_stream` | Pauses and refunds all unearned funds to the payer in one transaction. The recipient can still withdraw what they earned. |
| `withdraw_from_stream` | Sends a recipient everything they have earned. Anyone can trigger it; funds always go to the recipient. |

Tokens: USDC (default), EURC, or any ERC-20 on Base with at most 18 decimals.

## How it behaves

- **Exact approvals.** If Sablier can't yet pull the deposit, the tool first proposes an ERC-20 approval for that amount only, never an unlimited one. The agent calls the same tool again once it confirms. Runway top-ups add one hour of headroom, because the amount owed keeps growing while the approval waits.
- **Checks before proposing.** Payday refuses, with a plain reason, when the wallet lacks the tokens or ETH for gas, when someone other than the stream's sender tries to pause/resume/change/end it, when a stream doesn't exist, or when amounts round to zero.
- **Never underpays.** Per-second rates are rounded up, so 3,000/month really pays 3,000 every 30 days. The cost is under a millionth of a token.
- **Stateless.** All state lives on chain. Each call reads Base directly, which suits PayBox's fresh-sandbox-per-call runtime.
- **Live links.** Every stream comes with its Sablier app link (`app.sablier.com/payments/stream/FL4-8453-<id>`), where the balance ticks up in real time.

A month is 30 days and a year is 365 days.

## Companion dashboard

A small web page that shows what an address pays and receives on Sablier Flow, with the earned amounts counting up by the second. PayBox plugins cannot ship their own interface, so this lives beside the plugin as a plain static site. It reads Base straight from the browser, never asks for a wallet connection, and signs nothing.

**https://jemiiahh.github.io/payday/** (add `?a=0xYourAddress` to open it on an address)

It shows a live counter for what you owe recipients and what is waiting for you, one row per stream with its rate, status and runway, and a plain warning when a stream is about to run out of funds. Source is in `site/`; `pnpm site:build` writes the deployable copy to `docs/`.

## Verified on Base mainnet

One full run through Claude, PayBox and Payday on 17 October 2026, from a PayBox wallet (`0x5dae41fd8a0627e3e6d5a3b020696f8cc7c57550`) holding 2 USDC. Every step needed the wallet owner's approval in PayBox.

| Step | What happened | Transaction |
|---|---|---|
| Approve | Sablier allowed to pull exactly 1 USDC, never unlimited | [`0x2510bed4…ee6dfe`](https://basescan.org/tx/0x2510bed4e8c38edcfc30f4bd73f3182dc4d82ee49938742cb36861bfb9ee6dfe) |
| Start stream | Stream 5: 1 USDC an hour to `0xB370…f7be`, funded with 1 USDC | [`0xb9a2afdd…f85422`](https://basescan.org/tx/0xb9a2afdd18208cab8e6e4c3cfaa45c8e4b4fb192f1985591af97d41cacf85422) |
| End stream | Paused and refunded in one transaction after about 4.9 minutes | [`0xc7a1f2fa…1d6632`](https://basescan.org/tx/0xc7a1f2fa5626ecf11429bde1e19e62c2ed5c80fc35e070d820c6e39b0b1d6632) |

The recipient earned 0.081666 USDC and the payer got 0.918334 USDC back, so the two add up to the 1 USDC deposited. The three transactions cost under a cent in gas. [Stream 5 on Sablier](https://app.sablier.com/payments/stream/FL4-8453-5) and the [dashboard view of the payer](https://jemiiahh.github.io/payday/?a=0x5dae41fd8a0627e3e6d5a3b020696f8cc7c57550) show the same state.

## Configure in the PayBox developer portal

Network access (exact hosts):

- `mainnet.base.org`
- `base-rpc.publicnode.com` (fallback)

Optional environment variable: `BASE_RPC_URL`, a private Base RPC that is tried first. Add its host to network access too.

No secrets are needed.

## Build and test

Requires Node.js 24.21.0 and pnpm 11.11.0.

```bash
pnpm install --frozen-lockfile
pnpm test          # type-check, two identical builds, PayBox MCP conformance
```

Upload `dist/plugin.mjs` in the developer portal.

### End-to-end test on a Base fork

`scripts/e2e.mjs` calls every tool through the built bundle, using the same stdio protocol PayBox uses. It then sends each returned proposal as a real transaction from an impersonated USDC holder, on a local fork of Base mainnet, and checks the outcome on chain: accrual after an hour, payroll streams live, rate changes, pause/resume, top-up runway, the recipient's balance after withdrawal, the payer's refund after ending, and the refusals.

```bash
anvil --fork-url https://mainnet.base.org --port 8547
pnpm build && node scripts/e2e.mjs
```

## Contracts

| | Address (Base, chain 8453) |
|---|---|
| Sablier Flow v3.0 | [`0x0cbfe6ce6f05c47d6243bb3818837971c6ccb46b`](https://basescan.org/address/0x0cbfe6ce6f05c47d6243bb3818837971c6ccb46b) |
| USDC | [`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`](https://basescan.org/address/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913) |
| EURC | [`0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42`](https://basescan.org/address/0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42) |

## Credits and pre-existing components

- The build tooling, `src/paybox.ts` proposal helpers, and the conformance scripts in `scripts/` (except `e2e.mjs`) come from the PayBox plugin starter v1.0.2 at developer.paybox.sh.
- Streaming is done by Sablier Flow, deployed and maintained by Sablier Labs. Payday only builds calls to it.
- Libraries: [viem](https://viem.sh), the MCP TypeScript server SDK, and zod.
- The demo video was made with a code-rendered film pipeline. Everything it shows from the run (the prompts, PayBox windows, hashes, times and amounts) is real; the counter in "The stream, replayed" replays the real 4 min 54 s at a stated higher speed, and the lumps-versus-ramp chart is a schematic.

Payday's own code is `src/flow.ts`, `src/plugin.ts`, `scripts/e2e.mjs` and the dashboard in `site/`.

## Limits

- Hackathon software, not audited. Start with small amounts.
- Base mainnet only, with USDC and EURC built in (other ERC-20s on Base work, up to 18 decimals).
- Plugin calls must finish within PayBox's 10-second limit, so lists scan the newest 2,000 streams on Sablier Flow.
- Not yet in the public PayBox marketplace; it is installed privately pending review.
