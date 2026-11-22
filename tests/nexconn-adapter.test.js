// The Nexconn adapter on a hand-written stand-in for the SDK (tests/nexconn-sdk-mock.js). Every
// assertion here is MOCK-ONLY: it proves the adapter speaks the 26.2.1 typings' names in the order the
// typings ask for, and keeps the transport interface's promises on top of the mock's behaviour. What
// the real service does behind those names (paging, hasNext, startTime, kick codes, the send result's
// id and time) is UNVERIFIED until S1's live probe.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { FakeYouCamProvider } from "../src/providers/youcam-fake.js";
import { assertChatTransport, ChatError, hasUnreadCounts, PAGE_SIZE, STATUS } from "../src/chat/transport.js";
import { readBack } from "../src/chat/history.js";
import { registrationObjects, TYPES } from "../src/chat/messages.js";
import { SHOPPER_PROFILES } from "../src/chat/seats.js";
import { createNexconnTransport, transportFromSeats, statusFromSdk, missingSdkNames, KICK_CODES, AREA_KEYS, CONNECT_TIMEOUT_MS } from "../src/chat/nexconn-transport.js";
import { MockNexconnServer, CONNECTION_STATUS, CODES } from "./nexconn-sdk-mock.js";
import { fixedClock, noWait } from "./helpers.js";

const DESK = "sgdesk00000001";
const SHOP = "sgshop00000001";
const SHOP2 = "sgshop00000002";
const APP_KEY = "dummy-app-key";
const note = (text, visit = "v1") => ({ visit, caseId: "R-104", text });

function setup(serverOptions = {}) {
  const server = new MockNexconnServer(serverOptions);
  const tokens = { [DESK]: server.addUser(DESK), [SHOP]: server.addUser(SHOP), [SHOP2]: server.addUser(SHOP2) };
  const side = (userId, over = {}) => {
    const realm = server.realm();
    const t = createNexconnTransport({ sdk: realm.sdk, appKey: APP_KEY, area: "SG", userId, token: tokens[userId], ...over });
    return { realm, t, calls: realm.control.calls };
  };
  return { server, tokens, side };
}

async function connected(side, userId) {
  const s = side(userId);
  s.t.registerCustomMessages(registrationObjects());
  await s.t.connect();
  return s;
}

const ops = (calls) => calls.map((c) => c.op);

// ---------------------------------------------------------------------------- order and registration

test("nothing touches the SDK until connect; connect initializes, registers the six types, adds its three handlers, then connects, in that order", async () => {
  const { side } = setup();
  const { t, calls } = side(DESK);
  assert.deepEqual(calls, [], "creating the transport calls nothing");
  t.registerCustomMessages(registrationObjects());
  assert.deepEqual(calls, [], "registering only records the objects: the typings say registration follows initialize");
  assert.equal(t.status().state, STATUS.IDLE);
  const status = await t.connect();
  assert.equal(status.state, STATUS.CONNECTED);
  assert.deepEqual(ops(calls), ["NCEngine.initialize", "NCEngine.registerCustomMessages", "NCEngine.addMessageHandler", "NCEngine.addConnectionStatusHandler", "NCEngine.addChannelHandler", "NCEngine.connect"]);
  assert.deepEqual(calls[0].args, { appKey: APP_KEY, areaCode: 2, logLevel: 2 }, "AreaCode.SG and LogLevel.WARN, read from the module, not hard-coded");
  assert.deepEqual(calls[1].args, registrationObjects());
  for (const r of calls[1].args) {
    assert.deepEqual(Object.keys(r).sort(), ["isCounted", "isPersisted", "messageType"]);
    assert.equal(r.isPersisted, true);
    assert.equal(Object.hasOwn(r, "isPersited"), false, "never the docs' misspelling");
  }
  assertChatTransport(t);
});

test("a registration must carry exactly the typed keys, and none may follow connect", async () => {
  const { side } = setup();
  const { t } = side(DESK);
  assert.throws(() => t.registerCustomMessages([{ messageType: TYPES.NOTE, isPersited: true, isCounted: true }]), (e) => e instanceof ChatError && e.code === "bad_registration");
  t.registerCustomMessages(registrationObjects());
  await t.connect();
  assert.throws(() => t.registerCustomMessages(registrationObjects()), (e) => e instanceof ChatError && e.code === "register_after_connect");
});

test("a reconnect after disconnect does not initialize or register again; disconnect removes its handlers first", async () => {
  const { side } = setup();
  const { t, calls } = await connected(side, DESK);
  t.disconnect();
  assert.equal(t.status().state, STATUS.IDLE, "our own disconnect reads as idle, not as a dropped connection");
  assert.deepEqual(ops(calls).slice(-4), ["NCEngine.removeChannelHandler", "NCEngine.removeMessageHandler", "NCEngine.removeConnectionStatusHandler", "NCEngine.disconnect"]);
  await t.connect();
  assert.equal(t.status().state, STATUS.CONNECTED);
  const count = (op) => calls.filter((c) => c.op === op).length;
  assert.deepEqual([count("NCEngine.initialize"), count("NCEngine.registerCustomMessages"), count("NCEngine.connect")], [1, 1, 2]);
});

// ---------------------------------------------------------------------------- connection status

test("the SDK's four connection states map to the page's states, and a kick code reads as a busy seat", () => {
  const { server } = setup();
  const { sdk } = server.realm();
  const s = (status, code) => statusFromSdk(sdk, status, code);
  assert.equal(s(CONNECTION_STATUS.CONNECTED).state, STATUS.CONNECTED);
  assert.equal(s(CONNECTION_STATUS.CONNECTING).state, STATUS.CONNECTING);
  assert.equal(s(CONNECTION_STATUS.SUSPENDED).state, STATUS.CONNECTING, "suspended: the SDK reconnects by itself, and nothing may be sent meanwhile");
  assert.match(s(CONNECTION_STATUS.SUSPENDED).detail, /reconnects/);
  assert.deepEqual(KICK_CODES, [31010, 31023]);
  for (const code of KICK_CODES) assert.deepEqual([s(CONNECTION_STATUS.DISCONNECTED, code).state, s(CONNECTION_STATUS.DISCONNECTED, code).code], [STATUS.BUSY, code]);
  const bad = s(CONNECTION_STATUS.DISCONNECTED, CODES.TOKEN_INCORRECT);
  assert.deepEqual([bad.state, bad.code], [STATUS.OFFLINE, 31004]);
  assert.match(bad.detail, /31004.*token/);
  assert.deepEqual(s(CONNECTION_STATUS.DISCONNECTED), { state: STATUS.OFFLINE, code: null, detail: null });
  assert.equal(s(9).state, STATUS.OFFLINE, "a state the typings do not name is never read as connected");
});

test("status events reach onStatus through the typed handler name, onConnectionStatusChanged, the only one registered", async () => {
  const { server, side } = setup();
  const { t, realm } = await connected(side, DESK);
  assert.deepEqual(Object.keys(realm.control.state.statusHandlers.get("shade-guard")._invoker), ["onConnectionStatusChanged"]);
  const seen = [];
  t.onStatus((st) => seen.push(st.state));
  server.kick(DESK, CODES.KICK);
  assert.deepEqual(seen, [STATUS.BUSY]);
  assert.equal(t.status().code, 31010);
});

test("a connect that times out, throws or is refused lets go of the SDK: handlers removed, the engine disconnected, and a late 'connected' changes nothing", async () => {
  for (const answer of ["hang", "throw", 34006]) {
    const { server, side } = setup();
    server.connectAnswer = answer;
    const s = side(DESK, { connectTimeoutMs: 20 });
    s.t.registerCustomMessages(registrationObjects());
    assert.equal((await s.t.connect()).state, STATUS.OFFLINE);
    assert.deepEqual(ops(s.calls).slice(-4), ["NCEngine.removeChannelHandler", "NCEngine.removeMessageHandler", "NCEngine.removeConnectionStatusHandler", "NCEngine.disconnect"], answer);
    s.realm.control.fireStatus(CONNECTION_STATUS.CONNECTED);
    assert.equal(s.t.status().state, STATUS.OFFLINE, `${answer}: the page must never read as connected without a checked user id and a restore`);
    server.connectAnswer = null;
    assert.equal((await s.t.connect()).state, STATUS.CONNECTED, `${answer}: a later connect still works`);
  }
});

test("connect never throws for an expected failure: a wrong token, a kick code, a rejected or hung connect, another user's id", async () => {
  const wrong = setup().side(DESK, { token: "not-a-token" });
  wrong.t.registerCustomMessages(registrationObjects());
  assert.deepEqual([(await wrong.t.connect()).state, wrong.t.status().code], [STATUS.OFFLINE, 31004]);

  const busy = setup();
  busy.server.connectAnswer = CODES.SAME_CLIENT_ON_LINE;
  const b = busy.side(DESK);
  b.t.registerCustomMessages(registrationObjects());
  assert.equal((await b.t.connect()).state, STATUS.BUSY);

  const thrown = setup();
  thrown.server.connectAnswer = "throw";
  const th = thrown.side(DESK);
  th.t.registerCustomMessages(registrationObjects());
  const st = await th.t.connect();
  assert.equal(st.state, STATUS.OFFLINE);
  assert.match(st.detail, /navi request failed/);

  const hung = setup();
  hung.server.connectAnswer = "hang";
  const h = hung.side(DESK, { connectTimeoutMs: 20 });
  h.t.registerCustomMessages(registrationObjects());
  const hs = await h.t.connect();
  assert.equal(hs.state, STATUS.OFFLINE);
  assert.match(hs.detail, /did not answer within/);
  assert.equal(CONNECT_TIMEOUT_MS, 20_000);

  const other = setup();
  other.server.connectAsUser = SHOP;
  const o = other.side(DESK);
  o.t.registerCustomMessages(registrationObjects());
  const os = await o.t.connect();
  assert.equal(os.state, STATUS.OFFLINE);
  assert.match(os.detail, /another user/);
  assert.equal(ops(o.calls).at(-1), "NCEngine.disconnect", "a connection as the wrong user is closed at once");
});

// ---------------------------------------------------------------------------- receiving

test("onMessage hands over a received custom message with the server's id and time, as plain data; other channel types and unregistered types never reach the app", async () => {
  const { server, side } = setup();
  const desk = await connected(side, DESK);
  const shop = await connected(side, SHOP);
  const got = [];
  desk.t.onMessage((m) => got.push(m));
  const sent = await shop.t.send({ toUserId: DESK, type: TYPES.NOTE, content: note("is 250W any closer?") });
  assert.equal(got.length, 0, "delivery waits on the service");
  server.deliver(DESK);
  assert.equal(got.length, 1);
  const [m] = got;
  assert.deepEqual(Object.keys(m).sort(), ["content", "messageId", "senderUserId", "sentTime", "targetUserId", "type"]);
  assert.deepEqual([m.messageId, m.sentTime, m.type, m.senderUserId, m.targetUserId], [sent.messageId, sent.sentTime, TYPES.NOTE, SHOP, DESK]);
  assert.deepEqual(m.content, note("is 250W any closer?"));
  assert.equal(Object.getPrototypeOf(m.content), Object.prototype, "plain data, not an SDK object");

  server.record(SHOP, DESK, "RC:TxtMsg", { text: "a console test message" });
  server.deliver(DESK);
  const raw = server.record(SHOP, DESK, TYPES.NOTE, note("from a group"));
  desk.realm.control.inbox.length = 0;
  desk.realm.control.pushOther(raw, 3);
  assert.equal(got.length, 1, "an unregistered type and a non-direct channel are dropped");
  assert.deepEqual(desk.t.diagnostics().filter((d) => d.op === "dropped").map((d) => d.why), ["unregistered_type", "not_direct"]);
});

test("an echo of one's own message (another tab of the same user) is handed over with this user as sender and the peer as target", async () => {
  const { server, side } = setup({ echo: true });
  const deskA = await connected(side, DESK);
  const deskB = await connected(side, DESK);
  await connected(side, SHOP);
  const got = [];
  deskB.t.onMessage((m) => got.push(m));
  const sent = await deskA.t.send({ toUserId: SHOP, type: TYPES.NOTE, content: { ...note("from the other tab"), by: "staff" } });
  server.deliver(DESK);
  assert.deepEqual(got.map((m) => [m.messageId, m.senderUserId, m.targetUserId]), [[sent.messageId, DESK, SHOP]]);
});

// ---------------------------------------------------------------------------- sending

test("send returns the server's message id and time, with this user as sender and the peer as target", async () => {
  const { server, side } = setup();
  const desk = await connected(side, DESK);
  const sent = await desk.t.send({ toUserId: SHOP, type: TYPES.OFFER, content: { visit: "v1", caseId: "R-104", draftId: "d_0a1b2c3d_1", text: "245W", resolution: "exchange", shadeCode: "245W", deltaE: { "245W": 2.1 } } });
  const stored = server.history(DESK, SHOP)[0];
  assert.deepEqual([sent.messageId, sent.sentTime, sent.senderUserId, sent.targetUserId, sent.type], [stored.messageId, stored.sentTime, DESK, SHOP, TYPES.OFFER]);
  assert.deepEqual(desk.calls.find((c) => c.op === "BaseChannel.sendMessage").args, { channelId: SHOP, messageType: TYPES.OFFER }, "a DirectChannel to the peer, with SendMessageParams of the custom type");
});

test("a send that cannot go is a ChatError the verbs can read: chat_offline when not connected or the channel is down, send_failed otherwise", async () => {
  const { server, side } = setup();
  const idle = side(DESK);
  idle.t.registerCustomMessages(registrationObjects());
  await assert.rejects(idle.t.send({ toUserId: SHOP, type: TYPES.NOTE, content: note("x") }), (e) => e instanceof ChatError && e.code === "chat_offline");
  assert.equal(idle.calls.length, 0, "nothing reaches the SDK while not connected");

  const desk = await connected(side, DESK);
  await assert.rejects(desk.t.send({ toUserId: SHOP, type: "RC:TxtMsg", content: { text: "x" } }), (e) => e.code === "unregistered_type");
  server.sendFailures.push(CODES.MSG_RESP_TIMEOUT);
  await assert.rejects(desk.t.send({ toUserId: SHOP, type: TYPES.NOTE, content: note("x") }), (e) => e.code === "send_failed" && /30003/.test(e.message));
  server.sendFailures.push(CODES.NET_CHANNEL_INVALID);
  await assert.rejects(desk.t.send({ toUserId: SHOP, type: TYPES.NOTE, content: note("x") }), (e) => e.code === "chat_offline" && /30001/.test(e.message));
  server.sendFailures.push(20604);
  await assert.rejects(desk.t.send({ toUserId: SHOP, type: TYPES.NOTE, content: note("x") }), (e) => e.code === "send_failed" && /20604.*too fast/.test(e.message));
  server.sendFailures.push("throw");
  await assert.rejects(desk.t.send({ toUserId: SHOP, type: TYPES.NOTE, content: note("x") }), (e) => e.code === "send_failed" && /socket closed/.test(e.message));
  assert.equal(server.history(DESK, SHOP).length, 0);
  const ok = await desk.t.send({ toUserId: SHOP, type: TYPES.NOTE, content: note("x") });
  assert.equal(server.history(DESK, SHOP)[0].messageId, ok.messageId, "the next send goes");
});

// ---------------------------------------------------------------------------- reading history

async function seeded(n, serverOptions = {}, other = []) {
  const s = setup(serverOptions);
  for (let i = 0; i < n; i++) s.server.record(i % 2 ? DESK : SHOP, i % 2 ? SHOP : DESK, TYPES.NOTE, note(`m${i}`));
  for (const [from, to, type] of other) s.server.record(from, to, type, { text: "other" });
  const desk = await connected(s.side, DESK);
  return { ...s, desk };
}

const isNewestFirst = (page) => page.every((m, i) => i === 0 || page[i - 1].sentTime > m.sentTime || (page[i - 1].sentTime === m.sentTime && page[i - 1].messageId > m.messageId));

test("newest reads newest first whatever order the SDK hands a page in, and every load is a fresh query from the oldest time read so far plus one", async () => {
  for (const pageOrder of ["newest_first", "oldest_first"]) {
    for (const pageShape of ["pagedata", "array"]) {
      const { server, desk } = await seeded(45, { pageOrder, pageShape });
      const p1 = await desk.t.newest({ withUserId: SHOP, limit: PAGE_SIZE });
      assert.equal(p1.length, 20);
      assert.ok(isNewestFirst(p1), `${pageOrder}/${pageShape}`);
      assert.equal(p1[0].content.text, "m44");
      const p2 = await desk.t.newest({ withUserId: SHOP, limit: PAGE_SIZE, before: { messageId: p1.at(-1).messageId, sentTime: p1.at(-1).sentTime } });
      assert.deepEqual([p2.length, p2[0].content.text, p2.at(-1).content.text], [20, "m24", "m5"]);
      const p3 = await desk.t.newest({ withUserId: SHOP, limit: PAGE_SIZE, before: p2.at(-1) });
      assert.deepEqual(p3.map((m) => m.content.text), ["m4", "m3", "m2", "m1", "m0"], "a short page: nothing older exists");
      // The SDK continues a query by time, and an exclusive time drops a message that shares the
      // oldest one's millisecond; so the adapter never continues one.
      const loads = desk.calls.filter((c) => c.op === "MessagesQuery.loadNextPage").length;
      assert.equal(loads, server.queriesCreated.length, "one load per query");
      assert.equal(server.queriesCreated[0].startTime, undefined, "a read with no cursor starts at the newest message");
      // One more than a page from the top, two more from a cursor (the cursor's own message comes back
      // first), so a page usually proves its oldest millisecond complete in one load.
      assert.deepEqual(server.queriesCreated.map((q) => [q.pageSize, q.isAscending, q.channelId]), [[21, false, SHOP], [22, false, SHOP], [22, false, SHOP]]);
      assert.equal(server.queriesCreated[1].startTime, p1.at(-1).sentTime + 1);
    }
  }
});

test("a thread read back over the adapter reaches the start in three pages, and a fresh read always starts a new query (it asks the server)", async () => {
  const { server, desk } = await seeded(45);
  const r = await readBack(desk.t, SHOP);
  assert.deepEqual([r.messages.length, r.reached], [45, "start"]);
  assert.ok(isNewestFirst(r.messages));
  const held = server.queriesCreated.length;
  await readBack(desk.t, SHOP);
  assert.ok(server.queriesCreated.length > held);
  assert.equal(server.queriesCreated[held].startTime, undefined, "the second read starts again at the newest message");
  const three = await seeded(45);
  await readBack(three.desk.t, SHOP);
  assert.equal(three.server.queriesCreated.length, 3, "45 messages with no ties: one load a page");
  const small = await seeded(7);
  await readBack(small.desk.t, SHOP);
  assert.equal(small.server.queriesCreated.length, 1, "a thread shorter than a page is one load");
  const anchored = await readBack(desk.t, SHOP, { anchor: r.messages[30] });
  assert.equal(anchored.reached, "anchor");
});

test("messages that share a server millisecond across a page boundary are all read, ordered by id, under either reading of startTime and either tie order", async () => {
  for (const startTimeExclusive of [true, false]) {
    for (const tieOrder of ["id_desc", "id_asc"]) {
      const { server, side } = setup({ strictTimes: false, startTimeExclusive, tieOrder });
      for (let i = 0; i < 30; i++) server.record(SHOP, DESK, TYPES.NOTE, note(`t${i}`), { sentTime: 1_000 + Math.floor(i / 7) });
      const desk = await connected(side, DESK);
      const r = await readBack(desk.t, SHOP);
      const why = `exclusive=${startTimeExclusive} ties=${tieOrder}`;
      assert.equal(r.reached, "start", why);
      assert.deepEqual(r.messages.map((m) => m.content.text).sort(), Array.from({ length: 30 }, (_, i) => `t${i}`).sort(), why);
      assert.equal(new Set(r.messages.map((m) => m.messageId)).size, 30, why);
      assert.ok(isNewestFirst(r.messages), why);
    }
  }
});

test("a page thinned by other types is topped up without losing a message that shares the boundary's millisecond", async () => {
  const { server, side } = setup({ strictTimes: false });
  for (let i = 0; i < 10; i++) server.record(SHOP, DESK, TYPES.NOTE, note(`old${i}`), { sentTime: 1_000 + i });
  for (let i = 0; i < 3; i++) server.record(SHOP, DESK, TYPES.NOTE, note(`tie${i}`), { sentTime: 2_000 });
  for (let i = 0; i < 18; i++) server.record(SHOP, DESK, "RC:TxtMsg", { text: "console" }, { sentTime: 3_000 + i });
  const desk = await connected(side, DESK);
  const r = await readBack(desk.t, SHOP);
  assert.equal(r.reached, "start");
  assert.deepEqual(r.messages.map((m) => m.content.text).sort(), [...Array.from({ length: 10 }, (_, i) => `old${i}`), "tie0", "tie1", "tie2"].sort());
});

test("a millisecond holding more messages than a page cannot be paged past: the read fails closed, never reports the start", async () => {
  for (const startTimeExclusive of [true, false]) {
    const { server, side } = setup({ strictTimes: false, startTimeExclusive });
    for (let i = 0; i < 5; i++) server.record(SHOP, DESK, TYPES.NOTE, note(`before${i}`), { sentTime: 500 + i });
    for (let i = 0; i < 30; i++) server.record(SHOP, DESK, TYPES.NOTE, note(`same${i}`), { sentTime: 1_000 });
    const desk = await connected(side, DESK);
    await assert.rejects(readBack(desk.t, SHOP), (e) => e instanceof ChatError && e.code === "read_failed" && /millisecond|more/.test(e.message), `exclusive=${startTimeExclusive}`);
  }
});

test("a cursor the adapter did not hand out starts a new query at startTime = cursor time + 1 and keeps only strictly older messages, under either reading of startTime", async () => {
  for (const startTimeExclusive of [true, false]) {
    const { server, side } = setup({ strictTimes: false, startTimeExclusive });
    for (let i = 0; i < 12; i++) server.record(SHOP, DESK, TYPES.NOTE, note(`s${i}`), { sentTime: 2_000 + Math.floor(i / 3) });
    const desk = await connected(side, DESK);
    const all = server.history(DESK, SHOP);
    const cursor = { messageId: all[4].messageId, sentTime: all[4].sentTime };
    const page = await desk.t.newest({ withUserId: SHOP, limit: PAGE_SIZE, before: cursor });
    assert.deepEqual(page.map((m) => m.messageId), all.slice(5).map((m) => m.messageId), `exclusive=${startTimeExclusive}`);
    assert.equal(server.queriesCreated.at(-1).startTime, cursor.sentTime + 1);
  }
});

test("a page thinned by messages of other types is topped up from fresh queries, so a short page still means the start", async () => {
  const other = Array.from({ length: 15 }, (_, i) => [i % 2 ? DESK : SHOP, i % 2 ? SHOP : DESK, "RC:TxtMsg"]);
  const { server, desk } = await seeded(25, {}, other);
  const p1 = await desk.t.newest({ withUserId: SHOP, limit: PAGE_SIZE });
  assert.equal(p1.length, 20, "the newest SDK page held 15 text messages and 5 of ours; the adapter read on");
  assert.ok(p1.every((m) => m.type === TYPES.NOTE));
  const r = await readBack(desk.t, SHOP);
  assert.deepEqual([r.messages.length, r.reached], [25, "start"]);
  assert.ok(server.queriesCreated.length >= 3, "a thinned page takes more than one load");
});

test("a read that cannot be trusted is read_failed, never a short page: an error code, or a query that keeps saying there is more and hands nothing", async () => {
  const { server, desk } = await seeded(5);
  server.readFailure = CODES.METHOD_BUSY;
  await assert.rejects(desk.t.newest({ withUserId: SHOP, limit: PAGE_SIZE }), (e) => e instanceof ChatError && e.code === "read_failed" && /33103/.test(e.message));
  server.readFailure = 33007;
  await assert.rejects(desk.t.newest({ withUserId: SHOP, limit: PAGE_SIZE }), (e) => e.code === "read_failed" && /33007.*history/.test(e.message), "cloud history switched off");
  server.readFailure = null;
  server.emptyPagesWithHasNext = true;
  await assert.rejects(desk.t.newest({ withUserId: SHOP, limit: PAGE_SIZE }), (e) => e.code === "read_failed");
  server.emptyPagesWithHasNext = false;
  assert.equal((await desk.t.newest({ withUserId: SHOP, limit: PAGE_SIZE })).length, 5);
  desk.t.disconnect();
  await assert.rejects(desk.t.newest({ withUserId: SHOP, limit: PAGE_SIZE }), (e) => e.code === "chat_offline");
});

// ---------------------------------------------------------------------------- what it says about itself

test("describe() names Nexconn as the service a message crossed, with no banner and no pill", async () => {
  const { side } = setup();
  const { t } = side(DESK);
  assert.deepEqual(t.describe(), { kind: "nexconn", banner: null, userId: DESK, via: "Nexconn" });
});

// ---------------------------------------------------------------------------- from the seats config

const seatsConfig = (over = {}) => ({
  kind: "nexconn",
  appKey: APP_KEY,
  area: "SG",
  seats: [{ n: 1, deskUserId: DESK, shoppers: [{ userId: SHOP, ...SHOPPER_PROFILES[0] }, { userId: SHOP2, ...SHOPPER_PROFILES[1] }] }],
  tokens: { [DESK]: "t-desk", [SHOP]: "t-shop", [SHOP2]: "t-shop2" },
  ...over,
});

test("from the seats config: the SDK not loading, or loading without a name the adapter uses, is the 'SDK not loaded' transport, which fakes nothing", async () => {
  const failed = await transportFromSeats({ config: seatsConfig(), userId: DESK, loadSdk: async () => { throw new TypeError("Failed to fetch dynamically imported module"); } });
  assert.equal(failed.status().state, STATUS.SDK_NOT_LOADED);
  assert.match(failed.status().detail, /could not load/);
  await assert.rejects(failed.send({ toUserId: SHOP, type: TYPES.NOTE, content: note("x") }), (e) => e.code === "chat_offline");

  const { server } = setup();
  const { sdk } = server.realm();
  const { NCEngine, ...lacking } = sdk;
  assert.deepEqual(missingSdkNames(lacking), ["NCEngine"]);
  const partial = await transportFromSeats({ config: seatsConfig(), userId: DESK, loadSdk: async () => lacking });
  assert.equal(partial.status().state, STATUS.SDK_NOT_LOADED);
  assert.match(partial.status().detail, /NCEngine/);
  assert.deepEqual(missingSdkNames(sdk), []);
});

test("from the seats config: the area picks the SDK's AreaCode, and a user without a token, or an area the SDK lacks, gets no connection", async () => {
  assert.deepEqual(AREA_KEYS, { SG: "SG", NA: "NA", SAU: "SA" });
  const { server } = setup();
  const { sdk, control } = server.realm();
  const na = await transportFromSeats({ config: seatsConfig({ area: "NA" }), userId: DESK, loadSdk: async () => sdk });
  na.registerCustomMessages(registrationObjects());
  await na.connect();
  assert.equal(control.calls[0].args.areaCode, 3, "AreaCode.NA");
  const noToken = await transportFromSeats({ config: seatsConfig({ tokens: {} }), userId: DESK, loadSdk: async () => sdk });
  assert.deepEqual([noToken.status().state, noToken.describe().kind], [STATUS.OFFLINE, "unavailable"]);
  const { SA, ...areas } = sdk.AreaCode;
  const noArea = await transportFromSeats({ config: seatsConfig({ area: "SAU" }), userId: DESK, loadSdk: async () => ({ ...sdk, AreaCode: areas }) });
  assert.equal(noArea.status().state, STATUS.SDK_NOT_LOADED);
  assert.match(noArea.status().detail, /AreaCode/);
});

// ---------------------------------------------------------------------------- unread counts (mock-only)

test("unreadCounts reads one page of the channel list and hands back each asked peer's direct-channel unreadCount; unlisted peers, other peers and other channel types are left out", async () => {
  const { server, side } = setup();
  const desk = await connected(side, DESK);
  await connected(side, SHOP);
  server.record(SHOP, DESK, TYPES.NOTE, note("one"));
  server.record(SHOP, DESK, TYPES.NOTE, note("two"));
  server.record(DESK, SHOP, TYPES.NOTE, note("staff, not counted for the desk"));
  server.record(SHOP2, "sgother000001", TYPES.NOTE, note("not the desk's channel"));
  server.record("sgother000002", DESK, TYPES.NOTE, note("a peer the desk did not ask for"));
  assert.equal(hasUnreadCounts(desk.t), true);
  assert.deepEqual(await desk.t.unreadCounts([SHOP, SHOP2]), { [SHOP]: 2 }, "SHOP2 never wrote to the desk: no channel listed, no guessed 0");
  const listCalls = desk.calls.filter((c) => c.op === "BaseChannel.createChannelsQuery");
  assert.deepEqual(listCalls.map((c) => c.args), [{ pageSize: 20 }], "one fresh query of one page, at the typings' default size");
  const entry = desk.t.diagnostics().find((d) => d.op === "channels");
  assert.deepEqual([entry.size, entry.listed], [2, 1]);
});

test("a case-closed message is not counted (its registration's isCounted is false), and a channel of another type with the same id is not the direct one", async () => {
  const { server, side } = setup();
  const shop = await connected(side, SHOP);
  await connected(side, DESK);
  server.record(DESK, SHOP, TYPES.CASE_CLOSED, { visit: "v1", caseId: "R-104", reason: "resolved" });
  server.record(DESK, SHOP, TYPES.NOTE, { ...note("a staff note"), by: "staff" });
  assert.deepEqual(await shop.t.unreadCounts([DESK]), { [DESK]: 1 });
  const realm = shop.realm;
  const group = new realm.sdk.BaseChannel(new realm.sdk.ChannelIdentifier(3, DESK), 9);
  const original = realm.sdk.BaseChannel.createChannelsQuery;
  realm.sdk.BaseChannel.createChannelsQuery = () => ({ loadNextPage: async () => ({ isOk: true, code: 0, data: { data: [group] } }) });
  try {
    assert.deepEqual(await shop.t.unreadCounts([DESK]), {}, "a group channel named like the peer is not the direct channel");
  } finally {
    realm.sdk.BaseChannel.createChannelsQuery = original;
  }
});

test("an unread read the SDK refuses or throws on is read_failed, a count that is not a whole number is left out, and not connected is chat_offline", async () => {
  const { server, side } = setup();
  const desk = await connected(side, DESK);
  server.channelListFailure = CODES.METHOD_BUSY;
  await assert.rejects(desk.t.unreadCounts([SHOP]), (e) => e instanceof ChatError && e.code === "read_failed" && /33103/.test(e.message));
  server.channelListFailure = "throw";
  await assert.rejects(desk.t.unreadCounts([SHOP]), (e) => e instanceof ChatError && e.code === "read_failed");
  server.channelListFailure = null;
  const realm = desk.realm;
  const odd = new realm.sdk.BaseChannel(new realm.sdk.DirectChannelIdentifier(SHOP), 1.5);
  const original = realm.sdk.BaseChannel.createChannelsQuery;
  realm.sdk.BaseChannel.createChannelsQuery = () => ({ loadNextPage: async () => ({ isOk: true, code: 0, data: [odd] }) });
  try {
    assert.deepEqual(await desk.t.unreadCounts([SHOP]), {});
  } finally {
    realm.sdk.BaseChannel.createChannelsQuery = original;
  }
  desk.t.disconnect();
  await assert.rejects(desk.t.unreadCounts([SHOP]), (e) => e instanceof ChatError && e.code === "chat_offline");
  await assert.rejects(desk.t.clearUnread(SHOP), (e) => e instanceof ChatError && e.code === "chat_offline");
});

test("clearUnread marks the direct channel read through clearUnreadCount; a refusal is clear_failed; another tab of the same user hears of it through onChannelUnreadStatusSync", async () => {
  const { server, side } = setup();
  const tab1 = await connected(side, DESK);
  const tab2 = await connected(side, DESK);
  await connected(side, SHOP);
  server.record(SHOP, DESK, TYPES.NOTE, note("one"));
  const heard = { tab1: [], tab2: [] };
  tab1.t.onUnreadChange((peer) => heard.tab1.push(peer));
  tab2.t.onUnreadChange((peer) => heard.tab2.push(peer));
  assert.deepEqual(Object.keys(tab2.realm.control.state.channelHandlers.get("shade-guard")._invoker), ["onChannelUnreadStatusSync"]);
  await tab1.t.clearUnread(SHOP);
  assert.ok(tab1.calls.some((c) => c.op === "BaseChannel.clearUnreadCount" && c.args.channelId === SHOP));
  assert.deepEqual(await tab2.t.unreadCounts([SHOP]), { [SHOP]: 0 });
  assert.deepEqual(heard, { tab1: [], tab2: [SHOP] });
  server.clearFailure = CODES.METHOD_BUSY;
  await assert.rejects(tab1.t.clearUnread(SHOP), (e) => e instanceof ChatError && e.code === "clear_failed");
  tab2.t.disconnect();
  server.clearFailure = null;
  await tab1.t.clearUnread(SHOP);
  assert.deepEqual(heard.tab2, [SHOP], "a disconnected tab's handler is gone");
});

test("an SDK without the channel list gives a transport without unread counts (the desk keeps its own); without ChannelHandler it still connects", async () => {
  const { server, tokens } = setup();
  const { sdk } = server.realm();
  class NoList extends sdk.BaseChannel {}
  NoList.createChannelsQuery = undefined;
  const bare = createNexconnTransport({ sdk: { ...sdk, BaseChannel: NoList }, appKey: APP_KEY, area: "SG", userId: DESK, token: tokens[DESK] });
  assert.equal(hasUnreadCounts(bare), false);
  const { sdk: sdk2 } = server.realm();
  const noHandler = createNexconnTransport({ sdk: { ...sdk2, ChannelHandler: undefined }, appKey: APP_KEY, area: "SG", userId: DESK, token: tokens[DESK] });
  noHandler.registerCustomMessages(registrationObjects());
  assert.equal((await noHandler.connect()).state, STATUS.CONNECTED);
  assert.equal(typeof noHandler.onUnreadChange, "undefined");
  assert.equal(hasUnreadCounts(noHandler), true);
});

// ---------------------------------------------------------------------------- the app on the adapter

async function nexconnDuo({ visit = "visit-a" } = {}) {
  const s = setup();
  const seat = { n: 1, deskUserId: DESK, shoppers: [{ userId: SHOP, ...SHOPPER_PROFILES[0] }, { userId: SHOP2, ...SHOPPER_PROFILES[1] }] };
  const open = async (side, as = 0) => {
    const userId = side === "desk" ? DESK : seat.shoppers[as].userId;
    const { t } = s.side(userId);
    const app = await createApp({ provider: new FakeYouCamProvider(), now: fixedClock(), wait: noWait, chat: { transport: t, seat, side, as, visit } });
    await app.chat.connect();
    return { app, t };
  };
  const desk = await open("desk");
  const shopper = await open("shopper");
  async function settle() {
    for (let i = 0; i < 6; i++) {
      s.server.deliver();
      await desk.app.chat.settled();
      await shopper.app.chat.settled();
    }
  }
  return { ...s, seat, desk, shopper, open, settle };
}
const thread = (app, caseId = "R-104") => app.store.state.threads[caseId].messages;
const EV104 = { shadeCode: "245W", deltaE: { "245W": 2.1, "250W": 3.51, "220N": 5.0 }, band: 1 };

async function draftOffer(duo) {
  const r = await duo.desk.app.invoke("draft_return_resolution", { caseId: "R-104", resolution: "exchange", shadeCode: "245W", evidence: { deltaE: { "220N": 5.0, "245W": 2.1 } } }, "agent");
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const d = await duo.desk.app.invoke("draft_reply", { caseId: "R-104", kind: "exchange_offer", evidence: EV104 }, "agent");
  assert.equal(d.ok, true, JSON.stringify(d.error));
  return d.result.draft;
}

test("the chat runs unchanged on the adapter: her return request crosses, staff send the agent's offer, and the phone holds it under the same server id", async () => {
  const duo = await nexconnDuo();
  assert.equal(duo.desk.app.store.state.chat.connection.state, STATUS.CONNECTED);
  const req = await duo.shopper.app.invoke("shopper_send", { kind: "return_request" }, "shopper");
  assert.equal(req.ok, true, JSON.stringify(req.error));
  await duo.settle();
  assert.deepEqual(thread(duo.desk.app).map((m) => [m.type, m.sender]), [[TYPES.RETURN_REQUEST, "shopper"]]);
  const draft = await draftOffer(duo);
  const sent = await duo.desk.app.invoke("send_reply", { caseId: "R-104", draftId: draft.draftId, seen: draft.fingerprint }, "staff");
  assert.equal(sent.ok, true, JSON.stringify(sent.error));
  await duo.settle();
  const onPhone = thread(duo.shopper.app).find((m) => m.type === TYPES.OFFER);
  assert.equal(onPhone.messageId, sent.result.messageId);
  assert.equal(onPhone.messageId, duo.server.history(DESK, SHOP)[0].messageId, "the id the phone holds is the service's own");
});

test("on the adapter, a shopper message that is only on the service refuses send_reply as thread_moved, and the desk then shows it", async () => {
  const duo = await nexconnDuo();
  await duo.shopper.app.invoke("shopper_send", { kind: "return_request" }, "shopper");
  await duo.settle();
  const draft = await draftOffer(duo);
  await duo.shopper.t.send({ toUserId: DESK, type: TYPES.NOTE, content: { visit: "visit-a", caseId: "R-104", text: "is 250W any closer?" } });
  const r = await duo.desk.app.invoke("send_reply", { caseId: "R-104", draftId: draft.draftId, seen: draft.fingerprint }, "staff");
  assert.equal(r.error.code, "thread_moved");
  assert.equal(thread(duo.desk.app).at(-1).content.text, "is 250W any closer?", "read from the service's history, not delivered");
  assert.equal(duo.server.history(DESK, SHOP).filter((m) => m.messageType === TYPES.OFFER).length, 0, "nothing was sent");
});

test("on the adapter, a refused send is send_failed and the draft stays unsent; the same draft then goes once", async () => {
  const duo = await nexconnDuo();
  await duo.shopper.app.invoke("shopper_send", { kind: "return_request" }, "shopper");
  await duo.settle();
  const draft = await draftOffer(duo);
  duo.server.sendFailures.push(CODES.MSG_RESP_TIMEOUT);
  const failed = await duo.desk.app.invoke("send_reply", { caseId: "R-104", draftId: draft.draftId, seen: draft.fingerprint }, "staff");
  assert.equal(failed.error.code, "send_failed");
  assert.equal(duo.desk.app.store.state.replyDrafts[0].sent, null);
  const again = await duo.desk.app.invoke("send_reply", { caseId: "R-104", draftId: draft.draftId, seen: draft.fingerprint }, "staff");
  assert.equal(again.ok, true, JSON.stringify(again.error));
  assert.equal(duo.server.history(DESK, SHOP).filter((m) => m.messageType === TYPES.OFFER).length, 1);
});

test("on the adapter, a reload restores the thread from the service's history, every custom message's content intact", async () => {
  const duo = await nexconnDuo();
  await duo.shopper.app.invoke("shopper_send", { kind: "return_request" }, "shopper");
  await duo.settle();
  const draft = await draftOffer(duo);
  await duo.desk.app.invoke("send_reply", { caseId: "R-104", draftId: draft.draftId, seen: draft.fingerprint }, "staff");
  await duo.settle();
  const before = thread(duo.desk.app).map((m) => [m.messageId, m.type, m.sentTime, JSON.stringify(m.content)]);
  const reloaded = await duo.open("desk");
  const after = thread(reloaded.app).map((m) => [m.messageId, m.type, m.sentTime, JSON.stringify(m.content)]);
  assert.deepEqual(after, before);
  assert.ok(duo.server.queriesCreated.length >= 2, "the restore read history with createMessagesQuery");
});

test("on the adapter, the desk's unread count for her case is the channel list's, and marking it read clears it on the service (mock-only)", async () => {
  const duo = await nexconnDuo();
  assert.deepEqual(await duo.desk.app.chat.unreadCounts(), {});
  await duo.shopper.app.invoke("shopper_send", { kind: "return_request" }, "shopper");
  await duo.settle();
  assert.deepEqual(await duo.desk.app.chat.unreadCounts(), { "R-104": 1 });
  assert.equal(await duo.desk.app.chat.clearUnread("R-104"), true);
  assert.equal(duo.server.unreadOf(DESK, SHOP), 0);
  assert.deepEqual(await duo.desk.app.chat.unreadCounts(), { "R-104": 0 });
});
