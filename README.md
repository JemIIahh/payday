# Payday

Pay people by the second, from your agent.

Payday is a [PayBox](https://paybox.sh) plugin that turns "pay Ada 3,000 USDC a month" into a live payment stream on Base. Money accrues to the recipient every second and they can withdraw it whenever they like. The payer can top up, pause, change the rate, or end the stream and take back whatever hasn't been earned yet.

Streams run on [Sablier Flow](https://docs.sablier.com/concepts/flow/overview) v3, an audited open-ended streaming protocol. Payday never holds funds or keys. Every tool that moves money returns an unsigned transaction proposal, and PayBox simulates it and asks for the user's approval before anything is signed.

Built for MoonPay Hackathons: PayBox Chapter 1.

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

Payday's own code is `src/flow.ts`, `src/plugin.ts`, `scripts/e2e.mjs` and the dashboard in `site/`.

This is hackathon software and has not been audited. Start with small amounts.
