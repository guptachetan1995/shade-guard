// Reading a channel back far enough (S0b review G2): a read of "the newest page" is blind when
// messages of another visit crowd the page, so every thread read pages back until it reaches
// ground the mirror already covers, and refuses when it cannot.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { FakeYouCamProvider } from "../src/providers/youcam-fake.js";
import { TYPES } from "../src/chat/messages.js";
import { agentDrafts, EV104, makeChatDuo, messagesOf, newestIdOf, offerSent, R104, shopperAccepts, shopperRequests, staffSendsDraft } from "./chat-helpers.js";

const FLOODS = [0, 19, 20, 21, 45];
// What a thread read will page back through before it gives up: MAX_PAGES x PAGE_SIZE in src/chat/history.js,
// which chat-readback.test.js pins.
const CAP = 500;

// n messages from the shopper's own user id, but another visit's.
async function noise(duo, n, visit = "visit-b") {
  for (let i = 0; i < n; i++) {
    await duo.shopperTransport.send({ toUserId: duo.seat.deskUserId, type: TYPES.NOTE, content: { visit, caseId: "R-104", text: `noise ${i}` } });
  }
}
const herMessage = (duo, text = "I changed my mind, refund please") =>
  duo.shopperTransport.send({ toUserId: duo.seat.deskUserId, type: TYPES.NOTE, content: { visit: "visit-a", caseId: "R-104", text } });
const reload = (duo, visit = "visit-a") =>
  createApp({ provider: new FakeYouCamProvider(), wait: async () => {}, chat: { transport: duo.server.transport(duo.seat.deskUserId), seat: duo.seat, side: "desk", visit } });

test("G2: her message in flight is found by every staff verb however many messages of another visit follow it (0, 19, 20, 21, 45)", async () => {
  for (const n of FLOODS) {
    for (const verb of ["send_reply", "staff_note", "close_case"]) {
      const duo = await makeChatDuo();
      await shopperRequests(duo);
      const draft = await agentDrafts(duo);
      const seen = newestIdOf(duo.desk);
      const typed = await herMessage(duo);
      await noise(duo, n);
      const before = duo.server.log.length;
      const args = {
        send_reply: { ...R104, draftId: draft.draftId, seen: draft.fingerprint },
        staff_note: { ...R104, text: "Here is your exchange", seen },
        close_case: { ...R104, reason: "resolved", seen },
      }[verb];
      const r = await duo.desk.invoke(verb, args, "staff");
      const where = `${verb} after ${n} messages of another visit`;
      assert.equal(r.ok, false, where);
      assert.equal(r.error.code, "thread_moved", where);
      assert.equal(r.error.messageId, typed.messageId, where);
      assert.equal(duo.server.log.length, before, `${where}: nothing was sent`);
      assert.equal(messagesOf(duo.desk, "R-104").some((m) => m.messageId === typed.messageId), true, `${where}: the desk now shows her message`);
    }
  }
});

test("G2: approvals read back too: a message she wrote after her Accept, buried under another visit's traffic, is thread_moved; her Accept itself, buried the same way, is found", async () => {
  for (const n of FLOODS) {
    const buried = await makeChatDuo();
    const { draft } = await offerSent(buried);
    const typed = await herMessage(buried, "sorry, keep my order");
    await shopperAcceptsInFlight(buried, draft);
    await noise(buried, n);
    // Her Accept came after her note here, so it is the newest of hers and the approval goes.
    const ok = await buried.desk.invoke("approve_exchange", { ...R104, seen: newestIdOf(buried.desk) }, "staff");
    assert.equal(ok.ok, true, `her accept was found after ${n}: ${JSON.stringify(ok.error)}`);
    assert.ok(typed);

    const duo = await makeChatDuo();
    const offer = await offerSent(duo);
    await shopperAccepts(duo, offer.draft);
    const later = await herMessage(duo, "sorry, actually keep my order");
    await noise(duo, n);
    const r = await duo.desk.invoke("approve_exchange", { ...R104, seen: newestIdOf(duo.desk) }, "staff");
    assert.deepEqual([r.ok, r.error?.code, r.error?.messageId], [false, "thread_moved", later.messageId], `approval after ${n}`);
    assert.equal(duo.desk.store.getCase("R-104").status, "drafted");
  }
});

async function shopperAcceptsInFlight(duo, draft) {
  const r = await duo.shopper.invoke("accept_offer", { ...R104, draftId: draft.draftId }, "shopper");
  assert.equal(r.ok, true, JSON.stringify(r.error));
}

test("G2: a reload restores the visit's whole history out of the channel, however much of another visit's traffic follows it", async () => {
  for (const n of FLOODS) {
    const duo = await makeChatDuo();
    const offer = await offerSent(duo);
    await shopperAccepts(duo, offer.draft);
    await noise(duo, n);
    const wanted = messagesOf(duo.desk, "R-104").map((m) => m.messageId);
    assert.equal(wanted.length, 3, "request, offer, accept");
    const fresh = await reload(duo);
    await fresh.chat.connect();
    assert.deepEqual(messagesOf(fresh, "R-104").map((m) => m.messageId), wanted, `after ${n}`);
    assert.equal(fresh.store.state.threads["R-104"].historyTruncated, false);
    // The restored thread carries the acceptance, so the approval goes.
    assert.equal((await fresh.invoke("draft_return_resolution", { ...R104, resolution: "exchange", shadeCode: "245W", evidence: { deltaE: { "220N": 5.0, "245W": 2.1 } } }, "agent")).ok, true);
    assert.equal((await fresh.invoke("approve_exchange", { ...R104, seen: newestIdOf(fresh) }, "staff")).ok, true, `approval after a reload with ${n} messages of noise`);
  }
});

test("G2: two visits on one seat do not crowd each other out of a restored thread", async () => {
  const duo = await makeChatDuo();
  await shopperRequests(duo);
  await herMessage(duo, "is 250W any closer?");
  await noise(duo, 20, "visit-b");
  const fresh = await reload(duo, "visit-a");
  await fresh.chat.connect();
  assert.deepEqual(messagesOf(fresh, "R-104").map((m) => m.type), [TYPES.RETURN_REQUEST, TYPES.NOTE]);
  const other = await reload(duo, "visit-b");
  await other.chat.connect();
  assert.equal(messagesOf(other, "R-104").length, 20);
});

test("G2: a restore of a channel longer than the cap keeps the newest messages and says history is truncated", async () => {
  const duo = await makeChatDuo();
  await shopperRequests(duo);
  await noise(duo, CAP + 5);
  await herMessage(duo, "newest of hers");
  const fresh = await reload(duo);
  await fresh.chat.connect();
  const th = fresh.store.state.threads["R-104"];
  assert.equal(th.historyTruncated, true);
  assert.deepEqual(messagesOf(fresh, "R-104").map((m) => m.content.text ?? m.type), ["newest of hers"], "her request is below the cap and is not shown");
});

test("G2: the history-truncated flag stays set after a send and after another restore: the older part is still not loaded", async () => {
  const duo = await makeChatDuo();
  await shopperRequests(duo);
  await noise(duo, CAP + 5);
  await herMessage(duo, "newest of hers");
  const fresh = await reload(duo);
  await fresh.chat.connect();
  const th = fresh.store.state.threads["R-104"];
  assert.equal(th.historyTruncated, true);
  const note = await fresh.invoke("staff_note", { ...R104, text: "Looking into it now.", seen: newestIdOf(fresh) }, "staff");
  assert.equal(note.ok, true, JSON.stringify(note.error));
  assert.equal(th.historyTruncated, true, "a send's thread read reaches back only to what the mirror covers, never to the start");
  await fresh.chat.restore();
  assert.equal(th.historyTruncated, true, "nor does a second restore");
});

test("G2: a desk reloaded past a cut-short restore, whose mirror holds no offer, hands out an id the old offer does not carry", async () => {
  const duo = await makeChatDuo();
  const { draft } = await offerSent(duo);
  await noise(duo, CAP + 5);
  await herMessage(duo, "is it on its way?");
  const fresh = await reload(duo);
  await fresh.chat.connect();
  assert.equal(fresh.store.state.threads["R-104"].historyTruncated, true);
  assert.equal(messagesOf(fresh, "R-104").filter((m) => m.type === TYPES.OFFER).length, 0, "the old offer is past the cut");
  const r = await fresh.invoke("draft_return_resolution", { ...R104, resolution: "exchange", shadeCode: "245W", evidence: { deltaE: { "220N": 5.0, "245W": 2.1 } } }, "agent");
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const d = await fresh.invoke("draft_reply", { ...R104, kind: "exchange_offer", evidence: EV104 }, "agent");
  assert.equal(d.ok, true, JSON.stringify(d.error));
  assert.notEqual(d.result.draft.draftId, draft.draftId, "no read can see the old offer, so the id itself must differ");
});

test("G2: a verb refuses as thread_unverified when it cannot read back to what the mirror covers within the cap, and sends nothing", async () => {
  const duo = await makeChatDuo();
  await shopperRequests(duo);
  const draft = await agentDrafts(duo);
  await herMessage(duo);
  await noise(duo, CAP + 1);
  const before = duo.server.log.length;
  const r = await staffSendsDraft(duo, draft);
  assert.equal(r.error?.code, "thread_unverified");
  assert.match(r.error.message, /nothing was sent/i);
  assert.equal(duo.server.log.length, before);
  const note = await duo.desk.invoke("staff_note", { ...R104, text: "hello", seen: newestIdOf(duo.desk) }, "staff");
  assert.equal(note.error.code, "thread_unverified");
});

test("G2: a first read on a mirror that was never verified goes back to the start of the channel, not just one page", async () => {
  const duo = await makeChatDuo();
  duo.server.failReads = true;
  const fresh = await reload(duo);
  await fresh.chat.connect(); // the restore's read fails: nothing is verified
  duo.server.failReads = false;
  const typed = await herMessage(duo);
  await noise(duo, 45);
  const r = await fresh.invoke("staff_note", { ...R104, text: "hello", seen: "" }, "staff");
  assert.equal(r.error?.code, "thread_moved", "found under 45 messages of noise");
  assert.equal(r.error.messageId, typed.messageId);
});
