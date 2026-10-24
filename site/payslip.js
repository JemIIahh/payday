// Documents: a printable Payslip for whoever is paid and a Payment statement for whoever pays, built from
// Sablier's indexed history with the same math the plugin's payment_statement tool uses (src/statement.ts).
//   ?a=0x…&statement=2026-10[&doc=payslip|payments][&with=0x…]
import { getAddress } from "viem";
import { FLOW, client, indexedStreams, namesFor } from "./chain.js";
import { qr } from "./request.js";
import { $, h, fill, short, money, span, dateText, timeText, Odometer } from "./ui.js";
import { creationHashes, monthBounds, streamLines, totals, upfrontFromLogs } from "../src/statement.ts";

const MONTH_SECONDS = 2_592_000;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthName = (month) => `${MONTHS[Number(month.slice(5)) - 1]} ${month.slice(0, 4)}`;
const units = (value, decimals) => Number(value) / 10 ** decimals;
const lower = (a) => a.toLowerCase();

function shiftMonth(month, delta) {
  const d = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)) - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

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

const amt = (value, line) => `${money(units(value, line.decimals))} ${line.token}`;
const perMonth = (line) => `${money((Number(line.rate) / 1e18) * MONTH_SECONDS, 2)} ${line.token} a month`;
/** "2.14 USDC a month, paid for 6h 2m", or for a stream that has since stopped, what it paid while it ran. */
const rateText = (l) => l.rate_end > 0n
  ? `${perMonth(l)}, paid for ${span(l.seconds)}`
  : l.seconds > 0 ? `Paid ${perMonth(l)} for ${span(l.seconds)}, then stopped` : "Not streaming";
const chevron = (dir) => h("span", { "aria-hidden": "true", html: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="${dir < 0 ? "M15 5l-7 7 7 7" : "M9 5l7 7-7 7"}"/></svg>` });
const active = (line) => line.covered > 0n || line.unfunded > 0n || line.upfront > 0n || line.events.length > 0;

/** One readable line per transaction: "Started streams #7, #8 and #9; funded them with 1.50 USDC; paid 0.10 USDC up front." */
function activityRows(lines) {
  const byTx = new Map();
  for (const line of lines) for (const e of line.events) {
    const row = byTx.get(e.hash) ?? { hash: e.hash, at: e.timestamp, token: line.token, decimals: line.decimals, parts: new Map() };
    const part = row.parts.get(e.category) ?? { ids: new Set(), amount: 0n };
    part.ids.add(line.stream_id);
    if (e.amount !== null) part.amount += e.amount;
    row.parts.set(e.category, part);
    byTx.set(e.hash, row);
  }
  const ids = (set) => { const list = [...set].sort((a, b) => Number(a) - Number(b)).map((id) => `#${id}`); return list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list.at(-1)}` : list[0]; };
  const plural = (set, word) => `${word}${set.size > 1 ? "s" : ""} ${ids(set)}`;
  const say = (row) => {
    const p = row.parts, out = [], v = (cat) => `${money(units(p.get(cat).amount, row.decimals))} ${row.token}`;
    if (p.has("Create")) out.push(`started ${plural(p.get("Create").ids, "stream")}`);
    if (p.has("Deposit")) out.push(p.has("Create") ? `funded ${p.get("Create").ids.size > 1 ? "them" : "it"} with ${v("Deposit")}` : `added ${v("Deposit")} to ${plural(p.get("Deposit").ids, "stream")}`);
    if (p.has("Upfront")) out.push(`paid ${v("Upfront")} up front`);
    if (p.has("Withdraw")) out.push(`${v("Withdraw")} withdrawn from ${plural(p.get("Withdraw").ids, "stream")}`);
    if (p.has("Adjust")) out.push(`changed the pay on ${plural(p.get("Adjust").ids, "stream")}`);
    if (p.has("Pause")) out.push(`paused ${plural(p.get("Pause").ids, "stream")}`);
    if (p.has("Restart")) out.push(`resumed ${plural(p.get("Restart").ids, "stream")}`);
    if (p.has("Refund")) out.push(`${v("Refund")} refunded to the payer`);
    if (p.has("Void")) out.push(`ended ${plural(p.get("Void").ids, "stream")} for good`);
    if (p.has("Transfer")) out.push(`handed over ${plural(p.get("Transfer").ids, "stream")}`);
    const text = out.join("; ");
    return text.charAt(0).toUpperCase() + text.slice(1) + ".";
  };
  return [...byTx.values()].sort((a, b) => a.at - b.at).map((row) => ({ ...row, text: say(row) }));
}

export async function showPayslip(owner, ownerName, month, options = {}) {
  const view = $("payslip");
  const sheet = $("sheet");
  view.hidden = false;
  sheet.replaceChildren(h("p", { class: "doc-loading", text: "Reading this address's pay history from Base…" }));
  $("slipNav").replaceChildren();

  const bounds = monthBounds(month);
  const now = Math.floor(Date.now() / 1000);
  if (bounds.from > now) {
    sheet.replaceChildren(h("p", { class: "doc-loading", text: `${monthName(month)} hasn't started yet.` }));
    return;
  }
  const to = Math.min(bounds.to, now);
  const history = await indexedStreams(owner);
  if (history === null) {
    sheet.replaceChildren(h("p", { class: "doc-loading", text: "Sablier's indexer didn't answer, so the history behind this document can't be read right now. Try again in a minute." }));
    return;
  }
  const upfront = await upfrontPayments(history);
  const yearStart = Date.UTC(Number(month.slice(0, 4)), 0, 1) / 1000;
  const all = history.flatMap((s) => streamLines(s, owner, bounds.from, to, upfront.get(s.tokenId))).filter(active);
  const ytdAll = history.flatMap((s) => streamLines(s, owner, yearStart, to, upfront.get(s.tokenId)));

  const hasIncome = all.some((l) => l.side === "income");
  const hasSpending = all.some((l) => l.side === "spending");
  const doc = options.doc === "payments" && hasSpending ? "payments" : options.doc === "payslip" && hasIncome ? "payslip" : hasIncome ? "payslip" : "payments";
  const side = doc === "payslip" ? "income" : "spending";
  const withAddr = options.with && /^0x[0-9a-fA-F]{40}$/.test(options.with) ? lower(options.with) : null;
  const counterparties = [...new Set(all.filter((l) => l.side === side).map((l) => l.counterparty))];
  const pick = (list) => list.filter((l) => l.side === side && (!withAddr || l.counterparty === withAddr));
  const lines = pick(all);
  const ytd = pick(ytdAll);

  const found = await namesFor([owner, ...counterparties]);
  const names = new Map([...found].map(([a, n]) => [lower(a), n]));
  const nameOf = (a) => names.get(lower(a)) ?? null;
  const label = (a) => nameOf(a) ?? short(getAddress(a));
  const ownerLabel = ownerName ?? nameOf(owner) ?? short(owner);

  // ---------- toolbar (screen only) ----------
  const url = (patch) => {
    const p = new URLSearchParams({ a: owner, statement: month, doc });
    if (withAddr) p.set("with", withAddr);
    for (const [k, v] of Object.entries(patch)) v === null ? p.delete(k) : p.set(k, v);
    return `?${p}`;
  };
  const next = shiftMonth(month, 1);
  const tabs = (hasIncome && hasSpending)
    ? h("div", { class: "seg", role: "group", "aria-label": "Document" },
        h("a", { href: url({ doc: "payslip", with: null }), "aria-current": doc === "payslip" ? "page" : null, text: "Payslip" }),
        h("a", { href: url({ doc: "payments", with: null }), "aria-current": doc === "payments" ? "page" : null, text: "Payment statement" }))
    : h("p", { class: "doc-kind-label", text: doc === "payslip" ? "Payslip" : "Payment statement" });
  const who = counterparties.length > 1 ? h("label", { class: "doc-for" },
    h("span", { text: doc === "payslip" ? "From" : "To" }),
    h("select", { onchange: (e) => { location.search = url({ with: e.target.value || null }); } },
      h("option", { value: "", text: doc === "payslip" ? "All payers" : "Everyone paid", selected: !withAddr }),
      counterparties.map((c) => h("option", { value: c, text: label(c), selected: c === withAddr })))) : null;
  fill($("slipNav"),
    h("div", { class: "doc-bar-main" },
      tabs,
      h("div", { class: "month-nav" },
        h("a", { class: "arrow", href: url({ statement: shiftMonth(month, -1) }), "aria-label": `Previous month, ${monthName(shiftMonth(month, -1))}` }, chevron(-1)),
        h("span", { class: "month-label", text: monthName(month) }),
        monthBounds(next).from <= now
          ? h("a", { class: "arrow", href: url({ statement: next }), "aria-label": `Next month, ${monthName(next)}` }, chevron(1))
          : h("span", { class: "arrow off", "aria-hidden": "true" }, chevron(1))),
      who),
    h("div", { class: "doc-bar-actions" },
      h("a", { class: "pill ink", href: `?a=${owner}`, text: "Live view" }),
      h("button", { class: "pill ink", type: "button", text: "Copy link", onclick: async (e) => {
        const btn = e.currentTarget;
        try { await navigator.clipboard.writeText(location.href); btn.textContent = "Link copied"; } catch { btn.textContent = "Copy the address bar"; }
        setTimeout(() => (btn.textContent = "Copy link"), 1600);
      } }),
      h("button", { class: "pill solid", type: "button", text: "Save as PDF", onclick: () => window.print() })),
  );

  if (!lines.length) {
    sheet.replaceChildren(h("div", { class: "doc-empty" },
      h("p", { class: "doc-empty-title", text: `Nothing ${doc === "payslip" ? "was paid to" : "was paid by"} ${ownerLabel} in ${monthName(month)}.` }),
      h("p", { text: "Try another month with the arrows above, or open the live view." })));
    return;
  }

  // ---------- figures ----------
  const sums = totals(lines);
  const ytdSums = totals(ytd);
  const tokens = Object.entries(sums);
  const [mainToken, main] = tokens.sort((a, b) => units(b[1].covered + b[1].upfront, b[1].decimals) - units(a[1].covered + a[1].upfront, a[1].decimals))[0];
  const total = (row) => row.covered + row.upfront;
  const sumText = (rec, pickFn) => Object.entries(rec).map(([sym, row]) => `${money(units(pickFn(row), row.decimals))} ${sym}`).join(" + ") || "0.00";
  const headline = units(total(main), main.decimals);
  const docNo = `PD-${month.replace("-", "")}-${owner.slice(2, 6).toUpperCase()}${withAddr ? `-${withAddr.slice(2, 6).toUpperCase()}` : ""}-${doc === "payslip" ? "S" : "P"}`;
  const toDate = bounds.to > now;
  const periodText = `${new Date(bounds.from * 1000).getUTCDate()}–${dateText(to - 1)}`;

  // ---------- line items ----------
  const others = () => {
    const list = [...new Set(lines.map((l) => l.counterparty))];
    if (doc === "payslip" || list.length === 1) return list.slice(0, 6).map(party);
    return [h("div", { class: "party-row" }, h("p", { class: "party-name", text: `${list.length} people` }), h("p", { class: "party-list", text: list.map(label).join(", ") }))];
  };
  const party = (a) => h("div", { class: "party-row" }, h("p", { class: "party-name", text: label(a) }), h("p", { class: "party-addr", text: getAddress(a) }));
  const streamLink = (id) => h("a", { href: `https://app.sablier.com/payments/stream/FL4-8453-${id}`, target: "_blank", rel: "noopener", text: `stream #${id}` });
  const itemRow = (title, detail, value) => h("tr", {},
    h("td", {}, h("p", { class: "item-title" }, title), detail ? h("p", { class: "item-detail" }, detail) : null),
    h("td", { class: "num", text: value }));

  let items, summary;
  if (doc === "payslip") {
    items = [
      ...lines.map((l) => itemRow(["Pay from ", label(l.counterparty), ", ", streamLink(l.stream_id)],
        `${rateText(l)}${l.unfunded > 0n ? `. ${amt(l.unfunded, l)} more accrued without funds and isn't counted` : ""}`,
        amt(l.covered, l))),
      ...lines.filter((l) => l.upfront > 0n).map((l) => itemRow(["Paid up front with ", streamLink(l.stream_id)], `From ${label(l.counterparty)}, straight to your wallet`, amt(l.upfront, l))),
    ];
    summary = h("section", { class: "doc-where", "aria-label": "Where your pay is" },
      h("div", {}, h("p", { class: "where-label", text: "Withdrawn to your wallet" }), h("p", { class: "where-value", text: sumText(sums, (r) => r.withdrawn) })),
      h("div", {}, h("p", { class: "where-label", text: "Paid up front" }), h("p", { class: "where-value", text: sumText(sums, (r) => r.upfront) })),
      h("div", { class: "hl" }, h("p", { class: "where-label", text: `Ready to withdraw${toDate ? " now" : ` on ${dateText(to - 1)}`}` }), h("p", { class: "where-value", text: sumText(sums, (r) => r.owed_end) })));
  } else {
    const people = new Map();
    for (const l of lines) {
      const p = people.get(l.counterparty) ?? { who: l.counterparty, ids: [], covered: 0n, upfront: 0n, rate: 0n, line: l };
      p.ids.push(l.stream_id); p.covered += l.covered; p.upfront += l.upfront; p.rate += l.rate_end;
      people.set(l.counterparty, p);
    }
    items = [...people.values()].map((p) => itemRow(
      [label(p.who), ", ", ...p.ids.sort((a, b) => Number(a) - Number(b)).flatMap((id, i) => [i ? ", " : "", streamLink(id)])],
      [`${p.rate > 0n ? `Now ${perMonth({ ...p.line, rate: p.rate })}` : "Not streaming now"}${p.upfront > 0n ? `, including ${amt(p.upfront, p.line)} paid up front` : ""}`,
        h("span", { class: "item-addr", text: getAddress(p.who) })],
      amt(p.covered + p.upfront, p.line)));
    const recon = (labelText, value, cls) => h("tr", { class: cls ?? null }, h("td", { text: labelText }), h("td", { class: "num", text: value }));
    summary = h("section", { class: "doc-recon", "aria-label": "Reconciliation" },
      h("h3", { text: "Money held in your streams" }),
      h("table", { class: "recon" }, h("tbody", {},
        recon(`Held on ${dateText(bounds.from)}`, sumText(sums, (r) => r.held_start)),
        recon("Deposited", `+ ${sumText(sums, (r) => r.deposited)}`),
        recon("Streamed to people", `− ${sumText(sums, (r) => r.covered)}`),
        recon("Refunded to you", `− ${sumText(sums, (r) => r.refunded)}`),
        recon(`Held on ${dateText(to - 1)}`, sumText(sums, (r) => r.held_end), "recon-total"))),
      h("p", { class: "recon-note", text: `Of what people have earned, ${sumText(sums, (r) => r.owed_end)} is still in the streams, waiting for them to withdraw. Amounts paid up front went straight to their wallets and never sat in a stream.` }));
  }

  const gap = Object.entries(sums).filter(([, r]) => r.unfunded > 0n);
  const odo = new Odometer("tiles", mainToken);
  odo.set(headline, headline > 0 && headline < 1 ? 6 : 2, true);
  odo.label(money(headline));
  const docUrl = `${location.origin}${location.pathname}${url({})}`;

  fill(sheet,
    h("article", { class: `doc doc-${doc}` },
      h("header", { class: "doc-head" },
        h("div", {}, h("p", { class: "doc-brand", text: "Payday" }), h("p", { class: "doc-tag", text: "Pay by the second, on Base" })),
        h("div", { class: "doc-title" }, h("h2", { text: doc === "payslip" ? "Payslip" : "Payment statement" }), h("p", { class: "doc-no", text: `No. ${docNo}` }))),
      h("dl", { class: "doc-meta" },
        h("div", {}, h("dt", { text: doc === "payslip" ? "Pay period" : "Period" }), h("dd", {}, periodText, toDate ? h("span", { class: "dd-note", text: "so far" }) : null)),
        h("div", {}, h("dt", { text: "Issued" }), h("dd", { text: timeText(now) })),
        h("div", {}, h("dt", { text: "Paid in" }), h("dd", { text: `${tokens.map(([sym]) => sym).join(", ")} on Base` }))),
      h("section", { class: "doc-parties" },
        h("div", {}, h("p", { class: "party-label", text: doc === "payslip" ? "Paid to" : "Paid by" }), party(owner)),
        h("div", {}, h("p", { class: "party-label", text: doc === "payslip" ? "Paid by" : "Paid to" }), ...others())),
      h("section", { class: "doc-items" },
        h("table", { class: "items" },
          h("thead", {}, h("tr", {}, h("th", { scope: "col", text: doc === "payslip" ? "Earnings" : "People paid" }), h("th", { scope: "col", class: "num", text: "Amount" }))),
          h("tbody", {}, items),
          h("tfoot", {}, h("tr", {}, h("td", { text: doc === "payslip" ? "Total earned" : "Total paid to people" }), h("td", { class: "num" }, h("span", { class: "total-hl", text: sumText(sums, total) })))))),
      summary,
      gap.length ? h("p", { class: "doc-gap", text: doc === "payslip"
        ? `A further ${sumText(Object.fromEntries(gap), (r) => r.unfunded)} accrued after a stream ran out of funds. It isn't counted above until the payer tops the stream up.`
        : `A further ${sumText(Object.fromEntries(gap), (r) => r.unfunded)} accrued that the streams couldn't cover. Top them up to pay it.` }) : null,
      h("div", { class: "doc-stub" },
        h("div", { class: "stub-main" },
          h("p", { class: "stub-label", text: `${doc === "payslip" ? "Total earned" : "Total paid"}, ${monthName(month)}${toDate ? " so far" : ""}` }),
          odo.root,
          h("p", { class: "stub-ytd", text: `${doc === "payslip" ? "Earned" : "Paid"} in ${month.slice(0, 4)} so far: ${sumText(ytdSums, total)}` })),
        h("div", { class: "stub-qr" }, qr(docUrl), h("p", { text: "Scan to check this document against Base" })))),
    h("section", { class: "doc-activity" },
      h("h3", { text: "Activity" }),
      h("ol", { class: "acts" }, activityRows(lines).map((row) => h("li", {},
        h("span", { class: "act-when", text: timeText(row.at) }),
        h("span", { class: "act-what", text: row.text }),
        h("a", { href: `https://basescan.org/tx/${row.hash}`, target: "_blank", rel: "noopener" },
          h("span", { class: "hash-short", text: `${row.hash.slice(0, 10)}…` }),
          h("span", { class: "hash-full", text: row.hash }))))),
      h("p", { class: "doc-foot", text: `Every figure comes from Sablier Flow v3 on Base (${FLOW}) and the transactions above. Pay counts once a stream holds the funds to back it. Months are calendar months in UTC; a month's pay rate assumes 30 days.` })),
  );
  document.title = `${doc === "payslip" ? "Payslip" : "Payment statement"}, ${monthName(month)}, ${ownerLabel}`;
}
