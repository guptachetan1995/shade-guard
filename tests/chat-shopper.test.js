import { test } from "node:test";
import assert from "node:assert/strict";
import { runPlanner } from "../src/agent/planner.js";
import { TYPES } from "../src/chat/messages.js";
import { makeChatDuo, messagesOf } from "./chat-helpers.js";
import { makeApp, photo } from "./helpers.js";

const send = (duo, args, actor = "shopper") => duo.shopper.invoke("shopper_send", args, actor);
const types = (app, caseId) => messagesOf(app, caseId).map((m) => m.type);

// Staff's offer, sent from the desk's own transport as the desk's verb will, so a shopper test
// does not depend on the staff verbs.
async function staffSends(duo, type, content) {
  const m = await duo.deskTransport.send({ toUserId: duo.seat.shoppers[0].userId, type, content: { visit: "visit-a", ...content } });
  await duo.settle();
  return m;
}
const offer = (draftId, extra = {}) => ({ caseId: "R-104", draftId, text: "We can exchange it for 245W. Tap Accept.", resolution: "exchange", shadeCode: "245W", deltaE: { "245W": 2.1 }, ...extra });

test("shopper_send sends her own note, and it reaches the desk with the service's id and time", async () => {
  const duo = await makeChatDuo();
  const r = await send(duo, { kind: "note", text: "is 250W any closer?" });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.result.type, TYPES.NOTE);
  assert.deepEqual(duo.server.pending(duo.seat.deskUserId).map((m) => m.messageId), [r.result.messageId], "on the service, not yet at the desk");
  assert.equal(messagesOf(duo.desk, "R-104").length, 0);
  await duo.settle();
  const [onDesk] = messagesOf(duo.desk, "R-104");
  const [mine] = messagesOf(duo.shopper, "R-104");
  assert.deepEqual([onDesk.messageId, onDesk.sentTime, onDesk.sender, onDesk.content.text], [r.result.messageId, r.result.sentTime, "shopper", "is 250W any closer?"]);
  assert.deepEqual([mine.messageId, mine.own, mine.sender], [r.result.messageId, true, "shopper"], "recorded on her own side from what the service returned");
  assert.deepEqual(onDesk.content, { visit: "visit-a", caseId: "R-104", text: "is 250W any closer?" });
});

test("shopper_send return_request carries the order and the case's own reason, once", async () => {
  const duo = await makeChatDuo();
  const r = await send(duo, { kind: "return_request" });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  await duo.settle();
  assert.deepEqual(messagesOf(duo.desk, "R-104")[0].content, { visit: "visit-a", caseId: "R-104", orderId: "O-5521", reason: "wrong shade, opened" });
  assert.equal((await send(duo, { kind: "return_request" })).error.code, "already_requested");
  assert.equal((await send(duo, { kind: "return_request", text: "my own reason" })).error.code, "bad_args", "the reason is the order's, not typed");
  assert.equal(types(duo.shopper, "R-104").length, 1);
});

test("shopper_send refuses every actor but the shopper, and sends nothing", async () => {
  const duo = await makeChatDuo();
  const before = duo.server.log.length;
  for (const actor of ["agent", "staff", "merchant", "nexconn"]) {
    const r = await send(duo, { kind: "note", text: "hi" }, actor);
    assert.equal(r.error.code, "wrong_actor", actor);
  }
  assert.equal(duo.server.log.length, before);
});

test("shopper_send refuses bad arguments: a missing, blank or overlong text, an unknown kind, a smuggled field", async () => {
  const duo = await makeChatDuo();
  const code = async (args) => (await send(duo, args)).error?.code;
  assert.equal(await code({ kind: "note" }), "bad_args");
  assert.equal(await code({ kind: "note", text: "   " }), "bad_args");
  assert.equal(await code({ kind: "note", text: "x".repeat(501) }), "bad_args");
  assert.equal(await code({ kind: "shout", text: "hi" }), "bad_args");
  assert.equal(await code({ kind: "note", text: "hi", photo: "AAAA" }), "smuggled_field", "no photo rides along");
  assert.equal(duo.server.log.length, 0);
});

test("shopper_send: only her own case, and only while connected, and not on the desk's page", async () => {
  const duo = await makeChatDuo();
  assert.equal((await send(duo, { kind: "note", caseId: "R-107", text: "hi" })).error.code, "not_your_case");
  assert.equal((await send(duo, { kind: "note", caseId: "R-104", text: "hi" })).ok, true, "naming her own case is fine");
  duo.server.drop(duo.seat.shoppers[0].userId);
  const offline = await send(duo, { kind: "note", text: "anyone there?" });
  assert.equal(offline.error.code, "chat_offline");
  assert.equal(duo.shopper.store.state.threads["R-104"].messages.length, 1, "an unsent note is not in the thread");
  assert.equal((await duo.desk.invoke("shopper_send", { kind: "note", text: "hi" }, "shopper")).error.code, "wrong_side");
  const plain = await makeApp();
  assert.equal((await plain.invoke("shopper_send", { kind: "note", text: "hi" }, "shopper")).error.code, "chat_offline", "no chat configured");
});

test("shopper_send refuses once staff have closed the case", async () => {
  const duo = await makeChatDuo();
  await staffSends(duo, TYPES.CASE_CLOSED, { caseId: "R-104", reason: "resolved" });
  assert.equal((await send(duo, { kind: "note", text: "one more thing" })).error.code, "case_closed");
  assert.equal((await send(duo, { kind: "return_request" })).error.code, "case_closed");
});

async function closedReturnCheck(duo, shopperIndex = 1, name = "sample-shopper") {
  const caseId = duo.seat.shoppers[shopperIndex].caseId;
  const s = await duo.shopper.invoke("start_check", { photo: photo(name), capture: "upload", caseId }, "shopper");
  assert.equal(s.ok, true, JSON.stringify(s.error));
  await runPlanner(duo.shopper.invoke, { checkId: s.result.checkId, caseId });
  return { checkId: s.result.checkId, caseId };
}

test("share_reading sends the closed check's numbers as SG:Reading, and the desk's case opens on them", async () => {
  const duo = await makeChatDuo({ shopperIndex: 1 });
  const { checkId, caseId } = await closedReturnCheck(duo);
  assert.equal(duo.shopper.store.getCheck(checkId).status, "closed");
  const r = await duo.shopper.invoke("share_reading", { checkId, caseId }, "shopper");
  assert.equal(r.ok, true, JSON.stringify(r.error));
  await duo.settle();
  const msg = messagesOf(duo.desk, "R-107").find((m) => m.type === TYPES.READING);
  const c = duo.shopper.store.getCheck(checkId).complexion;
  assert.deepEqual(msg.content, { visit: "visit-a", caseId: "R-107", lab: c.lab, hueAngle: c.hueAngle, band: c.band, lighting: "good" });
  assert.equal(JSON.stringify(msg).match(/photo|base64|jpeg/i), null, "numbers only");
  const rcase = duo.desk.store.getCase("R-107");
  assert.equal(rcase.status, "open");
  assert.deepEqual(rcase.reading.ranking.map((x) => [x.code, x.de00]), [["245W", 1.93], ["250W", 3.1], ["220N", 4.62]], "the desk reaches the same ranking from the numbers");
  assert.equal((await duo.shopper.invoke("share_reading", { checkId, caseId }, "shopper")).error.code, "already_shared");
});

test("share_reading refuses a check that is not hers, not closed, or has no reading", async () => {
  const duo = await makeChatDuo({ shopperIndex: 1 });
  const share = (args, actor = "shopper") => duo.shopper.invoke("share_reading", args, actor);
  assert.equal((await share({ checkId: "chk_99", caseId: "R-107" })).error.code, "unknown_check");
  assert.equal((await share({ checkId: "chk_01", caseId: "R-104" })).error.code, "not_your_case");
  // A cart check is the shop's, not hers for this case.
  const cart = await duo.shopper.invoke("start_check", { photo: photo(), capture: "upload" }, "shopper");
  assert.equal((await share({ checkId: cart.result.checkId, caseId: "R-107" })).error.code, "check_not_hers");
  // An open return check has not closed yet.
  const open = await duo.shopper.invoke("start_check", { photo: photo(), capture: "upload", caseId: "R-107" }, "shopper");
  assert.equal((await share({ checkId: open.result.checkId, caseId: "R-107" })).error.code, "check_not_closed");
  assert.equal((await share({ checkId: open.result.checkId, caseId: "R-107" }, "agent")).error.code, "wrong_actor");
  assert.equal(duo.server.log.length, 0, "nothing was sent");
});

test("share_reading refuses a closed check that could not be read, and a closed case, and an offline chat", async () => {
  const duo = await makeChatDuo({ shopperIndex: 1 });
  const { checkId, caseId } = await closedReturnCheck(duo, 1, "angle-up");
  const check = duo.shopper.store.getCheck(checkId);
  assert.equal(check.status, "closed");
  assert.equal(check.complexion, null);
  assert.equal((await duo.shopper.invoke("share_reading", { checkId, caseId }, "shopper")).error.code, "no_reading_in_check");

  const ok = await makeChatDuo({ shopperIndex: 1 });
  const good = await closedReturnCheck(ok);
  ok.server.drop(ok.seat.shoppers[1].userId);
  assert.equal((await ok.shopper.invoke("share_reading", good, "shopper")).error.code, "chat_offline");
  await ok.shopperTransport.connect();
  const closed = await ok.deskTransport.send({ toUserId: ok.seat.shoppers[1].userId, type: TYPES.CASE_CLOSED, content: { visit: "visit-a", caseId: "R-107", reason: "resolved" } });
  await ok.settle();
  assert.ok(closed.messageId);
  assert.equal((await ok.shopper.invoke("share_reading", good, "shopper")).error.code, "case_closed");
});

test("accept_offer sends SG:OfferAccepted for the newest offer, once", async () => {
  const duo = await makeChatDuo();
  const o = await staffSends(duo, TYPES.OFFER, offer("d_01"));
  const r = await duo.shopper.invoke("accept_offer", { caseId: "R-104", draftId: "d_01" }, "shopper");
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.result.type, TYPES.OFFER_ACCEPTED);
  assert.ok(r.result.sentTime > o.sentTime, "after the offer, on the service's clock");
  await duo.settle();
  const accepted = messagesOf(duo.desk, "R-104").find((m) => m.type === TYPES.OFFER_ACCEPTED);
  assert.deepEqual(accepted.content, { visit: "visit-a", caseId: "R-104", draftId: "d_01" });
  assert.equal((await duo.shopper.invoke("accept_offer", { caseId: "R-104", draftId: "d_01" }, "shopper")).error.code, "already_accepted");
});

test("accept_offer refuses an offer that is not the newest, an unknown one, a closed case, another case, other actors, and offline", async () => {
  const duo = await makeChatDuo();
  const accept = (draftId, caseId = "R-104", actor = "shopper") => duo.shopper.invoke("accept_offer", { caseId, draftId }, actor);
  assert.equal((await accept("d_01")).error.code, "unknown_offer", "no offer at all yet");
  await staffSends(duo, TYPES.OFFER, offer("d_01"));
  await staffSends(duo, TYPES.OFFER, offer("d_02", { text: "We can exchange it for 245W instead. Tap Accept.", deltaE: { "245W": 2.1, "250W": 3.51 } }));
  assert.equal((await accept("d_01")).error.code, "offer_superseded", "she is looking at the old card");
  assert.equal((await accept("d_09")).error.code, "unknown_offer");
  assert.equal((await accept("d_02", "R-107")).error.code, "not_your_case");
  for (const actor of ["agent", "staff", "merchant", "nexconn"]) assert.equal((await accept("d_02", "R-104", actor)).error.code, "wrong_actor", actor);
  duo.server.drop(duo.seat.shoppers[0].userId);
  assert.equal((await accept("d_02")).error.code, "chat_offline");
  await duo.shopperTransport.connect();
  await staffSends(duo, TYPES.CASE_CLOSED, { caseId: "R-104", reason: "resolved" });
  assert.equal((await accept("d_02")).error.code, "case_closed", "after a close");
  assert.equal(messagesOf(duo.desk, "R-104").some((m) => m.type === TYPES.OFFER_ACCEPTED), false, "nothing was accepted");
});
