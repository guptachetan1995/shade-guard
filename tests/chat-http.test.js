import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "../src/server.js";
import { describeMode } from "../src/modes.js";
import { createApp } from "../src/app.js";
import { FakeChatServer, FAKE_BANNER } from "../src/chat/fake-transport.js";
import { createFakeClient } from "../src/chat/fake-client.js";
import { registrationObjects, TYPES } from "../src/chat/messages.js";
import { assertChatTransport, ChatError, STATUS } from "../src/chat/transport.js";
import { FakeYouCamProvider } from "../src/providers/youcam-fake.js";
import { makeApp } from "./helpers.js";

let withChat;
let without;
let fake;

before(async () => {
  fake = new FakeChatServer({ deliveryDelayMs: 15 });
  withChat = await startServer({ app: await makeApp(), mode: describeMode("fake"), fakeChat: fake });
  without = await startServer({ app: await makeApp(), mode: describeMode("fake") });
});
after(async () => {
  await withChat.close();
  await without.close();
});

const get = async (srv, path) => fetch(srv.url + path).then(async (r) => ({ status: r.status, body: await r.json() }));
const post = async (srv, path, body) =>
  fetch(srv.url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
const waitFor = async (fn, what) => {
  for (let i = 0; i < 400; i++) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
};
const client = (userId) => createFakeClient({ userId, baseUrl: withChat.url, pollMs: 10 });

test("the fake chat routes exist only when the server was started with the fake service", async () => {
  const on = await get(withChat, "/api/fake-chat/config");
  assert.equal(on.status, 200);
  assert.equal(on.body.banner, FAKE_BANNER);
  assert.equal(on.body.seats.length, 4);
  assert.equal(on.body.maxConnections, 10);
  const off = await get(without, "/api/fake-chat/config");
  assert.equal(off.status, 404);
  assert.equal(off.body.error.code, "not_found");
  assert.equal((await post(without, "/api/fake-chat/connect", { userId: "fakedesk1" })).status, 404);
});

test("a page's fake client implements the transport interface, and delivery arrives later by polling", async () => {
  const [seat] = fake.seats;
  const desk = assertChatTransport(client(seat.deskUserId));
  const shopper = client(seat.shoppers[0].userId);
  for (const t of [desk, shopper]) {
    t.registerCustomMessages(registrationObjects());
    assert.equal((await t.connect()).state, STATUS.CONNECTED);
  }
  const got = [];
  desk.onMessage((m) => got.push(m));
  const sent = await shopper.send({ toUserId: seat.deskUserId, type: TYPES.NOTE, content: { visit: "v", caseId: "R-104", text: "hello over http" } });
  assert.match(sent.messageId, /^fm_/);
  assert.deepEqual(got, [], "not delivered at the moment of sending");
  const page = await desk.newest({ withUserId: seat.shoppers[0].userId });
  assert.equal(page[0].messageId, sent.messageId, "but the service already has it");
  await waitFor(() => got.length, "the delayed delivery");
  assert.equal(got[0].messageId, sent.messageId);
  assert.equal(got[0].sentTime, sent.sentTime);
  desk.disconnect();
  shopper.disconnect();
  assert.equal(desk.status().state, STATUS.IDLE);
});

test("the fake client reads and clears the service's unread counts over the routes, and says chat_offline once its connection is gone", async () => {
  const seat = fake.seats[2];
  const desk = client(seat.deskUserId);
  const shopper = client(seat.shoppers[0].userId);
  for (const t of [desk, shopper]) {
    t.registerCustomMessages(registrationObjects());
    await t.connect();
  }
  await shopper.send({ toUserId: seat.deskUserId, type: TYPES.NOTE, content: { visit: "v", caseId: "R-104", text: "unread over http" } });
  assert.deepEqual(await desk.unreadCounts([seat.shoppers[0].userId, seat.shoppers[1].userId]), { [seat.shoppers[0].userId]: 1 });
  await desk.clearUnread(seat.shoppers[0].userId);
  assert.deepEqual(await desk.unreadCounts([seat.shoppers[0].userId]), { [seat.shoppers[0].userId]: 0 });
  fake.drop(seat.deskUserId);
  await waitFor(() => desk.status().state === STATUS.OFFLINE, "the client to see the drop");
  await assert.rejects(desk.unreadCounts([seat.shoppers[0].userId]), (e) => e instanceof ChatError && e.code === "chat_offline");
  shopper.disconnect();
});

test("the fake client reports an unregistered type, a busy seat, a dropped connection and an unreachable service in words the page can show", async () => {
  const [, seat2] = fake.seats;
  const unregistered = client(seat2.deskUserId);
  await unregistered.connect();
  await assert.rejects(() => unregistered.send({ toUserId: seat2.shoppers[0].userId, type: TYPES.NOTE, content: { visit: "v", text: "x" } }), (e) => e instanceof ChatError && e.code === "unregistered_type");
  unregistered.disconnect();

  const [, , seat3] = fake.seats;
  assert.equal((await post(withChat, "/api/fake-chat/control", { action: "fill", userId: seat3.deskUserId })).body.connections, 10);
  const busy = client(seat3.deskUserId);
  const status = await busy.connect();
  assert.equal(status.state, STATUS.BUSY);
  await post(withChat, "/api/fake-chat/control", { action: "free", userId: seat3.deskUserId });
  assert.equal((await busy.connect()).state, STATUS.CONNECTED, "once the seat frees up");
  busy.disconnect();

  const dropped = client(seat2.shoppers[1].userId);
  dropped.registerCustomMessages(registrationObjects());
  await dropped.connect();
  const states = [];
  dropped.onStatus((s) => states.push(s.state));
  await post(withChat, "/api/fake-chat/control", { action: "drop", userId: seat2.shoppers[1].userId });
  await waitFor(() => states.includes(STATUS.OFFLINE), "the drop to be noticed");
  assert.equal(dropped.status().state, STATUS.OFFLINE);
  await assert.rejects(() => dropped.send({ toUserId: seat2.deskUserId, type: TYPES.NOTE, content: { visit: "v", text: "x" } }), (e) => e.code === "chat_offline");

  await post(withChat, "/api/fake-chat/control", { action: "unreachable" });
  const late = client(seat2.deskUserId);
  assert.equal((await late.connect()).state, STATUS.OFFLINE);
  await post(withChat, "/api/fake-chat/control", { action: "reachable" });
  assert.equal((await post(withChat, "/api/fake-chat/control", { action: "nonsense" })).status, 400);
});

test("two apps over real sockets and the fake client: her request reaches the desk, the agent drafts, staff send, she accepts, staff approve", async () => {
  const [, , , seat4] = fake.seats;
  const visit = "walk-1";
  const mk = (side, userId, as) =>
    createApp({ provider: new FakeYouCamProvider(), chat: { transport: client(userId), seat: seat4, side, as, visit } });
  const desk = await mk("desk", seat4.deskUserId);
  const phone = await mk("shopper", seat4.shoppers[0].userId, 0);
  await desk.chat.connect();
  await phone.chat.connect();
  assert.equal((await phone.invoke("shopper_send", { kind: "return_request" }, "shopper")).ok, true);
  await waitFor(() => desk.store.state.threads["R-104"].messages.length === 1, "her request at the desk");

  const { runPlanner } = await import("../src/agent/planner.js");
  const planned = await runPlanner(desk.invoke, { caseId: "R-104", chat: true });
  assert.equal(planned.plan.outcome, "reply:exchange_offer");
  const draft = desk.store.state.replyDrafts[0];
  const sent = await desk.invoke("send_reply", { caseId: "R-104", draftId: draft.draftId, seen: draft.fingerprint }, "staff");
  assert.equal(sent.ok, true, JSON.stringify(sent.error));
  await waitFor(() => phone.store.state.threads["R-104"].messages.some((m) => m.type === TYPES.OFFER), "the offer on the phone");
  const shown = () => desk.store.state.threads["R-104"].messages.at(-1)?.messageId ?? "";
  assert.equal((await desk.invoke("approve_exchange", { caseId: "R-104", seen: shown() }, "staff")).error.code, "not_accepted");
  assert.equal((await phone.invoke("accept_offer", { caseId: "R-104", draftId: draft.draftId }, "shopper")).ok, true);
  await waitFor(() => desk.store.state.threads["R-104"].messages.some((m) => m.type === TYPES.OFFER_ACCEPTED), "her acceptance at the desk");
  const approved = await desk.invoke("approve_exchange", { caseId: "R-104", seen: shown() }, "staff");
  assert.equal(approved.ok, true, JSON.stringify(approved.error));
  desk.chat.transport.disconnect();
  phone.chat.transport.disconnect();
});

test("the walk's pause and resume: the client reads as connecting while paused and sends nothing, then comes back by itself, and the desk app reads back what it missed", async () => {
  const [seat] = fake.seats;
  const visit = "pause-1";
  const desk = await createApp({ provider: new FakeYouCamProvider(), chat: { transport: client(seat.deskUserId), seat, side: "desk", visit } });
  const phone = await createApp({ provider: new FakeYouCamProvider(), chat: { transport: client(seat.shoppers[0].userId), seat, side: "shopper", as: 0, visit } });
  await desk.chat.connect();
  await phone.chat.connect();
  assert.equal((await post(withChat, "/api/fake-chat/control", { action: "pause", userId: seat.deskUserId })).status, 200);
  await waitFor(() => desk.store.state.chat.connection.state === STATUS.CONNECTING, "the desk to read as connecting");
  assert.match(desk.store.state.chat.connection.detail, /reconnects by itself/);
  await assert.rejects(desk.chat.transport.send({ toUserId: seat.shoppers[0].userId, type: TYPES.NOTE, content: { visit, caseId: "R-104", text: "x", by: "staff" } }), (e) => e.code === "chat_offline");
  assert.equal((await phone.invoke("shopper_send", { kind: "return_request" }, "shopper")).ok, true);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(desk.store.state.threads["R-104"].messages.length, 0, "nothing reaches a paused desk");
  assert.equal((await post(withChat, "/api/fake-chat/control", { action: "resume", userId: seat.deskUserId })).status, 200);
  await waitFor(() => desk.store.state.chat.connection.state === STATUS.CONNECTED, "the desk back");
  await desk.chat.caughtUp();
  await desk.chat.settled();
  assert.deepEqual(desk.store.state.threads["R-104"].messages.map((m) => m.type), [TYPES.RETURN_REQUEST], "read back after the reconnect, not delivered");
  desk.chat.transport.disconnect();
  phone.chat.transport.disconnect();
});

test("every /api/fake-chat path the page-side code calls is a route the server serves", async () => {
  const { readFileSync } = await import("node:fs");
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
  const served = new Set([...read("src/chat/fake-http.js").matchAll(/"(?:GET|POST) (\/api\/fake-chat\/[a-z-]+)"/g)].map((m) => m[1]));
  assert.ok(served.size >= 7);
  for (const file of ["public/chat/local-transport.js", "src/chat/fake-client.js"]) {
    const called = [...read(file).matchAll(/\/api\/fake-chat\/[a-z-]+/g)].map((m) => m[0]);
    assert.ok(called.length >= 1, file);
    for (const path of called) assert.ok(served.has(path), `${file} calls ${path}, which the server does not serve`);
  }
});

// ---------------------------------------------------------------------------- who may POST (S0b review)

const raw = (srv, path, { headers = {}, body = "{}" } = {}) => fetch(srv.url + path, { method: "POST", headers, body }).then(async (r) => ({ status: r.status, body: await r.json() }));

test("a POST from another origin is refused, whatever its content type: a page open in the owner's browser can't press staff's buttons or drive the fake service", async () => {
  const before = (await get(withChat, "/api/state")).body.state.activityLog.length;
  const port = new URL(withChat.url).port;
  const evil = ["http://evil.example", "https://127.0.0.1", `http://127.0.0.1:${Number(port) + 1}`, `http://localhost:${port}`.replace("localhost", "localhost.evil.example"), "null"];
  for (const origin of evil) {
    for (const [path, body] of [
      ["/api/invoke", JSON.stringify({ tool: "approve_refund", args: { caseId: "R-104" }, actor: "staff" })],
      ["/api/fake-chat/connect", JSON.stringify({ userId: "fakedesk1" })],
      ["/api/fake-chat/control", JSON.stringify({ action: "unreachable" })],
    ]) {
      for (const contentType of ["application/json", "text/plain"]) {
        const r = await raw(withChat, path, { headers: { origin, "content-type": contentType }, body });
        assert.equal(r.status, 403, `${origin} ${path} ${contentType}`);
        assert.equal(r.body.error.code, "bad_origin");
      }
    }
  }
  assert.equal((await get(withChat, "/api/state")).body.state.activityLog.length, before, "nothing ran");
  assert.equal(fake.reachable, true, "and the fake service was not switched off");
});

test("a POST from this server's own page, or from a tool with no Origin at all, is let through", async () => {
  const host = new URL(withChat.url).host;
  for (const headers of [{}, { origin: `http://${host}` }]) {
    const r = await raw(withChat, "/api/invoke", { headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ tool: "get_cart", args: {}, actor: "agent" }) });
    assert.equal(r.status, 200, JSON.stringify(headers));
  }
});

test("a body that is not declared as JSON is refused before it is read: a simple cross-site form post can't carry one", async () => {
  for (const headers of [{ "content-type": "text/plain" }, { "content-type": "application/x-www-form-urlencoded" }, {}]) {
    const r = await raw(withChat, "/api/invoke", { headers, body: JSON.stringify({ tool: "get_cart", args: {}, actor: "agent" }) });
    assert.equal(r.status, 415, JSON.stringify(headers));
    assert.equal(r.body.error.code, "unsupported_media_type");
  }
  const charset = await raw(withChat, "/api/invoke", { headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify({ tool: "get_cart", args: {}, actor: "agent" }) });
  assert.equal(charset.status, 200);
});

test("fake connection ids are not a sequence anyone can guess, and a guessed one is not another user's connection", async () => {
  const a = await post(withChat, "/api/fake-chat/connect", { userId: "fakedesk3", registered: [] });
  const b = await post(withChat, "/api/fake-chat/connect", { userId: "fakedesk3", registered: [] });
  const ids = [a.body.connectionId, b.body.connectionId];
  for (const id of ids) assert.doesNotMatch(id, /^fc_\d+$/);
  assert.notEqual(ids[0], ids[1]);
  assert.ok(ids.every((id) => id.length >= 20), "long enough not to be guessed");
  for (const guess of ["fc_1", "fc_2", "fc_3"]) {
    assert.equal((await get(withChat, `/api/fake-chat/poll?connectionId=${guess}`)).status, 410, guess);
    assert.equal((await post(withChat, "/api/fake-chat/send", { connectionId: guess, toUserId: "fakeshop3a", type: TYPES.NOTE, content: {} })).status, 409, guess);
  }
  for (const id of ids) await post(withChat, "/api/fake-chat/disconnect", { connectionId: id });
});
