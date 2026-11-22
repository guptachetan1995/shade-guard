// Unread counts from the chat service (§15.5.3: "the channel list with unread counts for the desk
// inbox"). The transport may report the service's own count per channel; the desk shows it when it can
// and its own count otherwise, and says which. On the fake service here; the Nexconn adapter's side is
// in nexconn-adapter.test.js (mock-only, UNVERIFIED against the real service).
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeChatServer } from "../src/chat/fake-transport.js";
import { ChatError, createUnavailableTransport, hasUnreadCounts, OPTIONAL_TRANSPORT_METHODS, STATUS, TRANSPORT_METHODS } from "../src/chat/transport.js";
import { registrationObjects, TYPES } from "../src/chat/messages.js";
import { clearsFor, inboxUnread, oneAtATime, readCompletely, settleCleared, shouldClearUnread, unreadBadgeHtml, unreadCaptionHtml } from "../public/chat/common.js";
import { UNREAD_TIMEOUT_MS } from "../src/app.js";
import { makeChatDuo, shopperRequests, wrapTransport } from "./chat-helpers.js";

const note = (text, visit = "visit-a") => ({ visit, caseId: "R-104", text });

async function trio() {
  const server = new FakeChatServer({ clock: () => 1_000 });
  const [seat] = server.seats;
  const open = async (userId) => {
    const t = server.transport(userId);
    t.registerCustomMessages(registrationObjects());
    await t.connect();
    return t;
  };
  const shopA = seat.shoppers[0].userId;
  const shopB = seat.shoppers[1].userId;
  return { server, seat, shopA, shopB, desk: await open(seat.deskUserId), desk2: await open(seat.deskUserId), maya: await open(shopA), open };
}

test("the unread methods are optional: a transport without them is still a transport, and says it has none", () => {
  assert.deepEqual(OPTIONAL_TRANSPORT_METHODS, ["unreadCounts", "clearUnread", "onUnreadChange"]);
  for (const m of OPTIONAL_TRANSPORT_METHODS) assert.equal(TRANSPORT_METHODS.includes(m), false, `${m} is not required`);
  assert.equal(hasUnreadCounts(createUnavailableTransport()), false);
  assert.equal(hasUnreadCounts(new FakeChatServer().transport("fakedesk1")), true);
});

test("the fake service keeps an unread count per user and channel: counted types only, never the sender's own message, a channel it never held is not listed", async () => {
  const { desk, maya, seat, shopA, shopB } = await trio();
  await maya.send({ toUserId: seat.deskUserId, type: TYPES.RETURN_REQUEST, content: { visit: "v", caseId: "R-104", orderId: "O-5521", reason: "wrong shade, opened" } });
  await maya.send({ toUserId: seat.deskUserId, type: TYPES.NOTE, content: note("hello", "v") });
  await desk.send({ toUserId: shopA, type: TYPES.NOTE, content: { ...note("staff here", "v"), by: "staff" } });
  await desk.send({ toUserId: shopA, type: TYPES.CASE_CLOSED, content: { visit: "v", caseId: "R-104", reason: "resolved" } });
  assert.deepEqual(await desk.unreadCounts([shopA, shopB]), { [shopA]: 2 }, "her two messages; Asha's channel was never used, so it is not listed");
  assert.deepEqual(await maya.unreadCounts([seat.deskUserId]), { [seat.deskUserId]: 1 }, "the staff note counts; a case-closed message is registered as not counted");
});

test("clearing a channel's count resets it for every connection of that user, and tells the user's other connections, not the one that cleared", async () => {
  const { desk, desk2, maya, seat, shopA } = await trio();
  await maya.send({ toUserId: seat.deskUserId, type: TYPES.NOTE, content: note("one", "v") });
  const told = { desk: [], desk2: [], maya: [] };
  desk.onUnreadChange((peer) => told.desk.push(peer));
  const stop = desk2.onUnreadChange((peer) => told.desk2.push(peer));
  maya.onUnreadChange((peer) => told.maya.push(peer));
  assert.deepEqual(await desk2.unreadCounts([shopA]), { [shopA]: 1 }, "the count is the user's, not the connection's");
  await desk.clearUnread(shopA);
  assert.deepEqual(await desk.unreadCounts([shopA]), { [shopA]: 0 });
  assert.deepEqual(await desk2.unreadCounts([shopA]), { [shopA]: 0 });
  assert.deepEqual(told, { desk: [], desk2: [shopA], maya: [] });
  stop();
  await desk.clearUnread(shopA);
  assert.deepEqual(told.desk2, [shopA], "unsubscribed");
});

test("unread reads and clears refuse when not connected (chat_offline), and fail as read_failed / clear_failed when the service can't be read", async () => {
  const { desk, server, shopA } = await trio();
  server.failReads = true;
  await assert.rejects(desk.unreadCounts([shopA]), (e) => e instanceof ChatError && e.code === "read_failed");
  await assert.rejects(desk.clearUnread(shopA), (e) => e instanceof ChatError && e.code === "clear_failed");
  server.failReads = false;
  desk.disconnect();
  await assert.rejects(desk.unreadCounts([shopA]), (e) => e instanceof ChatError && e.code === "chat_offline");
  await assert.rejects(desk.clearUnread(shopA), (e) => e instanceof ChatError && e.code === "chat_offline");
});

// ---------------------------------------------------------------------------- the app's wiring

test("the desk app reads the service's counts by case, and can mark a case's channel read", async () => {
  const duo = await makeChatDuo();
  assert.deepEqual(await duo.desk.chat.unreadCounts(), {}, "no channel has been used yet: nothing listed, nothing guessed");
  await shopperRequests(duo);
  assert.deepEqual(await duo.desk.chat.unreadCounts(), { "R-104": 1 });
  assert.equal(await duo.desk.chat.clearUnread("R-104"), true);
  assert.deepEqual(await duo.desk.chat.unreadCounts(), { "R-104": 0 });
  assert.equal(await duo.desk.chat.clearUnread("R-999"), false, "no such case on this seat");
});

test("the counts are the channel's, so another visit's messages on the shared seat count too (the desk drops them from the thread, not from the service's count)", async () => {
  const duo = await makeChatDuo();
  await duo.shopperTransport.send({ toUserId: duo.seat.deskUserId, type: TYPES.NOTE, content: note("another visit", "visit-b") });
  await duo.settle();
  assert.equal(duo.desk.store.state.threads["R-104"].messages.length, 0);
  assert.deepEqual(await duo.desk.chat.unreadCounts(), { "R-104": 1 });
});

test("with no unread methods on the transport, offline, or a failed read, the app reports no service count (null) and the desk keeps its own", async () => {
  const bare = await makeChatDuo({ deskTransport: (t) => wrapTransport(t) });
  await shopperRequests(bare);
  assert.equal(await bare.desk.chat.unreadCounts(), null);
  assert.equal(await bare.desk.chat.clearUnread("R-104"), false);

  const failing = await makeChatDuo();
  await shopperRequests(failing);
  failing.server.failReads = true;
  assert.equal(await failing.desk.chat.unreadCounts(), null);
  assert.equal(await failing.desk.chat.clearUnread("R-104"), false);
  failing.server.failReads = false;
  failing.server.drop(failing.seat.deskUserId);
  assert.equal(failing.desk.store.state.chat.connection.state, STATUS.OFFLINE);
  assert.equal(await failing.desk.chat.unreadCounts(), null);
});

test("another tab of the desk marking a channel read makes this desk redraw", async () => {
  const duo = await makeChatDuo();
  await shopperRequests(duo);
  let changes = 0;
  duo.desk.chat.onChange(() => changes++);
  const other = duo.server.transport(duo.seat.deskUserId);
  other.registerCustomMessages(registrationObjects());
  await other.connect();
  await other.clearUnread(duo.seat.shoppers[0].userId);
  assert.ok(changes >= 1, "the desk is told, so it reads the counts again");
});

test("a hung unread read or clear gives up after a timeout: the desk falls back to its own count instead of waiting", async () => {
  assert.ok(UNREAD_TIMEOUT_MS > 0 && UNREAD_TIMEOUT_MS <= 10_000);
  const hang = () => new Promise(() => {});
  const duo = await makeChatDuo({ deskTransport: (t) => wrapTransport(t, { unreadCounts: hang, clearUnread: hang }) });
  await shopperRequests(duo);
  const started = Date.now();
  assert.equal(await duo.desk.chat.unreadCounts({ timeoutMs: 20 }), null);
  assert.equal(await duo.desk.chat.clearUnread("R-104", { timeoutMs: 20 }), false);
  assert.ok(Date.now() - started < 1000);
});

test("oneAtATime: calls made while a run is going are folded into one more run after it; never two at once; a failed run doesn't stop the next", async () => {
  let running = 0;
  let most = 0;
  let runs = 0;
  let release;
  const fn = async () => {
    runs++;
    running++;
    most = Math.max(most, running);
    if (runs === 1) await new Promise((r) => (release = r));
    running--;
    if (runs === 2) throw new Error("a failed read");
  };
  const run = oneAtATime(fn);
  const first = run();
  run();
  run();
  run();
  assert.equal(runs, 1);
  release();
  await first;
  await run.idle();
  assert.deepEqual([runs, most], [2, 1], "three calls during the first run made one more run, not three");
  await run();
  await run.idle();
  assert.equal(runs, 3, "the failed second run did not stop the third");
});

// ---------------------------------------------------------------------------- what the inbox shows

test("an inbox row shows the service's count when the service listed its channel, the desk's own otherwise, and the open thread shows none", () => {
  assert.deepEqual(inboxUnread({ selected: false, own: 1, service: 3 }), { count: 3, source: "service", own: 1, service: 3 });
  assert.deepEqual(inboxUnread({ selected: false, own: 2, service: undefined }), { count: 2, source: "desk", own: 2, service: null });
  assert.deepEqual(inboxUnread({ selected: false, own: 2, service: null }), { count: 2, source: "desk", own: 2, service: null });
  assert.deepEqual(inboxUnread({ selected: true, own: 0, service: 4 }), { count: 0, source: "service", own: 0, service: 4 });
});

test("a service count lower than what this visit has not shown is not shown: the badge never says fewer than the desk knows, and says why", () => {
  const u = inboxUnread({ selected: false, own: 2, service: 1 });
  assert.deepEqual(u, { count: 2, source: "desk", own: 2, service: 1 });
  const html = unreadBadgeHtml(u, { via: "Nexconn" });
  assert.match(html, /data-unread-source="desk"/);
  assert.match(html, />2<\/span>$/);
  assert.match(html, /channel list says 1/);
  assert.equal(shouldClearUnread({ selected: false, own: u.own, service: u.service, read: true }), false, "and it is not cleared: this visit still has unread messages there");
});

test("the desk marks a channel read on the service when it shows that thread, or when the service counts messages this visit has nothing unread in", () => {
  assert.equal(shouldClearUnread({ selected: true, own: 0, service: 2, read: true }), true, "the open thread: staff have it on screen");
  assert.equal(shouldClearUnread({ selected: false, own: 0, service: 3, read: true }), true, "another or an earlier visit's messages: nothing of this visit is unread");
  assert.equal(shouldClearUnread({ selected: false, own: 1, service: 1, read: true }), false, "this visit has an unread message there");
  assert.equal(shouldClearUnread({ selected: true, own: 0, service: 0, read: true }), false, "nothing to clear");
  assert.equal(shouldClearUnread({ selected: true, own: 0, service: undefined, read: true }), false, "the service gave no count");
});

test("the desk never marks a channel read when its own count of 0 means only that it could not read the thread (no complete read, or a gap)", () => {
  assert.equal(shouldClearUnread({ selected: false, own: 0, service: 3, read: false }), false);
  assert.equal(shouldClearUnread({ selected: true, own: 0, service: 3, read: false }), false, "an open thread whose history never loaded is not on screen either");
  const rows = (read) => [{ caseId: "R-104", selected: false, own: 0, read }];
  assert.deepEqual(clearsFor(rows(false), { "R-104": 2 }), []);
  assert.deepEqual(clearsFor(rows(true), { "R-104": 2 }), ["R-104"]);
});

test("a thread counts as read completely only with a read point, no gap and no history cut short: a truncated reload clears nothing", async () => {
  assert.equal(readCompletely({ readThrough: null, readGap: false, historyTruncated: false }), false, "never read");
  assert.equal(readCompletely({ readThrough: { sentTime: 1, messageId: "a" }, readGap: true, historyTruncated: false }), false, "a gap");
  assert.equal(readCompletely({ readThrough: { sentTime: 1, messageId: "a" }, readGap: false, historyTruncated: true }), false, "older messages not loaded");
  assert.equal(readCompletely({ readThrough: { sentTime: 0, messageId: "" }, readGap: false, historyTruncated: false }), true, "an empty channel read to its start");
  // A real reload past the page budget, with nothing of this visit unread in what it shows.
  const duo = await makeChatDuo();
  for (let i = 0; i < 505; i++) duo.server.record(duo.seat.shoppers[0].userId, duo.seat.deskUserId, TYPES.NOTE, note(`other ${i}`, "visit-b"));
  const { createApp } = await import("../src/app.js");
  const { FakeYouCamProvider } = await import("../src/providers/youcam-fake.js");
  const fresh = await createApp({ provider: new FakeYouCamProvider(), chat: { transport: duo.server.transport(duo.seat.deskUserId), seat: duo.seat, side: "desk", visit: "visit-a" } });
  await fresh.chat.connect();
  const th = fresh.store.state.threads["R-104"];
  assert.equal(th.historyTruncated, true);
  assert.equal(readCompletely(th), false);
  assert.deepEqual(clearsFor([{ caseId: "R-104", selected: false, own: 0, read: readCompletely(th) }], await fresh.chat.unreadCounts()), [], "its unread count on the service is left alone");
});

test("oneAtATime says what failed: a run's error is warned, not swallowed", async () => {
  const warned = [];
  const original = console.warn;
  console.warn = (...args) => warned.push(args);
  try {
    const run = oneAtATime(async () => {
      throw new Error("a render bug");
    });
    await run();
    await run.idle();
  } finally {
    console.warn = original;
  }
  assert.equal(warned.length, 1);
  assert.ok(warned[0].some((a) => a instanceof Error && a.message === "a render bug"));
});

test("a channel is cleared at most once per count seen: a clear that doesn't take, with the service telling the desk each time, can't loop", () => {
  const rows = [{ caseId: "R-107", selected: false, own: 0, read: true }];
  assert.deepEqual(clearsFor(rows, { "R-107": 3 }, {}), ["R-107"]);
  assert.deepEqual(clearsFor(rows, { "R-107": 3 }, { "R-107": 3 }), [], "the same count again after clearing it: not again");
  assert.deepEqual(clearsFor(rows, { "R-107": 4 }, { "R-107": 3 }), ["R-107"], "a new message changes the count: once more");
  assert.deepEqual(settleCleared({ "R-107": 3 }, { "R-107": 3 }), { "R-107": 3 }, "the clear did not take: remembered");
  assert.deepEqual(settleCleared({ "R-107": 3 }, { "R-107": 0 }), {}, "the clear took: forgotten, so the next message's count clears again");
  assert.deepEqual(settleCleared({ "R-107": 3 }, null), { "R-107": 3 });
  assert.deepEqual(clearsFor(rows, null, {}), [], "no counts, nothing to clear");
});

test("the badge and the inbox caption say whose count it is", () => {
  const svc = unreadBadgeHtml(inboxUnread({ selected: false, own: 1, service: 2 }), { via: "Nexconn" });
  assert.match(svc, /^<span class="unread" data-unread-source="service"/);
  assert.match(svc, />2<\/span>$/);
  assert.match(svc, /the chat service&#39;s own count for this channel \(via Nexconn;/);
  assert.match(svc, /This desk counts 1\./);
  const own = unreadBadgeHtml(inboxUnread({ selected: false, own: 1, service: undefined }), { via: "Nexconn" });
  assert.match(own, /data-unread-source="desk"/);
  assert.match(own, /this desk&#39;s own count/);
  assert.equal(unreadBadgeHtml(inboxUnread({ selected: true, own: 0, service: 3 }), { via: "Nexconn" }), "", "no badge on the open thread");
  assert.match(unreadCaptionHtml({ service: true, via: "Nexconn" }), /data-unread-source="service"[^>]*>Unread counts: the chat service's own, from its channel list \(via Nexconn\)/);
  assert.match(unreadCaptionHtml({ service: false, via: "Nexconn" }), /data-unread-source="desk"[^>]*>Unread counts: kept by this desk/);
  assert.doesNotMatch(unreadBadgeHtml(inboxUnread({ selected: false, own: 1, service: 2 }), { via: '<b>"x' }), /<b>|"x/, "escaped");
});
