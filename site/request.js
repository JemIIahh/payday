// "Pay me by the second": the page a pay-me link opens (made by the request_payment tool or the form on
// the home page). The whole request lives in the URL; this page checks it and shows the payer what to do.
import { getAddress, isAddress } from "viem";
import { renderSVG } from "uqr";
import { KNOWN, resolveInput } from "./chain.js";
import { requestPrompt } from "./prompts.js";
import { $, h, short, money, copyButton, decimalsFor, Odometer } from "./ui.js";

export const PERIODS = { hour: 3_600, day: 86_400, week: 604_800, month: 2_592_000, year: 31_536_000 };
const AMOUNT = /^(0|[1-9][0-9]{0,17})(\.[0-9]{1,18})?$/;

export function qr(text) {
  return h("div", { class: "qr", role: "img", "aria-label": "QR code for this request", html: renderSVG(text, { ecc: "M", border: 2, pixelSize: 6, whiteColor: "#ffffff", blackColor: "#0e1330" }) });
}

/** Reads and checks a request from URL parameters. Returns { request } or { error }. */
export function parseRequest(params) {
  const pay = params.get("pay") ?? "";
  const amount = params.get("amount") ?? "";
  const per = params.get("per") ?? "";
  const tokenParam = params.get("token") ?? "USDC";
  const days = Number(params.get("days") ?? "");
  if (!isAddress(pay.toLowerCase(), { strict: false })) return { error: "This link doesn't include a valid wallet address to pay." };
  if (!AMOUNT.test(amount) || Number(amount) <= 0) return { error: "This link doesn't include a valid amount." };
  if (!(per in PERIODS)) return { error: "This link doesn't say how often to pay (hour, day, week, month or year)." };
  const known = [...KNOWN.entries()].find(([address, t]) => t.symbol === tokenParam.toUpperCase() || address === tokenParam.toLowerCase());
  const symbol = known ? known[1].symbol : isAddress(tokenParam.toLowerCase(), { strict: false }) ? short(tokenParam) : null;
  if (!symbol) return { error: "This link names a token Payday doesn't recognise." };
  return {
    request: {
      address: getAddress(pay.toLowerCase()),
      name: params.get("name"),
      amount,
      per,
      symbol,
      days: Number.isFinite(days) && days > 0 && days <= 3650 ? days : PERIODS[per] / 86_400,
      note: (params.get("note") ?? "").slice(0, 80) || null,
    },
  };
}

export function requestLink(request) {
  const params = new URLSearchParams({ pay: request.address, amount: request.amount, per: request.per, token: request.symbol, days: String(request.days) });
  if (request.name) params.set("name", request.name);
  if (request.note) params.set("note", request.note);
  return `${location.origin}${location.pathname}?${params}`;
}

export async function showRequest(params) {
  const view = $("request");
  view.hidden = false;
  const { request, error } = parseRequest(params);
  const card = $("requestCard");
  if (error) {
    $("reqTitle").textContent = "This pay-me link is incomplete";
    $("reqAmount").textContent = error;
    card.replaceChildren(h("p", {}, "Ask the person who sent it for a new link, or ", h("a", { href: "./#ask", text: "make your own" }), "."));
    return;
  }
  const { address, name, amount, per, symbol, days, note } = request;
  const perSecond = Number(amount) / PERIODS[per];
  document.title = `${name ?? short(address)} asks to be paid ${amount} ${symbol} a ${per}`;
  $("reqTitle").textContent = `${name ?? short(address)} asks to be paid`;
  $("reqAmount").textContent = `${money(Number(amount), 2)} ${symbol} a ${per}, by the second.`;
  $("reqNote").textContent = note ?? "";
  $("reqNote").hidden = !note;

  // live preview: what they'd earn while the payer reads the page
  const odo = new Odometer("tiles", symbol);
  const opened = performance.now();
  const dec = decimalsFor(perSecond);
  odo.set(0, dec, true);
  $("reqMeter").replaceChildren(h("div", { class: "meter" }, h("p", { class: "meter-label", text: "What they'd have earned since you opened this page" }), odo.root));
  setInterval(() => odo.set(perSecond * (performance.now() - opened) / 1000, dec), 100);

  const check = h("p", { class: "verify", text: name ? `Checking ${name} on Base…` : `Pays ${address}. Check this address with them before you approve.` });
  if (name) {
    resolveInput(name).then((resolved) => {
      if (resolved.address === address) {
        check.className = "verify ok";
        check.textContent = `${name} points to ${address}, the address in this request.`;
      } else {
        check.className = "verify bad";
        check.textContent = `Careful: ${name} now points to ${resolved.address}, not ${address} as this link says. Confirm with them before paying.`;
      }
    }).catch((err) => {
      check.className = "verify bad";
      check.textContent = `${err.message} The link asks to pay ${address}; confirm it with them before paying.`;
    });
  }

  const prompt = requestPrompt({ name, address, amount, per, symbol, days, note });
  const upfront = perSecond * days * 86_400;
  const breakdown = Object.entries(PERIODS).map(([unit, seconds]) => h("li", {}, h("span", { text: `A ${unit}` }), h("b", { text: `${money(perSecond * seconds, unit === "hour" ? 4 : 2)} ${symbol}` })));

  card.replaceChildren(
    h("div", { class: "req-steps" },
      h("h2", { text: "How to pay" }),
      check,
      h("ol", { class: "steps" },
        h("li", {}, h("p", { class: "step-title", text: "Copy this sentence for your agent" }),
          h("div", { class: "prompt-box" }, h("p", { text: prompt }), copyButton(prompt, "Copy sentence", "big"))),
        h("li", {}, h("p", { class: "step-title", text: "Paste it into Claude with PayBox connected" }),
          h("p", {}, "Your agent needs the ", h("a", { href: "https://app.paybox.sh/plugins", target: "_blank", rel: "noopener", text: "Payday plugin" }), " enabled in PayBox. It checks your wallet and prepares the payment.")),
        h("li", {}, h("p", { class: "step-title", text: "Approve it in PayBox" }),
          h("p", { text: `You fund ${money(upfront, 2)} ${symbol} for the first ${days} days. Pay accrues every second; you can top up, pause, or end it and get the unearned part back.` })))),
    h("aside", { class: "req-side" },
      qr(location.href),
      h("p", { class: "qr-note", text: "Scan to open this request on another device." }),
      h("ul", { class: "breakdown" }, breakdown)),
  );
}
