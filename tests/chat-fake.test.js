import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeChatServer, FAKE_BANNER, DOCUMENTED_CONNECTION_LIMIT } from "../src/chat/fake-transport.js";
import { assertChatTransport, ChatError, PAGE_SIZE, STATUS } from "../src/chat/transport.js";
import { registrationObjects, TYPES } from "../src/chat/messages.js";
import { fakeSeats, sessionFor, SEAT_COUNT } from "../src/chat/seats.js";

const note = (text) => ({ visit: "v1", caseId: "R-104", text });

async function pair(opts = {}) {
  const server = new FakeChatServer({ clock: () => 1_000, ...opts });
  const [seat] = server.seats;
  const desk = server.transport(seat.deskUserId);
  const shopper = server.transport(seat.shoppers[0].userId);
  for (const t of [desk, shopper]) {
    t.registerCustomMessages(registrationObjects());
    await t.connect();
  }
  return { server, seat, desk, shopper, deskId: seat.deskUserId, shopperId: seat.shoppers[0].userId };
}

test("the fake transport implements the interface and its banner says FAKE CHAT (offline)", () => {
  const server = new FakeChatServer();
  const t = assertChatTransport(server.transport(server.seats[0].deskUserId));
  assert.match(FAKE_BANNER, /^FAKE CHAT \(offline\)/);
  assert.deepEqual(t.describe(), {
    kind: "fake",
    banner: FAKE_BANNER,
    pill: "FAKE CHAT (offline)",
    stateWords: { connected: "Connected to the fake in-memory service on this machine. Nothing here crosses Nexconn." },
    userId: "fakedesk1",
    via: "fake chat (offline)",
  });
});

test("the pool is four seats of three ids: one desk and two shoppers, twelve plain-fake ids in all", () => {
  const seats = fakeSeats();
  assert.equal(seats.length, SEAT_COUNT);
  assert.equal(SEAT_COUNT, 4);
  const ids = seats.flatMap((s) => [s.deskUserId, ...s.shoppers.map((p) => p.userId)]);
  assert.equal(ids.length, 12);
  assert.equal(new Set(ids).size, 12);
  assert.ok(ids.every((id) => id.startsWith("fake")), "never mistaken for a minted id");
  assert.deepEqual(seats[0].shoppers.map((p) => [p.caseId, p.orderId]), [["R-104", "O-5521"], ["R-107", "O-5530"]]);
  const desk = sessionFor({ seat: seats[1], side: "desk" });
  assert.deepEqual(Object.values(desk.peers).map((p) => p.caseId), ["R-104", "R-107"]);
  const asha = sessionFor({ seat: seats[1], side: "shopper", as: 1 });
  assert.deepEqual([asha.selfUserId, asha.me.caseId, Object.keys(asha.peers)], ["fakeshop2b", "R-107", ["fakedesk2"]]);
  assert.throws(() => sessionFor({ seat: seats[0], side: "shopper", as: 2 }), RangeError);
});

test("the server hands out its own ids and its own times, strictly increasing whatever the clock says", async () => {
  let t = 5_000;
  const server = new FakeChatServer({ clock: () => t });
  const [seat] = server.seats;
  const a = server.transport(seat.deskUserId);
  a.registerCustomMessages(registrationObjects());
  await a.connect();
  const m1 = await a.send({ toUserId: seat.shoppers[0].userId, type: TYPES.NOTE, content: note("one") });
  const m2 = await a.send({ toUserId: seat.shoppers[0].userId, type: TYPES.NOTE, content: note("two") });
  t = 1_000; // the clock runs backwards
  const m3 = await a.send({ toUserId: seat.shoppers[0].userId, type: TYPES.NOTE, content: note("three") });
  assert.deepEqual([m1.messageId, m2.messageId, m3.messageId], ["fm_000001", "fm_000002", "fm_000003"]);
  assert.deepEqual([m1.sentTime, m2.sentTime, m3.sentTime], [5_000, 5_001, 5_002]);
  assert.deepEqual([m1.senderUserId, m1.targetUserId], [seat.deskUserId, seat.shoppers[0].userId]);
  const mutated = note("four");
  const m4 = await a.send({ toUserId: seat.shoppers[0].userId, type: TYPES.NOTE, content: mutated });
  mutated.text = "changed after sending";
  const [newest] = await a.newest({ withUserId: seat.shoppers[0].userId, limit: 1 });
  assert.equal(newest.messageId, m4.messageId);
  assert.equal(newest.content.text, "four", "the server keeps its own copy");
});

test("the newest-page query reads newest first, one channel only, and never more than a page", async () => {
  const { server, desk, shopper, deskId, shopperId } = await pair();
  const other = server.transport(server.seats[0].shoppers[1].userId);
  other.registerCustomMessages(registrationObjects());
  await other.connect();
  await other.send({ toUserId: deskId, type: TYPES.NOTE, content: { visit: "v1", text: "from the other shopper" } });
  for (let i = 1; i <= 25; i++) await shopper.send({ toUserId: deskId, type: TYPES.NOTE, content: note(`m${i}`) });
  const page = await desk.newest({ withUserId: shopperId, limit: 100 });
  assert.equal(PAGE_SIZE, 20);
  assert.equal(page.length, 20, "capped at one page");
  assert.deepEqual(page.map((m) => m.content.text).slice(0, 3), ["m25", "m24", "m23"]);
  assert.ok(page.every((m, i) => i === 0 || page[i - 1].sentTime > m.sentTime), "newest first by server time");
  assert.ok(page.every((m) => m.senderUserId === shopperId), "the other shopper's channel is not in this page");
  assert.equal((await desk.newest({ withUserId: shopperId, limit: 2 })).length, 2);
});

test("delivery is delayed: a message is on the server before it reaches the other side's handler, and can arrive out of order", async () => {
  const { server, desk, shopper, deskId, shopperId } = await pair();
  const received = [];
  desk.onMessage((m) => received.push(m.content.text));
  const a = await shopper.send({ toUserId: deskId, type: TYPES.NOTE, content: note("first") });
  const b = await shopper.send({ toUserId: deskId, type: TYPES.NOTE, content: note("second") });
  assert.deepEqual(received, [], "nothing delivered yet");
  assert.deepEqual(server.pending(deskId).map((m) => m.messageId), [a.messageId, b.messageId]);
  assert.deepEqual((await desk.newest({ withUserId: shopperId })).map((m) => m.content.text), ["second", "first"], "but the server already has both");
  assert.equal(server.deliver(deskId, [b.messageId]), 1, "the later message arrives first");
  assert.deepEqual(received, ["second"]);
  assert.equal(server.deliver(deskId), 1);
  assert.deepEqual(received, ["second", "first"]);
  assert.deepEqual(server.pending(deskId), []);
});

test("timed delivery makes a message due after the delay, for a polling client to collect", async () => {
  let now = 10_000;
  const server = new FakeChatServer({ clock: () => now, deliveryDelayMs: 500 });
  const [seat] = server.seats;
  const opened = server.open(seat.deskUserId);
  const sender = server.transport(seat.shoppers[0].userId);
  sender.registerCustomMessages(registrationObjects());
  await sender.connect();
  await sender.send({ toUserId: seat.deskUserId, type: TYPES.NOTE, content: note("hi") });
  assert.deepEqual(server.drain(opened.connectionId), [], "not due yet");
  now += 499;
  assert.deepEqual(server.drain(opened.connectionId), []);
  now += 1;
  assert.deepEqual(server.drain(opened.connectionId).map((m) => m.content.text), ["hi"]);
  assert.deepEqual(server.drain(opened.connectionId), [], "collected once");
});

test("the documented limit: ten simultaneous connections for one user, the eleventh is reported busy", async () => {
  const server = new FakeChatServer();
  assert.equal(DOCUMENTED_CONNECTION_LIMIT, 10);
  const id = server.seats[0].deskUserId;
  const tabs = [];
  for (let i = 0; i < 10; i++) {
    const t = server.transport(id);
    assert.equal((await t.connect()).state, STATUS.CONNECTED, `connection ${i + 1}`);
    tabs.push(t);
  }
  const eleventh = server.transport(id);
  const status = await eleventh.connect();
  assert.equal(status.state, STATUS.BUSY);
  assert.match(status.detail, /10 connections/);
  assert.equal(server.connectionCount(id), 10);
  await assert.rejects(() => eleventh.send({ toUserId: server.seats[0].shoppers[0].userId, type: TYPES.NOTE, content: note("x") }), (e) => e instanceof ChatError && e.code === "chat_offline");
  const other = server.transport(server.seats[0].shoppers[0].userId);
  assert.equal((await other.connect()).state, STATUS.CONNECTED, "the limit is per user");
  tabs[0].disconnect();
  assert.equal((await server.transport(id).connect()).state, STATUS.CONNECTED, "a closed tab frees its slot");
});

test("an unreachable service: connect says offline, sends and reads refuse, open connections are told", async () => {
  const { server, desk, shopper, deskId, shopperId } = await pair();
  const seen = [];
  shopper.onStatus((s) => seen.push(s.state));
  server.setReachable(false);
  assert.deepEqual(seen, [STATUS.OFFLINE]);
  assert.equal(shopper.status().state, STATUS.OFFLINE);
  await assert.rejects(() => shopper.send({ toUserId: deskId, type: TYPES.NOTE, content: note("x") }), (e) => e.code === "chat_offline");
  assert.equal((await server.transport(deskId).connect()).state, STATUS.OFFLINE);
  server.setReachable(true);
  assert.equal((await shopper.connect()).state, STATUS.CONNECTED, "reconnects once it is back");
  assert.equal((await desk.connect()).state, STATUS.CONNECTED);
  const m = await shopper.send({ toUserId: deskId, type: TYPES.NOTE, content: note("again") });
  assert.equal(m.messageId, "fm_000001");
  server.failReads = true;
  await assert.rejects(() => desk.newest({ withUserId: shopperId }), (e) => e instanceof ChatError && e.code === "read_failed");
});

test("one user's connection can be dropped on its own", async () => {
  const { server, desk, shopper, deskId } = await pair();
  server.drop(deskId, "kicked for the test");
  assert.equal(desk.status().state, STATUS.OFFLINE);
  assert.equal(desk.status().detail, "kicked for the test");
  assert.equal(shopper.status().state, STATUS.CONNECTED);
});

test("custom messages must be registered before connect, with the typed keys, and only registered types send", async () => {
  const server = new FakeChatServer();
  const [seat] = server.seats;
  const t = server.transport(seat.deskUserId);
  assert.throws(() => t.registerCustomMessages([{ messageType: "SG:Note", isPersited: true, isCounted: true }]), (e) => e.code === "bad_registration");
  await t.connect();
  assert.throws(() => t.registerCustomMessages(registrationObjects()), (e) => e.code === "register_after_connect");
  await assert.rejects(() => t.send({ toUserId: seat.shoppers[0].userId, type: TYPES.NOTE, content: note("x") }), (e) => e.code === "unregistered_type");
  const unknown = await server.transport("nobody").connect();
  assert.equal(unknown.state, STATUS.OFFLINE);
  assert.match(unknown.detail, /no user nobody/);
});

test("the newest-page query pages backwards from a cursor, in the total order of server time and then id, ties included", async () => {
  const { server, desk, shopper, deskId, shopperId } = await pair({ strictTimes: false });
  const sent = [];
  for (let i = 1; i <= 7; i++) sent.push(await shopper.send({ toUserId: deskId, type: TYPES.NOTE, content: note(`m${i}`) }));
  assert.equal(new Set(sent.map((m) => m.sentTime)).size, 1, "this server hands out the same time to every message");
  const page1 = await desk.newest({ withUserId: shopperId, limit: 3 });
  assert.deepEqual(page1.map((m) => m.content.text), ["m7", "m6", "m5"], "ties are broken by id, newest id first");
  const page2 = await desk.newest({ withUserId: shopperId, limit: 3, before: { messageId: page1.at(-1).messageId, sentTime: page1.at(-1).sentTime } });
  assert.deepEqual(page2.map((m) => m.content.text), ["m4", "m3", "m2"]);
  const page3 = await desk.newest({ withUserId: shopperId, limit: 3, before: { messageId: page2.at(-1).messageId, sentTime: page2.at(-1).sentTime } });
  assert.deepEqual(page3.map((m) => m.content.text), ["m1"]);
  assert.deepEqual(await desk.newest({ withUserId: shopperId, limit: 3, before: { messageId: page3[0].messageId, sentTime: page3[0].sentTime } }), []);
  assert.ok(server);
});
