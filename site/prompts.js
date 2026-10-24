// The sentences people paste into their agent. The dashboard never signs anything, so every action it
// offers is one of these: Claude (or any agent with PayBox and the Payday plugin) turns it into a proposal
// that the wallet owner approves in PayBox.

const lead = "Using the Payday plugin";

export function streamPrompts(s, owner) {
  const pays = s.sender.toLowerCase() === owner.toLowerCase();
  const stopped = s.status === "voided" || s.status === "paused" || s.status === "paused_insolvent";
  if (!pays) {
    return [
      { label: "Withdraw what I've earned", text: `${lead}, withdraw everything I have earned on stream ${s.id} to my wallet.` },
    ];
  }
  const list = [];
  if (s.status !== "voided") list.push({ label: "Fund 30 more days", text: `${lead}, top up stream ${s.id} so it has 30 days of runway, paid from my PayBox Base wallet ${owner}.` });
  if (!stopped) {
    list.push({ label: "Change the pay", text: `${lead}, change stream ${s.id} to ___ ${s.symbol} per month.` });
    list.push({ label: "Pause it", text: `${lead}, pause stream ${s.id}. I'm the sender, ${owner}.` });
  } else if (s.status !== "voided") {
    list.push({ label: "Resume it", text: `${lead}, resume stream ${s.id} at ___ ${s.symbol} per month, funded for 30 days.` });
  }
  if (s.status !== "voided") list.push({ label: "End it and refund me", text: `${lead}, end stream ${s.id} and refund the unearned ${s.symbol} to ${owner}. I authorize this.` });
  list.push({ label: "Take back extra funds", text: `${lead}, reclaim the extra funds in stream ${s.id} but leave 14 days of pay in it.` });
  return list;
}

export function walletPrompts(owner, { paying, receiving, month, monthName }) {
  const list = [];
  if (receiving) list.push({ label: "Collect all my pay", text: `${lead}, withdraw all the pay I have earned on every stream to ${owner}.` });
  if (paying) list.push({ label: "Keep everyone funded", text: `${lead}, top up all the streams my wallet ${owner} pays so each has 30 days of runway.` });
  list.push({ label: `Statement for ${monthName}`, text: `${lead}, give me my payment statement for ${monthName} (${month}) for ${owner}.` });
  return list;
}

export function requestPrompt({ name, address, amount, per, symbol, days, note }) {
  return `${lead}, start paying ${name ?? address}${name ? ` (${address})` : ""} ${amount} ${symbol} per ${per} from my PayBox Base wallet, funded for ${days} days.${note ? ` It is for: ${note}.` : ""}`;
}
