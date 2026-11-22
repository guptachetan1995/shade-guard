// A flood of messages (S0b review): anyone holding a public seat's tokens can write to its channel, so
// another visit's traffic must cost the desk almost nothing, and the log must stay bounded and
// carry no message text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TYPES } from "../src/chat/messages.js";
import { makeChatDuo, messagesOf, newestIdOf, offerSent, R104, shopperAccepts, wrapTransport } from "./chat-helpers.js";
import { createApp } from "../src/app.js";
import { FakeYouCamProvider } from "../src/providers/youcam-fake.js";

test("3,000 messages of another visit are dropped before the chokepoint: counted, never logged, never recorded", async () => {
  const duo = await makeChatDuo();
  const body = "x".repeat(400);
  for (let i = 0; i < 3000; i++) await duo.shopperTransport.send({ toUserId: duo.seat.deskUserId, type: TYPES.NOTE, content: { visit: "visit-b", caseId: "R-104", text: body } });
  const logBefore = duo.desk.store.state.activityLog.length;
  let changes = 0;
  duo.desk.chat.onChange(() => changes++);
  duo.server.deliverAll();
  await duo.desk.chat.settled();
  assert.equal(duo.desk.store.state.activityLog.length, logBefore, "not one log entry");
  assert.equal(duo.desk.store.state.chat.otherVisitDropped, 3000);
  assert.equal(changes, 0, "and nothing to redraw");
  assert.equal(messagesOf(duo.desk, "R-104").length, 0);
});

test("the log line for a recorded message carries its id, type, sender, time and size, never its text", async () => {
  const duo = await makeChatDuo();
  const r = await duo.shopper.invoke("shopper_send", { kind: "note", text: "my secret-ish words about my skin" }, "shopper");
  await duo.settle();
  const entry = duo.desk.store.state.activityLog.findLast((e) => e.tool === "record_inbound");
  assert.deepEqual(Object.keys(entry.args).sort(), ["contentBytes", "messageId", "senderUserId", "sentTime", "type"]);
  assert.equal(entry.args.messageId, r.result.messageId);
  assert.ok(entry.args.contentBytes > 20);
  assert.equal(JSON.stringify(duo.desk.store.state.activityLog).includes("secret-ish"), false);
  assert.equal(messagesOf(duo.desk, "R-104")[0].content.text, "my secret-ish words about my skin", "the thread itself still holds it");
});

// The cap itself (MAX_LOG_ENTRIES in src/invoke.js) is pinned in chat-flood-units.test.js.
const MAX_LOG_ENTRIES = 2000;

test("the activity log is a ring: it never holds more than its cap, and keeps the newest", async () => {
  const duo = await makeChatDuo();
  for (let i = 0; i < MAX_LOG_ENTRIES + 50; i++) await duo.desk.invoke("read_thread", { caseId: `R-${i}` }, "agent");
  const log = duo.desk.store.state.activityLog;
  assert.equal(log.length, MAX_LOG_ENTRIES);
  assert.equal(log.at(-1).args.caseId, `R-${MAX_LOG_ENTRIES + 49}`);
  assert.equal(log[0].args.caseId, `R-${50}`);
});

// ---------------------------------------------------------------------------- two desk tabs of one visit

async function secondTab(duo) {
  const tab = await createApp({ provider: new FakeYouCamProvider(), wait: async () => {}, chat: { transport: duo.server.transport(duo.seat.deskUserId), seat: duo.seat, side: "desk", visit: "visit-a" } });
  await tab.chat.connect();
  return tab;
}

test("a case another tab of the same desk closed is closed here too: every staff verb re-checks after reading the service, and sends or approves nothing", async () => {
  for (const verb of ["send_reply", "staff_note", "close_case", "approve_exchange", "approve_refund"]) {
    const duo = await makeChatDuo();
    const { draft } = await offerSent(duo);
    await shopperAccepts(duo, draft);
    const tab2 = await secondTab(duo);
    const closed = await tab2.invoke("close_case", { ...R104, seen: newestIdOf(tab2), reason: "resolved" }, "staff");
    assert.equal(closed.ok, true, JSON.stringify(closed.error));
    assert.equal(messagesOf(duo.desk, "R-104").some((m) => m.type === TYPES.CASE_CLOSED), false, "this tab's mirror has not been delivered the close");
    const before = duo.server.log.length;
    const seen = newestIdOf(duo.desk);
    const args = {
      send_reply: { ...R104, draftId: "d_01", seen: "0" },
      staff_note: { ...R104, text: "one more thing", seen },
      close_case: { ...R104, reason: "resolved", seen },
      approve_exchange: { ...R104, seen },
      approve_refund: { ...R104, seen },
    }[verb];
    if (verb === "send_reply") {
      const again = (await duo.desk.invoke("draft_reply", { ...R104, kind: "exchange_offer", evidence: { shadeCode: "245W", deltaE: { "245W": 2.1, "250W": 3.51, "220N": 5.0 }, band: 1 } }, "agent")).result.draft;
      Object.assign(args, { draftId: again.draftId, seen: again.fingerprint });
    }
    const r = await duo.desk.invoke(verb, args, "staff");
    assert.equal(r.error?.code, "case_closed", verb);
    assert.equal(duo.server.log.length, before, `${verb}: nothing reached the thread`);
    assert.equal(duo.desk.store.getCase("R-104").status, "drafted", `${verb}: and nothing was approved`);
  }
});

test("a thread read that succeeded is remembered: the next one goes back only as far as the last, even when the restore had failed", async () => {
  let reads = 0;
  const duo = await makeChatDuo();
  duo.server.failReads = true;
  const raw = duo.server.transport(duo.seat.deskUserId);
  const counted = wrapTransport(raw, { newest: (a) => (reads++, raw.newest(a)) });
  const fresh = await createApp({ provider: new FakeYouCamProvider(), wait: async () => {}, chat: { transport: counted, seat: duo.seat, side: "desk", visit: "visit-a" } });
  await fresh.chat.connect();
  duo.server.failReads = false;
  assert.equal(fresh.store.state.threads["R-104"].readThrough, null, "the restore read nothing");
  for (let i = 0; i < 45; i++) await duo.shopperTransport.send({ toUserId: duo.seat.deskUserId, type: TYPES.NOTE, content: { visit: "visit-b", caseId: "R-104", text: `noise ${i}` } });
  reads = 0;
  const first = await fresh.invoke("staff_note", { ...R104, text: "hello", seen: "" }, "staff");
  assert.equal(first.ok, true, JSON.stringify(first.error));
  assert.ok(reads >= 3, `the first read had to go back through 45 messages (${reads} pages)`);
  assert.notEqual(fresh.store.state.threads["R-104"].readThrough, null);
  reads = 0;
  const second = await fresh.invoke("staff_note", { ...R104, text: "hello again", seen: newestIdOf(fresh) }, "staff");
  assert.equal(second.ok, true, JSON.stringify(second.error));
  assert.equal(reads, 2, "one page for the read before the send, one for the follow-up after it");
});
