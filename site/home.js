// The home view: a pay calculator (what a salary looks like by the second) and the pay-me link maker.
import { resolveInput } from "./chain.js";
import { PERIODS, qr, requestLink } from "./request.js";
import { $, h, money, copyButton, decimalsFor, whatsappButton, Odometer } from "./ui.js";

const AMOUNT = /^(0|[1-9][0-9]{0,17})(\.[0-9]{1,18})?$/;
const NS = "http://www.w3.org/2000/svg";

function svg(tag, attrs, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...kids);
  return el;
}

/** Sixty days of money received: a monthly paycheck (two steps) against a stream (one straight ramp). */
function rampChart(perMonth, symbol) {
  const W = 640, H = 260, L = 8, R = 150, T = 18, B = 34;
  const x = (day) => L + (day / 60) * (W - L - R);
  const y = (value) => H - B - (value / (perMonth * 2)) * (H - T - B);
  const steps = `M${x(0)},${y(0)} H${x(30)} V${y(perMonth)} H${x(60)} V${y(perMonth * 2)}`;
  const ramp = `M${x(0)},${y(0)} L${x(60)},${y(perMonth * 2)}`;
  const gap = `M${x(0)},${y(0)} L${x(30)},${y(perMonth)} L${x(30)},${y(0)} Z M${x(30)},${y(perMonth)} L${x(60)},${y(perMonth * 2)} L${x(60)},${y(perMonth)} Z`;
  const text = (content, attrs) => svg("text", attrs, content);
  return svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "ramp", role: "img", "aria-label": `Over 60 days a monthly paycheck arrives in two lumps of ${money(perMonth, 0)} ${symbol}; a stream pays the same total continuously.` },
    svg("line", { x1: x(0), y1: y(0), x2: x(60), y2: y(0), class: "axis" }),
    ...[0, 30, 60].map((day) => text(day === 0 ? "Today" : `Day ${day}`, { x: x(day), y: H - 10, class: "tick", "text-anchor": day === 0 ? "start" : "middle" })),
    svg("path", { d: gap, class: "gap" }),
    svg("path", { d: steps, class: "steps" }),
    svg("path", { d: ramp, class: "line" }),
    text("Payday stream", { x: x(60) + 12, y: y(perMonth * 2) + 5, class: "lbl lbl-line" }),
    text("Monthly paycheck", { x: x(60) + 12, y: y(perMonth * 2) + 28, class: "lbl lbl-steps" }),
  );
}

function calculator() {
  const amount = $("calcAmount"), per = $("calcPer"), token = $("calcToken");
  const odo = new Odometer("tiles", "USDC");
  $("calcMeter").replaceChildren(odo.root);
  let opened = performance.now();
  let perSecond = 0;
  const paint = () => {
    const value = AMOUNT.test(amount.value.trim()) ? Number(amount.value.trim()) : 0;
    const symbol = token.value;
    perSecond = value / PERIODS[per.value];
    opened = performance.now();
    odo.unit = symbol;
    odo.set(0, decimalsFor(perSecond), true);
    const rows = [["second", 1], ["hour", 3_600], ["day", 86_400], ["week", 604_800], ["month", 2_592_000]];
    $("calcRates").replaceChildren(...rows.map(([unit, seconds]) => h("li", {}, h("span", { text: `${unit === "hour" ? "An" : "A"} ${unit}` }), h("b", { text: `${money(perSecond * seconds, unit === "second" ? 6 : 2)} ${symbol}` }))));
    const perMonth = perSecond * 2_592_000;
    $("calcChart").replaceChildren(
      rampChart(perMonth || 1, symbol),
      h("p", { class: "chart-note", text: `On day 29 a monthly paycheck has paid nothing yet. A stream has already paid ${money(perMonth * 29 / 30, 2)} ${symbol}, and the yellow is the money you'd otherwise wait for.` }),
    );
  };
  for (const el of [amount, per, token]) el.addEventListener("input", paint);
  paint();
  setInterval(() => odo.set(perSecond * (performance.now() - opened) / 1000, decimalsFor(perSecond)), 100);
}

function askForm() {
  const form = $("askForm"), msg = $("askMsg"), out = $("askOut");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const amount = String(data.get("amount") ?? "").trim();
    msg.textContent = "";
    if (!AMOUNT.test(amount) || Number(amount) <= 0) { msg.textContent = "Enter the amount as a number, for example 3000 or 12.5."; return; }
    const button = form.querySelector("button");
    button.disabled = true;
    button.textContent = "Checking…";
    try {
      const who = await resolveInput(String(data.get("who") ?? ""));
      const per = String(data.get("per"));
      const days = Number(data.get("days")) > 0 ? Number(data.get("days")) : PERIODS[per] / 86_400;
      const link = requestLink({ address: who.address, name: who.name, amount, per, symbol: String(data.get("token")), days, note: String(data.get("note") ?? "").trim().slice(0, 80) || null });
      out.hidden = false;
      out.replaceChildren(
        h("div", { class: "ask-result" },
          h("p", { class: "step-title", text: who.name ? `Link for ${who.name}` : "Your link" }),
          h("input", { class: "link-field", type: "text", readonly: true, value: link, "aria-label": "Pay-me link", onfocus: (e) => e.target.select() }),
          h("div", { class: "ask-buttons" }, copyButton(link, "Copy link", "big"), whatsappButton(`Pay me by the second with Payday: ${link}`, "ink"), h("a", { class: "pill solid", href: link, text: "Open the request" })),
          h("p", { class: "panel-note", text: "Anyone you send it to sees the request, a live preview, and the sentence their agent needs. Nothing is signed until they approve in PayBox." })),
        qr(link),
      );
    } catch (err) {
      msg.textContent = err.message;
    } finally {
      button.disabled = false;
      button.textContent = "Make my link";
    }
  });
}

export function showHome() {
  $("home").hidden = false;
  calculator();
  askForm();
}
