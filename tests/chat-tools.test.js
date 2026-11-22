import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOLS, listTools } from "../src/tools.js";
import { TYPES } from "../src/chat/messages.js";
import { loadFixtures } from "../src/fixtures.js";
import { rankShades } from "../src/rules/recommend.js";
import { makeChatDuo, messagesOf, SERVER_EPOCH } from "./chat-helpers.js";
import { makeApp } from "./helpers.js";

const R104 = { caseId: "R-104" };
const evidence104 = { shadeCode: "245W", deltaE: { "245W": 2.1, "250W": 3.51, "220N": 5.0 }, band: 1 };

async function request(duo, shopperIndex = 0) {
  const { seat, settle } = duo;
  const shopper = seat.shoppers[shopperIndex];
  await duo.shopperTransport.send({ toUserId: seat.deskUserId, type: TYPES.RETURN_REQUEST, content: { visit: "visit-a", caseId: shopper.caseId, orderId: shopper.orderId, reason: "wrong shade, opened" } });
  await settle();
}

async function resolve104(desk) {
  const r = await desk.invoke("draft_return_resolution", { ...R104, resolution: "exchange", shadeCode: "245W", evidence: { deltaE: { "220N": 5.0, "245W": 2.1 } } }, "agent");
  assert.equal(r.ok, true, JSON.stringify(r.error));
}

const draft = (desk, args) => desk.invoke("draft_reply", args, "agent");

// A lab that sits halfway between two shades of the Skin Tint, or far from all of them.
function labBetween(a, b) {
  const { catalogue } = loadFixtures();
  const shades = catalogue.products.find((p) => p.productId === "skin-tint").shades;
  const [x, y] = [a, b].map((c) => shades.find((s) => s.code === c).lab);
  return x.map((v, i) => Math.round(((v + y[i]) / 2) * 10) / 10);
}

async function readingFor(duo, shopperIndex, lab, band = 1) {
  const { seat, settle } = duo;
  const shopper = seat.shoppers[shopperIndex];
  await duo.shopperTransport.send({ toUserId: seat.deskUserId, type: TYPES.READING, content: { visit: "visit-a", caseId: shopper.caseId, lab, hueAngle: 55, band, lighting: "good" } });
  await settle();
}

test("the registry holds the nine shop tools and the two thread tools, and discovery lists exactly them", () => {
  const names = TOOLS.map((t) => t.name);
  assert.deepEqual(names.slice(-2), ["read_thread", "draft_reply"]);
  assert.equal(names.length, 11);
  assert.deepEqual(listTools().map((t) => t.name), names);
});

test("read_thread returns the case's messages as recorded, with server ids and times, and sends nothing", async () => {
  const duo = await makeChatDuo();
  await request(duo);
  const sentBefore = duo.server.log.length;
  const r = await duo.desk.invoke("read_thread", R104, "agent");
  assert.equal(r.ok, true);
  assert.equal(r.result.caseId, "R-104");
  assert.equal(r.result.closed, false);
  assert.deepEqual(r.result.messages.map((m) => [m.sender, m.type]), [["shopper", TYPES.RETURN_REQUEST]]);
  const [m] = r.result.messages;
  assert.match(m.messageId, /^fm_\d{6}$/);
  assert.equal(m.sentTime, SERVER_EPOCH);
  assert.deepEqual(Object.keys(m).sort(), ["content", "messageId", "sender", "sentTime", "type"]);
  assert.equal(duo.server.log.length, sentBefore, "nothing was sent");
  assert.equal(duo.server.pending(duo.seat.shoppers[0].userId).length, 0);
  assert.equal(JSON.stringify(r).includes("photo"), false);
  r.result.messages[0].content.reason = "tampered";
  assert.equal(messagesOf(duo.desk, "R-104")[0].content.reason, "wrong shade, opened", "the agent gets a copy");
});

test("read_thread refuses an unknown case, and on an app with no chat returns an empty thread", async () => {
  const duo = await makeChatDuo();
  assert.equal((await duo.desk.invoke("read_thread", { caseId: "R-999" }, "agent")).error.code, "unknown_case");
  const plain = await makeApp();
  const r = await plain.invoke("read_thread", R104, "agent");
  assert.deepEqual([r.ok, r.result.messages], [true, []]);
});

test("draft_reply writes an exchange offer from the reading's own numbers, and never sends it", async () => {
  const duo = await makeChatDuo();
  await request(duo);
  await resolve104(duo.desk);
  const sentBefore = duo.server.log.length;
  const r = await draft(duo.desk, { ...R104, kind: "exchange_offer", evidence: evidence104 });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const d = r.result.draft;
  assert.match(d.draftId, /^d_[0-9a-f]{8}_01$/, "a draft id carries this tab's own tag");
  assert.deepEqual([d.kind, d.resolution, d.shadeCode, d.type, d.sent], ["exchange_offer", "exchange", "245W", TYPES.OFFER, null]);
  assert.match(d.text, /245W 2\.10, 250W 3\.51, 220N 5\.00/, "the three closest shades with their ΔE00");
  assert.match(d.text, /exchange it for 245W/);
  assert.match(d.text, /± 1\.0/);
  assert.match(d.text, /Accept/);
  assert.deepEqual(d.basedOn, { messageId: messagesOf(duo.desk, "R-104")[0].messageId, sentTime: SERVER_EPOCH });
  assert.match(d.fingerprint, /^[0-9a-f]{16}$/);
  assert.equal(duo.server.log.length, sentBefore, "a draft never reaches the chat service");
  assert.equal(messagesOf(duo.desk, "R-104").length, 1, "nor the thread");
  assert.equal(duo.desk.store.state.replyDrafts.length, 1);
});

test("draft_reply takes no free text: a text field is a smuggled field, refused and logged", async () => {
  const duo = await makeChatDuo();
  await request(duo);
  await resolve104(duo.desk);
  const r = await draft(duo.desk, { ...R104, kind: "exchange_offer", evidence: evidence104, text: "Free refund, no questions asked" });
  assert.equal(r.error.code, "smuggled_field");
  assert.deepEqual(r.error.fields, ["text"]);
  const log = duo.desk.store.state.activityLog.at(-1);
  assert.deepEqual([log.tool, log.result, log.code, log.fields], ["draft_reply", "refused", "smuggled_field", ["text"]]);
  assert.equal(duo.desk.store.state.replyDrafts.length, 0);
});

test("draft_reply refuses evidence that is not the reading's: each figure within 0.05, the same shades, the band, the shade", async () => {
  const duo = await makeChatDuo();
  await request(duo);
  await resolve104(duo.desk);
  const ev = (patch) => ({ ...evidence104, ...patch });
  const bad = async (patch) => (await draft(duo.desk, { ...R104, kind: "exchange_offer", evidence: ev(patch) })).error?.code;
  assert.equal(await bad({ deltaE: { "245W": 2.0, "250W": 3.51, "220N": 5.0 } }), "evidence_mismatch", "0.1 off");
  assert.equal(await bad({ deltaE: { "245W": 2.1, "250W": 3.51 } }), "evidence_mismatch", "a shade the text lists is not cited");
  assert.equal(await bad({ deltaE: { "245W": 2.1, "250W": 3.51, "220N": 5.0, "310W": 1.0 } }), "evidence_mismatch", "a shade the reading never ranked");
  assert.equal(await bad({ band: 2 }), "evidence_mismatch");
  assert.equal(await bad({ shadeCode: "250W" }), "evidence_mismatch", "an exchange for a shade the draft doesn't name");
  assert.equal(await bad({ extra: 1 }), "evidence_mismatch", "a field the evidence doesn't define");
  assert.equal((await draft(duo.desk, { ...R104, kind: "exchange_offer", evidence: ev({ deltaE: { "245W": 2.14, "250W": 3.5, "220N": 5.04 } }) })).ok, true, "within 0.05 is accepted");
  assert.equal(duo.desk.store.state.replyDrafts.length, 1, "only the matching one was written");
});

test("draft_reply: a check invite when there is no reading, and only then", async () => {
  const duo = await makeChatDuo({ shopperIndex: 1 });
  await request(duo, 1);
  const r = await draft(duo.desk, { caseId: "R-107", kind: "check_invite", evidence: {} });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.deepEqual([r.result.draft.type, r.result.draft.resolution, r.result.draft.shadeCode], [TYPES.NOTE, null, undefined]);
  assert.match(r.result.draft.text, /Check my shade/);
  assert.match(r.result.draft.text, /only ever receive numbers/);
  assert.equal((await draft(duo.desk, { caseId: "R-107", kind: "check_invite", evidence: { band: 1 } })).error.code, "evidence_mismatch", "an invite cites no numbers");
  assert.equal((await draft(duo.desk, { caseId: "R-107", kind: "exchange_offer", evidence: evidence104 })).error.code, "no_reading", "an exchange needs a reading");
  // With a reading on the case, the invite is refused.
  const d104 = await makeChatDuo();
  await request(d104);
  assert.equal((await draft(d104.desk, { ...R104, kind: "check_invite", evidence: {} })).error.code, "reading_exists");
});

test("draft_reply needs the resolution drafted first, and the kind must match what the reading supports", async () => {
  const duo = await makeChatDuo();
  await request(duo);
  assert.equal((await draft(duo.desk, { ...R104, kind: "exchange_offer", evidence: evidence104 })).error.code, "no_resolution_draft");
  await resolve104(duo.desk);
  assert.equal((await draft(duo.desk, { ...R104, kind: "sample_offer", evidence: { ...evidence104, shadeCode: "skin-tint-duo" } })).error.code, "reading_does_not_support_exchange", "the reading says swap, not a sample");
  assert.equal((await draft(duo.desk, { ...R104, kind: "refund_offer", evidence: { reason: "no_match", deltaE: evidence104.deltaE, band: 1 } })).error.code, "reading_supports_exchange");
});

test("draft_reply: a sample offer when two shades are too close to call, a refund offer when no shade fits", async () => {
  const duo = await makeChatDuo({ shopperIndex: 1 });
  await request(duo, 1);
  await readingFor(duo, 1, labBetween("245W", "250W"));
  const rc = duo.desk.store.getCase("R-107");
  assert.equal(rc.reading.draftDecision, "sample_duo", JSON.stringify(rc.reading));
  const de = Object.fromEntries(rc.reading.ranking.map((r) => [r.code, r.de00]));
  const res = await duo.desk.invoke("draft_return_resolution", { caseId: "R-107", resolution: "exchange", shadeCode: "skin-tint-duo", evidence: { deltaE: Object.fromEntries(["220N", ...rc.reading.recommended].map((c) => [c, de[c]])) } }, "agent");
  assert.equal(res.ok, true, JSON.stringify(res.error));
  const sample = await draft(duo.desk, { caseId: "R-107", kind: "sample_offer", evidence: { shadeCode: "skin-tint-duo", deltaE: de, band: 1 } });
  assert.equal(sample.ok, true, JSON.stringify(sample.error));
  assert.match(sample.result.draft.text, /too close to call/);
  assert.match(sample.result.draft.text, /two-shade sample \(skin-tint-duo\)/);

  const far = await makeChatDuo({ shopperIndex: 1 });
  await request(far, 1);
  await readingFor(far, 1, [20, 0, 0]);
  const rc2 = far.desk.store.getCase("R-107");
  assert.equal(rc2.reading.draftDecision, "no_match");
  const refund = await far.desk.invoke("draft_return_resolution", { caseId: "R-107", resolution: "refund", evidence: { reason: "no_match" } }, "agent");
  assert.equal(refund.ok, true, JSON.stringify(refund.error));
  const de2 = Object.fromEntries(rc2.reading.ranking.map((r) => [r.code, r.de00]));
  const offer = await draft(far.desk, { caseId: "R-107", kind: "refund_offer", evidence: { reason: "no_match", deltaE: de2, band: 1 } });
  assert.equal(offer.ok, true, JSON.stringify(offer.error));
  assert.deepEqual([offer.result.draft.resolution, offer.result.draft.type], ["refund", TYPES.OFFER]);
  assert.match(offer.result.draft.text, /No shade of Skin Tint \(fictional\) is within ΔE00 6\.0/);
  assert.equal((await draft(far.desk, { caseId: "R-107", kind: "refund_offer", evidence: { reason: "returned_shade_is_closest", deltaE: de2, band: 1 } })).error.code, "evidence_mismatch", "the reason is the resolution's");
});

test("draft_reply's fingerprint covers its text, its evidence and the thread's newest message", async () => {
  const duo = await makeChatDuo();
  await request(duo);
  await resolve104(duo.desk);
  const a = (await draft(duo.desk, { ...R104, kind: "exchange_offer", evidence: evidence104 })).result.draft;
  const b = (await draft(duo.desk, { ...R104, kind: "exchange_offer", evidence: evidence104 })).result.draft;
  assert.equal(a.fingerprint, b.fingerprint, "same text, evidence and thread, same fingerprint");
  assert.notEqual(a.draftId, b.draftId);
  await duo.shopperTransport.send({ toUserId: duo.seat.deskUserId, type: TYPES.NOTE, content: { visit: "visit-a", caseId: "R-104", text: "is 250W any closer?" } });
  await duo.settle();
  const c = (await draft(duo.desk, { ...R104, kind: "exchange_offer", evidence: evidence104 })).result.draft;
  assert.notEqual(c.fingerprint, a.fingerprint, "a new message in the thread changes it");
  assert.equal(c.basedOn.messageId, messagesOf(duo.desk, "R-104").at(-1).messageId);
});

test("draft_reply refuses a closed case, and an unknown one", async () => {
  const duo = await makeChatDuo();
  await request(duo);
  await resolve104(duo.desk);
  assert.equal((await draft(duo.desk, { caseId: "R-999", kind: "check_invite", evidence: {} })).error.code, "unknown_case");
  duo.desk.store.getCase("R-104").status = "exchange_approved";
  assert.equal((await draft(duo.desk, { ...R104, kind: "exchange_offer", evidence: evidence104 })).error.code, "case_closed");
});

test("the thread tools describe what they do and what they do NOT do, for someone who can't see the screen", () => {
  for (const name of ["read_thread", "draft_reply"]) {
    const t = listTools().find((x) => x.name === name);
    assert.match(t.description, /Does NOT/);
    assert.ok(t.description.length > 300, `${name} is too thin`);
    for (const spec of Object.values(t.args)) assert.ok(spec.description);
  }
  const d = listTools().find((x) => x.name === "draft_reply").description;
  assert.match(d, /never reaches/i);
  assert.match(d, /free text/i);
  assert.match(rankShades.name, /rankShades/);
});

test("the agent has no Nexconn user and no token: no tool takes one, and no tool answer or draft carries a user id", async () => {
  for (const t of listTools()) {
    for (const arg of Object.keys(t.args)) assert.doesNotMatch(arg, /user|token|secret|appkey/i, `${t.name}.${arg}`);
  }
  const duo = await makeChatDuo();
  await request(duo);
  await resolve104(duo.desk);
  const answers = [
    await duo.desk.invoke("read_thread", R104, "agent"),
    await duo.desk.invoke("draft_reply", { ...R104, kind: "exchange_offer", evidence: evidence104 }, "agent"),
    await duo.desk.invoke("list_return_cases", {}, "agent"),
  ];
  assert.ok(answers.every((a) => a.ok));
  const text = JSON.stringify(answers);
  const ids = duo.server.seats.flatMap((s) => [s.deskUserId, ...s.shoppers.map((p) => p.userId)]);
  for (const id of ids) assert.equal(text.includes(id), false, `an answer carries ${id}`);
  assert.equal(/token/i.test(text), false);
  assert.equal(JSON.stringify(duo.desk.store.state.replyDrafts).includes("fakedesk"), false, "nor does a draft");
});
