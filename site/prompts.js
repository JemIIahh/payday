// The sentences people paste into their agent. The dashboard never signs anything, so every action it
// offers is one of these: Claude (or any agent with PayBox and the Payday plugin) turns it into a proposal
// that the wallet owner approves in PayBox. Each stream only offers what the plugin can do in its state.

const lead = "Using the Payday plugin";

export function streamPrompts(s, owner) {
  const pays = s.sender.toLowerCase() === owner.toLowerCase();
  const leftover = s.balance - Math.min(s.debt, s.balance) > 0.000001;
  if (!pays) {
    return [{ label: "Withdraw what I've earned", text: `${lead}, withdraw everything I have earned on stream ${s.id} to my wallet.` }];
  }
  const fund = { label: "Fund 30 more days", text: `${lead}, top up stream ${s.id} so it has 30 days of runway, paid from my PayBox Base wallet ${owner}.` };
  const end = { label: "End it and refund me", text: `${lead}, end stream ${s.id} and refund the unearned funds to ${owner}. I authorize this.` };
  switch (s.status) {
    case "streaming":
    case "streaming_insolvent":
      return [
        fund,
        { label: "Change the pay", text: `${lead}, change stream ${s.id} to ___ per month.` },
        { label: "Pause it", text: `${lead}, pause stream ${s.id}. I'm the sender, ${owner}.` },
        ...(s.status === "streaming" ? [{ label: "Take back extra funds", text: `${lead}, reclaim the extra funds in stream ${s.id} but leave 14 days of pay in it.` }] : []),
        end,
      ];
    case "pending":
      return [{ label: "Cancel it before it starts", text: `${lead}, end stream ${s.id} before it starts and refund the deposit to ${owner}. I authorize this.` }];
    case "paused":
    case "paused_insolvent":
      return [
        { label: "Resume it", text: `${lead}, resume stream ${s.id} at ___ per month, funded for 30 days.` },
        ...(leftover ? [end] : []),
      ];
    default: // voided
      return leftover ? [{ label: "Refund what's left", text: `${lead}, end stream ${s.id} and refund what is left in it to ${owner}.` }] : [];
  }
}

export function walletPrompts(owner, { paying, receiving, month, monthName }) {
  const list = [];
  if (receiving) list.push({ label: "Collect all my pay", text: `${lead}, withdraw all the pay I have earned on every stream to ${owner}.` });
  if (paying) list.push({ label: "Keep everyone funded", text: `${lead}, top up all the streams my wallet ${owner} pays so each has 30 days of runway.` });
  list.push({ label: `Statement for ${monthName}`, text: `${lead}, give me my payment statement for ${monthName} (${month}) for ${owner}.` });
  return list;
}

/** The pay-me sentence. `name` must already be verified against `address`; the requester's note never goes in. */
export function requestPrompt({ name, address, amount, per, symbol, tokenAddress, days }) {
  const what = tokenAddress ? `${amount} of the token ${tokenAddress}` : `${amount} ${symbol}`;
  return `${lead}, start paying ${name ?? address}${name ? ` (${address})` : ""} ${what} per ${per} from my PayBox Base wallet, funded for ${days} days.`;
}
