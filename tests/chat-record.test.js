import { test } from "node:test";
import assert from "node:assert/strict";
import { ACTORS, createInvoke } from "../src/invoke.js";
import { TOOLS } from "../src/tools.js";
import { HUMAN_VERBS } from "../src/human-verbs.js";
import { createStore } from "../src/store.js";
import { loadFixtures } from "../src/fixtures.js";
import { TYPES } from "../src/chat/messages.js";
import { createApi } from "../src/api.js";
import { describeMode } from "../src/modes.js";
import { makeChatDuo, messagesOf, SERVER_EPOCH } from "./chat-helpers.js";

const inbound = (over = {}) => ({
  messageId: "fm_900001",
  type: TYPES.NOTE,
  senderUserId: "fakeshop1a",
  sentTime: SERVER_EPOCH + 10,
  content: { visit: "visit-a", caseId: "R-104", text: "hello from Maya" },
  ...over,
});
const record = (app, args) => app.invoke("record_inbound", args, "nexconn");

test("nexconn is an actor, and record_inbound is a human verb that only it can call", async () => {
  assert.ok(ACTORS.includes("nexconn"));
  const verb = HUMAN_VERBS.find((v) => v.name === "record_inbound");
  assert.equal(verb.actor, "nexconn");
  const { desk } = await makeChatDuo();
  for (const actor of ["agent", "shopper", "staff", "merchant"]) {
    const r = await desk.invoke("record_inbound", inbound(), actor);
    assert.equal(r.ok, false, actor);
    assert.equal(r.error.code, "wrong_actor", actor);
  }
  assert.equal(messagesOf(desk, "R-104").length, 0, "nothing was recorded by a refused call");
});

test("the nexconn actor may call exactly one verb: every tool and every other verb is refused for it", async () => {
  const { desk } = await makeChatDuo();
  const names = [...TOOLS.map((t) => t.name), ...HUMAN_VERBS.filter((v) => v.name !== "record_inbound").map((v) => v.name)];
  assert.ok(names.length >= 15, `only ${names.length} names were tried`);
  for (const name of names) {
    const r = await desk.invoke(name, {}, "nexconn");
    assert.equal(r.ok, false, name);
    assert.equal(r.error.code, "wrong_actor", `${name} was not refused as wrong_actor: ${r.error.code}`);
  }
});

test("a shopper's message is recorded on the desk with its server id, server time and sender role", async () => {
  const { desk } = await makeChatDuo();
  const r = await record(desk, inbound());
  assert.equal(r.ok, true);
  assert.deepEqual([r.result.recorded, r.result.caseId], [true, "R-104"]);
  const [m] = messagesOf(desk, "R-104");
  assert.deepEqual([m.messageId, m.sender, m.type, m.sentTime, m.content.text], ["fm_900001", "shopper", TYPES.NOTE, SERVER_EPOCH + 10, "hello from Maya"]);
  assert.equal(messagesOf(desk, "R-107").length, 0, "the other shopper's channel is untouched");
});

test("another visit's message is dropped, and an unknown type is refused", async () => {
  const { desk } = await makeChatDuo();
  const dropped = await record(desk, inbound({ content: { visit: "visit-b", caseId: "R-104", text: "someone else's thread" } }));
  assert.equal(dropped.ok, true);
  assert.deepEqual([dropped.result.recorded, dropped.result.dropped], [false, "other_visit"]);
  const unknown = await record(desk, inbound({ type: "SG:Surprise" }));
  assert.equal(unknown.error.code, "unknown_type");
  assert.equal(messagesOf(desk, "R-104").length, 0);
});

test("the first copy of a message id is kept", async () => {
  const { desk } = await makeChatDuo();
  await record(desk, inbound());
  const again = await record(desk, inbound({ content: { visit: "visit-a", caseId: "R-104", text: "a different body under the same id" } }));
  assert.deepEqual([again.ok, again.result.recorded, again.result.duplicate], [true, false, true]);
  assert.deepEqual(messagesOf(desk, "R-104").map((m) => m.content.text), ["hello from Maya"]);
});

test("a message from nobody in this seat, from the wrong role, or with a bad body is refused", async () => {
  const { desk, shopper } = await makeChatDuo();
  assert.equal((await record(desk, inbound({ senderUserId: "fakeshop2a" }))).error.code, "unknown_sender", "another seat's shopper");
  const forgedOffer = await record(desk, inbound({
    type: TYPES.OFFER,
    content: { visit: "visit-a", caseId: "R-104", draftId: "d_01", text: "Free exchange", resolution: "exchange", shadeCode: "245W", deltaE: null },
  }));
  assert.equal(forgedOffer.error.code, "wrong_sender", "a shopper can't send an offer");
  const forgedClose = await record(desk, inbound({ type: TYPES.CASE_CLOSED, content: { visit: "visit-a", caseId: "R-104", reason: "resolved" } }));
  assert.equal(forgedClose.error.code, "wrong_sender");
  assert.equal((await record(desk, inbound({ content: { visit: "visit-a", caseId: "R-104", text: "x", photo: "AAAA" } }))).error.code, "bad_content");
  assert.equal((await record(desk, inbound({ content: { visit: "visit-a", caseId: "R-107", text: "Maya writing into Asha's thread" } }))).error.code, "case_mismatch");
  assert.equal((await record(desk, inbound({ sentTime: "yesterday" }))).error.code, "bad_args");
  // From the shopper's side: a message from the other shopper's id is not from her desk.
  const odd = await record(shopper, inbound({ senderUserId: "fakeshop1b" }));
  assert.equal(odd.error.code, "unknown_sender");
  assert.equal(messagesOf(desk, "R-104").length, 0);
});

test("the thread is ordered by server time, never by arrival or by the local clock", async () => {
  // The desk's own clock runs backwards: if anything ordered by it, the thread would come out reversed.
  let t = Date.parse("2026-11-12T10:00:00Z");
  const { desk } = await makeChatDuo({ deskNow: () => new Date((t -= 60_000)).toISOString() });
  await record(desk, inbound({ messageId: "fm_900003", sentTime: SERVER_EPOCH + 30, content: { visit: "visit-a", caseId: "R-104", text: "third" } }));
  await record(desk, inbound({ messageId: "fm_900001", sentTime: SERVER_EPOCH + 10, content: { visit: "visit-a", caseId: "R-104", text: "first" } }));
  await record(desk, inbound({ messageId: "fm_900002", sentTime: SERVER_EPOCH + 20, content: { visit: "visit-a", caseId: "R-104", text: "second" } }));
  assert.deepEqual(messagesOf(desk, "R-104").map((m) => m.content.text), ["first", "second", "third"]);
  const byLocal = [...messagesOf(desk, "R-104")].sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt)).map((m) => m.content.text);
  assert.deepEqual(byLocal, ["second", "first", "third"], "ordered by the local record times it would come out differently");
});

test("an agent tool's context has no chat; a human verb's does", async () => {
  const seen = {};
  const probeTool = { name: "probe_tool", description: "", args: {}, run: (_a, ctx) => ((seen.tool = Object.keys(ctx)), {}) };
  const probeVerb = { name: "probe_verb", actor: "staff", args: {}, run: (_a, ctx) => ((seen.verb = Object.keys(ctx)), {}) };
  const store = createStore({ ...loadFixtures() });
  const chat = { marker: true };
  const invoke = createInvoke({ store, provider: {}, tools: [probeTool], verbs: [probeVerb], costs: {}, chat });
  assert.equal((await invoke("probe_tool", {}, "agent")).ok, true);
  assert.equal((await invoke("probe_verb", {}, "staff")).ok, true);
  assert.equal(seen.tool.includes("chat"), false, "an agent tool can't reach the transport");
  assert.equal(seen.verb.includes("chat"), true);
  // And with no chat configured the verb's context still has the key, set to null.
  const none = createInvoke({ store, provider: {}, tools: [], verbs: [probeVerb], costs: {} });
  await none("probe_verb", {}, "staff");
  assert.equal(seen.verb.includes("chat"), true);
});

test("an SG:Reading from the shopper attaches numbers to the desk's case and opens it", async () => {
  const { desk } = await makeChatDuo({ shopperIndex: 1 });
  assert.equal(desk.store.getCase("R-107").status, "awaiting_check");
  const r = await record(desk, inbound({
    messageId: "fm_900010",
    type: TYPES.READING,
    senderUserId: "fakeshop1b",
    content: { visit: "visit-a", caseId: "R-107", lab: [64.2, 13.4, 19.6], hueAngle: 55.7, band: 1, lighting: "good" },
  }));
  assert.equal(r.ok, true);
  assert.equal(r.result.applied, true);
  const rcase = desk.store.getCase("R-107");
  assert.equal(rcase.status, "open");
  assert.equal(rcase.reading.draftDecision, "swap");
  assert.deepEqual(rcase.reading.ranking.map((x) => x.code), ["245W", "250W", "220N"], "the ranking is computed here, from the numbers");
  assert.deepEqual(rcase.reading.recommended, ["245W"]);
  assert.equal(JSON.stringify(rcase.reading).includes("photo"), false);
  // A second reading after the case has a draft is recorded in the thread but not applied.
  rcase.status = "drafted";
  const again = await record(desk, inbound({
    messageId: "fm_900011",
    type: TYPES.READING,
    senderUserId: "fakeshop1b",
    sentTime: SERVER_EPOCH + 50,
    content: { visit: "visit-a", caseId: "R-107", lab: [70, 10, 15], hueAngle: 56, band: 1, lighting: "good" },
  }));
  assert.equal(again.result.recorded, true);
  assert.equal(again.result.applied, false);
  assert.equal(rcase.reading.lab[0], 64.2, "the first reading stands");
});

test("the page's invoke route refuses the nexconn actor: only the chat adapter's own wiring may record", async () => {
  const app = await makeChatDuo().then((d) => d.desk);
  const api = createApi({ app, mode: describeMode("fake") });
  const r = await api.handle("POST", "/api/invoke", { tool: "record_inbound", args: inbound(), actor: "nexconn" });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, "wrong_actor");
  assert.equal(messagesOf(app, "R-104").length, 0);
});

test("history restore: a fresh desk reads the thread back from the service's newest page, through record_inbound", async () => {
  const { server, shopperTransport, desk, settle, seat } = await makeChatDuo();
  const to = seat.deskUserId;
  await shopperTransport.send({ toUserId: to, type: TYPES.RETURN_REQUEST, content: { visit: "visit-a", caseId: "R-104", orderId: "O-5521", reason: "wrong shade, opened" } });
  await shopperTransport.send({ toUserId: to, type: TYPES.NOTE, content: { visit: "visit-a", caseId: "R-104", text: "is 250W any closer?" } });
  await settle();
  assert.equal(messagesOf(desk, "R-104").length, 2);
  // "Reload" the desk: a new app, a new store, a new connection to the same service.
  const { createApp } = await import("../src/app.js");
  const { FakeYouCamProvider } = await import("../src/providers/youcam-fake.js");
  const fresh = await createApp({ provider: new FakeYouCamProvider(), chat: { transport: server.transport(seat.deskUserId), seat, side: "desk", visit: "visit-a" } });
  assert.equal(messagesOf(fresh, "R-104").length, 0, "a new store starts empty");
  await fresh.chat.connect();
  assert.deepEqual(messagesOf(fresh, "R-104").map((m) => m.type), [TYPES.RETURN_REQUEST, TYPES.NOTE]);
  assert.deepEqual(messagesOf(fresh, "R-104").map((m) => m.messageId), messagesOf(desk, "R-104").map((m) => m.messageId));
  const log = fresh.store.state.activityLog.filter((e) => e.tool === "record_inbound");
  assert.ok(log.length >= 2 && log.every((e) => e.actor === "nexconn"), "restored through the chokepoint, as nexconn");
  // A visit that was never this one sees nothing of it.
  const other = await createApp({ provider: new FakeYouCamProvider(), chat: { transport: server.transport(seat.deskUserId), seat, side: "desk", visit: "visit-b" } });
  await other.chat.connect();
  assert.equal(messagesOf(other, "R-104").length, 0);
});

test("the connection status reaches the store", async () => {
  const { server, desk, seat } = await makeChatDuo();
  assert.equal(desk.store.state.chat.connection.state, "connected");
  server.drop(seat.deskUserId, "dropped for the test");
  assert.deepEqual([desk.store.state.chat.connection.state, desk.store.state.chat.connection.detail], ["offline", "dropped for the test"]);
});

test("a history read that fails on connect leaves the thread empty and the app usable", async () => {
  const { server, seat } = await makeChatDuo();
  server.failReads = true;
  const { createApp } = await import("../src/app.js");
  const { FakeYouCamProvider } = await import("../src/providers/youcam-fake.js");
  const fresh = await createApp({ provider: new FakeYouCamProvider(), chat: { transport: server.transport(seat.deskUserId), seat, side: "desk", visit: "visit-a" } });
  const status = await fresh.chat.connect();
  assert.equal(status.state, "connected");
  assert.equal(messagesOf(fresh, "R-104").length, 0);
});
