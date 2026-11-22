// The bounds on what a message may carry (S0b review): a reading is the shopper's own unauthenticated
// numbers, so every number has a range and every string a length; nothing is sent that the desk's own
// table would refuse; and the figures an offer carries are the reading's, not the agent's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { FakeYouCamProvider } from "../src/providers/youcam-fake.js";
import { FakeChatServer } from "../src/chat/fake-transport.js";
import { MAX_TEXT, TYPES, validateContent } from "../src/chat/messages.js";
import { DECISIONS } from "../src/rules/recommend.js";
import { EV104, makeChatDuo, R104, shopperRequests, SERVER_EPOCH } from "./chat-helpers.js";

const reading = (over = {}) => ({ visit: "v", caseId: "R-107", lab: [64.2, 13.4, 19.6], hueAngle: 55.7, band: 1, lighting: "good", ...over });
const ok = (type, content, sender) => validateContent(type, content, sender).ok;

test("a reading's numbers have ranges: lab, hue and band, with the edges inside and the first step outside refused", () => {
  const r = (over) => ok(TYPES.READING, reading(over), "shopper");
  assert.equal(r({}), true);
  for (const lab of [[0, -200, -200], [100, 200, 200], [50, 0, 0]]) assert.equal(r({ lab }), true, `edge ${lab}`);
  for (const lab of [[-0.01, 0, 0], [100.01, 0, 0], [50, 200.01, 0], [50, 0, -200.01], [1e200, 1e200, 1e200], [-5000, 0, 0], [Number.NaN, 0, 0], [Infinity, 0, 0]]) assert.equal(r({ lab }), false, `out ${lab}`);
  for (const hueAngle of [0, 360]) assert.equal(r({ hueAngle }), true, `edge hue ${hueAngle}`);
  for (const hueAngle of [-0.01, 360.01, 1e300, Number.NaN]) assert.equal(r({ hueAngle }), false, `hue ${hueAngle}`);
  for (const band of [0.1, 1, 1.5, 10]) assert.equal(r({ band }), true, `band ${band}`);
  for (const band of [0, 0.09, -1, 10.01, 1e300, 1e-300, Number.NaN]) assert.equal(r({ band }), false, `band ${band}`);
  assert.equal(r({ lighting: "x".repeat(33) }), false, "lighting is a short label");
  assert.equal(r({ lighting: null }), true);
});

test("every id and label has a length, and the close reason is one of staff's three", () => {
  const long = "x".repeat(65);
  assert.equal(ok(TYPES.NOTE, { visit: "v", caseId: long, text: "hi" }, "shopper"), false);
  assert.equal(ok(TYPES.NOTE, { visit: long, text: "hi" }, "shopper"), false);
  assert.equal(ok(TYPES.RETURN_REQUEST, { visit: "v", caseId: "R-104", orderId: long, reason: "wrong shade" }, "shopper"), false);
  assert.equal(ok(TYPES.RETURN_REQUEST, { visit: "v", caseId: "R-104", orderId: "O-5521", reason: "x".repeat(MAX_TEXT + 1) }, "shopper"), false, "the 1.9 MB reason");
  assert.equal(ok(TYPES.RETURN_REQUEST, { visit: "v", caseId: "R-104", orderId: "O-5521", reason: "x".repeat(MAX_TEXT) }, "shopper"), true);
  assert.equal(ok(TYPES.OFFER_ACCEPTED, { visit: "v", caseId: "R-104", draftId: long }, "shopper"), false);
  const offer = (over) => ({ visit: "v", caseId: "R-104", draftId: "d_01", text: "t", resolution: "exchange", shadeCode: "245W", deltaE: { "245W": 2.1 }, ...over });
  assert.equal(ok(TYPES.OFFER, offer({ shadeCode: long }), "staff"), false);
  assert.equal(ok(TYPES.OFFER, offer({ draftId: long }), "staff"), false);
  assert.equal(ok(TYPES.OFFER, offer({ deltaE: { [long]: 1 } }), "staff"), false);
  assert.equal(ok(TYPES.OFFER, offer({ deltaE: { "245W": -1 } }), "staff"), false, "a ΔE00 is not negative");
  assert.equal(ok(TYPES.OFFER, offer({ deltaE: { "245W": 1e9 } }), "staff"), false);
  assert.equal(ok(TYPES.OFFER, offer({ deltaE: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`s${i}`, 1])) }), "staff"), false, "at most sixteen shades");
  assert.equal(ok(TYPES.OFFER, offer({ deltaE: null }), "staff"), true);
  for (const reason of ["resolved", "no_reply", "other"]) assert.equal(ok(TYPES.CASE_CLOSED, { visit: "v", caseId: "R-104", reason }, "staff"), true, reason);
  assert.equal(ok(TYPES.CASE_CLOSED, { visit: "v", caseId: "R-104", reason: "because I said so" }, "staff"), false);
});

test("a hostile reading arriving at the desk is refused, never recorded, and leaves the case waiting", async () => {
  const hostile = {
    huge: { lab: [1e200, 1e200, 1e200], band: 1 },
    "huge band": { lab: [60, 10, 20], band: 1e300 },
    "tiny band": { lab: [60, 10, 20], band: 1e-300 },
    "negative L": { lab: [-5000, 0, 0], band: 1 },
  };
  for (const [name, fields] of Object.entries(hostile)) {
    const duo = await makeChatDuo({ shopperIndex: 1 });
    await duo.shopper.invoke("shopper_send", { kind: "return_request" }, "shopper");
    await duo.settle();
    await duo.shopperTransport.send({ toUserId: duo.seat.deskUserId, type: TYPES.READING, content: { visit: "visit-a", caseId: "R-107", hueAngle: 40, lighting: null, ...fields } });
    duo.server.deliverAll();
    await duo.desk.chat.settled();
    const rcase = duo.desk.store.getCase("R-107");
    assert.equal(rcase.reading ?? null, null, name);
    assert.equal(rcase.status, "awaiting_check", name);
    assert.equal(duo.desk.store.state.threads["R-107"].messages.some((m) => m.type === TYPES.READING), false, `${name} was not recorded`);
    assert.equal(duo.desk.store.state.activityLog.at(-1).code, "bad_content", name);
  }
});

test("every reading the table accepts ranks to finite numbers and a decision the rules know, edges included", async () => {
  const labs = [];
  for (const L of [0, 0.5, 50, 99.5, 100]) for (const a of [-200, -20, 0, 20, 200]) for (const b of [-200, -20, 0, 20, 200]) labs.push([L, a, b]);
  const duo = await makeChatDuo({ shopperIndex: 1 });
  const desk = duo.desk;
  const user = duo.seat.shoppers[1].userId;
  let n = 0;
  for (const lab of labs) {
    for (const [band, hueAngle] of [[0.1, 0], [1, 180], [10, 360]]) {
      const rcase = desk.store.getCase("R-107");
      rcase.status = "awaiting_check";
      rcase.reading = null;
      const r = await desk.invoke("record_inbound", { messageId: `fm_h${n}`, type: TYPES.READING, senderUserId: user, sentTime: SERVER_EPOCH + n++, content: { visit: "visit-a", caseId: "R-107", lab, hueAngle, band, lighting: null } }, "nexconn");
      assert.equal(r.ok, true, `${lab} ${band}: ${JSON.stringify(r.error)}`);
      assert.equal(r.result.applied, true);
      const rd = rcase.reading;
      assert.ok(rd.ranking.every((x) => Number.isFinite(x.de00) && x.de00 >= 0), `${lab}: ${JSON.stringify(rd.ranking)}`);
      assert.ok(DECISIONS.includes(rd.draftDecision), rd.draftDecision);
      assert.equal(JSON.stringify(rd).includes("null,null"), false, "nothing turns to null in a JSON round trip");
    }
  }
  assert.equal(n, 125 * 3);
});

test("visit ids are 1-64 plain characters, checked when the app starts and not after a message has been sent", async () => {
  const server = new FakeChatServer();
  const [seat] = server.seats;
  const mk = (visit) => createApp({ provider: new FakeYouCamProvider(), chat: { transport: server.transport(seat.deskUserId), seat, side: "desk", visit } });
  for (const visit of ["", "v".repeat(65), "has space", "<b>", "a/b", undefined, 42]) {
    await assert.rejects(() => mk(visit), RangeError, String(visit));
  }
  const duo = await makeChatDuo({ visit: "v".repeat(64) });
  assert.equal((await duo.shopper.invoke("shopper_send", { kind: "return_request" }, "shopper")).ok, true, "64 is fine");
});

test("nothing is sent that the table would refuse: the content is checked before the service sees it, so a retry can't pile up copies", async () => {
  const duo = await makeChatDuo();
  duo.shopper.store.getCase("R-104").reason = "x".repeat(MAX_TEXT + 1); // would be a 1.9 MB reason in the wild
  for (let i = 0; i < 2; i++) {
    const r = await duo.shopper.invoke("shopper_send", { kind: "return_request" }, "shopper");
    assert.equal(r.error?.code, "bad_content");
  }
  assert.equal(duo.server.log.length, 0, "not one message reached the service");
  assert.equal(duo.shopper.store.state.threads["R-104"].messages.length, 0);
});

test("the offer carries the reading's own ΔE00 figures, not the agent's, which may differ by up to 0.05", async () => {
  const duo = await makeChatDuo();
  await shopperRequests(duo);
  assert.equal((await duo.desk.invoke("draft_return_resolution", { ...R104, resolution: "exchange", shadeCode: "245W", evidence: { deltaE: { "220N": 5.0, "245W": 2.1 } } }, "agent")).ok, true);
  const cited = { ...EV104, deltaE: { "245W": 2.14, "250W": 3.55, "220N": 4.96 } };
  const d = await duo.desk.invoke("draft_reply", { ...R104, kind: "exchange_offer", evidence: cited }, "agent");
  assert.equal(d.ok, true, JSON.stringify(d.error));
  const draft = d.result.draft;
  assert.match(draft.text, /245W 2\.10, 250W 3\.51, 220N 5\.00/, "the text quotes the reading");
  assert.deepEqual(draft.deltaE, { "245W": 2.1, "250W": 3.51, "220N": 5 }, "and so does the figure the offer will carry");
  assert.deepEqual(draft.evidence.deltaE, cited.deltaE, "the agent's citation stays as the agent wrote it");
  const sent = await duo.desk.invoke("send_reply", { ...R104, draftId: draft.draftId, seen: draft.fingerprint }, "staff");
  assert.equal(sent.ok, true, JSON.stringify(sent.error));
  assert.deepEqual(duo.desk.store.state.threads["R-104"].messages.at(-1).content.deltaE, { "245W": 2.1, "250W": 3.51, "220N": 5 });
});
