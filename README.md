# Payday

**Your AI agent pays people by the second.**

[![CI](https://github.com/JemIIahh/payday/actions/workflows/ci.yml/badge.svg)](https://github.com/JemIIahh/payday/actions/workflows/ci.yml) · [Live dashboard](https://jemiiahh.github.io/payday/) · [Changelog](CHANGELOG.md)

Tell your agent "pay my nanny 3,000 USDC a month" and Payday turns it into a live payment stream on Base, to her 0x address or her Base name. She earns every second and can withdraw whenever she likes. You can top up, pause, change the rate, or end it and take back whatever hasn't been earned, to the second. A whole team's payroll takes one approval: to start it, to keep it funded, and to end it.

Payday is a [PayBox](https://paybox.sh) plugin. It never holds money or keys. Every tool that moves funds only *proposes* a transaction; PayBox simulates it and signs only what the wallet's approval policy allows, which can require the owner's approval for every transaction. Streams run on [Sablier Flow](https://docs.sablier.com/concepts/flow/overview) v3.

Built for MoonPay Hackathons: PayBox Chapter 1 (Consumer finance). Version 0.2 adds the improvements listed in the [changelog](CHANGELOG.md), made after Payday was named a finalist. The original submission is tagged `v0.1.0`.

## For judges: a five-minute tour

You don't need to install anything to check what Payday does.

| Look at | Where | What you'll see |
|---|---|---|
| The demo video | [`docs/demo.mp4`](docs/demo.mp4) | The problem, the idea, a real Claude and PayBox run, and the refund |
| A live wallet | [Dashboard for the demo payer](https://jemiiahh.github.io/payday/?a=0x5dae41fd8a0627e3e6d5a3b020696f8cc7c57550) | Streams read live from Base, with each stream's history and the sentence to give your agent for every action |
| Documents from the blockchain | [Payment statement for the payer](https://jemiiahh.github.io/payday/?a=0x5dae41fd8a0627e3e6d5a3b020696f8cc7c57550&statement=2026-10&doc=payments) and [payslip for a payee](https://jemiiahh.github.io/payday/?a=0xb3704310e72538342b0cb28ee41d62e77d64f7be&statement=2026-10&doc=payslip), October 2026 | Paid, paid up front, deposited and refunded to the token unit, with every transaction linked. Print them or save them as PDFs |
| A pay-me link | [Example request: 500 USDC a month to the demo wallet](https://jemiiahh.github.io/payday/?pay=0x5Dae41Fd8A0627E3E6d5a3B020696F8CC7C57550&amount=500&per=month&token=USDC&days=30&note=Example+request+from+the+Payday+README) | What a payer sees: the request, a live preview, a QR code, an address check and the exact sentence for their agent |
| Real transactions | [Verified on Base mainnet](#verified-on-base-mainnet) | A three-person payroll with pay up front in one transaction, and a stream started, ended and refunded, on Basescan |
| The code | [`src/plugin.ts`](src/plugin.ts) (all 17 tools), [`src/flow.ts`](src/flow.ts) (Sablier calls, amounts, checks), [`src/statement.ts`](src/statement.ts) (payslip math) | Small and readable |
| The tests | [`scripts/e2e.mjs`](scripts/e2e.mjs), [`test/statement.test.ts`](test/statement.test.ts), [CI](https://github.com/JemIIahh/payday/actions/workflows/ci.yml) | Every tool run against a fork of Base mainnet, each proposal executed and its outcome checked on chain |

## The problem

Pay is earned every second but arrives in lumps. A nanny, a freelancer or a contractor works all month and waits for the money; a parent's allowance or a roommate's rent is all or nothing; cancelling a subscription halfway through rarely gives anything back. Streaming fixes that, but today it means leaving the chat, opening another app and signing by hand, and few people want to hand an AI the keys to a wallet.

Payday keeps the agent in the loop without giving it custody. The agent plans and proposes, Payday checks and warns, PayBox simulates the transaction, and nothing is signed beyond what the owner's approval policy allows.

## What it looks like

An illustration of the conversation. The wording follows the tools' real output; `name.base.eth` stands for any Base name.

> **You:** Pay name.base.eth 3,000 USDC a month from my PayBox wallet, funded for two weeks, and give her 500 now as a signing bonus.
>
> **Agent:** *(start_stream)* Stream 3000 USDC per month (100/day) to name.base.eth (0x…), funded with 1400 USDC (about 14d 0h of runway), starting now. Also pays 500 USDC to them right away, in the same transaction. Check before approving: first Sablier stream from this wallet to name.base.eth. *[PayBox asks you to approve]*

> **You:** Keep everyone I pay funded for the next 30 days.
>
> **Agent:** *(top_up_streams)* Fund 4 stream(s) for 30 days in one transaction: #11 to name.base.eth +314.28, #10 to 0x… +580.42, … Total 1622.69 USDC.

> **Your nanny:** I need a payslip for my landlord.
>
> **Agent:** *(payment_statement)* 2026-10 statement for name.base.eth: earned 3000 USDC across 1 stream(s); withdrew 2400 USDC. Printable payslip: jemiiahh.github.io/payday/?a=0x…&statement=2026-10

## What an agent can do

| | Tool | What it does |
|---|---|---|
| Plan | `plan_stream` | Converts an amount per hour/day/week/month/year into Sablier's per-second rate and the deposit for a runway. With `sender`, checks affordability: the wallet's balance, what it already streams, and how many months it can keep paying. Read-only. |
| Pay | `start_stream` | Starts one stream (salary, allowance, rent, retainer) to an address or Base name. Optional `pay_now` pays a one-off amount in the same transaction. |
| | `start_payroll` | Starts streams for up to 25 people in **one transaction and one approval**, each with an optional `pay_now`. |
| | `request_payment` | Makes a pay-me link: a page with the request, a QR code and the exact sentence the payer's agent needs. Read-only. |
| Manage | `top_up_stream` | Adds a fixed amount, or exactly enough to clear unpaid debt and fund N more days. |
| | `top_up_streams` | Keeps a whole payroll funded: every stream short of N days, in **one transaction**. |
| | `pause_stream` / `resume_stream` | Stops accrual; the recipient keeps everything earned. Resume at the same or a new rate, optionally refuelling in the same transaction. |
| | `change_stream_rate` | Raises or lowers pay. Pay already earned is locked in at the old rate. |
| | `reclaim_funds` | Takes back overfunding but leaves N days of pay, so the stream keeps running. |
| | `end_stream` / `end_streams` | Stops one stream, or up to 25 in **one transaction**, and refunds everything unearned. Recipients keep what they earned. |
| Get paid | `withdraw_from_stream` | Sends a recipient what they've earned on one stream. |
| | `withdraw_all` | Collects everything earned across every stream that pays an address, in **one transaction**. |
| See | `stream_status` | Live state of up to 25 streams: rate, balance, withdrawable now, refundable, unpaid debt, run-out time, Base names. |
| | `list_streams` | Payroll and income overview for an address, with streams that need attention, pay waiting to be withdrawn, and ready-to-call next steps. |
| | `payment_statement` | A monthly statement (income and pay sent, year to date, every transaction) and a printable payslip link. Pay counts as earned only once a stream held the funds to back it; anything accrued beyond that is listed as unfunded. Read-only. |

Tokens: USDC (default), EURC, or any ERC-20 on Base with at most 18 decimals.

## How it works

```
you ──"pay name.base.eth 3000 USDC a month"──▶ agent (Claude)
                                                │  use_plugin
                                                ▼
                                    Payday plugin ──reads──▶ Base (Sablier Flow, Basenames)
                                                │      └──reads──▶ Sablier indexer (history)
                                                │ unsigned proposal + plain-language warnings
                                                ▼
                               PayBox: simulates it, applies your approval policy, signs, sends
                                                ▼
                               Sablier Flow streams USDC to them, by the second
```

PayBox takes one transaction per proposal. A new stream therefore needs two approvals the first time: an ERC-20 allowance for exactly the amount, then the stream itself. Payday checks the wallet, proposes the allowance, and the agent calls the same tool again once it confirms. Everything else (payroll, bulk top-ups, bulk endings, collecting pay, pay-now amounts) is packed into a single transaction with Sablier's `batch`.

## How it keeps you safe

- **Proposals only.** Payday has no keys. PayBox simulates every proposal and signs only under the owner's approval policy; set it to ask you every time and nothing moves without your approval.
- **Exact approvals.** Payday never asks for an unlimited allowance. A top-up approval adds one hour of headroom, because the amount owed keeps growing while the approval waits.
- **Warnings before approval,** in plain words for the agent to relay:
  - most of the wallet's balance is going into one deposit;
  - the stream is funded for less than three days;
  - the wallet will have little left for top-ups;
  - an hourly or daily amount that looks like a monthly figure;
  - a first-ever stream to this address.
- **Refusals with a reason:**
  - the wallet can't cover the payment or the gas;
  - someone other than the sender tries to manage a stream;
  - the recipient is a token contract or Sablier itself;
  - a name isn't registered;
  - an amount rounds to zero or has more decimal places than the token.
- **Every payee in full.** Payroll summaries show each person's full address next to any label, because a label is only what the agent typed.
- **Names you can trust.** A Base name is resolved on chain and shown next to the full address. Reverse names are only displayed after checking that they resolve back to the same address.
- **Pay-me links can't put words in your agent's mouth.** The page checks the name in the link against its address and blocks copying on a mismatch. The requester's note is shown on the page but never enters the sentence you give your agent.
- **Tokens by address.** USDC and EURC are recognised by contract address. Any other token is shown with its address, so a token calling itself "USDC" can't pass for it.
- **Never underpays.** Per-second rates are rounded up, so 3,000/month really pays 3,000 every 30 days. The extra is under a millionth of a token.
- **Stateless.** All state lives on chain, which suits PayBox's fresh-sandbox-per-call runtime. History comes from Sablier's public indexer; balances are always read live from Base.

A month is 30 days and a year is 365 days.

## Companion dashboard

**https://jemiiahh.github.io/payday/**

PayBox plugins can't ship their own interface, so Payday's lives beside it as a static site. It reads Base and Sablier's indexer straight from the browser, never asks for a wallet connection, and signs nothing. Every action on it is a sentence to copy to your agent.

- `?a=0x…` or `?a=name.base.eth`: live counters for what an address pays and is owed, one row per stream with its runway, history and agent prompts, and warnings when a stream is running dry.
- `?a=…&statement=2026-10`: a printable payslip. It uses the same math as `payment_statement`.
- `?pay=0x…&amount=3000&per=month`: a pay-me request page with a QR code and a name check.
- The home page has a pay calculator and a form for making pay-me links.

Source is in `site/`. `pnpm site:build` writes the deployable copy to `docs/`.

## Try it yourself

You need a PayBox account with a Base wallet holding a little USDC (a few cents is enough) and a few cents of ETH for gas. **This runs on Base mainnet with real money.** Keep amounts small.

1. Run `pnpm install --frozen-lockfile && pnpm test` (Node 24.21.0 and pnpm 11.11.0).
2. Upload `dist/plugin.mjs` in the [PayBox developer portal](https://developer.paybox.sh) and add the network hosts under [Configure](#configure-in-the-paybox-developer-portal).
3. Enable it at [app.paybox.sh/plugins](https://app.paybox.sh/plugins) and connect Claude to PayBox with the connector URL `https://api.paybox.sh/mcp`.
4. In a new chat, try these. Replace the address with one you own.
   - `Use the Payday plugin to plan paying someone 3000 USDC per month, and check whether my PayBox Base wallet can afford it.`
   - `Using the Payday plugin, start paying 0xYourOtherWallet 1 USDC per day from my PayBox Base wallet, funded with 1 USDC, and pay them 0.05 USDC now.`
   - `Using the Payday plugin, show my streams and what needs attention.`
   - `Using the Payday plugin, make a pay-me link for 0xYourOtherWallet for 500 USDC a month.`
   - `Using the Payday plugin, give me my payment statement for this month.`
   - `I authorize this. Using the Payday plugin, end the stream I just started and refund the unearned USDC to me.`

Notes from real use: PayBox proposals expire after about five minutes, so approve promptly. Claude may ask for an explicit go-ahead before a recurring payment; saying "I authorize this" in the prompt avoids the pause. The first approval asks you to connect a signing key once.

## Verified on Base mainnet

### Payday 0.2: a three-person payroll in one transaction (24 October 2026)

Through Claude chat, PayBox and Payday 0.2, from the same PayBox wallet. Claude first checked affordability (`plan_stream` with `sender`), then started the payroll with one sentence.

| Step | What happened | Transaction |
|---|---|---|
| Approve | Sablier allowed to pull exactly 1.60 USDC; the allowance left afterwards is 0 | [`0x078d9bd3…3faa68`](https://basescan.org/tx/0x078d9bd34dbeb7d3bb906f0f37a3579635a4356fdd4433abeb35a5d98b3faa68) |
| Payroll | Streams [7](https://app.sablier.com/payments/stream/FL4-8453-7), [8](https://app.sablier.com/payments/stream/FL4-8453-8) and [9](https://app.sablier.com/payments/stream/FL4-8453-9), at 0.5 USDC a week each, funded for 7 days, plus 0.10 USDC paid to the first payee up front, all in **one transaction** | [`0x6cf5b1d3…9beb04`](https://basescan.org/tx/0x6cf5b1d323ead54c61f2d7446dac9440c18cc398088a5d6caba2f4ba119beb04) |

The streams run until 31 October and tick live on the [dashboard](https://jemiiahh.github.io/payday/?a=0x5dae41fd8a0627e3e6d5a3b020696f8cc7c57550). The payer's [October payment statement](https://jemiiahh.github.io/payday/?a=0x5dae41fd8a0627e3e6d5a3b020696f8cc7c57550&statement=2026-10&doc=payments) and the first payee's [October payslip](https://jemiiahh.github.io/payday/?a=0xb3704310e72538342b0cb28ee41d62e77d64f7be&statement=2026-10&doc=payslip) show the same transactions, including the 0.10 USDC paid up front.

### Payday 0.1: start, end and refund (17 October 2026)

One full run through Claude, PayBox and Payday 0.1 on 17 October 2026, from a PayBox wallet (`0x5dae41fd8a0627e3e6d5a3b020696f8cc7c57550`) holding 2 USDC. Every step needed the wallet owner's approval in PayBox.

| Step | What happened | Transaction |
|---|---|---|
| Approve | Sablier allowed to pull exactly 1 USDC, never unlimited | [`0x2510bed4…ee6dfe`](https://basescan.org/tx/0x2510bed4e8c38edcfc30f4bd73f3182dc4d82ee49938742cb36861bfb9ee6dfe) |
| Start stream | Stream 5: 1 USDC an hour to `0xB370…f7be`, funded with 1 USDC | [`0xb9a2afdd…f85422`](https://basescan.org/tx/0xb9a2afdd18208cab8e6e4c3cfaa45c8e4b4fb192f1985591af97d41cacf85422) |
| End stream | Paused and refunded in one transaction after about 4.9 minutes | [`0xc7a1f2fa…1d6632`](https://basescan.org/tx/0xc7a1f2fa5626ecf11429bde1e19e62c2ed5c80fc35e070d820c6e39b0b1d6632) |

The recipient earned 0.081666 USDC and the payer got 0.918334 USDC back, which adds up to the 1 USDC deposited. The three transactions cost under a cent in gas. The [payment statement for that wallet](https://jemiiahh.github.io/payday/?a=0x5dae41fd8a0627e3e6d5a3b020696f8cc7c57550&statement=2026-10&doc=payments) reproduces those numbers from chain history, and so does the unit test in [`test/statement.test.ts`](test/statement.test.ts).

## Configure in the PayBox developer portal

Network access (exact hosts):

- `mainnet.base.org`
- `base-rpc.publicnode.com` (fallback)
- `indexer.hyperindex.xyz` (Sablier's public indexer: statements, history and older streams; optional, everything else works without it)

Optional environment variables:

- `BASE_RPC_URL`: a private Base RPC to try first. Add its host to network access too.
- `SABLIER_INDEXER_URL`: overrides the indexer endpoint.
- `PAYDAY_SITE_URL`: points payslip and pay-me links at another copy of the dashboard.

No secrets are needed.

## Build and test

Requires Node.js 24.21.0 and pnpm 11.11.0.

```bash
pnpm install --frozen-lockfile
pnpm test          # type-check, two identical builds, PayBox MCP conformance
pnpm test:unit     # statement and amount math
```

Upload `dist/plugin.mjs` in the developer portal.

### End-to-end test on a Base fork

`scripts/e2e.mjs` calls every tool through the built bundle, using the same stdio protocol PayBox uses. It sends each returned proposal as a real transaction from an impersonated USDC holder on a local fork of Base mainnet, then checks the outcome on chain:

- cancelling a stream before it starts;
- accrual after an hour;
- payroll with an upfront payment;
- paying a real Base name;
- rate changes, pause and resume;
- top-ups, bulk top-ups and partial reclaims;
- resuming with new funds;
- collecting pay across two streams;
- ending a payroll in one transaction;
- pay-me links;
- the warnings and the refusals;
- a read-only statement against Base mainnet.

```bash
anvil --fork-url https://mainnet.base.org --port 8547
pnpm build && pnpm e2e
```

CI runs all of this on every push.

## Code map

| File | What's in it |
|---|---|
| `src/plugin.ts` | The 17 tools: inputs, checks, proposals and text for the agent |
| `src/flow.ts` | Sablier Flow v3 calls, amounts and rounding, stream reads, warnings, proposals |
| `src/names.ts` | Base name resolution, with forward-verified reverse lookups |
| `src/discover.ts` | Finding an address's streams (chain scan plus indexer) |
| `src/indexer.ts` | Sablier's public indexer client |
| `src/statement.ts` | Statement math shared by the plugin and the dashboard |
| `site/` | The dashboard: views, chain reads, payslips, pay-me pages |

## Contracts

| | Address (Base, chain 8453) |
|---|---|
| Sablier Flow v3.0 | [`0x0cbfe6ce6f05c47d6243bb3818837971c6ccb46b`](https://basescan.org/address/0x0cbfe6ce6f05c47d6243bb3818837971c6ccb46b) |
| USDC | [`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`](https://basescan.org/address/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913) |
| EURC | [`0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42`](https://basescan.org/address/0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42) |
| Basenames registry | [`0xb94704422c2a1e396835a571837aa5ae53285a95`](https://basescan.org/address/0xb94704422c2a1e396835a571837aa5ae53285a95) |

## Credits and pre-existing components

- The build tooling, the `src/paybox.ts` proposal helpers, and the conformance scripts in `scripts/` (except `e2e.mjs`) come from the PayBox plugin starter v1.0.2 at developer.paybox.sh.
- Streaming is done by Sablier Flow, deployed and maintained by Sablier Labs. Payday only builds calls to it. History comes from Sablier's public Envio indexer.
- Base names are resolved through the Basenames contracts on Base.
- Libraries: [viem](https://viem.sh), the MCP TypeScript server SDK, zod, and [uqr](https://github.com/unjs/uqr) for QR codes on the dashboard.
- The demo video was made with a code-rendered film pipeline. Everything it shows from the run (the prompts, PayBox windows, hashes, times and amounts) is real. The counter in "The stream, replayed" replays the real 4 min 54 s at a stated higher speed, and the lumps-versus-ramp chart is a schematic.

Payday's own code is `src/` (except `paybox.ts`), `test/`, `scripts/e2e.mjs` and the dashboard in `site/`.

## Limits

- Hackathon software, not audited. Start with small amounts.
- Base mainnet only, with USDC and EURC built in (other ERC-20s on Base work, up to 18 decimals).
- Plugin calls must finish within PayBox's 10-second limit. Bulk tools handle up to 25 streams per call, and lists show the newest 25.
- Statements cover Payday's Flow v3 contract and need Sablier's indexer to be reachable.
