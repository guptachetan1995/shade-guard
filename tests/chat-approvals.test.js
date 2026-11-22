// The approvals' thread checks, from the second review (G1, L2-1, L2-2 and what they share).
import { test } from "node:test";
import assert from "node:assert/strict";
import { runPlanner } from "../src/agent/planner.js";
import { createApp } from "../src/app.js";
import { FakeYouCamProvider } from "../src/providers/youcam-fake.js";
import { TYPES } from "../src/chat/messages.js";
import { makeChatDuo, messagesOf, newestIdOf, offerSent, R104, shopperAccepts } from "./chat-helpers.js";

// seen defaults to what the desk's screen shows: the newest message in its mirror when the button is clicked.
const approveExchange = (app, args = {}, actor = "staff") => app.invoke("approve_exchange", { ...R104, seen: newestIdOf(app), ...args }, actor);
const approveRefund = (app, args = {}, actor = "staff") => app.invoke("approve_refund", { ...R104, seen: newestIdOf(app), ...args }, actor);
const herNote = async (duo, text) => {
  const r = await duo.shopper.invoke("shopper_send", { kind: "note", text }, "shopper");
  assert.equal(r.ok, true, JSON.stringify(r.error));
  return r.result;
};

test("G1: on a chat thread that holds no message at all, approve_exchange and approve_refund are not_accepted: the shopper's Accept is never skipped", async () => {
  const duo = await makeChatDuo();
  const run = await runPlanner(duo.desk.invoke, { caseId: "R-104", chat: true });
  assert.equal(run.plan.outcome, "reply:exchange_offer", "the agent drafted on an empty thread");
  assert.equal(messagesOf(duo.desk, "R-104").length, 0);
  assert.equal(duo.server.log.length, 0, "nobody has written anything");
  const stock = duo.desk.store.getShade("skin-tint", "245W").stock;
  for (const approve of [approveExchange, approveRefund]) {
    const r = await approve(duo.desk);
    assert.equal(r.ok, false, JSON.stringify(r.result));
    assert.equal(r.error.code, "not_accepted");
  }
  const rcase = duo.desk.store.getCase("R-104");
  assert.equal(rcase.status, "drafted", "nothing was approved");
  assert.equal(rcase.approval, undefined);
  assert.equal(duo.desk.store.getShade("skin-tint", "245W").stock, stock, "no stock moved");
});

test("G1: the same holds for the second shopper, whose order carries no reading, and for a thread that holds only notes", async () => {
  const duo = await makeChatDuo({ shopperIndex: 1 });
  assert.equal((await duo.desk.invoke("draft_return_resolution", { caseId: "R-107", resolution: "refund", evidence: { reason: "no_reading" } }, "agent")).ok, true);
  const refund = await duo.desk.invoke("approve_refund", { caseId: "R-107", seen: "" }, "staff");
  assert.equal(refund.error.code, "not_accepted", "a refund draft on an empty thread is not an accepted offer");
  assert.equal(duo.desk.store.getCase("R-107").status, "drafted");
  await duo.shopper.invoke("shopper_send", { kind: "note", text: "hello?" }, "shopper");
  await duo.settle();
  assert.equal((await duo.desk.invoke("approve_refund", { caseId: "R-107", seen: newestIdOf(duo.desk, "R-107") }, "staff")).error.code, "not_accepted", "a note is not an offer");
});

test("G1: a reloaded desk whose history restore failed reads the service, finds it empty, and refuses too; offline it refuses chat_offline", async () => {
  const duo = await makeChatDuo();
  duo.server.failReads = true;
  const fresh = await createApp({ provider: new FakeYouCamProvider(), chat: { transport: duo.server.transport(duo.seat.deskUserId), seat: duo.seat, side: "desk", visit: "visit-a" } });
  await fresh.chat.connect();
  duo.server.failReads = false;
  assert.equal((await fresh.invoke("draft_return_resolution", { ...R104, resolution: "exchange", shadeCode: "245W", evidence: { deltaE: { "220N": 5.0, "245W": 2.1 } } }, "agent")).ok, true);
  assert.equal(messagesOf(fresh, "R-104").length, 0);
  assert.equal((await approveExchange(fresh)).error.code, "not_accepted", "the service holds nothing either");
  duo.server.drop(duo.seat.deskUserId);
  assert.equal((await approveExchange(fresh)).error.code, "chat_offline");
  assert.equal(fresh.store.getCase("R-104").status, "drafted");
});

// ---------------------------------------------------------------------------- L2-2: seen

test("L2-2: a thank-you after her Accept blocks the approval once, until the desk's screen shows it; then staff's click goes", async () => {
  const duo = await makeChatDuo();
  const { draft } = await offerSent(duo);
  await shopperAccepts(duo, draft);
  const screenBefore = newestIdOf(duo.desk); // what the desk showed when she accepted
  const thanks = await herNote(duo, "thanks!");
  const first = await approveExchange(duo.desk, { seen: screenBefore });
  assert.deepEqual([first.ok, first.error.code, first.error.messageId], [false, "thread_moved", thanks.messageId]);
  assert.equal(newestIdOf(duo.desk), thanks.messageId, "the message is now on the desk's screen");
  assert.equal(duo.desk.store.getCase("R-104").status, "drafted", "nothing was approved");
  assert.equal((await duo.shopper.invoke("accept_offer", { ...R104, draftId: draft.draftId }, "shopper")).error.code, "already_accepted", "she cannot accept again, so only staff's seeing it can clear this");
  const second = await approveExchange(duo.desk, { seen: thanks.messageId });
  assert.equal(second.ok, true, JSON.stringify(second.error));
  assert.equal(duo.desk.store.getCase("R-104").status, "exchange_approved");
});

test("L2-2: the same through approve_refund, and a message that never reached the mirror blocks whatever `seen` is", async () => {
  const duo = await makeChatDuo({ shopperIndex: 1 });
  await duo.shopper.invoke("shopper_send", { kind: "return_request" }, "shopper");
  await duo.settle();
  await duo.desk.invoke("draft_return_resolution", { caseId: "R-107", resolution: "refund", evidence: { reason: "no_reading" } }, "agent");
  const d = (await duo.desk.invoke("draft_reply", { caseId: "R-107", kind: "refund_offer", evidence: { reason: "no_reading" } }, "agent")).result.draft;
  assert.equal((await duo.desk.invoke("send_reply", { caseId: "R-107", draftId: d.draftId, seen: d.fingerprint }, "staff")).ok, true);
  await duo.settle();
  assert.equal((await duo.shopper.invoke("accept_offer", { caseId: "R-107", draftId: d.draftId }, "shopper")).ok, true);
  await duo.settle();
  const typed = (await duo.shopper.invoke("shopper_send", { kind: "note", text: "thank you" }, "shopper")).result; // on the service, not yet at the desk
  const seen = newestIdOf(duo.desk, "R-107");
  const blocked = await duo.desk.invoke("approve_refund", { caseId: "R-107", seen }, "staff");
  assert.deepEqual([blocked.error.code, blocked.error.messageId], ["thread_moved", typed.messageId], "found on the service, and not on the screen");
  const ok = await duo.desk.invoke("approve_refund", { caseId: "R-107", seen: typed.messageId }, "staff");
  assert.equal(ok.ok, true, JSON.stringify(ok.error));
});

test("L2-2: whatever kind of shopper message follows her Accept, it blocks until the screen shows it, and an empty-screen seen shows nothing", async () => {
  const kinds = {
    note: (duo) => herNote(duo, "thanks"),
    reading: (duo) =>
      duo.shopperTransport.send({ toUserId: duo.seat.deskUserId, type: TYPES.READING, content: { visit: "visit-a", caseId: "R-104", lab: [64, 14, 20], hueAngle: 55, band: 1, lighting: "good" } }),
    request_again: (duo) =>
      duo.shopperTransport.send({ toUserId: duo.seat.deskUserId, type: TYPES.RETURN_REQUEST, content: { visit: "visit-a", caseId: "R-104", orderId: "O-5521", reason: "wrong shade, opened" } }),
  };
  for (const [name, write] of Object.entries(kinds)) {
    const duo = await makeChatDuo();
    const { draft } = await offerSent(duo);
    await shopperAccepts(duo, draft);
    const before = newestIdOf(duo.desk);
    const msg = await write(duo);
    await duo.settle();
    assert.equal((await approveExchange(duo.desk, { seen: before })).error?.code, "thread_moved", `${name}: stale seen`);
    assert.equal((await approveExchange(duo.desk, { seen: "" })).error?.code, "thread_moved", `${name}: an empty screen showed nothing`);
    const shown = await approveExchange(duo.desk, { seen: msg.messageId });
    assert.equal(shown.ok, true, `${name}: ${JSON.stringify(shown.error)}`);
  }
});

test("L2-2: a message sent before her Accept never blocks, and staff's own words after it don't either", async () => {
  const duo = await makeChatDuo();
  const { draft } = await offerSent(duo);
  await herNote(duo, "is that the closest one?");
  await shopperAccepts(duo, draft);
  const staffNote = await duo.desk.invoke("staff_note", { ...R104, text: "Great, approving now", seen: newestIdOf(duo.desk) }, "staff");
  assert.equal(staffNote.ok, true, JSON.stringify(staffNote.error));
  const r = await approveExchange(duo.desk, { seen: staffNote.result.messageId });
  assert.equal(r.ok, true, JSON.stringify(r.error));
});

test("L2-2: on a case with a thread, approvals need `seen`, and it must name a message of that thread", async () => {
  const duo = await makeChatDuo();
  const { draft } = await offerSent(duo);
  await shopperAccepts(duo, draft);
  for (const approve of ["approve_exchange", "approve_refund"]) {
    assert.equal((await duo.desk.invoke(approve, R104, "staff")).error.code, "bad_args", `${approve} without seen`);
    assert.equal((await duo.desk.invoke(approve, { ...R104, seen: "fm_nope" }, "staff")).error.code, "unknown_message");
    assert.equal((await duo.desk.invoke(approve, { ...R104, seen: newestIdOf(duo.desk), reason: "x" }, "staff")).error.code, "smuggled_field");
  }
  assert.equal(duo.desk.store.getCase("R-104").status, "drafted");
});

test("L2-2: a case with no thread still approves on {caseId} alone", async () => {
  const { makeApp } = await import("./helpers.js");
  const app = await makeApp();
  await app.invoke("draft_return_resolution", { ...R104, resolution: "exchange", shadeCode: "245W", evidence: { deltaE: { "220N": 5.0, "245W": 2.1 } } }, "agent");
  assert.equal((await app.invoke("approve_exchange", R104, "staff")).ok, true);
});
