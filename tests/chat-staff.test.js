import { test } from "node:test";
import assert from "node:assert/strict";
import { TYPES } from "../src/chat/messages.js";
import { byServerTime } from "../src/threads.js";
import { makeChatDuo, messagesOf, wrapTransport } from "./chat-helpers.js";
import { makeApp } from "./helpers.js";

const EV104 = { shadeCode: "245W", deltaE: { "245W": 2.1, "250W": 3.51, "220N": 5.0 }, band: 1 };
const R104 = { caseId: "R-104" };

// The shopper starts the return; the agent drafts the resolution and an exchange offer.
async function begin(duo, { settleIt = true } = {}) {
  await duo.shopper.invoke("shopper_send", { kind: "return_request" }, "shopper");
  if (settleIt) await duo.settle();
}
async function agentDraft(duo) {
  const r = await duo.desk.invoke("draft_return_resolution", { ...R104, resolution: "exchange", shadeCode: "245W", evidence: { deltaE: { "220N": 5.0, "245W": 2.1 } } }, "agent");
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const d = await duo.desk.invoke("draft_reply", { ...R104, kind: "exchange_offer", evidence: EV104 }, "agent");
  assert.equal(d.ok, true, JSON.stringify(d.error));
  return d.result.draft;
}
const sendReply = (duo, draft, over = {}, actor = "staff") => duo.desk.invoke("send_reply", { ...R104, draftId: draft.draftId, seen: draft.fingerprint, ...over }, actor);
const newestId = (app, caseId = "R-104") => messagesOf(app, caseId).at(-1)?.messageId ?? "";
const note = (duo, args, actor = "staff") => duo.desk.invoke("staff_note", { ...R104, seen: newestId(duo.desk), text: "250W is ΔE00 3.51 from your reading; 245W is closer at 2.10", ...args }, actor);
const close = (duo, args, actor = "staff") => duo.desk.invoke("close_case", { ...R104, seen: newestId(duo.desk), reason: "resolved", ...args }, actor);
const shopperWrites = async (duo, text) => duo.shopperTransport.send({ toUserId: duo.seat.deskUserId, type: TYPES.NOTE, content: { visit: "visit-a", caseId: "R-104", text } });
const sentCount = (duo) => duo.server.log.length;

// ---------------------------------------------------------------------------- send_reply

test("send_reply sends the draft as SG:Offer, once, and the shopper's phone receives it", async () => {
  const duo = await makeChatDuo();
  await begin(duo);
  const draft = await agentDraft(duo);
  const r = await sendReply(duo, draft);
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.deepEqual([r.result.type, r.result.crossed], [TYPES.OFFER, []]);
  const sent = messagesOf(duo.desk, "R-104").at(-1);
  assert.deepEqual(sent.content, { visit: "visit-a", caseId: "R-104", draftId: draft.draftId, text: draft.text, resolution: "exchange", shadeCode: "245W", deltaE: EV104.deltaE });
  assert.deepEqual([sent.sender, sent.own, sent.messageId], ["staff", true, r.result.messageId]);
  assert.deepEqual(Object.keys(sent.seenThrough).sort(), ["messageId", "sentTime"], "a place in the total order, not a bare time");
  assert.equal(duo.desk.store.state.replyDrafts[0].sent.messageId, r.result.messageId);
  await duo.settle();
  const onPhone = messagesOf(duo.shopper, "R-104").find((m) => m.type === TYPES.OFFER);
  assert.deepEqual([onPhone.messageId, onPhone.sender, onPhone.content.draftId], [r.result.messageId, "staff", draft.draftId]);
  const again = await sendReply(duo, draft);
  assert.equal(again.error.code, "already_sent");
  assert.equal(messagesOf(duo.desk, "R-104").filter((m) => m.type === TYPES.OFFER).length, 1);
});

test("send_reply sends a check invite as an SG:Note labelled as the agent's draft", async () => {
  const duo = await makeChatDuo({ shopperIndex: 1 });
  await duo.shopper.invoke("shopper_send", { kind: "return_request" }, "shopper");
  await duo.settle();
  const d = (await duo.desk.invoke("draft_reply", { caseId: "R-107", kind: "check_invite", evidence: {} }, "agent")).result.draft;
  const r = await duo.desk.invoke("send_reply", { caseId: "R-107", draftId: d.draftId, seen: d.fingerprint }, "staff");
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const sent = messagesOf(duo.desk, "R-107").at(-1);
  assert.deepEqual([sent.type, sent.content.by, sent.content.text], [TYPES.NOTE, "draft", d.text]);
});

test("send_reply is staff's alone: the agent, the shopper, the merchant and the adapter are refused, and nothing is sent", async () => {
  const duo = await makeChatDuo();
  await begin(duo);
  const draft = await agentDraft(duo);
  const before = sentCount(duo);
  for (const actor of ["agent", "shopper", "merchant", "nexconn"]) {
    const r = await sendReply(duo, draft, {}, actor);
    assert.equal(r.error.code, "wrong_actor", actor);
  }
  assert.equal(sentCount(duo), before);
  assert.equal(duo.desk.store.state.replyDrafts[0].sent, null);
});

test("send_reply refuses a smuggled field, an unknown case or draft, a superseded draft, and a seen that is not the draft's fingerprint", async () => {
  const duo = await makeChatDuo();
  await begin(duo);
  const first = await agentDraft(duo);
  await shopperWrites(duo, "is 250W any closer?");
  await duo.settle();
  const second = (await duo.desk.invoke("draft_reply", { ...R104, kind: "exchange_offer", evidence: EV104 }, "agent")).result.draft;
  assert.notEqual(first.fingerprint, second.fingerprint, "the newer draft was written against a newer thread");
  const before = sentCount(duo);
  assert.equal((await sendReply(duo, second, { text: "Free refund" })).error.code, "smuggled_field");
  assert.equal((await sendReply(duo, second, { caseId: "R-999" })).error.code, "unknown_case");
  assert.equal((await sendReply(duo, second, { draftId: "d_99" })).error.code, "unknown_draft");
  assert.equal((await sendReply(duo, first)).error.code, "draft_superseded", "the case's newest draft is the one that sends");
  assert.equal((await sendReply(duo, second, { seen: "0000000000000000" })).error.code, "seen_mismatch");
  assert.equal((await sendReply(duo, second, { seen: first.fingerprint })).error.code, "seen_mismatch", "the screen showed another draft");
  assert.equal(sentCount(duo), before, "none of them sent anything");
  assert.equal((await sendReply(duo, second)).ok, true);
});

test("send_reply refuses a closed or approved case, an offered shade that is out of stock, and a chat that is offline", async () => {
  const stock = await makeChatDuo();
  await begin(stock);
  const d = await agentDraft(stock);
  stock.desk.store.getShade("skin-tint", "245W").stock = 0;
  assert.equal((await sendReply(stock, d)).error.code, "out_of_stock");
  assert.equal(sentCount(stock), 1, "only her request is on the service");

  const off = await makeChatDuo();
  await begin(off);
  const d2 = await agentDraft(off);
  off.server.drop(off.seat.deskUserId);
  assert.equal((await sendReply(off, d2)).error.code, "chat_offline");

  const closed = await makeChatDuo();
  await begin(closed);
  const d3 = await agentDraft(closed);
  assert.equal((await close(closed, {})).ok, true);
  assert.equal((await sendReply(closed, d3)).error.code, "case_closed");

  const approved = await makeChatDuo();
  await begin(approved);
  const d4 = await agentDraft(approved);
  approved.desk.store.getCase("R-104").status = "exchange_approved";
  assert.equal((await sendReply(approved, d4)).error.code, "case_closed");
});

test("send_reply reads the service at the moment of use: a shopper message that is only on the service refuses it as thread_moved, and the desk then shows it", async () => {
  const duo = await makeChatDuo();
  await begin(duo);
  const draft = await agentDraft(duo);
  const typed = await shopperWrites(duo, "is 250W any closer?");
  assert.equal(messagesOf(duo.desk, "R-104").length, 1, "the desk has not been delivered it: the mirror alone would have let the send through");
  assert.deepEqual(duo.server.pending(duo.seat.deskUserId).map((m) => m.messageId), [typed.messageId]);
  const before = sentCount(duo);
  const r = await sendReply(duo, draft);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "thread_moved");
  assert.equal(r.error.messageId, typed.messageId);
  assert.equal(sentCount(duo), before, "nothing was sent");
  assert.equal(duo.desk.store.state.replyDrafts[0].sent, null);
  assert.deepEqual(messagesOf(duo.desk, "R-104").map((m) => m.messageId).at(-1), typed.messageId, "recorded, so the desk shows it");
  assert.equal(duo.desk.store.state.activityLog.at(-1).code, "thread_moved");
  // The agent re-drafts against the new thread; that draft sends.
  const redraft = (await duo.desk.invoke("draft_reply", { ...R104, kind: "exchange_offer", evidence: EV104 }, "agent")).result.draft;
  assert.equal(redraft.basedOn.messageId, typed.messageId);
  assert.equal((await sendReply(duo, redraft)).ok, true);
  assert.equal((await sendReply(duo, draft)).error.code, "draft_superseded");
});

test("send_reply refuses as thread_moved when the shopper's message already reached the desk after the draft", async () => {
  const duo = await makeChatDuo();
  await begin(duo);
  const draft = await agentDraft(duo);
  await shopperWrites(duo, "wait, which shade did you pick?");
  await duo.settle();
  const r = await sendReply(duo, draft);
  assert.equal(r.error.code, "thread_moved");
});

test("thread_moved is decided on server times and ids, whatever the desk's own clock says and whatever order messages arrived in", async () => {
  // The desk's local clock is stuck in the past: by it, the shopper's message looks older than the draft.
  const duo = await makeChatDuo({ deskNow: () => "2020-01-01T00:00:00.000Z" });
  await begin(duo);
  const draft = await agentDraft(duo);
  await shopperWrites(duo, "one more question");
  await duo.settle();
  const moved = messagesOf(duo.desk, "R-104").at(-1);
  assert.equal(Date.parse(moved.recordedAt) <= Date.parse(draft.at), true, "locally it was recorded no later than the draft");
  assert.equal((await sendReply(duo, draft)).error.code, "thread_moved", "yet on the service's clock it came after");

  // An older message that reaches the desk late (delivered after a newer one) was still never seen by the draft.
  const late = await makeChatDuo();
  await begin(late);
  const early = await shopperWrites(late, "first thought");
  const later = await shopperWrites(late, "second thought");
  late.server.deliver(late.seat.deskUserId, [later.messageId]);
  await late.desk.chat.settled();
  const d = await agentDraft(late);
  assert.equal(d.basedOn.messageId, later.messageId);
  const r = await sendReply(late, d);
  assert.equal(r.error.code, "thread_moved", "the older message was on the service but not in the draft's view");
  assert.equal(r.error.messageId, early.messageId);
  assert.deepEqual(messagesOf(late.desk, "R-104").map((m) => m.messageId).slice(-2), [early.messageId, later.messageId], "and the thread shows it in server order");
});

test("send_reply refuses as thread_unverified when the thread can't be read, and sends nothing", async () => {
  const duo = await makeChatDuo();
  await begin(duo);
  const draft = await agentDraft(duo);
  duo.server.failReads = true;
  const before = sentCount(duo);
  const r = await sendReply(duo, draft);
  assert.equal(r.error.code, "thread_unverified");
  assert.match(r.error.message, /nothing was sent/i);
  assert.equal(sentCount(duo), before);
  duo.server.failReads = false;
  assert.equal((await sendReply(duo, draft)).ok, true, "and goes once the thread can be read");
});

test("crossed: a shopper message sent in the one round trip between the read and the send is flagged on the desk", async () => {
  let duo;
  let crossing;
  duo = await makeChatDuo({
    deskTransport: (t) =>
      wrapTransport(t, {
        send: async (args) => {
          if (args.type === TYPES.OFFER) crossing = await shopperWrites(duo, "actually I prefer 250W");
          return t.send(args);
        },
      }),
  });
  await begin(duo);
  const draft = await agentDraft(duo);
  const r = await sendReply(duo, draft);
  assert.equal(r.ok, true, "the read had found nothing, so the send went");
  assert.deepEqual(r.result.crossed, [crossing.messageId]);
  const thread = duo.desk.store.state.threads["R-104"];
  assert.deepEqual(thread.crossed, [{ shopperMessageId: crossing.messageId, staffMessageId: r.result.messageId }]);
  const offer = thread.messages.find((m) => m.messageId === r.result.messageId);
  const typed = thread.messages.find((m) => m.messageId === crossing.messageId);
  assert.ok(byServerTime(typed, offer.seenThrough) > 0 && byServerTime(typed, offer) < 0, "its place falls between what the desk had seen and the send");
  assert.deepEqual((await duo.desk.invoke("read_thread", R104, "agent")).result.crossed, thread.crossed, "the agent sees it too, so it re-drafts");
});

test("crossed is also flagged when the crossing message reaches the desk only afterwards, in server order", async () => {
  let duo;
  let crossing;
  duo = await makeChatDuo({
    deskTransport: (t) =>
      wrapTransport(t, {
        send: async (args) => {
          if (args.type !== TYPES.OFFER) return t.send(args);
          crossing = await shopperWrites(duo, "actually I prefer 250W");
          const sent = await t.send(args);
          duo.server.failReads = true; // the desk's own follow-up read fails
          return sent;
        },
      }),
  });
  await begin(duo);
  const draft = await agentDraft(duo);
  const r = await sendReply(duo, draft);
  assert.equal(r.ok, true);
  assert.deepEqual(r.result.crossed, [], "not known yet");
  duo.server.failReads = false;
  await duo.settle();
  assert.deepEqual(duo.desk.store.state.threads["R-104"].crossed.map((c) => c.shopperMessageId), [crossing.messageId]);
  assert.deepEqual(messagesOf(duo.desk, "R-104").map((m) => m.messageId).slice(-2), [crossing.messageId, r.result.messageId], "ordered by server time: her message came first");
});

// ---------------------------------------------------------------------------- staff_note

test("staff_note sends staff's own words as an SG:Note labelled staff, and the phone receives it", async () => {
  const duo = await makeChatDuo();
  await begin(duo);
  const r = await note(duo, {});
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const sent = messagesOf(duo.desk, "R-104").at(-1);
  assert.deepEqual([sent.type, sent.content.by, sent.content.text, sent.sender], [TYPES.NOTE, "staff", "250W is ΔE00 3.51 from your reading; 245W is closer at 2.10", "staff"]);
  await duo.settle();
  assert.equal(messagesOf(duo.shopper, "R-104").at(-1).content.by, "staff");
});

test("staff_note is staff's alone, takes only words, and the agent has no way to write one", async () => {
  const duo = await makeChatDuo();
  await begin(duo);
  const before = sentCount(duo);
  for (const actor of ["agent", "shopper", "merchant", "nexconn"]) assert.equal((await note(duo, {}, actor)).error.code, "wrong_actor", actor);
  assert.equal((await note(duo, { text: "   " })).error.code, "bad_args");
  assert.equal((await note(duo, { text: "x".repeat(501) })).error.code, "bad_args");
  assert.equal((await note(duo, { photo: "AAAA" })).error.code, "smuggled_field");
  assert.equal((await note(duo, { caseId: "R-999" })).error.code, "unknown_case");
  assert.equal((await note(duo, { seen: "fm_nope" })).error.code, "unknown_message");
  assert.equal(sentCount(duo), before);
});

test("staff_note and close_case refuse as thread_moved when the thread read shows a shopper message the screen had not", async () => {
  const duo = await makeChatDuo();
  await begin(duo);
  const seen = newestId(duo.desk);
  const typed = await shopperWrites(duo, "hello? any news");
  const before = sentCount(duo);
  const n = await note(duo, { seen });
  assert.deepEqual([n.error.code, n.error.messageId], ["thread_moved", typed.messageId]);
  assert.equal(messagesOf(duo.desk, "R-104").at(-1).messageId, typed.messageId, "recorded, so the screen shows it");
  assert.equal(sentCount(duo), before);
  // Now the screen has it: the note goes. A new message reaching the mirror after the screen's `seen` also moves it.
  assert.equal((await note(duo, { seen: typed.messageId })).ok, true);
  const second = await shopperWrites(duo, "thanks");
  await duo.settle();
  assert.equal((await close(duo, { seen: typed.messageId })).error.code, "thread_moved");
  assert.equal((await close(duo, { seen: second.messageId })).ok, true);
});

test("staff_note refuses when offline, when the thread can't be read, and once the case is closed", async () => {
  const duo = await makeChatDuo();
  await begin(duo);
  duo.server.failReads = true;
  assert.equal((await note(duo, {})).error.code, "thread_unverified");
  duo.server.failReads = false;
  duo.server.drop(duo.seat.deskUserId);
  assert.equal((await note(duo, {})).error.code, "chat_offline");
  await duo.deskTransport.connect();
  assert.equal((await close(duo, {})).ok, true);
  assert.equal((await note(duo, { seen: newestId(duo.desk) })).error.code, "case_closed");
});

// ---------------------------------------------------------------------------- close_case

test("close_case sends SG:CaseClosed and closes the thread for everyone", async () => {
  const duo = await makeChatDuo();
  await begin(duo);
  const r = await close(duo, { reason: "resolved" });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const sent = messagesOf(duo.desk, "R-104").at(-1);
  assert.deepEqual([sent.type, sent.content.reason], [TYPES.CASE_CLOSED, "resolved"]);
  await duo.settle();
  assert.equal(messagesOf(duo.shopper, "R-104").at(-1).type, TYPES.CASE_CLOSED);
  assert.equal((await duo.desk.invoke("read_thread", R104, "agent")).result.closed, true);
  assert.equal((await duo.shopper.invoke("shopper_send", { kind: "note", text: "wait" }, "shopper")).error.code, "case_closed");
  assert.equal((await close(duo, { seen: newestId(duo.desk) })).error.code, "case_closed", "no second close");
});

test("close_case is staff's alone and takes one of its reasons", async () => {
  const duo = await makeChatDuo();
  await begin(duo);
  const before = sentCount(duo);
  for (const actor of ["agent", "shopper", "merchant", "nexconn"]) assert.equal((await close(duo, {}, actor)).error.code, "wrong_actor", actor);
  assert.equal((await close(duo, { reason: "because" })).error.code, "bad_args");
  assert.equal((await close(duo, { caseId: "R-999" })).error.code, "unknown_case");
  assert.equal(sentCount(duo), before);
});

// ---------------------------------------------------------------------------- approvals

async function toAccepted(duo) {
  await begin(duo);
  const draft = await agentDraft(duo);
  const sent = await sendReply(duo, draft);
  assert.equal(sent.ok, true, JSON.stringify(sent.error));
  await duo.settle();
  return { draft, sent: sent.result };
}
const approveExchange = (duo, actor = "staff", seen = newestId(duo.desk)) => duo.desk.invoke("approve_exchange", { ...R104, seen }, actor);
const accept = async (duo, draft) => {
  const r = await duo.shopper.invoke("accept_offer", { caseId: "R-104", draftId: draft.draftId }, "shopper");
  assert.equal(r.ok, true, JSON.stringify(r.error));
  await duo.settle();
  return r.result;
};

test("approve_exchange on a thread is refused as not_accepted until the shopper's own Accept, then goes", async () => {
  const duo = await makeChatDuo();
  const { draft } = await toAccepted(duo);
  const stock = duo.desk.store.getShade("skin-tint", "245W").stock;
  const early = await approveExchange(duo);
  assert.equal(early.error.code, "not_accepted");
  assert.equal(duo.desk.store.getCase("R-104").status, "drafted", "nothing changed");
  assert.equal(duo.desk.store.getShade("skin-tint", "245W").stock, stock);
  await accept(duo, draft);
  const r = await approveExchange(duo);
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(duo.desk.store.getCase("R-104").status, "exchange_approved");
  assert.equal(duo.desk.store.getShade("skin-tint", "245W").stock, stock - 1);
  assert.equal((await approveExchange(duo, "agent")).error.code, "wrong_actor");
});

test("approve_exchange with no offer sent at all is not_accepted, and an acceptance of an older offer doesn't count", async () => {
  const none = await makeChatDuo();
  await begin(none);
  await agentDraft(none);
  assert.equal((await approveExchange(none)).error.code, "not_accepted");

  const duo = await makeChatDuo();
  const { draft } = await toAccepted(duo);
  await accept(duo, draft);
  // Staff send a newer offer: the old acceptance is for a different draft.
  const again = (await duo.desk.invoke("draft_reply", { ...R104, kind: "exchange_offer", evidence: EV104 }, "agent")).result.draft;
  assert.equal((await sendReply(duo, again)).ok, true);
  assert.equal((await approveExchange(duo)).error.code, "not_accepted");
});

test("approvals refuse as offer_mismatch when the newest offer named a different resolution or shade", async () => {
  const duo = await makeChatDuo();
  const { draft } = await toAccepted(duo);
  await accept(duo, draft);
  assert.equal((await duo.desk.invoke("approve_refund", { ...R104, seen: newestId(duo.desk) }, "staff")).error.code, "offer_mismatch", "she accepted an exchange, not a refund");
  duo.desk.store.getCase("R-104").draft.shadeCode = "250W";
  assert.equal((await approveExchange(duo)).error.code, "offer_mismatch", "the offer named 245W");
  assert.equal(duo.desk.store.getCase("R-104").status, "drafted");
});

test("approve_refund on a thread needs a refund offer that she accepted", async () => {
  const duo = await makeChatDuo({ shopperIndex: 1 });
  await duo.shopper.invoke("shopper_send", { kind: "return_request" }, "shopper");
  await duo.settle();
  assert.equal((await duo.desk.invoke("approve_refund", { caseId: "R-107", seen: newestId(duo.desk, "R-107") }, "staff")).error.code, "not_accepted");
  // A refund offer for an order with no reading.
  await duo.desk.invoke("draft_return_resolution", { caseId: "R-107", resolution: "refund", evidence: { reason: "no_reading" } }, "agent");
  const d = (await duo.desk.invoke("draft_reply", { caseId: "R-107", kind: "refund_offer", evidence: { reason: "no_reading" } }, "agent")).result.draft;
  assert.equal((await duo.desk.invoke("send_reply", { caseId: "R-107", draftId: d.draftId, seen: d.fingerprint }, "staff")).ok, true);
  await duo.settle();
  assert.equal((await duo.desk.invoke("approve_refund", { caseId: "R-107", seen: newestId(duo.desk, "R-107") }, "staff")).error.code, "not_accepted");
  assert.equal((await duo.shopper.invoke("accept_offer", { caseId: "R-107", draftId: d.draftId }, "shopper")).ok, true);
  await duo.settle();
  const r = await duo.desk.invoke("approve_refund", { caseId: "R-107", seen: newestId(duo.desk, "R-107") }, "staff");
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(duo.desk.store.getCase("R-107").status, "refund_approved");
  assert.equal((await duo.desk.invoke("approve_exchange", { caseId: "R-107", seen: newestId(duo.desk, "R-107") }, "staff")).error.code, "case_closed");
});

test("approvals refuse as thread_moved when the service shows a shopper message after her acceptance that the screen had not shown", async () => {
  const duo = await makeChatDuo();
  const { draft } = await toAccepted(duo);
  await accept(duo, draft);
  const screen = newestId(duo.desk);
  const typed = await shopperWrites(duo, "sorry, actually keep my order as it is");
  assert.equal(messagesOf(duo.desk, "R-104").some((m) => m.messageId === typed.messageId), false, "not delivered yet");
  const r = await approveExchange(duo, "staff", screen);
  assert.deepEqual([r.error.code, r.error.messageId], ["thread_moved", typed.messageId]);
  assert.equal(duo.desk.store.getCase("R-104").status, "drafted");
  assert.equal(messagesOf(duo.desk, "R-104").at(-1).messageId, typed.messageId, "recorded, so the desk shows it");
  assert.equal((await approveExchange(duo, "staff", screen)).error.code, "thread_moved", "a screen that still shows nothing of it is still out of date");
  assert.equal((await approveExchange(duo)).ok, true, "once the screen shows her message, whether to approve is staff's call");
});

test("approvals on a thread refuse when offline or when the thread can't be read, and after the case is closed", async () => {
  const duo = await makeChatDuo();
  const { draft } = await toAccepted(duo);
  await accept(duo, draft);
  duo.server.failReads = true;
  assert.equal((await approveExchange(duo)).error.code, "thread_unverified");
  duo.server.failReads = false;
  duo.server.drop(duo.seat.deskUserId);
  assert.equal((await approveExchange(duo)).error.code, "chat_offline");
  await duo.deskTransport.connect();
  assert.equal((await approveExchange(duo)).ok, true);
  assert.equal((await close(duo, {})).ok, true);
  assert.equal((await duo.desk.invoke("approve_refund", { ...R104, seen: newestId(duo.desk) }, "staff")).error.code, "case_closed");
});

test("a case with no thread keeps the returns desk's old checks", async () => {
  const app = await makeApp();
  await app.invoke("draft_return_resolution", { ...R104, resolution: "exchange", shadeCode: "245W", evidence: { deltaE: { "220N": 5.0, "245W": 2.1 } } }, "agent");
  assert.equal((await app.invoke("approve_exchange", R104, "staff")).ok, true, "no chat, no acceptance needed");
});

test("an empty mirror proves nothing: an approval reads the service first, offline it refuses, and a thread that exists there is found", async () => {
  const duo = await makeChatDuo();
  await begin(duo);
  const draft = await agentDraft(duo);
  assert.equal((await sendReply(duo, draft)).ok, true);
  await duo.settle();
  // The desk reloads: a new app with an empty mirror, not yet connected.
  const { createApp } = await import("../src/app.js");
  const { FakeYouCamProvider } = await import("../src/providers/youcam-fake.js");
  const fresh = await createApp({ provider: new FakeYouCamProvider(), chat: { transport: duo.server.transport(duo.seat.deskUserId), seat: duo.seat, side: "desk", visit: "visit-a" } });
  await fresh.invoke("draft_return_resolution", { ...R104, resolution: "exchange", shadeCode: "245W", evidence: { deltaE: { "220N": 5.0, "245W": 2.1 } } }, "agent");
  assert.equal(messagesOf(fresh, "R-104").length, 0);
  assert.equal((await fresh.invoke("approve_exchange", { ...R104, seen: "" }, "staff")).error.code, "chat_offline", "an empty mirror is not a case with no thread");
  assert.equal((await fresh.invoke("approve_refund", { ...R104, seen: "" }, "staff")).error.code, "chat_offline");
  assert.equal(fresh.store.getCase("R-104").status, "drafted");
  // Connected, but the history was never restored: the approval reads the service and finds the unaccepted offer.
  await fresh.chat.transport.connect();
  assert.equal((await fresh.invoke("approve_exchange", { ...R104, seen: "" }, "staff")).error.code, "not_accepted");
  assert.equal(messagesOf(fresh, "R-104").some((m) => m.type === TYPES.OFFER), true, "and it is now in the mirror");
});
