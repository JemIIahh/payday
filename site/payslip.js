// The payslip view: a printable monthly statement built from Sablier's indexed history with the same
// math the plugin's payment_statement tool uses (src/statement.ts), so both always agree.
import { getAddress } from "viem";
import { FLOW, client, indexedStreams, namesFor } from "./chain.js";
import { $, h, fill, short, money, dateText, timeText, Odometer } from "./ui.js";
import { creationHashes, monthBounds, streamLines, totals, upfrontFromLogs } from "../src/statement.ts";

const units = (value, decimals) => Number(value) / 10 ** decimals;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthName = (month) => `${MONTHS[Number(month.slice(5)) - 1]} ${month.slice(0, 4)}`;

function shiftMonth(month, delta) {
  const d = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)) - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

const VERB = { Create: "Stream started", Deposit: "Funded", Withdraw: "Withdrawn", Adjust: "Pay changed", Pause: "Paused", Restart: "Resumed", Refund: "Refunded", Void: "Ended", Transfer: "Handed over", Upfront: "Paid up front" };

const NUMERIC = new Set(["Earned", "Withdrawn", "Paid", "Deposited", "Refunded", "Amount", "Not funded", "Up front"]);

/** pay_now payments, read from each stream's creation transaction (newest 25); best effort. */
async function upfrontPayments(history) {
  const hashes = creationHashes(history).slice(0, 25);
  const receipts = await Promise.all(hashes.map((hash) => client.getTransactionReceipt({ hash }).catch(() => null)));
  const logs = new Map(hashes.map((hash, i) => [hash, receipts[i]?.logs ?? null]));
  const found = new Map();
  for (const stream of history) {
    const hash = stream.actions.find((a) => a.category === "Create")?.hash;
    const upfront = hash && logs.get(hash) ? upfrontFromLogs(stream, logs.get(hash)) : null;
    if (upfront) found.set(stream.tokenId, upfront);
  }
  return found;
}

function table(head, rows, className) {
  return h("div", { class: "table-wrap" }, h("table", { class: className },
    h("thead", {}, h("tr", {}, head.filter(Boolean).map((cell) => h("th", { scope: "col", class: NUMERIC.has(cell) ? "num" : null, text: cell })))),
    h("tbody", {}, rows)));
}

export async function showPayslip(owner, ownerName, month) {
  const view = $("payslip");
  const sheet = $("sheet");
  view.hidden = false;
  document.title = `${ownerName ?? short(owner)}, payslip for ${monthName(month)}`;
  sheet.replaceChildren(h("p", { class: "sheet-loading", text: "Reading Sablier's history for this address…" }));

  const bounds = monthBounds(month);
  const now = Math.floor(Date.now() / 1000);
  const next = shiftMonth(month, 1);
  fill($("slipNav"),
    h("a", { class: "pill ink", href: `?a=${owner}&statement=${shiftMonth(month, -1)}`, text: monthName(shiftMonth(month, -1)) }),
    monthBounds(next).from <= now ? h("a", { class: "pill ink", href: `?a=${owner}&statement=${next}`, text: monthName(next) }) : null,
    h("a", { class: "pill ink", href: `?a=${owner}`, text: "Live view" }),
    h("button", { class: "pill solid", type: "button", text: "Print or save as PDF", onclick: () => window.print() }),
  );

  if (bounds.from > now) {
    sheet.replaceChildren(h("p", { class: "sheet-loading", text: `${monthName(month)} hasn't started yet.` }));
    return;
  }
  const to = Math.min(bounds.to, now);
  const history = await indexedStreams(owner);
  if (history === null) {
    sheet.replaceChildren(h("p", { class: "sheet-loading", text: "Sablier's indexer didn't answer, so the history behind this payslip can't be read right now. Try again in a minute." }));
    return;
  }
  const yearStart = Date.UTC(Number(month.slice(0, 4)), 0, 1) / 1000;
  const upfront = await upfrontPayments(history);
  const lines = history.flatMap((s) => streamLines(s, owner, bounds.from, to, upfront.get(s.tokenId)));
  const ytd = history.flatMap((s) => streamLines(s, owner, yearStart, to, upfront.get(s.tokenId)));
  const active = (line) => line.covered > 0n || line.unfunded > 0n || line.upfront > 0n || line.events.length > 0;
  const income = lines.filter((l) => l.side === "income" && active(l));
  const spending = lines.filter((l) => l.side === "spending" && active(l));
  const found = await namesFor([owner, ...lines.map((l) => l.counterparty)]);
  const names = new Map([...found].map(([address, name]) => [address.toLowerCase(), name]));
  const displayName = ownerName ?? names.get(owner.toLowerCase()) ?? null;
  const who = (address) => names.get(address.toLowerCase()) ?? short(getAddress(address));

  const incomeTotals = totals(lines.filter((l) => l.side === "income"));
  const spendTotals = totals(lines.filter((l) => l.side === "spending"));
  const ytdIncome = totals(ytd.filter((l) => l.side === "income"));
  const ytdSpend = totals(ytd.filter((l) => l.side === "spending"));
  const headlineSide = income.length || !spending.length ? "income" : "spending";
  const headTotals = headlineSide === "income" ? incomeTotals : spendTotals;
  const [headSym, head] = Object.entries(headTotals).sort((a, b) => units(b[1].covered, b[1].decimals) - units(a[1].covered, a[1].decimals))[0] ?? ["USDC", { covered: 0n, unfunded: 0n, decimals: 6, withdrawn: 0n, deposited: 0n, refunded: 0n }];
  const headValue = units(head.covered, head.decimals);
  const odo = new Odometer("tiles", headSym);
  odo.set(headValue, headValue > 0 && headValue < 1 ? 6 : 2, true);
  odo.label(`${money(headValue)}`);

  const stat = (text, value) => h("div", { class: "stat" }, h("p", { class: "stat-label", text }), h("p", { class: "stat-value", text: value }));
  const sumText = (record, key) => Object.entries(record).map(([sym, row]) => `${money(units(row[key], row.decimals))} ${sym}`).join(" + ") || "0.00";
  const toDate = bounds.to > now;
  const amountCell = (value, l) => h("td", { class: "num", text: `${money(units(value, l.decimals))} ${l.token}` });
  const streamCell = (l) => h("td", {}, h("a", { href: `https://app.sablier.com/payments/stream/FL4-8453-${l.stream_id}`, target: "_blank", rel: "noopener", text: `#${l.stream_id}` }));
  const incomeGap = income.some((l) => l.unfunded > 0n);
  const spendGap = spending.some((l) => l.unfunded > 0n);
  const incomeUp = income.some((l) => l.upfront > 0n);
  const spendUp = spending.some((l) => l.upfront > 0n);

  const incomeRows = income.map((l) => h("tr", {},
    streamCell(l),
    h("td", { title: getAddress(l.counterparty), text: who(l.counterparty) }),
    amountCell(l.covered, l),
    incomeUp ? amountCell(l.upfront, l) : null,
    amountCell(l.withdrawn, l),
    incomeGap ? amountCell(l.unfunded, l) : null,
  ));
  const spendRows = spending.map((l) => h("tr", {},
    streamCell(l),
    h("td", { title: getAddress(l.counterparty), text: who(l.counterparty) }),
    amountCell(l.covered, l),
    spendUp ? amountCell(l.upfront, l) : null,
    amountCell(l.deposited, l),
    amountCell(l.refunded, l),
    spendGap ? amountCell(l.unfunded, l) : null,
  ));
  const gapNote = (lines, side) => {
    const gap = totals(lines.filter((l) => l.side === side));
    const text = Object.entries(gap).filter(([, row]) => row.unfunded > 0n).map(([sym, row]) => `${money(units(row.unfunded, row.decimals))} ${sym}`).join(" + ");
    if (!text) return null;
    return h("p", { class: "sheet-gap", text: side === "income"
      ? `A further ${text} accrued without funds behind it, because a stream ran dry. It isn't counted as earned until the payer tops the stream up.`
      : `A further ${text} accrued that the streams couldn't cover. Top them up to pay it.` });
  };
  const seen = new Set();
  const events = lines.flatMap((l) => l.events.map((e) => ({ l, e })))
    .filter(({ l, e }) => { const k = `${e.hash}${l.stream_id}${e.category}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.e.timestamp - b.e.timestamp);
  const eventRows = events.map(({ l, e }) => h("tr", {},
    h("td", { text: timeText(e.timestamp) }),
    h("td", { text: `#${l.stream_id}` }),
    h("td", { text: VERB[e.category] ?? e.category }),
    h("td", { class: "num", text: e.amount === null ? "" : `${money(units(e.amount, l.decimals))} ${l.token}` }),
    h("td", {}, h("a", { href: `https://basescan.org/tx/${e.hash}`, target: "_blank", rel: "noopener" },
      h("span", { class: "hash-short", text: `${e.hash.slice(0, 10)}…` }),
      h("span", { class: "hash-full", text: e.hash }))),
  ));

  fill(sheet,
    h("header", { class: "sheet-head" },
      h("div", {},
        h("p", { class: "sheet-brand", text: "Payday" }),
        h("h2", { class: "sheet-who", text: displayName ?? short(owner) }),
        h("p", { class: "sheet-addr", text: owner })),
      h("div", { class: "sheet-period" },
        h("p", { class: "sheet-kind", text: "Pay statement" }),
        h("p", { class: "sheet-month", text: monthName(month) }),
        h("p", { class: "sheet-range", text: `${dateText(bounds.from)} to ${dateText(to - 1)}${toDate ? ", so far" : ""}` }))),
    h("section", { class: "sheet-hero" },
      h("p", { class: "sheet-hero-label", text: headlineSide === "income" ? "Earned this month" : "Paid out this month" }),
      odo.root,
      h("div", { class: "stats" },
        headlineSide === "income"
          ? [incomeUp ? stat("Received up front", sumText(incomeTotals, "upfront")) : null, stat("Withdrawn this month", sumText(incomeTotals, "withdrawn")), stat(`Earned in ${month.slice(0, 4)} so far`, sumText(ytdIncome, "covered"))]
          : [spendUp ? stat("Paid up front", sumText(spendTotals, "upfront")) : null, stat("Deposited this month", sumText(spendTotals, "deposited")), stat("Refunded this month", sumText(spendTotals, "refunded")), stat(`Paid out in ${month.slice(0, 4)} so far`, sumText(ytdSpend, "covered"))],
        headlineSide === "income" && spending.length ? stat("Paid out this month", sumText(spendTotals, "covered")) : null),
      gapNote(lines, headlineSide)),
    income.length ? h("section", { class: "sheet-section" },
      h("h3", { text: "Income" }),
      table(["Stream", "From", "Earned", incomeUp ? "Up front" : null, "Withdrawn", incomeGap ? "Not funded" : null], incomeRows, "slip-table")) : null,
    spending.length ? h("section", { class: "sheet-section" },
      h("h3", { text: "Pay sent" }),
      table(["Stream", "To", "Paid", spendUp ? "Up front" : null, "Deposited", "Refunded", spendGap ? "Not funded" : null], spendRows, "slip-table"),
      headlineSide === "income" ? gapNote(lines, "spending") : null) : null,
    !income.length && !spending.length ? h("p", { class: "sheet-empty", text: `No Payday streams paid or were paid by this address in ${monthName(month)}.` }) : null,
    events.length ? h("section", { class: "sheet-section" },
      h("h3", { text: "Transactions" }),
      table(["When", "Stream", "What", "Amount", "Transaction"], eventRows, "slip-table tx-table")) : null,
    h("footer", { class: "sheet-foot" },
      h("p", { text: `Every figure comes from Sablier Flow v3 on Base (${FLOW}). Pay accrues at each stream's per-second rate; it counts as earned (or paid) once the stream holds the funds to back it. Deposits, withdrawals, refunds and amounts paid up front with a stream are the transactions listed, each linked to Basescan. History is read from Sablier's public indexer and the transactions themselves.` }),
      h("p", { text: `Generated ${timeText(now)}. Months are calendar months in UTC.` })),
  );
}
