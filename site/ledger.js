// The address view: live counters in the hero, one row per stream, agent prompts and per-stream history.
import { loadStreams, namesFor, same } from "./chain.js";
import { streamPrompts, walletPrompts } from "./prompts.js";
import { $, h, short, clamp, fmt, money, span, timeText, copyButton, decimalsFor, Odometer } from "./ui.js";
import { currentMonth } from "../src/statement.ts";

const MONTH = 2_592_000;
const SOON = 7 * 86_400;
const REFRESH_MS = 30_000;

const accruing = (s) => s.status === "pending" || s.status === "streaming" || s.status === "streaming_insolvent";
const flowing = (s) => s.status === "streaming" || s.status === "streaming_insolvent";

function earnedAt(s, t) {
  if (!accruing(s)) return s.debt;
  return s.debt + s.ratePerSec * Math.max(0, t - Math.max(s.readAt, s.snapshot));
}
const withdrawableAt = (s, t) => Math.min(earnedAt(s, t), s.balance);
const dryAt = (s, t) => s.status.endsWith("insolvent") || (flowing(s) && s.depletion != null && s.ratePerSec > 0 && t >= s.depletion);

function stateOf(s, t) {
  if (s.status === "voided") return ["Ended", "end"];
  if (s.status === "pending" && t < s.snapshot) return [`Starts in ${span(s.snapshot - t)}`, "wait"];
  if (s.status === "paused") return ["Paused", "warn"];
  if (s.status === "paused_insolvent") return ["Paused, underfunded", "bad"];
  return dryAt(s, t) ? ["Out of funds", "bad"] : ["Streaming", "ok"];
}

const state = { owner: null, ownerName: null, names: new Map(), streams: [], offset: 0, scanned: 0, filter: "all", token: null, fetchedAt: 0, rows: new Map(), meters: [], timers: [] };
const nowChain = () => (Date.now() + state.offset) / 1000;
const role = (s) => (same(s.sender, state.owner) ? "pay" : "get");
const label = (address) => state.names.get(address) ?? short(address);

// ---------- history ----------

function describeAction(a, s) {
  const amount = (raw) => money(Number(raw) / 10 ** s.decimals);
  const perMonth = (raw) => `${money((Number(raw) / 1e18) * MONTH, 2)} ${s.symbol} a month`;
  switch (a.category) {
    case "Create": return `Started at ${perMonth(a.amountA)}`;
    case "Deposit": return `Funded with ${amount(a.amountA)} ${s.symbol}`;
    case "Withdraw": return `${amount(a.amountA)} ${s.symbol} withdrawn to ${label(a.addressB)}`;
    case "Adjust": return `Pay changed to ${perMonth(a.amountB)}`;
    case "Pause": return "Paused";
    case "Restart": return `Resumed at ${perMonth(a.amountA)}`;
    case "Refund": return `${amount(a.amountA)} ${s.symbol} refunded to the payer`;
    case "Void": return "Ended for good";
    case "Transfer": return `Handed over to ${label(a.addressB)}`;
    default: return a.category;
  }
}

function historyPanel(s) {
  if (!s.history) return h("p", { class: "panel-note", text: "History is unavailable right now (Sablier's indexer didn't answer). Balances above are live from Base." });
  const shown = s.history.filter((a) => a.category !== "Approval" && a.category !== "ApprovalForAll");
  if (!shown.length) return h("p", { class: "panel-note", text: "No history indexed yet. New streams appear within a minute or two." });
  return h("ol", { class: "history" }, shown.slice().reverse().map((a) => h("li", {},
    h("span", { class: "when", text: timeText(Number(a.timestamp)) }),
    h("span", { class: "what", text: describeAction(a, s) }),
    h("a", { href: `https://basescan.org/tx/${a.hash}`, target: "_blank", rel: "noopener", text: "Transaction" }),
  )));
}

function promptPanel(list) {
  return h("ul", { class: "prompts" }, list.map((p) => h("li", {},
    h("p", { class: "prompt-label", text: p.label }),
    h("p", { class: "prompt-text", text: p.text }),
    copyButton(p.text, "Copy"),
  )));
}

// ---------- rows ----------

function makeRow(s) {
  const odo = new Odometer("line", s.symbol);
  const who = h("div", { class: "who" });
  const earned = h("div", { class: "earned" }, odo.root, h("small", { text: "earned so far" }));
  const rate = h("p", { class: "rate" });
  const st = h("span", { class: "state" });
  const terms = h("div", { class: "terms" }, rate, st);
  const fill = h("div", { class: "rail-fill" });
  const owed = h("b"), unearned = h("b"), runway = h("span");
  const rail = h("div", { class: "rail" },
    h("div", { class: "rail-track", role: "img", "aria-label": "Share of the funded balance already earned" }, fill),
    h("p", { class: "rail-text" }, h("span", {}, "Waiting to be withdrawn ", owed), h("span", {}, "Not yet earned ", unearned), runway));
  const panel = h("div", { class: "row-panel", hidden: true });
  const tools = h("div", { class: "row-tools" });
  const el = h("li", { class: "row" }, who, earned, terms, rail, tools, panel);
  const r = { s, el, odo, who, rate, st, fill, owed, unearned, runway, tools, panel, open: null, cache: {} };
  paintWho(r);
  paintTools(r);
  return r;
}

function paintTools(r) {
  const toggle = (key, text, build) => {
    const btn = h("button", { class: "tool", type: "button", "aria-expanded": String(r.open === key), text });
    btn.addEventListener("click", () => {
      r.open = r.open === key ? null : key;
      r.panel.hidden = !r.open;
      r.panel.replaceChildren(...(r.open ? [build()] : []));
      paintTools(r);
    });
    return btn;
  };
  const prompts = streamPrompts(r.s, state.owner);
  r.tools.replaceChildren(...[
    prompts.length ? toggle("ask", "Ask your agent", () => promptPanel(streamPrompts(r.s, state.owner))) : null,
    toggle("history", "History", () => historyPanel(r.s)),
  ].filter(Boolean));
}

function paintWho(r) {
  const s = r.s, pays = role(s) === "pay";
  const other = pays ? s.recipient : s.sender;
  const self = same(s.sender, s.recipient);
  const name = state.names.get(other);
  r.who.replaceChildren(
    h("p", { class: "role", text: self ? "You pay yourself" : pays ? "You pay" : "You receive from" }),
    h("p", { class: "who-name", text: name ?? short(other), title: other }),
    h("p", { class: "who-line" }, name ? h("span", { class: "addr", text: short(other), title: other }) : null, copyButton(other, "Copy address")),
    h("p", { class: "sid" }, h("a", { href: `https://app.sablier.com/payments/stream/FL4-8453-${s.id}`, target: "_blank", rel: "noopener", text: `Stream ${s.id} on Sablier` })),
  );
  r.el.dataset.role = pays ? "pay" : "get";
}

function setText(r, key, node, value) {
  if (r.cache[key] !== value) { r.cache[key] = value; node.textContent = value; }
}

function updateRow(r, t) {
  const s = r.s;
  const earned = earnedAt(s, t);
  r.odo.set(earned, decimalsFor(s.ratePerSec));
  const [text, cls] = stateOf(s, t);
  setText(r, "st", r.st, text);
  if (r.cache.cls !== cls) { r.cache.cls = cls; r.st.className = `state ${cls}`; }
  const monthly = s.ratePerSec * MONTH;
  setText(r, "rate", r.rate, flowing(s) || s.status === "pending" ? `${fmt(monthly, 2)} ${s.symbol} a month` : "No pay while stopped");
  const owed = Math.min(earned, s.balance);
  setText(r, "owed", r.owed, `${fmt(owed, 2)} ${s.symbol}`);
  setText(r, "unearned", r.unearned, `${fmt(Math.max(0, s.balance - earned), 2)} ${s.symbol}`);
  const owes = Math.max(0, earned - s.balance);
  let run = "";
  if (s.status === "voided") run = "Stream ended";
  else if (owes > 0.005) run = `${fmt(owes, 2)} ${s.symbol} owed but unfunded`;
  else if (flowing(s) && s.depletion != null) run = `Runs out in ${span(s.depletion - t)}`;
  else if (!accruing(s)) run = "Not streaming";
  setText(r, "run", r.runway, run);
  const share = s.balance > 0 ? clamp(earned / s.balance, 0, 1) : (earned > 0 ? 1 : 0);
  const w = `${(share * 100).toFixed(1)}%`;
  if (r.cache.w !== w) { r.cache.w = w; r.fill.style.width = w; }
}

// ---------- hero meters + summary ----------

function tokenList() {
  const counts = new Map();
  for (const s of state.streams) counts.set(s.symbol, (counts.get(s.symbol) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([sym]) => sym);
}

function buildMeters() {
  const box = $("meters");
  box.replaceChildren();
  state.meters = [];
  const sym = state.token;
  const mine = state.streams.filter((s) => s.symbol === sym);
  const out = mine.filter((s) => role(s) === "pay");
  const inn = mine.filter((s) => role(s) === "get");
  const groups = [];
  if (out.length) groups.push({ label: "Owed to the people you pay", list: out, kind: "out" });
  if (inn.length) groups.push({ label: "Waiting for you", list: inn, kind: "in" });
  for (const g of groups) {
    const odo = new Odometer("tiles", sym || "USDC");
    const note = h("p", { class: "meter-note" });
    box.append(h("div", { class: "meter" }, h("p", { class: "meter-label", text: g.label }), odo.root, note));
    state.meters.push({ ...g, odo, note, sym, last: "" });
  }
}

/** "Growing by 0.0012 USDC every second", or per minute/hour/day when a smaller unit would round to zero. */
function growthText(rate, sym) {
  const units = [["second", 1], ["minute", 60], ["hour", 3_600], ["day", 86_400]];
  const [unit, seconds] = units.find(([, s]) => rate * s >= 0.001) ?? units[units.length - 1];
  const value = rate * seconds;
  return `Growing by ${fmt(value, value < 1 ? 4 : 2)} ${sym} every ${unit}`;
}

function updateMeters(t, snap = false) {
  for (const m of state.meters) {
    const solvent = m.list.filter((s) => flowing(s) && !dryAt(s, t));
    const rate = solvent.reduce((a, s) => a + s.ratePerSec, 0);
    const dec = decimalsFor(rate);
    const value = m.list.reduce((a, s) => a + (m.kind === "in" ? withdrawableAt(s, t) : earnedAt(s, t)), 0);
    m.odo.set(value, dec, snap);
    const note = rate > 0 ? growthText(rate, m.sym) : "Nothing is flowing right now";
    if (m.last !== note) { m.last = note; m.note.textContent = note; }
    if (!m.labelAt || t - m.labelAt > 5) { m.labelAt = t; m.odo.label(m.odo.text(value, dec)); }
  }
}

function summarize(t) {
  const sym = state.token;
  const mine = state.streams.filter((s) => s.symbol === sym);
  const out = mine.filter((s) => role(s) === "pay" && flowing(s)), inn = mine.filter((s) => role(s) === "get" && flowing(s));
  const sum = (l) => l.reduce((a, s) => a + s.ratePerSec * MONTH, 0);
  const el = $("summary");
  el.replaceChildren();
  $("formMsg").textContent = state.owner && !state.streams.length
    ? `No streams found for ${state.ownerName ?? short(state.owner)} yet. Ask your agent to start one with the Payday plugin in PayBox.`
    : "";
  const bits = [];
  if (out.length) bits.push(`You pay ${fmt(sum(out), 2)} ${sym} a month across ${out.length} running ${out.length === 1 ? "stream" : "streams"}.`);
  if (inn.length) bits.push(`You receive ${fmt(sum(inn), 2)} ${sym} a month across ${inn.length} ${inn.length === 1 ? "stream" : "streams"}.`);
  if (bits.length) el.append(bits.join(" "));
  const left = (s) => (dryAt(s, t) ? -1 : s.depletion - t);
  const needs = state.streams
    .filter((s) => role(s) === "pay" && s.status !== "voided" && (dryAt(s, t) || (flowing(s) && s.depletion != null && s.depletion - t < SOON)))
    .sort((a, b) => left(a) - left(b));
  if (needs.length) {
    const first = needs[0];
    const when = dryAt(first, t) ? "is out of funds" : `runs out in ${span(first.depletion - t)}`;
    el.append(h("span", { class: "alert", text: needs.length === 1
      ? `Needs a top-up: stream ${first.id} ${when}.`
      : `${needs.length} streams need a top-up within a week. Soonest: stream ${first.id}, which ${when}.` }));
  }
  // A payee can't top up, but should know when earned pay isn't covered.
  const dry = state.streams.filter((s) => role(s) === "get" && s.symbol === sym && dryAt(s, t));
  if (dry.length) {
    const unpaid = dry.reduce((a, s) => a + Math.max(0, earnedAt(s, t) - s.balance), 0);
    el.append(h("span", { class: "alert", text: `${dry.length === 1 ? `Stream ${dry[0].id} has` : `${dry.length} streams have`} run out of funds: ${fmt(unpaid, 2)} ${sym} you've earned isn't covered yet. The payer needs to top it up.` }));
  }
}

function renderWallet() {
  const box = $("walletTools");
  box.replaceChildren();
  if (!state.owner || !state.streams.length) { box.hidden = true; return; }
  box.hidden = false;
  const month = currentMonth();
  const paying = state.streams.some((s) => role(s) === "pay" && s.status !== "voided");
  const receiving = state.streams.some((s) => role(s) === "get");
  const monthName = new Date().toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  const panel = h("div", { class: "wallet-panel", hidden: true }, promptPanel(walletPrompts(state.owner, { paying, receiving, month, monthName })));
  const ask = h("button", { class: "pill", type: "button", "aria-expanded": "false", text: "Ask your agent" });
  ask.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    ask.setAttribute("aria-expanded", String(!panel.hidden));
  });
  box.append(
    h("div", { class: "wallet-actions" },
      h("a", { class: "pill solid", href: `?a=${state.owner}&statement=${month}`, text: "Open this month's payslip" }),
      ask),
    panel,
  );
}

function renderFilters() {
  const box = $("filters");
  const pay = state.streams.filter((s) => role(s) === "pay").length, get = state.streams.length - pay;
  box.replaceChildren();
  if (!(pay && get)) { box.hidden = true; state.filter = "all"; return; }
  box.hidden = false;
  for (const [key, text, n] of [["all", "All", pay + get], ["pay", "You pay", pay], ["get", "You receive", get]]) {
    const b = h("button", { class: "pill", type: "button", "aria-pressed": String(state.filter === key), text: `${text} ${n}` });
    b.addEventListener("click", () => { state.filter = key; applyFilter(); renderFilters(); });
    box.append(b);
  }
}

function applyFilter() {
  for (const r of state.rows.values()) r.el.hidden = state.filter !== "all" && r.el.dataset.role !== state.filter;
}

function renderTokens() {
  const box = $("tokens"), list = tokenList();
  box.replaceChildren();
  box.hidden = list.length < 2;
  if (list.length < 2) return;
  for (const sym of list) {
    const b = h("button", { class: "pill", type: "button", "aria-pressed": String(state.token === sym), text: sym });
    b.addEventListener("click", () => { state.token = sym; renderTokens(); buildMeters(); const t = nowChain(); updateMeters(t, true); summarize(t); });
    box.append(b);
  }
}

function showStatus(node) { const el = $("status"); el.replaceChildren(); if (node) el.append(node); }

function render() {
  const rowsEl = $("rows");
  const keep = new Map();
  for (const s of state.streams) {
    const key = s.id.toString();
    let r = state.rows.get(key);
    if (r) { r.s = s; paintWho(r); } else r = makeRow(s);
    keep.set(key, r);
  }
  const changed = keep.size !== state.rows.size || [...keep.keys()].some((k) => !state.rows.has(k));
  state.rows = keep;
  if (changed) rowsEl.replaceChildren(...[...keep.values()].map((r) => r.el));
  if (!state.token || !tokenList().includes(state.token)) state.token = tokenList()[0] || null;
  renderTokens(); renderFilters(); applyFilter(); renderWallet();
  buildMeters();
  const t = nowChain();
  for (const r of state.rows.values()) updateRow(r, t);
  updateMeters(t, true); summarize(t);
  $("owner").replaceChildren(
    h("span", { class: "owner-name", text: state.ownerName ?? short(state.owner) }),
    h("span", { class: "owner-addr", text: state.owner }),
  );
  if (!state.streams.length) {
    showStatus(null);
    rowsEl.replaceChildren(h("li", { class: "empty" },
      h("p", { text: "No streams for this address yet." }),
      h("p", {}, "Ask your agent to start one with the Payday plugin in PayBox, for example ", h("code", { text: "Pay name.base.eth 100 USDC a week" }), ".")));
    state.rows = new Map();
  } else showStatus(null);
}

// ---------- loading ----------

let busy = false;
function setBusy(on) {
  const btn = $("lookup").querySelector("button");
  btn.disabled = on;
  btn.textContent = on ? "Reading Base…" : "Show streams";
}

async function refresh(initial) {
  if (!state.owner || busy) return;
  busy = true;
  if (initial) { setBusy(true); $("formMsg").textContent = ""; showStatus(document.createTextNode("Reading Base…")); }
  try {
    const data = await loadStreams(state.owner);
    const others = data.streams.flatMap((s) => [s.sender, s.recipient]);
    const names = await namesFor([state.owner, ...others]);
    if (state.ownerName) names.set(state.owner, state.ownerName);
    state.ownerName ??= names.get(state.owner) ?? null;
    Object.assign(state, { streams: data.streams, offset: data.offset, scanned: data.scanned, names, fetchedAt: Date.now() });
    render();
  } catch (err) {
    console.error(err);
    if (initial || !state.streams.length) {
      $("formMsg").textContent = "Couldn't reach Base just now. Check your connection and try again.";
      showStatus(h("span", {}, "Couldn't reach Base just now.", h("button", { type: "button", text: "Try again", onclick: () => refresh(true) })));
    }
  } finally { busy = false; if (initial) setBusy(false); }
}

export function showLedger(owner, ownerName) {
  Object.assign(state, { owner, ownerName, names: new Map(), streams: [], rows: new Map(), token: null, filter: "all" });
  $("rows").replaceChildren();
  $("ledger").hidden = false;
  document.title = `${ownerName ?? short(owner)} on Payday`;
  refresh(true);
  if (!state.timers.length) {
    state.timers.push(setInterval(() => {
      if (!state.owner) return;
      const t = nowChain();
      for (const r of state.rows.values()) updateRow(r, t);
      updateMeters(t);
      if (state.fetchedAt) $("updated").textContent = `Updated ${Math.max(0, Math.round((Date.now() - state.fetchedAt) / 1000))}s ago`;
    }, 100));
    state.timers.push(setInterval(() => { if (!document.hidden) refresh(false); }, REFRESH_MS));
    document.addEventListener("visibilitychange", () => { if (!document.hidden && state.owner && Date.now() - state.fetchedAt > 10_000) refresh(false); });
  }
}
