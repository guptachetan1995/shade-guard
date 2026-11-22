// Guards that existed in the code but that no test depended on, found by mutating them one at a time
// (S0b review): each test here fails when its guard is removed (see the commit message for the list).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ChatError } from "../src/chat/transport.js";
import { TYPES } from "../src/chat/messages.js";
import { fingerprintOf } from "../src/threads.js";
import { agentDrafts, EV104, makeChatDuo, messagesOf, newestIdOf, offerSent, R104, shopperAccepts, shopperRequests, SERVER_EPOCH, staffSendsDraft, wrapTransport } from "./chat-helpers.js";

const hers = (duo, text) => duo.shopperTransport.send({ toUserId: duo.seat.deskUserId, type: TYPES.NOTE, content: { visit: "visit-a", caseId: "R-104", text } });
const thread = (duo) => duo.desk.store.state.threads["R-104"];

// ---- crossed: its upper bound, and seenThrough on a note and a close ----

test("crossed does not flag the ordinary walk: her Accept and her thanks come after staff's send, not across it", async () => {
  const duo = await makeChatDuo();
  const { draft } = await offerSent(duo);
  await shopperAccepts(duo, draft);
  assert.deepEqual(thread(duo).crossed, [], "her Accept is after the offer");
  await duo.shopper.invoke("shopper_send", { kind: "note", text: "thanks!" }, "shopper");
  await duo.settle();
  assert.deepEqual(thread(duo).crossed, []);
  assert.deepEqual((await duo.desk.invoke("read_thread", R104, "agent")).result.crossed, []);
});

test("a staff note and a close carry what the desk had seen, and a message that crosses either is flagged like one that crosses an offer", async () => {
  for (const [verb, type] of [["staff_note", TYPES.NOTE], ["close_case", TYPES.CASE_CLOSED]]) {
    let duo;
    let crossing;
    duo = await makeChatDuo({
      deskTransport: (t) =>
        wrapTransport(t, {
          send: async (args) => {
            if (args.type === type) crossing = await hers(duo, "wait, one more thing");
            return t.send(args);
          },
        }),
    });
    await shopperRequests(duo);
    const seen = newestIdOf(duo.desk);
    const args = verb === "staff_note" ? { ...R104, text: "We are checking", seen } : { ...R104, reason: "resolved", seen };
    const r = await duo.desk.invoke(verb, args, "staff");
    assert.equal(r.ok, true, `${verb}: ${JSON.stringify(r.error)}`);
    assert.deepEqual(r.result.crossed, [crossing.messageId], `${verb} flagged what crossed it`);
    const sent = messagesOf(duo.desk, "R-104").find((m) => m.messageId === r.result.messageId);
    assert.deepEqual(Object.keys(sent.seenThrough).sort(), ["messageId", "sentTime"], `${verb} carries seenThrough`);
    assert.equal(sent.seenThrough.messageId, seen);
  }
});

// ---- thread_moved for a note and a close: a stale screen, and a message older than `seen` that the mirror lacked ----

test("staff_note, close_case and the approvals refuse as thread_moved when a message that reached the mirror after the screen's `seen` is hers", async () => {
  for (const verb of ["staff_note", "close_case", "approve_exchange"]) {
    const duo = await makeChatDuo();
    const { draft } = await offerSent(duo);
    await shopperAccepts(duo, draft);
    const screen = newestIdOf(duo.desk);
    const typed = await hers(duo, "hello?");
    duo.server.deliverAll();
    await duo.desk.chat.settled();
    assert.equal(newestIdOf(duo.desk), typed.messageId, "it is in the mirror, so only the screen's `seen` can tell it is new");
    const args = { staff_note: { ...R104, text: "hi", seen: screen }, close_case: { ...R104, reason: "resolved", seen: screen }, approve_exchange: { ...R104, seen: screen } }[verb];
    const r = await duo.desk.invoke(verb, args, "staff");
    assert.deepEqual([r.error?.code, r.error?.messageId], ["thread_moved", typed.messageId], verb);
  }
});

test("a message OLDER than the screen's `seen` that the mirror had never been given is still unseen: note, close and approval refuse", async () => {
  for (const verb of ["staff_note", "close_case", "approve_exchange"]) {
    const duo = await makeChatDuo();
    const { draft } = await offerSent(duo);
    await shopperAccepts(duo, draft);
    const early = await hers(duo, "first thought");
    const later = await hers(duo, "second thought");
    duo.server.deliver(duo.seat.deskUserId, [later.messageId]); // the newer one arrives first; the older is only on the service
    await duo.desk.chat.settled();
    const seen = later.messageId;
    const args = { staff_note: { ...R104, text: "hi", seen }, close_case: { ...R104, reason: "resolved", seen }, approve_exchange: { ...R104, seen } }[verb];
    const r = await duo.desk.invoke(verb, args, "staff");
    assert.deepEqual([r.error?.code, r.error?.messageId], ["thread_moved", early.messageId], verb);
  }
});

// ---- an approval on a case staff already closed in the chat refuses before it reads anything ----

test("an approval after a close with no approval before it is case_closed, from the mirror alone: the service is not read", async () => {
  let reads = 0;
  const duo = await makeChatDuo({ deskTransport: (t) => wrapTransport(t, { newest: (a) => (reads++, t.newest(a)) }) });
  await shopperRequests(duo);
  await agentDrafts(duo);
  assert.equal((await duo.desk.invoke("close_case", { ...R104, seen: newestIdOf(duo.desk), reason: "resolved" }, "staff")).ok, true);
  reads = 0;
  for (const verb of ["approve_exchange", "approve_refund"]) {
    const r = await duo.desk.invoke(verb, { ...R104, seen: newestIdOf(duo.desk) }, "staff");
    assert.equal(r.error?.code, "case_closed", verb);
    assert.match(r.error.message, /closed by staff in the chat/);
  }
  assert.equal(reads, 0);
  assert.equal(duo.desk.store.getCase("R-104").status, "drafted");
});

// ---- the service drops between the read and the send ----

test("a service that fails the send after a good read: chat_offline stays chat_offline, anything else is send_failed, and nothing is recorded or marked sent", async () => {
  const fail = (code) => async () => {
    throw new ChatError(code, `the service said ${code}`);
  };
  for (const [code, expected] of [["chat_offline", "chat_offline"], ["unregistered_type", "send_failed"], ["unknown_peer", "send_failed"]]) {
    let broken = false;
    const duo = await makeChatDuo({ deskTransport: (t) => wrapTransport(t, { send: (a) => (broken ? fail(code)() : t.send(a)) }) });
    await shopperRequests(duo);
    const draft = await agentDrafts(duo);
    const seen = newestIdOf(duo.desk);
    broken = true;
    const before = duo.server.log.length;
    for (const [verb, args] of [
      ["send_reply", { ...R104, draftId: draft.draftId, seen: draft.fingerprint }],
      ["staff_note", { ...R104, text: "hello", seen }],
      ["close_case", { ...R104, reason: "resolved", seen }],
    ]) {
      const r = await duo.desk.invoke(verb, args, "staff");
      assert.equal(r.error?.code, expected, `${verb} after ${code}`);
      assert.match(r.error.message, new RegExp(code));
    }
    assert.equal(duo.server.log.length, before);
    assert.equal(messagesOf(duo.desk, "R-104").length, 1, "nothing of the failed sends is in the thread");
    assert.equal(duo.desk.store.state.replyDrafts[0].sent, null, "and the draft is not marked sent");
    broken = false;
    assert.equal((await duo.desk.invoke("send_reply", { ...R104, draftId: draft.draftId, seen: draft.fingerprint }, "staff")).ok, true, "so it can still go once the service is back");
  }
  // The shopper's side maps them the same way.
  let broken = false;
  const duo = await makeChatDuo({ deskTransport: undefined });
  const t = duo.shopperTransport;
  const orig = t.send.bind(t);
  t.send = (a) => (broken ? fail("unknown_peer")() : orig(a));
  broken = true;
  assert.equal((await duo.shopper.invoke("shopper_send", { kind: "note", text: "hi" }, "shopper")).error?.code, "send_failed");
  assert.equal(duo.shopper.store.state.threads["R-104"].messages.length, 0);
  // An error that is not the chat's own is a bug and is not swallowed into a refusal.
  t.send = async () => {
    throw new TypeError("a bug");
  };
  await assert.rejects(() => duo.shopper.invoke("shopper_send", { kind: "note", text: "hi" }, "shopper"), TypeError);
});

// ---- the fingerprint covers the evidence ----

test("a draft's fingerprint covers its evidence, not only its text and the thread it was written against", async () => {
  const base = { text: "same words", evidence: { band: 1 }, basedOn: { messageId: "fm_1", sentTime: 5 } };
  const f = await fingerprintOf(base);
  assert.notEqual(await fingerprintOf({ ...base, evidence: { band: 1.04 } }), f, "different evidence");
  assert.notEqual(await fingerprintOf({ ...base, text: "other words" }), f);
  assert.notEqual(await fingerprintOf({ ...base, basedOn: { messageId: "fm_2", sentTime: 5 } }), f);
  assert.notEqual(await fingerprintOf({ ...base, basedOn: { messageId: "fm_1", sentTime: 6 } }), f);
  assert.notEqual(await fingerprintOf({ ...base, basedOn: null }), f);
  assert.equal(await fingerprintOf({ ...base }), f, "and it is stable");

  const duo = await makeChatDuo();
  await shopperRequests(duo);
  await duo.desk.invoke("draft_return_resolution", { ...R104, resolution: "exchange", shadeCode: "245W", evidence: { deltaE: { "220N": 5.0, "245W": 2.1 } } }, "agent");
  const a = (await duo.desk.invoke("draft_reply", { ...R104, kind: "exchange_offer", evidence: EV104 }, "agent")).result.draft;
  const b = (await duo.desk.invoke("draft_reply", { ...R104, kind: "exchange_offer", evidence: { ...EV104, deltaE: { ...EV104.deltaE, "250W": 3.55 } } }, "agent")).result.draft;
  assert.equal(a.text, b.text, "the words come from the reading, so the same");
  assert.notEqual(a.fingerprint, b.fingerprint, "yet the two citations are two different drafts");
});

// ---- the staff verbs belong to the desk's page ----

test("staff's chat verbs are refused as wrong_side from the shopper's phone, and the thread does not change", async () => {
  const duo = await makeChatDuo();
  await shopperRequests(duo);
  const before = duo.server.log.length;
  for (const [verb, args] of [
    ["send_reply", { ...R104, draftId: "d_01", seen: "0" }],
    ["staff_note", { ...R104, text: "hi", seen: "" }],
    ["close_case", { ...R104, reason: "resolved", seen: "" }],
  ]) {
    const r = await duo.shopper.invoke(verb, args, "staff");
    assert.equal(r.error?.code, "wrong_side", verb);
  }
  assert.equal(duo.server.log.length, before);
});

// ---- draft_reply's refund guards ----

test("a refund offer needs a refund drafted first, with the right reason, whether or not the order has a reading", async () => {
  // With a reading that supports no exchange (no shade within range): no refund drafted yet.
  const withReading = await makeChatDuo();
  await withReading.desk.invoke("record_inbound", { messageId: "fm_r1", type: TYPES.READING, senderUserId: withReading.seat.shoppers[0].userId, sentTime: SERVER_EPOCH + 1, content: { visit: "visit-a", caseId: "R-104", lab: [20, -20, -10], hueAngle: 200, band: 1, lighting: null } }, "nexconn");
  const rd = withReading.desk.store.getCase("R-104").reading;
  assert.equal(rd.draftDecision, "no_match");
  const evidence = { reason: "no_match", deltaE: Object.fromEntries(rd.ranking.map((r) => [r.code, r.de00])), band: rd.band };
  assert.equal((await withReading.desk.invoke("draft_reply", { ...R104, kind: "refund_offer", evidence }, "agent")).error.code, "no_resolution_draft");
  assert.equal((await withReading.desk.invoke("draft_return_resolution", { ...R104, resolution: "refund", evidence: { reason: "no_match" } }, "agent")).ok, true);
  assert.equal((await withReading.desk.invoke("draft_reply", { ...R104, kind: "refund_offer", evidence }, "agent")).ok, true);

  // An order with no reading: a refund needs the no_reading draft, and cites only that reason.
  const none = await makeChatDuo({ shopperIndex: 1 });
  const refund = (evidence) => none.desk.invoke("draft_reply", { caseId: "R-107", kind: "refund_offer", evidence }, "agent");
  assert.equal((await refund({ reason: "no_reading" })).error.code, "no_resolution_draft", "nothing drafted yet");
  assert.equal((await none.desk.invoke("draft_return_resolution", { caseId: "R-107", resolution: "refund", evidence: { reason: "no_reading" } }, "agent")).ok, true);
  const wrong = await refund({ reason: "no_match" });
  assert.equal(wrong.error.code, "evidence_mismatch");
  assert.match(wrong.error.message, /no_reading/);
  assert.equal((await refund({ reason: "no_reading", band: 1 })).error.code, "evidence_mismatch", "no figures: there is no reading to cite");
  assert.equal((await refund({ reason: "no_reading" })).ok, true);
});
