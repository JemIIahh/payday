// Unit tests for the statement math and the amount helpers: pnpm test:unit
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { descale, fundingWarnings, ratePerSecond } from "../src/flow.js";
import { accruedScaled, monthBounds, segments, streamLines, totals, type IndexedStream } from "../src/statement.js";

const USDC = { address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", symbol: "USDC", decimals: "6" };
const PAYER = "0x5dae41fd8a0627e3e6d5a3b020696f8cc7c57550";
const PAYEE = "0xb3704310e72538342b0cb28ee41d62e77d64f7be";
const OTHER = "0x00000000000000000000000000000000000a11ce";
const action = (category: string, timestamp: number, fields: Partial<{ amountA: string; amountB: string; addressA: string; addressB: string }> = {}) => ({
  category, timestamp: String(timestamp), hash: `0x${category.toLowerCase()}${timestamp}`,
  amountA: fields.amountA ?? null, amountB: fields.amountB ?? null, addressA: fields.addressA ?? null, addressB: fields.addressB ?? null,
});

// Payday's verified mainnet run, exactly as Sablier's indexer returns it: stream 5, 1 USDC an hour, ended after 294 s.
const stream5: IndexedStream = {
  tokenId: "5", sender: PAYER, recipient: PAYEE, startTime: "1792265671", asset: USDC,
  actions: [
    action("Create", 1792265671, { amountA: "277777777777778", addressA: PAYER, addressB: PAYEE }),
    action("Deposit", 1792265671, { amountA: "1000000", addressA: PAYER, addressB: PAYEE }),
    action("Pause", 1792265965, { amountA: "81666", addressA: PAYEE, addressB: PAYER }),
    action("Refund", 1792265965, { amountA: "918334", addressA: PAYER }),
  ],
};
const october = monthBounds("2026-10");

describe("statement math", () => {
  it("reproduces the mainnet run to the token unit", () => {
    const [spending] = streamLines(stream5, PAYER, october.from, october.to);
    assert.equal(spending?.side, "spending");
    assert.equal(spending?.covered, 81_666n); // 294 s x 1/3600 USDC, the 0.081666 the recipient earned
    assert.equal(spending?.unfunded, 0n);
    assert.equal(spending?.deposited, 1_000_000n);
    assert.equal(spending?.refunded, 918_334n);
    assert.equal(spending!.covered + spending!.refunded, spending!.deposited);
    const [income] = streamLines(stream5, PAYEE, october.from, october.to);
    assert.equal(income?.side, "income");
    assert.equal(income?.covered, 81_666n);
    assert.equal(income?.withdrawn, 0n);
  });

  it("counts only the part of a stream inside the period", () => {
    const mid = 1792265671 + 100;
    const [before] = streamLines(stream5, PAYEE, october.from, mid);
    const [after] = streamLines(stream5, PAYEE, mid, october.to);
    assert.equal(before!.covered + after!.covered, 81_666n); // cumulative positions, so the parts add up exactly
    assert.equal(streamLines(stream5, PAYEE, monthBounds("2026-11").from, monthBounds("2026-11").to)[0]?.covered, 0n);
  });

  it("never counts pay a dry stream could not cover as earned", () => {
    // Stream 6 on mainnet: 1 USDC an hour, funded with 1 USDC, 0.052222 withdrawn, then left to run dry.
    const t = 1792709275;
    const stream6: IndexedStream = {
      tokenId: "6", sender: OTHER, recipient: PAYEE, startTime: String(t), asset: USDC,
      actions: [
        action("Create", t, { amountA: "277777777777778", addressA: OTHER, addressB: PAYEE }),
        action("Deposit", t, { amountA: "1000000" }),
        action("Withdraw", t + 188, { amountA: "52222", addressA: OTHER, addressB: PAYEE }),
      ],
    };
    const end = t + 100 * 3_600; // a hundred hours later
    const [income] = streamLines(stream6, PAYEE, october.from, end);
    assert.equal(income?.covered, 1_000_000n); // only the 1 USDC that was ever deposited
    assert.equal(income?.covered + income!.unfunded, 100_000_000n); // 100 hours accrued at 1 USDC an hour (rounding up the rate)
    assert.equal(income?.withdrawn, 52_222n);
    const [spending] = streamLines(stream6, OTHER, october.from, end);
    assert.equal(spending?.covered, 1_000_000n);
    assert.equal(spending?.unfunded, income?.unfunded);
  });

  it("follows rate changes, pauses and restarts", () => {
    const t = 1_800_000_000;
    const stream: IndexedStream = {
      tokenId: "9", sender: PAYER, recipient: PAYEE, startTime: String(t), asset: USDC,
      actions: [
        action("Create", t, { amountA: (10n ** 18n).toString(), addressB: PAYEE }), // 1 USDC / s
        action("Adjust", t + 10, { amountA: (10n ** 18n).toString(), amountB: (2n * 10n ** 18n).toString() }), // 2 USDC / s
        action("Pause", t + 20),
        action("Restart", t + 50, { amountA: (3n * 10n ** 18n).toString() }), // 3 USDC / s
      ],
    };
    const pieces = segments(stream);
    assert.deepEqual(pieces.map((piece) => [piece.from, piece.to, piece.rate / 10n ** 18n]), [
      [t, t + 10, 1n], [t + 10, t + 20, 2n], [t + 20, t + 50, 0n], [t + 50, null, 3n],
    ]);
    assert.equal(descale(accruedScaled(pieces, t, t + 60), 6), 60_000_000n); // 10 + 20 + 0 + 30 USDC
  });

  it("starts accruing at a future start time, not at creation", () => {
    const t = 1_800_000_000;
    const stream: IndexedStream = {
      tokenId: "10", sender: PAYER, recipient: PAYEE, startTime: String(t + 100), asset: USDC,
      actions: [action("Create", t, { amountA: (10n ** 18n).toString(), addressB: PAYEE })],
    };
    assert.equal(descale(accruedScaled(segments(stream), t, t + 150), 6), 50_000_000n);
  });

  it("splits income when the stream NFT changes hands", () => {
    const t = 1_800_000_000;
    const stream: IndexedStream = {
      tokenId: "11", sender: PAYER, recipient: OTHER, startTime: String(t), asset: USDC,
      actions: [
        action("Create", t, { amountA: (10n ** 18n).toString(), addressA: PAYER, addressB: PAYEE }),
        action("Deposit", t, { amountA: "500000000" }),
        action("Withdraw", t + 30, { amountA: "30000000", addressA: PAYEE, addressB: PAYEE }),
        action("Transfer", t + 40, { addressA: PAYEE, addressB: OTHER }),
      ],
    };
    const [first] = streamLines(stream, PAYEE, t, t + 100);
    const [second] = streamLines(stream, OTHER, t, t + 100);
    assert.equal(first?.covered, 40_000_000n);
    assert.equal(first?.withdrawn, 30_000_000n);
    assert.equal(second?.covered, 60_000_000n);
    assert.equal(second?.withdrawn, 0n);
    const [spending] = streamLines(stream, PAYER, t, t + 100);
    assert.equal(spending?.covered, 100_000_000n);
    assert.equal(spending?.counterparty, OTHER);
  });

  it("nets written-off debt out of totals", () => {
    const t = 1_800_000_000;
    const stream: IndexedStream = {
      tokenId: "12", sender: PAYER, recipient: PAYEE, startTime: String(t), asset: USDC,
      actions: [
        action("Create", t, { amountA: (10n ** 18n).toString(), addressB: PAYEE }),
        action("Deposit", t, { amountA: "5000000" }),
        action("Void", t + 8, { amountA: "5000000", amountB: "3000000", addressA: PAYEE, addressB: PAYER }),
      ],
    };
    const lines = streamLines(stream, PAYEE, t, t + 100);
    assert.equal(lines[0]?.covered, 5_000_000n); // 8 accrued, 3 written off, 5 funded
    assert.equal(lines[0]?.unfunded, 0n);
    assert.equal(totals(lines).USDC?.covered, 5_000_000n);
  });

  it("handles a self-stream as both income and spending", () => {
    const self = { ...stream5, recipient: PAYER, actions: stream5.actions.map((a) => (a.category === "Create" ? { ...a, addressB: PAYER } : a)) };
    assert.deepEqual(streamLines(self, PAYER, october.from, october.to).map((line) => line.side), ["income", "spending"]);
  });

  it("bounds calendar months in UTC, across a year end", () => {
    assert.deepEqual(monthBounds("2026-12"), { from: Date.UTC(2026, 11, 1) / 1000, to: Date.UTC(2027, 0, 1) / 1000 });
    assert.throws(() => monthBounds("2026-13"));
  });
});

describe("amounts", () => {
  it("rounds per-second rates up, so a month really pays the monthly amount", () => {
    const rate = ratePerSecond("3000", "month");
    assert.ok(descale(rate * 2_592_000n, 6) >= 3_000_000_000n);
    assert.ok(descale(rate * 2_592_000n, 6) - 3_000_000_000n < 1_000n);
  });

  it("keeps tiny rates above zero and refuses a zero rate", () => {
    assert.equal(ratePerSecond("0.000001", "year"), 31_710n); // 1e12 / 31,536,000 s, rounded up
    assert.throws(() => ratePerSecond("0", "month"), /rounds to zero/);
  });
});

describe("funding warnings", () => {
  const token = { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const, symbol: "USDC", decimals: 6 };
  it("stays quiet for an ordinary, well-funded stream", () => {
    assert.deepEqual(fundingWarnings({ token, balance: 50_000_000_000n, outlay: 3_000_000_000n, monthly: 3_000_000_000n, runwaySeconds: 30 * 86_400, per: "month" }), []);
  });
  it("flags a per-hour amount that reads like a monthly salary", () => {
    const warnings = fundingWarnings({ token, balance: 10_000_000_000n, outlay: 72_000_000_000n, monthly: 2_160_000_000_000n, per: "hour" });
    assert.ok(warnings.some((warning) => warning.includes("more than ten times")));
  });
  it("flags a short runway and a thin wallet", () => {
    const warnings = fundingWarnings({ token, balance: 2_000_000n, outlay: 1_000_000n, monthly: 720_000_000n, runwaySeconds: 3_600 });
    assert.equal(warnings.length, 3);
  });
});
