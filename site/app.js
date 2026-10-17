import { createPublicClient, http, fallback, parseAbi, getAddress, isAddress, formatUnits, erc20Abi } from "viem";
import { base } from "viem/chains";

// Replaced at build time (site/build.mjs).
const RPCS = __RPCS__;

const FLOW = "0x0cbfe6ce6f05c47d6243bb3818837971c6ccb46b";
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const SCAN = 2000; // newest stream IDs to scan
const MAX_STREAMS = 50;
const MONTH = 2_592_000;
const SOON = 7 * 86_400;
const REFRESH_MS = 30_000;
const KNOWN = new Map([
  ["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", "USDC"],
  ["0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42", "EURC"],
]);

const flowAbi = parseAbi([
  "function nextStreamId() view returns (uint256)",
  "function isStream(uint256 id) view returns (bool)",
  "function getSender(uint256 id) view returns (address)",
  "function getRecipient(uint256 id) view returns (address)",
  "function getToken(uint256 id) view returns (address)",
  "function getTokenDecimals(uint256 id) view returns (uint8)",
  "function getRatePerSecond(uint256 id) view returns (uint128)",
  "function getBalance(uint256 id) view returns (uint128)",
  "function statusOf(uint256 id) view returns (uint8)",
  "function totalDebtOf(uint256 id) view returns (uint256)",
  "function depletionTimeOf(uint256 id) view returns (uint256)",
  "function getSnapshotTime(uint256 id) view returns (uint40)",
]);
const clockAbi = parseAbi(["function getCurrentBlockTimestamp() view returns (uint256)"]);
const FIELDS = ["isStream", "getSender", "getRecipient", "getToken", "getTokenDecimals", "getRatePerSecond", "getBalance", "statusOf", "totalDebtOf", "depletionTimeOf", "getSnapshotTime"];
const STATUS = ["pending", "streaming", "streaming_insolvent", "paused", "paused_insolvent", "voided"];

const client = createPublicClient({
  chain: base,
  transport: fallback(RPCS.map((url) => http(url, { timeout: 8000, retryCount: 1 }))),
});

const $ = (id) => document.getElementById(id);

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === "text") el.textContent = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids) if (kid != null) el.append(kid);
  return el;
}

const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function fmt(n, d) {
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

function span(sec) {
  sec = Math.max(0, Math.floor(sec));
  const d = Math.floor(sec / 86_400), hr = Math.floor((sec % 86_400) / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (d >= 1) return `${d}d ${hr}h`;
  if (hr >= 1) return `${hr}h ${m}m`;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

// ---------- rolling-digit counter ----------

class Col {
  constructor(digit, cls) {
    this.pos = 10 + digit; // middle of three 0-9 cycles
    this.strip = h("span", { class: "strip" });
    for (let i = 0; i < 30; i++) this.strip.append(h("span", { text: String(i % 10) }));
    this.el = h("span", { class: `col ${cls}`, "aria-hidden": "true" }, h("span", { class: "win" }, this.strip));
    this.apply(false);
    this.strip.addEventListener("transitionend", () => {
      if (this.pos >= 20) { this.pos -= 10; this.apply(false); }
    });
  }
  apply(animate) {
    if (!animate) this.strip.style.transition = "none";
    this.strip.style.setProperty("--p", this.pos);
    if (!animate) { void this.strip.offsetHeight; this.strip.style.transition = ""; }
  }
  go(digit) {
    const cur = this.pos % 10;
    if (digit === cur) return;
    this.pos += digit > cur ? digit - cur : 10 - cur + digit;
    this.apply(true);
  }
}

class Odometer {
  constructor(variant, unit) {
    this.root = h("span", { class: `odo odo-${variant}`, role: "img" });
    this.unit = unit;
    this.slots = [];
    this.layout = "";
    this.prev = -1;
  }
  text(value, decimals) {
    const [int, dec] = value.toFixed(decimals).split(".");
    const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return dec ? `${grouped}.${dec}` : grouped;
  }
  set(value, decimals, snap = false) {
    const text = this.text(value, decimals);
    const layout = text.replace(/\d/g, "0");
    if (snap || layout !== this.layout || value < this.prev - 1e-9) this.build(text, layout);
    else [...text].forEach((ch, i) => { if (/\d/.test(ch)) this.slots[i].go(+ch); });
    this.prev = value;
  }
  build(text, layout) {
    this.layout = layout;
    this.root.replaceChildren();
    this.slots = [];
    let afterDot = false;
    for (const ch of text) {
      if (/\d/.test(ch)) {
        const col = new Col(+ch, afterDot ? "dec" : "int");
        this.slots.push(col);
        this.root.append(col.el);
      } else {
        if (ch === ".") afterDot = true;
        this.slots.push(null);
        this.root.append(h("span", { class: `sep ${ch === "," ? "group" : "dot"}`, text: ch, "aria-hidden": "true" }));
      }
    }
    if (this.unit) this.root.append(h("span", { class: "unit", text: this.unit, "aria-hidden": "true" }));
  }
  label(text) { this.root.setAttribute("aria-label", `${text} ${this.unit || ""}`.trim()); }
}

// ---------- chain reads ----------

async function loadStreams(owner) {
  const next = await client.readContract({ address: FLOW, abi: flowAbi, functionName: "nextStreamId" });
  const ids = [];
  for (let id = next - 1n; id >= 1n && ids.length < SCAN; id--) ids.push(id);

  const parties = ids.length
    ? await client.multicall({
        contracts: ids.flatMap((id) => [
          { address: FLOW, abi: flowAbi, functionName: "getSender", args: [id] },
          { address: FLOW, abi: flowAbi, functionName: "getRecipient", args: [id] },
        ]),
        allowFailure: true,
        batchSize: 100_000,
      })
    : [];
  const mine = ids.filter((_, i) => {
    const s = parties[i * 2], r = parties[i * 2 + 1];
    return (s?.status === "success" && same(s.result, owner)) || (r?.status === "success" && same(r.result, owner));
  }).slice(0, MAX_STREAMS);
  if (!mine.length) return { streams: [], offset: 0, scanned: ids.length };

  const calls = mine.flatMap((id) => FIELDS.map((functionName) => ({ address: FLOW, abi: flowAbi, functionName, args: [id] })));
  calls.push({ address: MULTICALL3, abi: clockAbi, functionName: "getCurrentBlockTimestamp" });
  const res = await client.multicall({ contracts: calls, allowFailure: true, batchSize: 100_000 });
  const clock = res[res.length - 1];
  if (clock.status !== "success") throw new Error("no block timestamp");
  const readAt = Number(clock.result);
  const offset = readAt * 1000 - Date.now();

  const rows = mine.map((id, i) => {
    const cell = (f) => { const r = res[i * FIELDS.length + FIELDS.indexOf(f)]; return r?.status === "success" ? r.result : undefined; };
    return { id, cell };
  }).filter((r) => r.cell("isStream") === true);

  const tokens = [...new Set(rows.map((r) => r.cell("getToken").toLowerCase()))];
  const unknown = tokens.filter((t) => !KNOWN.has(t));
  const symbols = new Map(KNOWN);
  if (unknown.length) {
    const sym = await client.multicall({ contracts: unknown.map((t) => ({ address: t, abi: erc20Abi, functionName: "symbol" })), allowFailure: true });
    unknown.forEach((t, i) => symbols.set(t, sym[i]?.status === "success" ? String(sym[i].result).slice(0, 12) : "TOKEN"));
  }

  const streams = rows.map(({ id, cell }) => {
    const decimals = Number(cell("getTokenDecimals"));
    const human = (v) => Number(formatUnits(v ?? 0n, decimals));
    const token = cell("getToken").toLowerCase();
    const depletion = cell("depletionTimeOf");
    return {
      id,
      sender: getAddress(cell("getSender")),
      recipient: getAddress(cell("getRecipient")),
      token,
      symbol: symbols.get(token) || "TOKEN",
      status: STATUS[Number(cell("statusOf"))] || "pending",
      ratePerSec: Number(cell("getRatePerSecond") ?? 0n) / 1e18,
      balance: human(cell("getBalance")),
      debt: human(cell("totalDebtOf")),
      depletion: depletion && depletion > 0n ? Number(depletion) : null,
      snapshot: Number(cell("getSnapshotTime") ?? 0),
      readAt,
    };
  }).sort((a, b) => (b.id > a.id ? 1 : -1));
  return { streams, offset, scanned: ids.length };
}

// ---------- live values ----------

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

// ---------- state + rendering ----------

const state = { owner: null, streams: [], offset: 0, scanned: 0, filter: "all", token: null, fetchedAt: 0, rows: new Map(), meters: [] };
const nowChain = () => (Date.now() + state.offset) / 1000;
const role = (s) => (same(s.sender, state.owner) ? "pay" : "get");

// Enough decimals that the last digit changes at most about three times a second.
function decimalsFor(rate) {
  return rate > 0 ? clamp(Math.ceil(-Math.log10(rate * 3)), 2, 6) : 2;
}

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
  const el = h("li", { class: "row" }, who, earned, terms, rail);
  const r = { s, el, odo, who, rate, st, fill, owed, unearned, runway, cache: {} };
  paintWho(r);
  return r;
}

function paintWho(r) {
  const s = r.s, pays = role(s) === "pay";
  const other = pays ? s.recipient : s.sender;
  const self = same(s.sender, s.recipient);
  const copy = h("button", { class: "copy", type: "button", "aria-label": `Copy address ${other}`, text: "Copy" });
  copy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(other); copy.textContent = "Copied"; setTimeout(() => (copy.textContent = "Copy"), 1400); } catch { copy.textContent = "Select it"; }
  });
  r.who.replaceChildren(
    h("p", { class: "role", text: self ? "You pay yourself" : pays ? "You pay" : "You receive" }),
    h("p", { class: "who-line" }, h("span", { class: "addr", text: short(other), title: other }), copy),
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
  const [label, cls] = stateOf(s, t);
  setText(r, "st", r.st, label);
  if (r.cache.cls !== cls) { r.cache.cls = cls; r.st.className = `state ${cls}`; }
  const monthly = s.ratePerSec * MONTH;
  setText(r, "rate", r.rate, flowing(s) || s.status === "pending" ? `${fmt(monthly, 2)} ${s.symbol} a month` : "No rate while stopped");
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
  if (out.length) groups.push({ label: "Owed to recipients", note: "Earned by the people you pay and not yet withdrawn", list: out, kind: "out" });
  if (inn.length) groups.push({ label: "Waiting for you", note: "Earned on streams that pay you, ready to withdraw", list: inn, kind: "in" });
  if (!groups.length) groups.push({ label: "Owed to recipients", note: state.owner ? "No streams for this address yet" : "Counters start when you look up an address", list: [], kind: "out", idle: true });
  for (const g of groups) {
    const odo = new Odometer("tiles", sym || "USDC");
    const note = h("p", { class: "meter-note", text: g.idle ? g.note : "" });
    box.append(h("div", { class: "meter" }, h("p", { class: "meter-label", text: g.label }), odo.root, note));
    state.meters.push({ ...g, odo, note, sym, decimals: 2, last: "" });
  }
}

function updateMeters(t, snap = false) {
  for (const m of state.meters) {
    const solvent = m.list.filter((s) => flowing(s) && !dryAt(s, t));
    const rate = solvent.reduce((a, s) => a + s.ratePerSec, 0);
    const dec = decimalsFor(rate);
    const value = m.list.reduce((a, s) => a + (m.kind === "in" ? withdrawableAt(s, t) : earnedAt(s, t)), 0);
    m.odo.set(value, dec, snap);
    const note = m.idle || !m.list.length ? m.note.textContent
      : rate > 0 ? `Growing by ${fmt(rate, 4)} ${m.sym} every second` : "Nothing is flowing right now";
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
  // The result of a lookup is told right under the address field, so it is never below the fold.
  $("formMsg").textContent = state.owner && !state.streams.length
    ? `No streams found for ${short(state.owner)} on Sablier Flow. Ask your agent to start one with the Payday plugin in PayBox.`
    : "";
  const bits = [];
  if (out.length) bits.push(`You pay ${fmt(sum(out), 2)} ${sym} a month across ${out.length} running ${out.length === 1 ? "stream" : "streams"}.`);
  if (inn.length) bits.push(`You receive ${fmt(sum(inn), 2)} ${sym} a month across ${inn.length} ${inn.length === 1 ? "stream" : "streams"}.`);
  if (!bits.length && state.streams.length) bits.push("Nothing is streaming right now.");
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
}

function renderFilters() {
  const box = $("filters");
  const pay = state.streams.filter((s) => role(s) === "pay").length, get = state.streams.length - pay;
  box.replaceChildren();
  if (!(pay && get)) { box.hidden = true; state.filter = "all"; return; }
  box.hidden = false;
  for (const [key, label, n] of [["all", "All", pay + get], ["pay", "You pay", pay], ["get", "You receive", get]]) {
    const b = h("button", { class: "pill", type: "button", "aria-pressed": String(state.filter === key), text: `${label} ${n}` });
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
  renderTokens(); renderFilters(); applyFilter();
  buildMeters();
  const t = nowChain();
  for (const r of state.rows.values()) updateRow(r, t);
  updateMeters(t, true); summarize(t);
  if (!state.streams.length) {
    showStatus(null);
    rowsEl.replaceChildren(h("li", { class: "empty" },
      h("p", { text: "No streams found for this address." }),
      h("p", {}, `Searched the newest ${fmt(state.scanned, 0)} streams on Sablier Flow. Ask your agent to start one with the Payday plugin in PayBox, for example: `, h("code", { text: "Stream 1 USDC an hour to 0x…" }))));
    state.rows = new Map();
  } else showStatus(null);
}

// ---------- loading + wiring ----------

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
    Object.assign(state, { streams: data.streams, offset: data.offset, scanned: data.scanned, fetchedAt: Date.now() });
    render();
  } catch (err) {
    console.error(err);
    if (initial || !state.streams.length) {
      $("formMsg").textContent = "Couldn't reach Base just now. Check your connection and try again.";
      const retry = h("button", { type: "button", text: "Try again" });
      retry.addEventListener("click", () => refresh(true));
      showStatus(h("span", {}, "Couldn't reach Base just now.", retry));
    }
  } finally { busy = false; if (initial) setBusy(false); }
}

function lookup(raw) {
  const value = raw.trim();
  const msg = $("formMsg");
  if (!isAddress(value.toLowerCase(), { strict: false })) {
    msg.textContent = "That doesn't look like a wallet address. It should start with 0x and be 42 characters long.";
    return;
  }
  msg.textContent = "";
  state.owner = getAddress(value.toLowerCase());
  state.streams = []; state.rows = new Map(); state.token = null; state.filter = "all";
  $("rows").replaceChildren();
  $("addr").value = state.owner;
  history.replaceState(null, "", `?a=${state.owner}`);
  refresh(true);
}

$("lookup").addEventListener("submit", (e) => { e.preventDefault(); lookup($("addr").value); });

setInterval(() => {
  if (!state.owner) return;
  const t = nowChain();
  for (const r of state.rows.values()) updateRow(r, t);
  updateMeters(t);
  if (state.fetchedAt) $("updated").textContent = `Updated ${Math.max(0, Math.round((Date.now() - state.fetchedAt) / 1000))}s ago`;
}, 100);
setInterval(() => { if (!document.hidden) refresh(false); }, REFRESH_MS);
document.addEventListener("visibilitychange", () => { if (!document.hidden && state.owner && Date.now() - state.fetchedAt > 10_000) refresh(false); });

buildMeters();
updateMeters(0, true);
const initial = new URLSearchParams(location.search).get("a");
if (initial) lookup(initial);
