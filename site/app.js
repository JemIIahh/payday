// Picks the view from the URL:
//   ?pay=0x…&amount=…&per=…   a pay-me request
//   ?a=0x…&statement=YYYY-MM  a printable payslip
//   ?a=0x… or ?a=name.base.eth live streams for a wallet
//   (nothing)                 home: calculator and pay-me link maker
import { resolveInput } from "./chain.js";
import { showHome } from "./home.js";
import { showLedger } from "./ledger.js";
import { showPayslip } from "./payslip.js";
import { showRequest } from "./request.js";
import { $ } from "./ui.js";

const params = new URLSearchParams(location.search);

function setView(view) {
  document.body.dataset.view = view;
  $("heroLedger").hidden = view !== "ledger";
  $("heroRequest").hidden = view !== "request";
  $("heroLookup").hidden = view === "request" || view === "payslip";
  $("updated").hidden = view !== "ledger";
}

async function open(raw, statement) {
  const msg = $("formMsg");
  msg.textContent = "";
  let who;
  try {
    who = await resolveInput(raw);
  } catch (err) {
    msg.textContent = err.message;
    return false;
  }
  $("addr").value = who.name ?? who.address;
  if (statement) {
    setView("payslip");
    showPayslip(who.address, who.name, statement);
  } else {
    setView("ledger");
    history.replaceState(null, "", `?a=${who.name ?? who.address}`);
    showLedger(who.address, who.name);
  }
  return true;
}

$("lookup").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("lookup").querySelector("button");
  button.disabled = true;
  await open($("addr").value);
  button.disabled = false;
});

const statement = params.get("statement");
if (params.has("pay")) {
  setView("request");
  showRequest(params);
} else if (params.get("a")) {
  open(params.get("a"), statement && /^\d{4}-(0[1-9]|1[0-2])$/.test(statement) ? statement : null).then((ok) => { if (!ok) { setView("home"); showHome(); } });
} else {
  setView("home");
  showHome();
}
