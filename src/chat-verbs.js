// The chat's human-only verbs, and the one function that records a message into a thread.
// Like human-verbs.js (which collects these), this file is never imported by tools.js or the
// planner: the agent can draft a reply but has no way to send, accept, approve or close one.
//
// Every thread check here reads the SERVER's ids and server times, never the local clock. The
// staff verbs also read the channel's newest page from the chat service at the moment of use
// (syncThread), because the mirror can lag a message that is already on the service.
import { Refusal, refuse } from "./refusal.js";
import { ChatError, STATUS } from "./chat/transport.js";
import { readBack } from "./chat/history.js";
import { CLOSE_REASONS, isKnownType, MAX_TEXT, TYPES, validateContent } from "./chat/messages.js";
import { decide, rankShades } from "./rules/recommend.js";
import { acceptanceOf, byServerTime, EMPTY_CHANNEL, insertMessage, isClosed, markRead, messageById, newestMessage, newestOffer, placeOf, recomputeCrossed } from "./threads.js";

const clone = (v) => structuredClone(v);

// ---------------------------------------------------------------------------------------
// who is who

function mustSession(store) {
  const s = store.state.chat;
  if (!s) refuse("chat_offline", "This app has no chat connection configured.");
  return s;
}

function roleOf(session, userId) {
  if (userId === session.selfUserId) return session.side === "desk" ? "staff" : "shopper";
  return session.peers[userId]?.role ?? null;
}

function caseOfMessage(session, role, senderUserId, content) {
  let derived;
  if (role === "shopper") derived = senderUserId === session.selfUserId ? session.me.caseId : session.peers[senderUserId].caseId;
  else if (session.side === "shopper") derived = session.me.caseId;
  else {
    if (typeof content.caseId !== "string") refuse("bad_content", "A staff message restored on the desk names its case.");
    derived = content.caseId;
    if (!Object.values(session.peers).some((p) => p.caseId === derived)) refuse("unknown_case", `No thread for ${derived} exists in this seat.`);
  }
  if (content.caseId !== undefined && content.caseId !== derived) {
    refuse("case_mismatch", `The message names ${content.caseId}, but its sender's thread is ${derived}.`);
  }
  return derived;
}

// ---------------------------------------------------------------------------------------
// recording

function readingFrom(store, rcase, content, message) {
  const product = store.getProduct(rcase.productId);
  const ranking = rankShades(content.lab, product.shades);
  const rule = decide({ ranking, cartShadeCode: rcase.shadeCode, band: content.band });
  const top = ranking.slice(0, 3);
  if (!top.some((r) => r.code === rcase.shadeCode)) top.push(ranking.find((r) => r.code === rcase.shadeCode));
  return {
    checkedAt: new Date(message.sentTime).toISOString(),
    checkId: null,
    lab: [...content.lab],
    band: content.band,
    ranking: top.map((r) => ({ ...r })),
    draftDecision: rule.decision,
    recommended: rule.decision === "swap" ? [rule.shadeCode] : rule.decision === "sample_duo" ? [...rule.shadeCodes] : rule.decision === "keep" ? [rcase.shadeCode] : [],
    shopperOutcome: null,
    viaChat: { messageId: message.messageId, sentTime: message.sentTime },
  };
}

// The reading is numbers from the shopper's own check; the ranking, the decision and the
// recommended shade are worked out here, by the same rules the shop uses. Applied only while
// the case has no draft yet: a later reading in a drafted case stays in the thread as a card,
// and the shopper message it is makes any waiting reply draft stale (thread_moved).
function applyReading(store, rcase, content, message) {
  if (rcase.status !== "awaiting_check" && rcase.status !== "open") return { applied: false, reason: "case_already_drafted" };
  rcase.reading = readingFrom(store, rcase, content, message);
  if (rcase.status === "awaiting_check") rcase.status = "open";
  return { applied: true };
}

// The one mutation that puts a message into a thread: record_inbound's body, and what the verbs
// call for what they just sent or what a server read turned up. Returns the outcome; refuses
// with a Refusal for a message that must not be held.
export function recordMessage(store, raw, { own = false, seenThrough } = {}) {
  const session = mustSession(store);
  const { messageId, type, senderUserId, sentTime } = raw;
  const role = roleOf(session, senderUserId);
  if (!role) refuse("unknown_sender", `${senderUserId} is not part of this seat.`);
  if (!isKnownType(type)) refuse("unknown_type", `${type} is not one of the support thread's message types.`);
  const content = raw.content;
  if (content === null || typeof content !== "object" || Array.isArray(content) || typeof content.visit !== "string") {
    refuse("bad_content", "The message content must be an object carrying its visit.");
  }
  if (content.visit !== session.visit) return { recorded: false, dropped: "other_visit", messageId };
  const checked = validateContent(type, content, role);
  if (!checked.ok) refuse(checked.wrongSender ? "wrong_sender" : "bad_content", checked.reason);
  const caseId = caseOfMessage(session, role, senderUserId, content);
  const rcase = store.getCase(caseId);
  const thread = store.state.threads[caseId];
  if (!rcase || !thread) refuse("unknown_case", `No thread for ${caseId} exists in this seat.`);
  const message = {
    messageId,
    type,
    sender: role,
    senderUserId,
    sentTime,
    content: clone(content),
    recordedAt: store.now(),
    ...(own ? { own: true } : {}),
    ...(typeof seenThrough?.sentTime === "number" ? { seenThrough: { sentTime: seenThrough.sentTime, messageId: seenThrough.messageId } } : {}),
  };
  if (!insertMessage(thread, message)) return { recorded: false, duplicate: true, messageId, caseId };
  const outcome = { recorded: true, messageId, caseId };
  if (type === TYPES.READING && role === "shopper" && session.side === "desk" && !own) Object.assign(outcome, applyReading(store, rcase, content, message));
  const crossed = recomputeCrossed(thread);
  if (crossed.length) outcome.crossed = true;
  return outcome;
}

// ---------------------------------------------------------------------------------------
// reading the service at the moment of use

export function assertConnected(ctx) {
  if (!ctx.chat || ctx.chat.status().state !== STATUS.CONNECTED) {
    refuse("chat_offline", "The chat is not connected, so nothing was sent. Reload to reconnect.");
  }
}

// Reads the channel from the service (it always asks the server), back page by page until the
// read reaches the point the mirror already covered (or the start of the channel), and records
// every message of this visit the mirror lacked, so the desk shows it. The channel is shared by
// every visit of the seat, so the newest page alone can hold none of this visit's messages. A read
// that fails, or that cannot reach back far enough within its page budget, refuses as
// thread_unverified: nothing is sent on a thread the desk could not see.
export async function syncThread(ctx, caseId) {
  const { store, chat } = ctx;
  const thread = store.state.threads[caseId];
  let read;
  try {
    read = await readBack(chat, thread.peerUserId, { anchor: thread.readThrough });
  } catch (e) {
    if (e instanceof ChatError) refuse("thread_unverified", "The thread could not be read from the chat service, so nothing was sent.");
    throw e;
  }
  if (read.reached === null) {
    refuse("thread_unverified", "The chat service holds more newer messages than the desk can read back, so it cannot be sure it has seen this thread. Nothing was sent.");
  }
  const added = [];
  for (const raw of [...read.messages].reverse()) {
    if (messageById(thread, raw.messageId)) continue;
    try {
      const r = recordMessage(store, raw);
      if (r.recorded) added.push(raw.messageId);
    } catch (e) {
      if (!(e instanceof Refusal)) throw e;
    }
  }
  markRead(thread, read.messages);
  return { added };
}

// ---------------------------------------------------------------------------------------
// sending

// What is sent is checked against the message table first: a message the table would refuse must
// never reach the service, because the mirror (and so every "already sent" guard) only knows what
// it recorded, and a retry would put another copy on the channel.
export async function sendThrough(ctx, caseId, type, content, { seenThrough } = {}) {
  const { store, chat } = ctx;
  const session = store.state.chat;
  const toUserId = session.side === "desk" ? store.state.threads[caseId].peerUserId : session.deskUserId;
  const outgoing = { visit: session.visit, ...content };
  const checked = validateContent(type, outgoing, session.side === "desk" ? "staff" : "shopper");
  if (!checked.ok) refuse("bad_content", `Nothing was sent: ${checked.reason}.`);
  let sent;
  try {
    sent = await chat.send({ toUserId, type, content: outgoing });
  } catch (e) {
    if (!(e instanceof ChatError)) throw e;
    // The service may have taken an offer whose answer was lost. A retry of the same draft finds it
    // there and marks it sent; a new draft would put a second offer in front of her.
    const retry = type === TYPES.OFFER ? " Send the same draft again: if it did reach the chat service, the retry finds it there and marks it sent instead of sending it twice. A new draft would go out as a second offer." : "";
    refuse(e.code === "chat_offline" ? "chat_offline" : "send_failed", `${e.message}${retry}`);
  }
  recordMessage(store, sent, { own: true, seenThrough });
  return sent;
}

export function textArg(text) {
  if (typeof text !== "string" || text.trim().length === 0 || text.length > MAX_TEXT) refuse("bad_args", `text must be 1–${MAX_TEXT} characters.`);
  return text;
}

// ---------------------------------------------------------------------------------------
// the verbs

const record_inbound = {
  name: "record_inbound",
  actor: "nexconn",
  args: {
    messageId: { type: "string", required: true, description: "The chat service's own id for the message." },
    type: { type: "string", required: true, description: "One of the six SG: message types." },
    senderUserId: { type: "string", required: true, description: "The sender's user id on the chat service." },
    sentTime: { type: "integer", required: true, description: "The chat service's own time for the message, in ms." },
    content: { type: "object", required: true, description: "The message content." },
  },
  run(args, { store }) {
    return recordMessage(store, args);
  },
};

// ---- the shopper's verbs ----

function mustBeShopper(store) {
  const session = mustSession(store);
  if (session.side !== "shopper") refuse("wrong_side", "These are the shopper's verbs; they run from her phone, not from the desk.");
  return session;
}

function ownCase(session, caseId) {
  const mine = session.me.caseId;
  if (caseId !== undefined && caseId !== mine) refuse("not_your_case", `This phone is ${session.me.name}'s; its thread is ${mine}, not ${caseId}.`);
  return mine;
}

function mustBeOpen(store, caseId) {
  if (isClosed(store.state.threads[caseId])) refuse("case_closed", `${caseId} was closed by staff.`);
}

const shopper_send = {
  name: "shopper_send",
  actor: "shopper",
  args: {
    kind: { type: "string", required: true, enum: ["note", "return_request"], description: "note: her own words. return_request: starts the return for her order." },
    caseId: { type: "string", description: "Her own return case; defaults to it." },
    text: { type: "string", description: "A note's words, 1 to 500 characters. A return request takes none: its reason is the order's." },
  },
  async run({ kind, caseId, text }, ctx) {
    const { store } = ctx;
    const session = mustBeShopper(store);
    const id = ownCase(session, caseId);
    if (kind === "note") textArg(text);
    else if (text !== undefined) refuse("bad_args", "A return request takes no text: its reason is the order's own.");
    mustBeOpen(store, id);
    const thread = store.state.threads[id];
    if (kind === "return_request" && thread.messages.some((m) => m.type === TYPES.RETURN_REQUEST)) refuse("already_requested", `The return for ${id} was already requested.`);
    assertConnected(ctx);
    const rcase = store.getCase(id);
    const content = kind === "note" ? { caseId: id, text } : { caseId: id, orderId: rcase.orderId, reason: rcase.reason };
    const sent = await sendThrough(ctx, id, kind === "note" ? TYPES.NOTE : TYPES.RETURN_REQUEST, content);
    return { messageId: sent.messageId, sentTime: sent.sentTime, type: sent.type };
  },
};

const share_reading = {
  name: "share_reading",
  actor: "shopper",
  args: {
    checkId: { type: "string", required: true, description: "Her own closed return check." },
    caseId: { type: "string", required: true, description: "Her own return case." },
  },
  async run({ checkId, caseId }, ctx) {
    const { store } = ctx;
    const session = mustBeShopper(store);
    ownCase(session, caseId);
    const check = store.getCheck(checkId);
    if (!check) refuse("unknown_check", `No check ${checkId} exists.`);
    if (check.origin.from !== "return" || check.origin.caseId !== caseId) refuse("check_not_hers", `Check ${checkId} is not a check for ${caseId}.`);
    if (check.status !== "closed") refuse("check_not_closed", `Check ${checkId} is still open; her photo is not gone yet, so nothing is shared.`);
    if (!check.complexion) refuse("no_reading_in_check", `Check ${checkId} produced no reading, so there is nothing to share.`);
    if (check.sharedReading) refuse("already_shared", `Check ${checkId}'s reading was already shared.`);
    mustBeOpen(store, caseId);
    assertConnected(ctx);
    const c = check.complexion;
    const sent = await sendThrough(ctx, caseId, TYPES.READING, { caseId, lab: [...c.lab], hueAngle: c.hueAngle, band: c.band, lighting: c.faceQuality.lighting ?? null });
    check.sharedReading = { messageId: sent.messageId, at: store.now() };
    return { messageId: sent.messageId, sentTime: sent.sentTime, type: sent.type };
  },
};

const accept_offer = {
  name: "accept_offer",
  actor: "shopper",
  args: {
    caseId: { type: "string", required: true, description: "Her own return case." },
    draftId: { type: "string", required: true, description: "The offer card's draft id." },
  },
  async run({ caseId, draftId }, ctx) {
    const { store } = ctx;
    const session = mustBeShopper(store);
    ownCase(session, caseId);
    mustBeOpen(store, caseId);
    const thread = store.state.threads[caseId];
    if (!thread.messages.some((m) => m.type === TYPES.OFFER && m.content.draftId === draftId)) refuse("unknown_offer", `No offer ${draftId} is in this thread.`);
    const offer = newestOffer(thread);
    if (offer.content.draftId !== draftId) refuse("offer_superseded", `${draftId} is not the newest offer in this thread; a newer one is waiting for her.`);
    if (acceptanceOf(thread, offer)) refuse("already_accepted", `Offer ${draftId} was already accepted.`);
    assertConnected(ctx);
    const sent = await sendThrough(ctx, caseId, TYPES.OFFER_ACCEPTED, { caseId, draftId });
    return { messageId: sent.messageId, sentTime: sent.sentTime, type: sent.type };
  },
};

// ---- staff's verbs ----

function mustBeDesk(store, caseId) {
  const session = mustSession(store);
  if (session.side !== "desk") refuse("wrong_side", "These are staff's verbs; they run from the desk, not from the shopper's phone.");
  const rcase = store.getCase(caseId);
  const thread = store.state.threads[caseId];
  if (!rcase || !thread) refuse("unknown_case", `No return case ${caseId} has a thread on this desk.`);
  return { rcase, thread };
}

const approved = (rcase) => rcase.status === "exchange_approved" || rcase.status === "refund_approved";

function moved(messageId, message) {
  refuse("thread_moved", message, { messageId });
}

// The service read can turn up a close the mirror lacked (another tab of this desk, or staff elsewhere
// on the seat, closed the case): nothing is sent into a thread that is closed there.
function stillOpen(thread, caseId) {
  if (isClosed(thread)) refuse("case_closed", `${caseId} was closed by staff; the thread read shows it.`);
}

// What the screen showed is its newest message, `seen` (an empty string: an empty thread). The
// screen's place in the thread is that message's, or null for nothing shown at all.
function screenOf(thread, seen) {
  if (seen === "") return null;
  const shown = messageById(thread, seen);
  if (!shown) refuse("unknown_message", `${seen} is not a message of this thread, so the screen it came from can't be checked.`);
  return placeOf(shown);
}

// What the desk had seen of a thread when it sends: the place of its newest message.
const seenThroughOf = (thread) => (newestMessage(thread) ? placeOf(newestMessage(thread)) : { ...EMPTY_CHANNEL });

// A message the screen did not show: one the mirror lacked until the service was read (`added`),
// or one that sits after the screen's newest message in server order.
const unshown = (m, screen, added) => added.includes(m.messageId) || screen === null || byServerTime(m, screen) > 0;

// After the service has been read, a shopper message the screen had not shown means the screen is
// out of date, so nothing is sent.
async function checkScreenIsCurrent(ctx, caseId, seen) {
  const { store } = ctx;
  const thread = store.state.threads[caseId];
  const screen = screenOf(thread, seen);
  assertConnected(ctx);
  const { added } = await syncThread(ctx, caseId);
  stillOpen(thread, caseId);
  const unseen = thread.messages.find((m) => m.sender === "shopper" && unshown(m, screen, added));
  if (unseen) moved(unseen.messageId, "The customer has written since this screen last showed the thread, so nothing was sent. The message is now on the screen.");
}

// After a send, once more: a shopper message whose server time falls between what the desk had
// seen and its own message crossed it. The follow-up read is best effort; a message that only
// reaches the desk later is flagged the same way when it is recorded.
async function afterSend(ctx, caseId, sent) {
  try {
    await syncThread(ctx, caseId);
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
  }
  const thread = ctx.store.state.threads[caseId];
  return thread.crossed.filter((c) => c.staffMessageId === sent.messageId).map((c) => c.shopperMessageId);
}

// The terms an offer puts to her: its words, resolution, shade and ΔE00 figures.
const sortedEntries = (o) => Object.entries(o ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
const sameOffer = (a, b) =>
  a.text === b.text && a.resolution === b.resolution && (a.shadeCode ?? null) === (b.shadeCode ?? null) && JSON.stringify(sortedEntries(a.deltaE)) === JSON.stringify(sortedEntries(b.deltaE));

const send_reply = {
  name: "send_reply",
  actor: "staff",
  args: {
    caseId: { type: "string", required: true, description: "The return case." },
    draftId: { type: "string", required: true, description: "The agent's reply draft to send." },
    seen: { type: "string", required: true, description: "The fingerprint of the draft as the screen showed it." },
  },
  async run({ caseId, draftId, seen }, ctx) {
    const { store } = ctx;
    const { rcase, thread } = mustBeDesk(store, caseId);
    if (approved(rcase) || isClosed(thread)) refuse("case_closed", `${caseId} is closed; there is nothing left to send.`);
    const drafts = store.state.replyDrafts.filter((d) => d.caseId === caseId);
    const draft = drafts.find((d) => d.draftId === draftId);
    if (!draft) refuse("unknown_draft", `No reply draft ${draftId} exists for ${caseId}.`);
    if (draft.sent) refuse("already_sent", `Draft ${draftId} was already sent.`);
    if (drafts.at(-1) !== draft) refuse("draft_superseded", `Draft ${draftId} is not the newest draft for ${caseId}; the agent wrote a newer one.`);
    if (seen !== draft.fingerprint) refuse("seen_mismatch", `The screen showed a different draft from ${draftId}'s current text, so nothing was sent.`);
    if (draft.resolution === "exchange") {
      const shade = store.getShade(rcase.productId, draft.shadeCode);
      if (shade && shade.stock < 1) refuse("out_of_stock", `${draft.shadeCode} is out of stock, so it can't be offered.`);
    }
    assertConnected(ctx);
    const { added } = await syncThread(ctx, caseId);
    stillOpen(thread, caseId);
    const content =
      draft.type === TYPES.OFFER
        ? { caseId, draftId, text: draft.text, resolution: draft.resolution, ...(draft.shadeCode ? { shadeCode: draft.shadeCode } : {}), deltaE: draft.deltaE }
        : { caseId, text: draft.text, by: "draft" };
    // Her Accept names an offer by its draft id, so a thread never holds two offers under one id.
    // Draft ids carry this tab's own tag, so an offer the service read turns up under this id is
    // this very draft, sent by an earlier click whose answer was lost (it is sent: say so, before
    // anything newer in the thread can hide that), or one someone else holding the seat's public
    // desk token sent.
    const held = draft.type === TYPES.OFFER ? thread.messages.find((m) => m.type === TYPES.OFFER && m.content.draftId === draftId) : null;
    if (held && sameOffer(held.content, content)) {
      // The read recorded it as anyone's message; it carries what the desk had seen when it went.
      if (draft.sendingSeenThrough && !held.seenThrough) {
        held.seenThrough = { ...draft.sendingSeenThrough };
        recomputeCrossed(thread);
      }
      draft.sent = { messageId: held.messageId, sentTime: held.sentTime, at: store.now() };
      refuse("already_sent", `Draft ${draftId} is already on the chat service: an earlier send went through though its answer was lost. Nothing more was sent.`);
    }
    if (held) refuse("draft_id_taken", `An offer with other terms already carries the id ${draftId} in this thread, so this draft was not sent: her Accept names an offer by its id. That offer is now on the screen.`);
    const unseen = thread.messages.find((m) => m.sender === "shopper" && (!draft.seenIds.includes(m.messageId) || added.includes(m.messageId)));
    if (unseen) moved(unseen.messageId, "The customer has written since this draft was made, so it was not sent. The message is now on the screen; the agent can draft again.");
    const seenThrough = seenThroughOf(thread);
    draft.sendingSeenThrough = seenThrough;
    const sent = await sendThrough(ctx, caseId, draft.type, content, { seenThrough });
    draft.sent = { messageId: sent.messageId, sentTime: sent.sentTime, at: store.now() };
    const crossed = await afterSend(ctx, caseId, sent);
    return { messageId: sent.messageId, sentTime: sent.sentTime, type: sent.type, crossed };
  },
};

const staff_note = {
  name: "staff_note",
  actor: "staff",
  args: {
    caseId: { type: "string", required: true, description: "The return case." },
    text: { type: "string", required: true, description: "Staff's own words, 1 to 500 characters." },
    seen: { type: "string", required: true, description: "The id of the newest message the screen showed, or an empty string for an empty thread." },
  },
  async run({ caseId, text, seen }, ctx) {
    const { store } = ctx;
    const { thread } = mustBeDesk(store, caseId);
    if (isClosed(thread)) refuse("case_closed", `${caseId} is closed.`);
    textArg(text);
    await checkScreenIsCurrent(ctx, caseId, seen);
    const sent = await sendThrough(ctx, caseId, TYPES.NOTE, { caseId, text, by: "staff" }, { seenThrough: seenThroughOf(thread) });
    const crossed = await afterSend(ctx, caseId, sent);
    return { messageId: sent.messageId, sentTime: sent.sentTime, type: sent.type, crossed };
  },
};


const close_case = {
  name: "close_case",
  actor: "staff",
  args: {
    caseId: { type: "string", required: true, description: "The return case." },
    seen: { type: "string", required: true, description: "The id of the newest message the screen showed, or an empty string for an empty thread." },
    reason: { type: "string", required: true, enum: CLOSE_REASONS, description: "resolved, no_reply or other." },
  },
  async run({ caseId, seen, reason }, ctx) {
    const { store } = ctx;
    const { thread } = mustBeDesk(store, caseId);
    if (isClosed(thread)) refuse("case_closed", `${caseId} is already closed.`);
    await checkScreenIsCurrent(ctx, caseId, seen);
    const sent = await sendThrough(ctx, caseId, TYPES.CASE_CLOSED, { caseId, reason }, { seenThrough: seenThroughOf(thread) });
    const crossed = await afterSend(ctx, caseId, sent);
    return { messageId: sent.messageId, sentTime: sent.sentTime, type: sent.type, crossed };
  },
};

// The thread's part of an approval. Only a case with no chat thread at all (store.state.threads
// has no entry: the existing returns desk, an app with no chat) keeps its old checks. A case that
// has a thread is decided on the service's own reading, never on the mirror alone: the mirror may
// be empty because the history was never read, or stale because a message is still in flight. So
// the desk reads the service first, and then the approval needs the newest offer to be the one
// being approved and the shopper's own SG:OfferAccepted for it. A thread with no offer in it,
// empty or not, is not_accepted: no Accept was ever possible. Last, a shopper message after her
// acceptance that the desk's screen had not shown (`seen`, as close_case has it) is thread_moved:
// staff are about to approve over something they have not read. One they have read is theirs to
// weigh, which is also the only way out after she types "thanks!" (she cannot Accept twice).
export async function checkThreadForApproval(ctx, rcase, resolution, seen) {
  const { store } = ctx;
  const thread = store.state.threads[rcase.caseId];
  if (!thread) return;
  if (typeof seen !== "string") refuse("bad_args", "seen is needed for a case with a chat thread: the id of the newest message the screen showed, or an empty string for an empty thread.");
  const screen = screenOf(thread, seen);
  assertConnected(ctx);
  const { added } = await syncThread(ctx, rcase.caseId);
  stillOpen(thread, rcase.caseId);
  const offer = newestOffer(thread);
  if (!offer) refuse("not_accepted", "No offer has been sent in this thread, so there is nothing for the shopper to have accepted.");
  const shade = rcase.draft?.shadeCode;
  if (offer.content.resolution !== resolution || (resolution === "exchange" && offer.content.shadeCode !== shade)) {
    refuse("offer_mismatch", `The newest offer sent was ${offer.content.resolution === "refund" ? "a refund" : `an exchange for ${offer.content.shadeCode}`}, not ${resolution === "refund" ? "a refund" : `an exchange for ${shade}`}.`);
  }
  const accepted = acceptanceOf(thread, offer);
  if (!accepted) refuse("not_accepted", `The shopper has not accepted offer ${offer.content.draftId} in the chat, so it can't be approved.`);
  const later = thread.messages.find((m) => m.sender === "shopper" && byServerTime(m, accepted) > 0 && unshown(m, screen, added));
  if (later) moved(later.messageId, "The customer has written since she accepted the offer, and this screen had not shown it, so it was not approved. The message is now on the screen.");
}

export const CHAT_VERBS = [record_inbound, shopper_send, share_reading, accept_offer, send_reply, staff_note, close_case];
