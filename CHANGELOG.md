# Changelog

## 0.2.0 (October 2026, after the finalist announcement)

PayBox invited finalists to keep improving their plugins before the top three are chosen. Everything below came after the original submission, which is tagged `v0.1.0`.

**Pay people by name.** Recipients can be Base names such as `name.base.eth` as well as 0x addresses. Names resolve on Base itself. When Payday shows a name for an address, it has checked that the name resolves back to that same address, so nobody can make their wallet appear as someone else.

**Payroll that runs itself.** Every operation you need for a team now takes one approval:
- `top_up_streams` funds every stream that is short of N days.
- `end_streams` stops several streams and refunds what hasn't been earned.
- `withdraw_all` lets a payee collect every stream that pays them.

**Money moves for real life:**
- `pay_now`: pay a one-off amount, such as a signing bonus, rent deposit or back pay, in the same transaction that starts the stream.
- `reclaim_funds`: take back overfunding while the stream keeps paying.
- `resume_stream`: can now top the stream up in the same transaction.

**Proof of income.** `payment_statement` produces a monthly statement of what an address earned, withdrew, paid, deposited and was refunded, with year-to-date totals and the transaction behind every figure. Its link opens a printable payslip on the dashboard. The plugin and the dashboard share one statement module (`src/statement.ts`), so they always agree.

A stream that runs dry keeps building up pay it can't cover. Statements count pay as earned only once the stream held the funds to back it, and list the rest separately as unfunded, so a payslip never overstates income.

**Trust nothing a token says about itself.** USDC and EURC are recognised by address. Any other token is shown with its address next to its symbol, so a token that calls itself "USDC" can't pass for USDC in totals, summaries or payslips.

**Get paid.** `request_payment` makes a pay-me link. It opens a page with the request, a live preview, a QR code, a check that the name and address match, and the exact sentence the payer's agent needs.

**Checks before you approve.** Proposals now carry plain-language warnings:
- a deposit that uses most of the wallet;
- a short runway;
- little left for top-ups;
- a per-hour amount that looks like a monthly salary (3,000 per hour is 2.16M a month);
- a first payment to an address.

Payday refuses to pay a token contract or the Sablier contract itself.

**Agent-friendly overviews:**
- `list_streams` returns ready-to-call next steps and pay waiting to be withdrawn.
- `plan_stream` takes a `sender` and checks affordability against what the wallet already streams.

**Discovery that scales.** Streams are found by scanning Base and, when it's reachable, Sablier's public indexer, so older streams aren't missed.

**Dashboard 0.2:**
- Look up any wallet or Base name.
- Each stream row has its history and copy-paste agent prompts.
- Printable payslips.
- Pay-me request pages.
- A pay calculator that shows a paycheck arriving in lumps against a stream that ramps.

**Tests and CI:**
- 18 unit tests for the statement, token-label and amount math, including regressions built from real mainnet streams.
- An independent code review; every finding was fixed and covered by a test. Fixes include:
  - ending a stream before it starts;
  - refunding leftovers in an ended stream;
  - token labels by address;
  - names and notes in pay-me links that can't reach the agent's sentence;
  - full payee addresses in payroll summaries;
  - clear errors for too many decimal places.
- The Base-fork end-to-end suite now runs every one of the 17 tools and checks the outcome on chain.
- GitHub Actions runs everything on each push.

## 0.1.0 (17 October 2026, hackathon submission)

- Eleven tools for Sablier Flow v3 on Base: plan, start, payroll (up to 25 people in one approval), status, list, top up, pause, resume, change rate, end with refund, and withdraw.
- Exact-amount approvals only, checks before anything is proposed, and per-second rates rounded up so a monthly amount is never underpaid.
- Companion dashboard with live counters.
- Verified on Base mainnet through Claude and PayBox: approve, start, then end and refund.
