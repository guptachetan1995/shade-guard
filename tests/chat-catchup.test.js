// Catch-up after an automatic reconnect. When a connection pauses and comes back by itself (the SDK's
// suspended state), messages sent meanwhile may never reach the real-time handler. Once the transport
// reports connected again after having been connected, the app reads each thread back through the same
// path a restore uses (the same budgets, another visit's messages dropped), so they appear without
// waiting for the next send's thread read, in order and never twice. The first connect is not a
// reconnect: it restores once. On the fake service here; on the adapter (mock-only) at the end.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { FakeYouCamProvider } from "../src/providers/youcam-fake.js";
import { registrationObjects, TYPES } from "../src/chat/messages.js";
import { createNexconnTransport } from "../src/chat/nexconn-transport.js";
import { SHOPPER_PROFILES } from "../src/chat/seats.js";
import { ChatError, MAX_PAGES, PAGE_SIZE, STATUS } from "../src/chat/transport.js";
import { agentDrafts, makeChatDuo, messagesOf, shopperRequests, staffSendsDraft, textsOf, wrapTransport } from "./chat-helpers.js";
import { MockNexconnServer } from "./nexconn-sdk-mock.js";
import { fixedClock, noWait } from "./helpers.js";

const say = async (duo, text) => {
  const r = await duo.shopper.invoke("shopper_send", { kind: "note", text }, "shopper");
  assert.equal(r.ok, true, JSON.stringify(r.error));
};
const ids = (app, caseId = "R-104") => messagesOf(app, caseId).map((m) => m.messageId);
const unique = (list) => new Set(list).size === list.length;

test("the fake service can pause a connection without ending it: it reads as connecting, delivers nothing and sends nothing, then comes back connected", async () => {
  const duo = await makeChatDuo();
  const seen = [];
  duo.deskTransport.onStatus((s) => seen.push(s.state));
  duo.server.suspend(duo.seat.deskUserId);
  assert.equal(duo.deskTransport.status().state, STATUS.CONNECTING);
  assert.match(duo.deskTransport.status().detail, /reconnects by itself/);
  await assert.rejects(duo.deskTransport.newest({ withUserId: duo.seat.shoppers[0].userId }), (e) => e.code === "chat_offline");
  await say(duo, "while you were away");
  assert.equal(duo.server.deliver(duo.seat.deskUserId), 0, "nothing is delivered to a paused connection");
  duo.server.resume(duo.seat.deskUserId);
  assert.deepEqual(seen, [STATUS.CONNECTING, STATUS.CONNECTED]);
  assert.equal(duo.server.deliver(duo.seat.deskUserId), 0, "by default the messages sent meanwhile never reach the real-time handler");
});

test("after an automatic reconnect the desk reads its threads back: what the shopper sent meanwhile appears, in order, with no duplicate, and before any send", async () => {
  const duo = await makeChatDuo();
  await shopperRequests(duo);
  duo.server.suspend(duo.seat.deskUserId);
  await say(duo, "is 250W any closer?");
  await say(duo, "or 240W?");
  await duo.settle();
  assert.deepEqual(textsOf(duo.desk, "R-104"), [TYPES.RETURN_REQUEST], "not delivered while paused");
  duo.server.resume(duo.seat.deskUserId);
  await duo.desk.chat.caughtUp();
  await duo.desk.chat.settled();
  assert.deepEqual(textsOf(duo.desk, "R-104"), [TYPES.RETURN_REQUEST, "is 250W any closer?", "or 240W?"]);
  assert.ok(unique(ids(duo.desk)));
  const times = messagesOf(duo.desk, "R-104").map((m) => m.sentTime);
  assert.deepEqual(times, [...times].sort((a, b) => a - b), "in server-time order");
});

test("when the service also hands the missed messages over after the reconnect, nothing is held twice", async () => {
  const duo = await makeChatDuo();
  await shopperRequests(duo);
  duo.server.suspend(duo.seat.deskUserId);
  await say(duo, "one");
  await say(duo, "two");
  duo.server.resume(duo.seat.deskUserId, { replay: true });
  await duo.settle();
  await duo.desk.chat.caughtUp();
  await duo.desk.chat.settled();
  assert.deepEqual(textsOf(duo.desk, "R-104"), [TYPES.RETURN_REQUEST, "one", "two"]);
  assert.ok(unique(ids(duo.desk)));
});

test("the first connect is not a reconnect: it restores each thread once and starts no catch-up", async () => {
  let reads = 0;
  const duo = await makeChatDuo({ deskTransport: (t) => wrapTransport(t, { newest: (args) => (reads++, t.newest(args)) }) });
  assert.equal(reads, 2, "one read for each of the seat's two channels");
  await duo.desk.chat.caughtUp();
  assert.equal(reads, 2);
});

test("a reconnect while the first restore is still reading is caught up once that restore ends", async () => {
  let first = true;
  const duo = await makeChatDuo({
    connect: false,
    // The desk's first read is cut off by a pause and a reconnect, as a flaky network would.
    deskTransport: (t) =>
      wrapTransport(t, {
        newest: async (args) => {
          if (first) {
            first = false;
            duo.server.suspend(duo.seat.deskUserId);
            duo.server.resume(duo.seat.deskUserId);
            throw new ChatError("read_failed", "the read was cut off");
          }
          return t.newest(args);
        },
      }),
  });
  await duo.shopper.chat.connect();
  assert.equal((await duo.shopper.invoke("shopper_send", { kind: "return_request" }, "shopper")).ok, true);
  await duo.desk.chat.connect();
  await duo.desk.chat.settled();
  assert.equal(first, false);
  assert.deepEqual(textsOf(duo.desk, "R-104"), [TYPES.RETURN_REQUEST], "the read the reconnect cut off was made again");
});

test("a catch-up keeps the restore's budget: past it, the newest part is recorded, another visit's messages are dropped, and the gap is flagged, not called older history", async () => {
  const duo = await makeChatDuo();
  await shopperRequests(duo);
  const desk = duo.seat.deskUserId;
  const shop = duo.seat.shoppers[0].userId;
  const before = { ...duo.desk.store.state.threads["R-104"].readThrough };
  duo.server.suspend(desk);
  for (let i = 0; i < MAX_PAGES * PAGE_SIZE + 5; i++) duo.server.record(shop, desk, TYPES.NOTE, { visit: "visit-b", caseId: "R-104", text: `other ${i}` });
  await say(duo, "newest, mine");
  duo.server.resume(desk);
  await duo.desk.chat.caughtUp();
  await duo.desk.chat.settled();
  const thread = duo.desk.store.state.threads["R-104"];
  assert.deepEqual(textsOf(duo.desk, "R-104"), [TYPES.RETURN_REQUEST, "newest, mine"]);
  assert.equal(thread.readGap, true, "messages may be missing in the middle of the thread");
  assert.equal(thread.historyTruncated, false, "the missing part is not older history");
  assert.deepEqual(thread.readThrough, before, "the read point stays where the last complete read left it");
  assert.ok(duo.desk.store.state.chat.otherVisitDropped >= MAX_PAGES * PAGE_SIZE - 1);
});

// The independent review's repro (17 Nov): her message in the gap, buried under another visit's flood
// while the desk was away. Without the catch-up the next send can't read back far enough and refuses;
// the catch-up must not change that by moving the read point past the gap.
for (const catchUp of [true, false]) {
  test(`a message of this visit in the gap under a flood still stops the next send as thread_unverified (${catchUp ? "after a catch-up" : "no catch-up"})`, async () => {
    const duo = await makeChatDuo();
    await shopperRequests(duo);
    const desk = duo.seat.deskUserId;
    const shop = duo.seat.shoppers[0].userId;
    const draft = await agentDrafts(duo);
    if (catchUp) duo.server.suspend(desk);
    await say(duo, "mine, in the gap");
    for (let i = 0; i < MAX_PAGES * PAGE_SIZE + 5; i++) duo.server.record(shop, desk, TYPES.NOTE, { visit: "visit-b", caseId: "R-104", text: `other ${i}` });
    if (catchUp) {
      duo.server.resume(desk);
      await duo.desk.chat.caughtUp();
      await duo.desk.chat.settled();
    }
    const sent = await staffSendsDraft(duo, draft);
    assert.equal(sent.ok, false);
    assert.equal(sent.error.code, "thread_unverified");
    assert.equal(duo.server.newest(desk, shop, 20).filter((m) => m.type === TYPES.OFFER).length, 0, "nothing was sent");
    if (catchUp) assert.equal(duo.desk.store.state.threads["R-104"].readGap, true);
  });
}

// The fix check's repro (17 Nov): the exported restore(), called without the catch-up's flag, moved the
// read point past the gap, and a send went out over her unseen message. The gap is decided by whether
// the thread already had a read point, never by who called.
test("restore() called on its own, past a gap, also keeps the read point: the next send is still thread_unverified", async () => {
  const duo = await makeChatDuo();
  await shopperRequests(duo);
  const desk = duo.seat.deskUserId;
  const shop = duo.seat.shoppers[0].userId;
  const draft = await agentDrafts(duo);
  const before = { ...duo.desk.store.state.threads["R-104"].readThrough };
  await say(duo, "mine, in the gap");
  for (let i = 0; i < MAX_PAGES * PAGE_SIZE + 5; i++) duo.server.record(shop, desk, TYPES.NOTE, { visit: "visit-b", caseId: "R-104", text: `other ${i}` });
  await duo.desk.chat.restore();
  await duo.desk.chat.settled();
  const thread = duo.desk.store.state.threads["R-104"];
  assert.deepEqual(thread.readThrough, before);
  assert.equal(thread.readGap, true);
  const sent = await staffSendsDraft(duo, draft);
  assert.equal(sent.ok, false);
  assert.equal(sent.error.code, "thread_unverified");
  assert.equal(duo.server.newest(desk, shop, 20).filter((m) => m.type === TYPES.OFFER).length, 0, "nothing was sent");
});

test("a later read that reaches back to the read point closes the gap", async () => {
  const duo = await makeChatDuo();
  await shopperRequests(duo);
  const desk = duo.seat.deskUserId;
  const shop = duo.seat.shoppers[0].userId;
  duo.server.suspend(desk);
  for (let i = 0; i < MAX_PAGES * PAGE_SIZE + 5; i++) duo.server.record(shop, desk, TYPES.NOTE, { visit: "visit-b", caseId: "R-104", text: `other ${i}` });
  duo.server.resume(desk);
  await duo.desk.chat.caughtUp();
  const thread = duo.desk.store.state.threads["R-104"];
  assert.equal(thread.readGap, true);
  // A wider read than the page budget, as a later slice or a quieter channel would allow.
  const { readBack } = await import("../src/chat/history.js");
  const { markRead } = await import("../src/threads.js");
  const read = await readBack(duo.deskTransport, shop, { anchor: thread.readThrough, maxPages: 40 });
  assert.notEqual(read.reached, null, "a complete read: it reached the read point or the start");
  markRead(thread, read.messages);
  assert.equal(thread.readGap, false);
});

test("a catch-up that cannot read the service leaves the thread as it was, and the next reconnect reads again", async () => {
  const duo = await makeChatDuo();
  await shopperRequests(duo);
  const desk = duo.seat.deskUserId;
  duo.server.suspend(desk);
  await say(duo, "lost for now");
  duo.server.failReads = true;
  duo.server.resume(desk);
  await duo.desk.chat.caughtUp();
  assert.deepEqual(textsOf(duo.desk, "R-104"), [TYPES.RETURN_REQUEST]);
  duo.server.failReads = false;
  duo.server.suspend(desk);
  duo.server.resume(desk);
  await duo.desk.chat.caughtUp();
  await duo.desk.chat.settled();
  assert.deepEqual(textsOf(duo.desk, "R-104"), [TYPES.RETURN_REQUEST, "lost for now"]);
});

test("the phone catches up the same way: a staff note sent while her connection was paused appears after it comes back", async () => {
  const duo = await makeChatDuo();
  await shopperRequests(duo);
  const shop = duo.seat.shoppers[0].userId;
  duo.server.suspend(shop);
  const r = await duo.desk.invoke("staff_note", { caseId: "R-104", text: "We have your request.", seen: messagesOf(duo.desk, "R-104").at(-1).messageId }, "staff");
  assert.equal(r.ok, true, JSON.stringify(r.error));
  duo.server.resume(shop);
  await duo.shopper.chat.caughtUp();
  await duo.shopper.chat.settled();
  assert.deepEqual(textsOf(duo.shopper, "R-104"), [TYPES.RETURN_REQUEST, "We have your request."]);
});

// ---------------------------------------------------------------------------- on the adapter (mock-only)

const DESK = "sgdesk00000001";
const SHOP = "sgshop00000001";
const SHOP2 = "sgshop00000002";

async function nexconnDuo() {
  const server = new MockNexconnServer();
  const tokens = { [DESK]: server.addUser(DESK), [SHOP]: server.addUser(SHOP), [SHOP2]: server.addUser(SHOP2) };
  const seat = { n: 1, deskUserId: DESK, shoppers: [{ userId: SHOP, ...SHOPPER_PROFILES[0] }, { userId: SHOP2, ...SHOPPER_PROFILES[1] }] };
  const open = async (side) => {
    const userId = side === "desk" ? DESK : SHOP;
    const t = createNexconnTransport({ sdk: server.realm().sdk, appKey: "dummy-app-key", area: "SG", userId, token: tokens[userId] });
    const app = await createApp({ provider: new FakeYouCamProvider(), now: fixedClock(), wait: noWait, chat: { transport: t, seat, side, as: 0, visit: "visit-a" } });
    await app.chat.connect();
    return app;
  };
  const desk = await open("desk");
  const shopper = await open("shopper");
  const settle = async () => {
    for (let i = 0; i < 6; i++) {
      server.deliver();
      await desk.chat.settled();
      await shopper.chat.settled();
    }
  };
  return { server, desk, shopper, settle };
}

for (const replay of [false, true]) {
  test(`on the adapter, a suspended connection the SDK brings back catches up from history (the SDK ${replay ? "also hands the missed messages over" : "hands nothing over"}), in order and never twice`, async () => {
    const duo = await nexconnDuo();
    const r = await duo.shopper.invoke("shopper_send", { kind: "return_request" }, "shopper");
    assert.equal(r.ok, true);
    await duo.settle();
    const queriesBefore = duo.server.queriesCreated.length;
    duo.server.suspend(DESK);
    assert.equal(duo.desk.store.state.chat.connection.state, STATUS.CONNECTING);
    for (const text of ["is 250W any closer?", "or 240W?"]) assert.equal((await duo.shopper.invoke("shopper_send", { kind: "note", text }, "shopper")).ok, true);
    await duo.settle();
    assert.deepEqual(textsOf(duo.desk, "R-104"), [TYPES.RETURN_REQUEST], "nothing reaches a suspended connection");
    duo.server.resume(DESK, { replay });
    await duo.settle();
    await duo.desk.chat.caughtUp();
    await duo.desk.chat.settled();
    assert.equal(duo.desk.store.state.chat.connection.state, STATUS.CONNECTED);
    assert.deepEqual(textsOf(duo.desk, "R-104"), [TYPES.RETURN_REQUEST, "is 250W any closer?", "or 240W?"]);
    assert.ok(unique(ids(duo.desk)));
    assert.ok(duo.server.queriesCreated.length > queriesBefore, "the catch-up read history with createMessagesQuery");
  });
}

test("registrations are still in place for a catch-up: the adapter does not register or initialize again on an automatic reconnect", async () => {
  const duo = await nexconnDuo();
  const realmCalls = duo.server.realms.find((r) => r.userId === DESK).calls;
  duo.server.suspend(DESK);
  duo.server.resume(DESK);
  await duo.desk.chat.caughtUp();
  const count = (op) => realmCalls.filter((c) => c.op === op).length;
  assert.deepEqual([count("NCEngine.initialize"), count("NCEngine.registerCustomMessages"), count("NCEngine.connect")], [1, 1, 1]);
  assert.ok(registrationObjects().length > 0);
});
