// The address view: live counters and a summary card in the hero, then a roster of streams grouped into
// paying, receiving and stopped, each with its live counter, rate, runway ring, agent prompts and history.
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

const state = { owner: null, ownerName: null, names: new Map(), streams: [], offset: 0, scanned: 0, token: null, fetchedAt: 0, rows: new Map(), meters: [], timers: [], layout: "" };
const nowChain = () => (Date.now() + state.offset) / 1000;
const role = (s) => (same(s.sender, state.owner) ? "pay" : "get");
const label = (address) => state.names.get(address) ?? short(address);
const stopped = (s) => !accruing(s);

// ---------- small pieces ----------

/** A colour disc per address (two hues from its bytes) with an initial, so people are easy to tell apart. */
function avatar(address, name) {
  const a = parseInt(address.slice(2, 6), 16) % 360, b = (a + 47) % 360;
  const text = name ? name[0].toUpperCase() : address.slice(2, 4).toUpperCase();
  return h("span", { class: "avatar", "aria-hidden": "true", style: `--a:${a};--b:${b}`, text });
}

const COPY_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>';
function copyIcon(text, what) {
  const btn = h("button", { class: "icon-btn", type: "button", "aria-label": `Copy ${what}`, title: `Copy ${what}`, html: COPY_ICON });
  btn.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(text); btn.classList.add("done"); } catch { /* the address is visible to select */ }
    setTimeout(() => btn.classList.remove("done"), 1400);
  });
  return btn;
}

/** A ring showing how much of the funded balance is still unearned: the stream's fuel gauge. */
function ring() {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 44 44"); svg.setAttribute("class", "ring"); svg.setAttribute("aria-hidden", "true");
  const track = document.createElementNS(NS, "circle");
  const arc = document.createElementNS(NS, "circle");
  for (const c of [track, arc]) { c.setAttribute("cx", "22"); c.setAttribute("cy", "22"); c.setAttribute("r", "18"); }
  track.setAttribute("class", "ring-track"); arc.setAttribute("class", "ring-arc");
  svg.append(track, arc);
  return { svg, arc };
}
const CIRC = 2 * Math.PI * 18;

// ---------- history and prompts ----------

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

/** This month's document for one counterparty: their payslip from the payer, or the payer's statement for them. */
function docLink(s) {
  const pays = role(s) === "pay";
  const other = pays ? s.recipient : s.sender;
  return `?a=${state.owner}&statement=${currentMonth()}&doc=${pays ? "payments" : "payslip"}&with=${other.toLowerCase()}`;
}

// ---------- roster rows ----------

function makeRow(s) {
  const odo = new Odometer("line", s.symbol);
  const who = h("div", { class: "r-who" });
  const sub = h("p", { class: "r-small" });
  const earned = h("div", { class: "r-earned" }, odo.root, sub);
  const rateBig = h("p", { class: "r-big" }), rateSmall = h("p", { class: "r-small" });
  const rate = h("div", { class: "r-rate" }, rateBig, rateSmall);
  const { svg, arc } = ring();
  const st = h("p", { class: "state" }), left = h("p", { class: "r-small" });
  const run = h("div", { class: "r-run" }, svg, h("div", {}, st, left));
  const tools = h("div", { class: "r-tools" });
  const panel = h("div", { class: "r-panel", hidden: true });
  const el = h("li", { class: "r" }, h("div", { class: "r-main" }, who, earned, rate, run, tools), panel);
  const r = { s, el, odo, who, sub, rateBig, rateSmall, arc, st, left, tools, panel, open: null, cache: {} };
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
    prompts.length ? toggle("ask", "Ask agent", () => promptPanel(streamPrompts(r.s, state.owner))) : null,
    toggle("history", "History", () => historyPanel(r.s)),
    h("a", { class: "tool", href: docLink(r.s), text: role(r.s) === "pay" ? "Statement" : "Payslip" }),
  ].filter(Boolean));
}

function paintWho(r) {
  const s = r.s, pays = role(s) === "pay";
  const other = pays ? s.recipient : s.sender;
  const name = state.names.get(other);
  r.who.replaceChildren(
    avatar(other, name),
    h("div", { class: "r-id" },
      h("p", { class: "r-name" }, h("span", { text: name ?? short(other), title: other }), copyIcon(other, "address")),
      h("p", { class: "r-small" },
        same(s.sender, s.recipient) ? "Pays yourself, " : pays ? "" : "Pays you, ",
        h("a", { href: `https://app.sablier.com/payments/stream/FL4-8453-${s.id}`, target: "_blank", rel: "noopener", text: `stream ${s.id}` }))),
  );
  r.el.classList.toggle("is-stopped", stopped(s));
}

function setText(r, key, node, value) {
  if (r.cache[key] !== value) { r.cache[key] = value; node.textContent = value; }
}

function updateRow(r, t) {
  const s = r.s, pays = role(s) === "pay";
  const earned = earnedAt(s, t);
  r.odo.set(earned, decimalsFor(s.ratePerSec));
  const waiting = Math.min(earned, s.balance);
  setText(r, "sub", r.sub, waiting > 0.000001 ? `${fmt(waiting, waiting < 1 ? 4 : 2)} ${pays ? "not withdrawn yet" : "ready to withdraw"}` : "all withdrawn");
  const live = flowing(s) || s.status === "pending";
  setText(r, "rb", r.rateBig, live ? `${fmt(s.ratePerSec * MONTH, 2)} ${s.symbol}` : "Stopped");
  setText(r, "rs", r.rateSmall, live ? "a month" : "no pay accruing");
  const [text, cls] = stateOf(s, t);
  setText(r, "st", r.st, text);
  if (r.cache.cls !== cls) { r.cache.cls = cls; r.st.className = `state ${cls}`; r.el.dataset.state = cls; }
  const owes = Math.max(0, earned - s.balance);
  let leftText = "";
  if (s.status === "voided") leftText = "Stream ended";
  else if (owes > 0.005) leftText = `${fmt(owes, 2)} ${s.symbol} unfunded`;
  else if (flowing(s) && s.depletion != null) leftText = `${span(s.depletion - t)} left`;
  else if (s.status === "pending") leftText = `${fmt(s.balance, 2)} ${s.symbol} funded`;
  else leftText = `${fmt(Math.max(0, s.balance - earned), 2)} ${s.symbol} unearned`;
  setText(r, "left", r.left, leftText);
  const fuel = s.balance > 0 ? clamp((s.balance - Math.min(earned, s.balance)) / s.balance, 0, 1) : 0;
  const dash = `${(fuel * CIRC).toFixed(1)} ${CIRC.toFixed(1)}`;
  if (r.cache.dash !== dash) { r.cache.dash = dash; r.arc.setAttribute("stroke-dasharray", dash); r.arc.style.opacity = fuel > 0.004 ? "1" : "0"; }
}

// ---------- hero: counters and summary card ----------

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

/** The card beside the counters: monthly totals, the next top-up, any shortfall, documents and agent prompts. */
function summarize(t) {
  const sym = state.token;
  const mine = state.streams.filter((s) => s.symbol === sym);
  const out = mine.filter((s) => role(s) === "pay" && flowing(s)), inn = mine.filter((s) => role(s) === "get" && flowing(s));
  const sum = (l) => l.reduce((a, s) => a + s.ratePerSec * MONTH, 0);
  const people = (l) => new Set(l.map((s) => (role(s) === "pay" ? s.recipient : s.sender))).size;
  $("formMsg").textContent = state.owner && !state.streams.length
    ? `No streams found for ${state.ownerName ?? short(state.owner)} yet. Ask your agent to start one with the Payday plugin in PayBox.`
    : "";
  const stat = (k, v, note, cls = "") => h("div", { class: `stat-card ${cls}`.trim() }, h("p", { class: "sc-label", text: k }), h("p", { class: "sc-value", text: v }), note ? h("p", { class: "sc-note", text: note }) : null);
  const stats = [];
  if (out.length) stats.push(stat("You pay", `${fmt(sum(out), 2)} ${sym}`, `a month, to ${people(out)} ${people(out) === 1 ? "person" : "people"}`));
  if (inn.length) stats.push(stat("You receive", `${fmt(sum(inn), 2)} ${sym}`, `a month, from ${people(inn)} ${people(inn) === 1 ? "payer" : "payers"}`));
  const incoming = mine.filter((s) => role(s) === "get");
  const ready = incoming.reduce((a, s) => a + withdrawableAt(s, t), 0);
  if (incoming.length && ready > 0.000001) stats.push(stat("Ready to withdraw", `${fmt(ready, ready < 1 ? 4 : 2)} ${sym}`, `across ${incoming.filter((s) => withdrawableAt(s, t) > 0.000001).length} ${incoming.length === 1 ? "stream" : "streams"}`, "good"));
  const left = (s) => (dryAt(s, t) ? -1 : s.depletion - t);
  const needs = state.streams
    .filter((s) => role(s) === "pay" && s.status !== "voided" && (dryAt(s, t) || (flowing(s) && s.depletion != null)))
    .sort((a, b) => left(a) - left(b));
  if (needs.length) {
    const first = needs[0];
    const soon = dryAt(first, t) || first.depletion - t < SOON;
    stats.push(stat("Next top-up", dryAt(first, t) ? "Now" : `In ${span(first.depletion - t)}`, `${label(first.recipient)}, stream ${first.id}`, soon ? "warn" : ""));
  }
  const alerts = [];
  const dry = state.streams.filter((s) => role(s) === "get" && s.symbol === sym && dryAt(s, t));
  if (dry.length) {
    const unpaid = dry.reduce((a, s) => a + Math.max(0, earnedAt(s, t) - s.balance), 0);
    alerts.push(h("p", { class: "card-alert", text: `${dry.length === 1 ? `Stream ${dry[0].id} has` : `${dry.length} streams have`} run out of funds: ${fmt(unpaid, 2)} ${sym} you've earned isn't covered yet. The payer needs to top it up.` }));
  }
  const el = $("summary");
  el.replaceChildren(...(stats.length ? [h("div", { class: "stat-grid" }, stats)] : []), ...alerts);
}

function renderWallet() {
  const box = $("walletTools");
  box.replaceChildren();
  if (!state.owner || !state.streams.length) { box.hidden = true; return; }
  box.hidden = false;
  const month = currentMonth();
  const paying = state.streams.some((s) => role(s) === "pay" && s.status !== "voided");
  const receiving = state.streams.some((s) => role(s) === "get");
  const everPaid = state.streams.some((s) => role(s) === "pay");
  const monthName = new Date().toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  const panel = h("div", { class: "wallet-panel", hidden: true }, promptPanel(walletPrompts(state.owner, { paying, receiving, month, monthName })));
  const ask = h("button", { class: "pill ink", type: "button", "aria-expanded": "false", text: "Ask your agent" });
  ask.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    ask.setAttribute("aria-expanded", String(!panel.hidden));
  });
  box.append(
    h("p", { class: "sc-label", text: `${monthName} documents` }),
    h("div", { class: "wallet-actions" },
      receiving ? h("a", { class: "pill solid", href: `?a=${state.owner}&statement=${month}&doc=payslip`, text: "Payslip" }) : null,
      everPaid ? h("a", { class: receiving ? "pill ink" : "pill solid", href: `?a=${state.owner}&statement=${month}&doc=payments`, text: "Payment statement" }) : null,
      ask),
    panel,
  );
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

/** Paying and receiving rosters, with stopped streams gathered at the end. */
function groups() {
  const live = (r) => !stopped(r.s);
  const rows = [...state.rows.values()];
  return [
    ["You pay", rows.filter((r) => role(r.s) === "pay" && live(r))],
    ["You receive", rows.filter((r) => role(r.s) === "get" && live(r))],
    ["Stopped", rows.filter((r) => !live(r))],
  ].filter(([, list]) => list.length);
}

function render() {
  const rowsEl = $("rows");
  const keep = new Map();
  for (const s of state.streams) {
    const key = s.id.toString();
    let r = state.rows.get(key);
    if (r) { r.s = s; paintWho(r); } else r = makeRow(s);
    keep.set(key, r);
  }
  state.rows = keep;
  const layout = groups().map(([title, list]) => `${title}:${list.map((r) => r.s.id).join(",")}`).join("|");
  if (layout !== state.layout) {
    state.layout = layout;
    rowsEl.replaceChildren(...groups().map(([title, list]) => h("section", { class: "roster-group" },
      h("h3", { class: "roster-title" }, title, h("span", { class: "roster-count", text: String(list.length) })),
      h("div", { class: "roster" },
        h("div", { class: "r-head", "aria-hidden": "true" },
          h("span", { text: title === "You receive" ? "Payer" : "Person" }), h("span", { text: "Earned so far" }), h("span", { text: "Pay" }), h("span", { text: "Runway" }), h("span")),
        h("ol", { class: "r-list" }, list.map((r) => r.el))))));
  }
  if (!state.token || !tokenList().includes(state.token)) state.token = tokenList()[0] || null;
  renderTokens(); renderWallet();
  buildMeters();
  const t = nowChain();
  for (const r of state.rows.values()) updateRow(r, t);
  updateMeters(t, true); summarize(t);
  const name = state.ownerName;
  $("owner").replaceChildren(
    h("h1", { class: "owner-name", text: name ?? short(state.owner) }),
    h("p", { class: "owner-addr" },
      h("span", { text: state.owner }),
      copyIcon(state.owner, "wallet address"),
      h("a", { href: `https://basescan.org/address/${state.owner}`, target: "_blank", rel: "noopener", text: "Basescan" })),
  );
  if (!state.streams.length) {
    showStatus(null);
    state.layout = "";
    rowsEl.replaceChildren(h("div", { class: "empty" },
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
  btn.textContent = on ? "Reading…" : $("lookup").classList.contains("compact") ? "Look up" : "Show streams";
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
  Object.assign(state, { owner, ownerName, names: new Map(), streams: [], rows: new Map(), token: null, layout: "" });
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
