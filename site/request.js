// "Pay me by the second": the page a pay-me link opens (made by the request_payment tool or the form on
// the home page). The whole request lives in the URL, so nothing in it is trusted: the address is checked,
// a name only counts once it resolves to that address, and the note is shown but never put in the sentence
// the payer gives their agent.
import { getAddress, isAddress } from "viem";
import { renderSVG } from "uqr";
import { KNOWN, resolveInput } from "./chain.js";
import { requestPrompt } from "./prompts.js";
import { $, h, short, money, copyButton, decimalsFor, whatsappButton, Odometer } from "./ui.js";
import { tokenLabel } from "../src/statement.ts";

export const PERIODS = { hour: 3_600, day: 86_400, week: 604_800, month: 2_592_000, year: 31_536_000 };
const AMOUNT = /^(0|[1-9][0-9]{0,17})(\.[0-9]{1,18})?$/;
const BASENAME = /^(?:[a-z0-9-]+\.)+base\.eth$/i;

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
  const name = params.get("name");
  if (!isAddress(pay.toLowerCase(), { strict: false })) return { error: "This link doesn't include a valid wallet address to pay." };
  if (!AMOUNT.test(amount) || Number(amount) <= 0) return { error: "This link doesn't include a valid amount." };
  if (!Object.hasOwn(PERIODS, per)) return { error: "This link doesn't say how often to pay (hour, day, week, month or year)." };
  // USDC and EURC travel by symbol; any other token only by address, and is shown with that address.
  const bySymbol = [...KNOWN.entries()].find(([, t]) => t.symbol === tokenParam.toUpperCase());
  const byAddress = isAddress(tokenParam.toLowerCase(), { strict: false }) ? tokenParam.toLowerCase() : null;
  let token;
  if (bySymbol) token = { address: bySymbol[0], symbol: bySymbol[1].symbol, known: true };
  else if (byAddress && KNOWN.has(byAddress)) token = { address: byAddress, symbol: KNOWN.get(byAddress).symbol, known: true };
  else if (byAddress) token = { address: getAddress(byAddress), symbol: tokenLabel(byAddress, null), known: false };
  else return { error: "This link names a token Payday doesn't recognise." };
  return {
    request: {
      address: getAddress(pay.toLowerCase()),
      name: name && name.length <= 100 && BASENAME.test(name) ? name.toLowerCase() : null,
      amount,
      per,
      symbol: token.symbol,
      tokenAddress: token.known ? null : token.address,
      days: Number.isFinite(days) && days > 0 && days <= 3650 ? days : PERIODS[per] / 86_400,
      note: (params.get("note") ?? "").slice(0, 80) || null,
    },
  };
}

export function requestLink(request) {
  const params = new URLSearchParams({ pay: request.address, amount: request.amount, per: request.per, token: request.tokenAddress ?? request.symbol, days: String(request.days) });
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
  // Until a name checks out, the page calls them by their address.
  const titled = (who) => {
    document.title = `${who} asks to be paid ${amount} ${symbol} a ${per}`;
    $("reqTitle").textContent = `${who} asks to be paid`;
  };
  titled(short(address));
  $("reqAmount").textContent = `${money(Number(amount), 2)} ${symbol} a ${per}, by the second.`;
  $("reqNote").textContent = note ? `Their note: ${note}` : "";
  $("reqNote").hidden = !note;

  // live preview: what they'd earn while the payer reads the page
  const odo = new Odometer("tiles", symbol);
  const opened = performance.now();
  const dec = decimalsFor(perSecond);
  odo.set(0, dec, true);
  $("reqMeter").replaceChildren(h("div", { class: "meter" }, h("p", { class: "meter-label", text: "What they'd have earned since you opened this page" }), odo.root));
  setInterval(() => odo.set(perSecond * (performance.now() - opened) / 1000, dec), 100);

  // The sentence starts with the address alone; a name is added only once it checks out.
  const sentence = h("p", {});
  let prompt = "";
  const setPrompt = (verifiedName) => {
    prompt = requestPrompt({ ...request, name: verifiedName });
    sentence.textContent = prompt;
  };
  setPrompt(null);
  const copy = copyButton(() => prompt, "Copy sentence", "big");
  const shareText = (who) => `${who} asks to be paid ${money(Number(amount), 2)} ${symbol} a ${per}, by the second, with Payday: ${location.href}`;
  const share = whatsappButton(shareText(short(address)), "ink");
  const check = h("p", { class: "verify", text: name ? `Checking ${name} on Base…` : `Pays ${address}. Confirm this address with them before you approve.` });
  const heading = h("h2", { text: "How to pay" });
  const steps = h("ol", { class: "steps" });
  const side = h("aside", { class: "req-side" });
  if (name) {
    copy.disabled = true;
    resolveInput(name).then((resolved) => {
      if (resolved.address === address) {
        check.className = "verify ok";
        check.textContent = `${name} points to ${address}, the address in this request.`;
        setPrompt(name);
        titled(name);
        share.href = `https://wa.me/?text=${encodeURIComponent(shareText(name))}`;
        copy.disabled = false;
      } else {
        // A link whose name points elsewhere is a fake: show the warning and nothing to pay with.
        $("reqTitle").textContent = "This pay-me link doesn't check out";
        document.title = "Unverified pay-me link";
        check.className = "verify bad";
        check.textContent = `Don't pay from this link: ${name} points to ${resolved.address}, not ${address} as the link says. Ask them for a new one.`;
        heading.textContent = "What's wrong";
        for (const el of [steps, side, $("reqMeter"), $("reqNote")]) el.hidden = true;
      }
    }).catch((err) => {
      // The name couldn't be checked; the sentence never had it, so paying the bare address is still an option.
      check.className = "verify bad";
      check.textContent = `Couldn't check ${name}: ${err.message} The sentence below pays ${address} only; confirm that address with them before you approve.`;
      copy.disabled = false;
    });
  }

  const upfront = perSecond * days * 86_400;
  const breakdown = Object.entries(PERIODS).map(([unit, seconds]) => h("li", {}, h("span", { text: `${unit === "hour" ? "An" : "A"} ${unit}` }), h("b", { text: `${money(perSecond * seconds, unit === "hour" ? 4 : 2)} ${symbol}` })));

  steps.append(
    h("li", {}, h("p", { class: "step-title", text: "Copy this sentence for your agent" }),
      h("div", { class: "prompt-box" }, sentence, copy)),
    h("li", {}, h("p", { class: "step-title", text: "Paste it into Claude with PayBox connected" }),
      h("p", {}, "Your agent needs the ", h("a", { href: "https://app.paybox.sh/plugins", target: "_blank", rel: "noopener", text: "Payday plugin" }), " enabled in PayBox. It checks your wallet and prepares the payment.")),
    h("li", {}, h("p", { class: "step-title", text: "Approve it in PayBox" }),
      h("p", { text: `You fund ${money(upfront, 2)} ${symbol} for the first ${days} days. Pay accrues every second; you can top up, pause, or end it and get the unearned part back.` })));
  side.append(
    qr(location.href),
    h("p", { class: "qr-note", text: "Scan to open this request on another device." }),
    share,
    h("ul", { class: "breakdown" }, breakdown));

  card.replaceChildren(h("div", { class: "req-steps" }, heading, check, steps), side);
}
