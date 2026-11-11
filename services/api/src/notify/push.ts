import type { Sql } from "postgres";
import { getPushSender } from "./fcm.js";

/**
 * Push notifications (FCM). The consumer calls handleNotifyEvent for the outbox topics
 * below; this decides who is told what, then delivers within the user's preferences
 * (/me notificationPrefs: channels.push and the topic switch).
 *
 *   deal.created     { dealId, seq: 1, … }               an offer or a quote
 *   deal.transition  { dealId, seq, from, to, actor, action }
 *   message.created  { messageId }                       a chat message (0033 trigger)
 *
 * The outbox is at-least-once, so each notification is first claimed by a dedupe key
 * (deal:<id>:<seq>:<user> / msg:<id>) — a redelivered poke finds it taken and stops.
 * A failed send is logged on the row, never thrown: a push is best-effort, and
 * retrying the whole message would re-run the claim and skip anyway.
 */
export const NOTIFY_TOPICS = new Set(["deal.created", "deal.transition", "message.created"]);

type Topic = "orders" | "messages";
type Note = { userId: string; topic: Topic; title: string; body: string; key: string; data: Record<string, string>; tag?: string };

type NotifyMsg = { topic: string; dealId?: string; seq?: number; action?: string; actor?: string; to?: string; messageId?: number };

export async function handleNotifyEvent(db: Sql, msg: NotifyMsg): Promise<void> {
  const notes =
    msg.topic === "message.created" ? await forMessage(db, Number(msg.messageId)) : await forDeal(db, msg);
  for (const n of notes) await deliver(db, n);
}

/** ₦8,000 — exact, since these are prices people agreed to. */
function money(kobo: number | string): string {
  return `₦${(Number(kobo) / 100).toLocaleString("en-NG", { maximumFractionDigits: 2 })}`;
}
function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

type DealCtx = {
  id: string;
  buyer_id: string;
  seller_id: string;
  price_kobo: string;
  title: string;
  buyer_name: string | null;
  seller_name: string | null;
  conversation_id: string | null;
  booking: boolean;
};

async function forDeal(db: Sql, msg: NotifyMsg): Promise<Note[]> {
  if (!msg.dealId) return [];
  const [d] = await db<DealCtx[]>`
    select d.id, d.buyer_id, d.seller_id, d.price_kobo::text as price_kobo, l.title,
           pb.display_name as buyer_name, ps.display_name as seller_name,
           (select c.id from public.conversations c where c.listing_id = d.listing_id and c.buyer_id = d.buyer_id) as conversation_id,
           (d.terms ? 'booking') as booking
    from public.deals d
    join public.listings l on l.id = d.listing_id
    left join public.profiles pb on pb.id = d.buyer_id
    left join public.profiles ps on ps.id = d.seller_id
    where d.id = ${msg.dealId}`;
  if (!d) return [];
  const seq = Number(msg.seq ?? 1);
  // The event, not the deal row: by the time the poke arrives the deal may have moved on.
  const [ev] = await db<{ action: string; actor: string; price_kobo: string | null; to_state: string }[]>`
    select action, actor, price_kobo::text as price_kobo, to_state from public.deal_events
    where deal_id = ${d.id} and seq = ${seq}`;
  if (!ev) return [];

  const title = clip(d.title, 60);
  const price = money(ev.price_kobo ?? d.price_kobo);
  const buyer = d.buyer_name || "The buyer";
  const seller = d.seller_name || "The seller";
  const data: Record<string, string> = { type: "deal", dealId: d.id, ...(d.conversation_id ? { conversationId: d.conversation_id } : {}) };
  const out: Note[] = [];
  const to = (who: "buyer" | "seller", t: string, b: string) =>
    out.push({
      userId: who === "buyer" ? d.buyer_id : d.seller_id,
      topic: "orders",
      title: t,
      body: b,
      key: `deal:${d.id}:${seq}:${who}`,
      data,
      tag: `deal:${d.id}`,
    });
  const byBuyer = ev.actor === "BUYER";

  switch (ev.action) {
    // ── Negotiation ──
    case "offer":
      to("seller", `New offer: ${price}`, `${buyer} offered ${price} for ${title}.`);
      break;
    case "quote":
      to("buyer", `New quote: ${price}`, `${seller} quoted ${price} for ${title}.`);
      break;
    case "counter":
      if (byBuyer) to("seller", `Counter-offer: ${price}`, `${buyer} countered with ${price} for ${title}.`);
      else to("buyer", `Counter-offer: ${price}`, `${seller} countered with ${price} for ${title}.`);
      break;
    case "accept":
      if (byBuyer) to("seller", "Price accepted", `${buyer} accepted ${price} for ${title}. They'll pay into escrow next.`);
      else to("buyer", "Offer accepted — pay to secure it", `${seller} accepted ${price} for ${title}. Pay into escrow to lock it in.`);
      break;
    case "decline":
      to("buyer", "Offer declined", `${seller} declined your offer for ${title}.`);
      break;
    case "cancel":
      to("buyer", "Deal cancelled", `${seller} cancelled the deal for ${title} before payment.`);
      break;
    case "withdraw":
      to("seller", "Buyer withdrew", `${buyer} withdrew from the deal for ${title}.`);
      break;
    case "expire":
      to("buyer", "Deal expired", `The deal for ${title} expired before it was completed.`);
      to("seller", "Deal expired", `The deal for ${title} expired before it was completed.`);
      break;

    // ── Payment ──
    case "payment_confirmed":
      to("buyer", "Payment secured in escrow", `${price} for ${title} is held safely until you confirm.`);
      if (d.booking) to("seller", "New booking paid", `${buyer} booked ${title}. The payment is in escrow.`);
      else to("seller", "Paid — hand it over", `${buyer} paid ${price} into escrow for ${title}. Hand it off, then mark it handed off.`);
      break;
    case "payment_failed":
      to("buyer", "Payment didn't go through", `Your payment for ${title} failed. You can try again from the deal.`);
      break;
    case "oversold":
      to("buyer", "Sold out — refund on its way", `${title} sold out before your payment landed. You're being refunded.`);
      break;

    // ── Fulfilment ──
    case "hand_off":
      to("buyer", "Marked as handed off", `${seller} marked ${title} handed off. Confirm you've got it to release payment.`);
      break;
    case "confirm_receipt":
      to("seller", "Payment released", `${buyer} confirmed receipt of ${title}. Your payment has been released.`);
      break;
    case "auto_release":
      to("seller", "Payment released", `The confirmation window for ${title} ended, so your payment has been released.`);
      break;
    case "release_stage":
      to("seller", "Stage payment released", `A stage payment for ${title} has been released.`);
      break;
    case "check_out":
      to("seller", "Stay complete", `The stay at ${title} has ended and your payment has been released.`);
      break;
    case "cancel_refund":
      to("buyer", "Deal cancelled — refund on its way", `${seller} couldn't complete ${title}. You're being refunded from escrow.`);
      break;
    case "cancel_booking":
      to("seller", "Booking cancelled", `${buyer} cancelled their booking of ${title}.`);
      break;
    case "auto_refund":
      to("buyer", "Refund on its way", `The deal for ${title} wasn't completed in time, so you're being refunded.`);
      to("seller", "Deal refunded", `The deal for ${title} wasn't completed in time, so the buyer was refunded.`);
      break;

    // ── Disputes ──
    case "dispute":
      to("seller", "Dispute opened — respond within 24h", `${buyer} opened a dispute on ${title}. Respond within 24 hours or the buyer is refunded.`);
      break;
    case "respond":
      to("buyer", "Seller responded", `${seller} responded to your dispute on ${title}. Our team will review it.`);
      break;
    case "claim_deposit":
      to("buyer", "Deposit claim", `${seller} has claimed the caution deposit for ${title}. Our team will review it.`);
      break;
    case "resolve_release":
    case "resolve_refund":
    case "return_deposit": {
      const forBuyer = ev.action === "resolve_release" ? "The payment went to the seller." : ev.action === "resolve_refund" ? "You're being refunded." : "Your deposit is being returned.";
      const forSeller = ev.action === "resolve_release" ? "The payment has been released to you." : ev.action === "resolve_refund" ? "The buyer is being refunded." : "The deposit goes back to the guest.";
      to("buyer", "Dispute resolved", `Our team resolved the dispute on ${title}. ${forBuyer}`);
      to("seller", "Dispute resolved", `Our team resolved the dispute on ${title}. ${forSeller}`);
      break;
    }
    // pay (awaiting the webhook), book (told once paid): nothing to say yet.
  }
  return out;
}

async function forMessage(db: Sql, messageId: number): Promise<Note[]> {
  if (!Number.isFinite(messageId)) return [];
  const [m] = await db<{ sender_id: string; body: string; conversation_id: string; buyer_id: string; seller_id: string; deal_id: string | null; sender_name: string | null; title: string }[]>`
    select m.sender_id, m.body, m.conversation_id, c.buyer_id, c.seller_id, m.deal_id,
           p.display_name as sender_name, l.title
    from public.messages m
    join public.conversations c on c.id = m.conversation_id
    join public.listings l on l.id = c.listing_id
    left join public.profiles p on p.id = m.sender_id
    where m.id = ${messageId}`;
  if (!m) return [];
  const recipient = m.sender_id === m.buyer_id ? m.seller_id : m.buyer_id;
  return [
    {
      userId: recipient,
      topic: "messages",
      title: m.sender_name || "New message",
      body: clip(m.body, 140),
      key: `msg:${messageId}`,
      data: { type: "conversation", conversationId: m.conversation_id, ...(m.deal_id ? { dealId: m.deal_id } : {}) },
      tag: `conv:${m.conversation_id}`,
    },
  ];
}

const CHANNEL: Record<Topic, string> = { orders: "orders", messages: "messages" };

async function deliver(db: Sql, n: Note): Promise<void> {
  const [claimed] = await db<{ id: number }[]>`
    insert into public.notifications (user_id, dedupe_key, topic, title, body, data)
    values (${n.userId}, ${n.key}, ${n.topic}, ${n.title}, ${n.body}, ${db.json(n.data)})
    on conflict (dedupe_key) do nothing
    returning id`;
  if (!claimed) return; // a redelivered poke: already handled
  const done = (status: string, detail: string | null = null) =>
    db`update public.notifications set status = ${status}, detail = ${detail} where id = ${claimed.id}`;

  const [p] = await db<{ prefs: { channels?: { push?: boolean }; topics?: Record<string, boolean> } | null }[]>`
    select notification_prefs as prefs from public.profiles where id = ${n.userId}`;
  // Defaults mirror 0022: push on, orders + messages on.
  if (p?.prefs?.channels?.push === false || p?.prefs?.topics?.[n.topic] === false) return void (await done("skipped", "prefs"));

  // Blocked senders don't get through, even if the message was sent before the block.
  if (n.topic === "messages") {
    const [blocked] = await db`
      select 1 from public.blocks b join public.messages m on m.id = ${Number(n.key.slice(4))}
      where (b.blocker_id = ${n.userId} and b.blocked_id = m.sender_id) limit 1`;
    if (blocked) return void (await done("skipped", "blocked"));
  }

  const devices = await db<{ token: string }[]>`select token from public.push_devices where user_id = ${n.userId}`;
  if (!devices.length) return void (await done("no_device"));

  const sender = await getPushSender();
  if (sender.name === "mock") return void (await done("mocked", `${devices.length} device(s)`));

  let sent = 0;
  const errors: string[] = [];
  for (const d of devices) {
    const r = await sender.send({ token: d.token, title: n.title, body: n.body, data: n.data, tag: n.tag, channel: CHANNEL[n.topic] });
    if (r.ok) sent++;
    else {
      errors.push(r.error);
      if (r.gone) await db`delete from public.push_devices where token = ${d.token}`;
    }
  }
  await done(sent ? "sent" : "failed", errors.length ? errors.join(" | ").slice(0, 500) : `${sent} device(s)`);
}
