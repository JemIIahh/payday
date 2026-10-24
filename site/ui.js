// Small DOM helpers and the rolling-digit counter used by every view.

export const $ = (id) => document.getElementById(id);

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === "text") el.textContent = v;
    else if (k === "html") el.innerHTML = v; // only ever used with SVG we generate ourselves
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}

export const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export function fmt(n, d) {
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** Two decimals at least, up to `max` when they matter: 3000 -> "3,000.00", 0.081666 -> "0.081666". */
export function money(n, max = 6) {
  return n.toLocaleString("en-US", { minimumFractionDigits: Math.min(2, max), maximumFractionDigits: max });
}

/** replaceChildren that skips empty slots (null, false), so conditional sections never print "null". */
export function fill(el, ...kids) {
  el.replaceChildren(...kids.flat().filter((kid) => kid != null && kid !== false));
}

export function span(sec) {
  sec = Math.max(0, Math.floor(sec));
  const d = Math.floor(sec / 86_400), hr = Math.floor((sec % 86_400) / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (d >= 1) return `${d}d ${hr}h`;
  if (hr >= 1) return `${hr}h ${m}m`;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

export const dateText = (seconds) => new Date(seconds * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
export const timeText = (seconds) => new Date(seconds * 1000).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";

/** A button that copies `text` and says so. */
export function copyButton(text, label = "Copy", extraClass = "") {
  const btn = h("button", { class: `copy ${extraClass}`.trim(), type: "button", text: label });
  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(typeof text === "function" ? text() : text);
      btn.textContent = "Copied";
    } catch {
      btn.textContent = "Select and copy";
    }
    setTimeout(() => (btn.textContent = label), 1600);
  });
  return btn;
}

// Enough decimals that the last digit changes at most about three times a second.
export function decimalsFor(rate) {
  return rate > 0 ? clamp(Math.ceil(-Math.log10(rate * 3)), 2, 6) : 2;
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

export class Odometer {
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
