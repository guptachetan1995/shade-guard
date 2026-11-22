import { test } from "node:test";
import assert from "node:assert/strict";
import { MESSAGE_TYPES, MAX_TEXT, TYPES, registrationObjects, validateContent } from "../src/chat/messages.js";
import { assertChatTransport, createUnavailableTransport, ChatError, STATUS } from "../src/chat/transport.js";
import { STATE_WORDS, THREAD_NOT_VERIFIED, wordsFor } from "../src/chat/states.js";

test("six message types are registered, each with exactly the typed keys and none named isPersited", () => {
  const regs = registrationObjects();
  assert.deepEqual(regs.map((r) => r.messageType), ["SG:Note", "SG:ReturnRequest", "SG:Reading", "SG:Offer", "SG:OfferAccepted", "SG:CaseClosed"]);
  for (const r of regs) {
    assert.deepEqual(Object.keys(r).sort(), ["isCounted", "isPersisted", "messageType"], r.messageType);
    assert.equal(r.isPersisted, true, `${r.messageType} is persisted so a reload restores it from remote history`);
    assert.equal(Object.hasOwn(r, "isPersited"), false, "the docs' misspelling is ignored by the SDK without an error");
  }
  assert.deepEqual(Object.fromEntries(regs.map((r) => [r.messageType, r.isCounted])), {
    "SG:Note": true,
    "SG:ReturnRequest": true,
    "SG:Reading": true,
    "SG:Offer": true,
    "SG:OfferAccepted": true,
    "SG:CaseClosed": false,
  });
  assert.deepEqual(MESSAGE_TYPES, regs.map((r) => r.messageType));
});

test("content is validated strictly: required fields, no extra field, text bounds, who may send", () => {
  const ok = (type, content, sender) => validateContent(type, content, sender);
  assert.equal(ok(TYPES.NOTE, { visit: "v1", caseId: "R-104", text: "hello" }, "shopper").ok, true);
  assert.equal(ok(TYPES.NOTE, { visit: "v1", text: "hello", by: "staff" }, "staff").ok, true);
  assert.equal(ok(TYPES.NOTE, { visit: "v1", text: "hello", by: "staff" }, "shopper").ok, false, "a shopper can't label herself as staff");
  assert.equal(ok(TYPES.NOTE, { visit: "v1", text: "   " }, "shopper").ok, false, "blank text");
  assert.equal(ok(TYPES.NOTE, { visit: "v1", text: "x".repeat(MAX_TEXT + 1) }, "shopper").ok, false, "too long");
  assert.equal(ok(TYPES.NOTE, { visit: "v1", text: "hi", photo: "AAAA" }, "shopper").ok, false, "an undeclared field is refused, so no photo can ride along");
  assert.equal(ok(TYPES.NOTE, { text: "hi" }, "shopper").ok, false, "no visit");
  assert.equal(ok(TYPES.OFFER, { visit: "v", caseId: "R-104", draftId: "d_01", text: "t", resolution: "exchange", shadeCode: "245W", deltaE: { "245W": 2.1 } }, "staff").ok, true);
  const forged = ok(TYPES.OFFER, { visit: "v", caseId: "R-104", draftId: "d_01", text: "t", resolution: "exchange", deltaE: null }, "shopper");
  assert.equal(forged.ok, false);
  assert.equal(forged.wrongSender, true, "a shopper can't send an offer");
  assert.equal(ok(TYPES.CASE_CLOSED, { visit: "v", caseId: "R-104", reason: "resolved" }, "shopper").wrongSender, true);
  assert.equal(ok(TYPES.OFFER_ACCEPTED, { visit: "v", caseId: "R-104", draftId: "d_01" }, "staff").wrongSender, true, "staff can't accept for the shopper");
  assert.equal(ok(TYPES.READING, { visit: "v", caseId: "R-107", lab: [64.2, 13.4, 19.6], hueAngle: 55.7, band: 1, lighting: "good" }, "shopper").ok, true);
  assert.equal(ok(TYPES.READING, { visit: "v", caseId: "R-107", lab: [64.2, 13.4], hueAngle: 55.7, band: 1, lighting: "good" }, "shopper").ok, false);
  assert.equal(ok(TYPES.READING, { visit: "v", caseId: "R-107", lab: [64.2, 13.4, 19.6], hueAngle: 55.7, band: 1, lighting: "good", photo: "x" }, "shopper").ok, false, "numbers only");
  assert.equal(ok("SG:Surprise", { visit: "v" }, "shopper").ok, false);
});

test("the unavailable transport implements the interface, reports sdk_not_loaded, and fakes nothing", async () => {
  const t = assertChatTransport(createUnavailableTransport());
  assert.deepEqual(await t.connect(), { state: STATUS.SDK_NOT_LOADED, code: null, detail: null });
  assert.equal(t.status().state, "sdk_not_loaded");
  await assert.rejects(() => t.send({ toUserId: "x", type: TYPES.NOTE, content: {} }), (e) => e instanceof ChatError && e.code === "chat_offline");
  await assert.rejects(() => t.newest({ withUserId: "x" }), (e) => e instanceof ChatError && e.code === "read_failed");
  assert.equal(t.describe().via, "no chat service");
  assert.throws(() => assertChatTransport({ send() {} }), /must implement/);
});

test("every connection state has words on screen, and so does an unverified thread", () => {
  for (const state of Object.values(STATUS)) {
    const w = STATE_WORDS[state];
    assert.ok(w?.label && w.words.length > 20, `${state} has no words`);
  }
  assert.match(STATE_WORDS.connecting.words, /Connecting/);
  assert.match(STATE_WORDS.busy.words, /busy/);
  assert.match(STATE_WORDS.offline.words, /Offline/);
  assert.match(STATE_WORDS.sdk_not_loaded.words, /SDK is not loaded/);
  assert.match(THREAD_NOT_VERIFIED.words, /Nothing was sent/);
  assert.match(wordsFor("nonsense").words, /Unknown chat state/);
});
