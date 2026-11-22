// Server-time ties (S0b review): every gate compares in the total order (sentTime, messageId) that
// byServerTime defines, so two messages in the same server millisecond are still ordered, and a
// gate never misreads one as "not after" the other. Whether Nexconn can repeat a millisecond is
// UNVERIFIED; these tests make the fake do it on every message.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TYPES } from "../src/chat/messages.js";
import { acceptanceOf, emptyThread, insertMessage, recomputeCrossed } from "../src/threads.js";
import { agentDrafts, makeChatDuo, messagesOf, newestIdOf, offerSent, R104, shopperAccepts, shopperRequests, staffSendsDraft, wrapTransport } from "./chat-helpers.js";

const allTied = { serverOptions: { strictTimes: false } };

test("on a server that gives every message the same millisecond, the walk still works: her Accept is found and the approval goes", async () => {
  const duo = await makeChatDuo(allTied);
  const { sent } = await offerSent(duo);
  const accepted = await shopperAccepts(duo, { draftId: duo.desk.store.state.replyDrafts[0].draftId });
  assert.equal(accepted.sentTime, sent.sentTime, "the same millisecond as the offer");
  const r = await duo.desk.invoke("approve_exchange", { ...R104, seen: newestIdOf(duo.desk) }, "staff");
  assert.equal(r.ok, true, JSON.stringify(r.error));
});

test("a shopper message in the same millisecond as her Accept, with a later id, is after it", async () => {
  const duo = await makeChatDuo(allTied);
  const { draft } = await offerSent(duo);
  const accepted = await shopperAccepts(duo, draft);
  const screen = newestIdOf(duo.desk);
  const typed = (await duo.shopper.invoke("shopper_send", { kind: "note", text: "sorry, keep my order" }, "shopper")).result;
  assert.equal(typed.sentTime, accepted.sentTime);
  const r = await duo.desk.invoke("approve_exchange", { ...R104, seen: screen }, "staff");
  assert.deepEqual([r.error?.code, r.error?.messageId], ["thread_moved", typed.messageId]);
  assert.equal(duo.desk.store.getCase("R-104").status, "drafted");
});

test("the screen's `seen` is a place in the total order: a message with its own time and a later id is not shown by it", async () => {
  const duo = await makeChatDuo(allTied);
  await shopperRequests(duo);
  const seen = newestIdOf(duo.desk);
  const typed = (await duo.shopper.invoke("shopper_send", { kind: "note", text: "one more thing" }, "shopper")).result;
  await duo.settle();
  const r = await duo.desk.invoke("staff_note", { ...R104, text: "hello", seen }, "staff");
  assert.deepEqual([r.error?.code, r.error?.messageId], ["thread_moved", typed.messageId]);
});

test("crossed is decided in the total order too: a shopper message in the desk's own millisecond, between its seen id and its send, is flagged", async () => {
  let duo;
  let crossing;
  duo = await makeChatDuo({
    ...allTied,
    deskTransport: (t) =>
      wrapTransport(t, {
        send: async (args) => {
          if (args.type === TYPES.OFFER) crossing = (await duo.shopperTransport.send({ toUserId: duo.seat.deskUserId, type: TYPES.NOTE, content: { visit: "visit-a", caseId: "R-104", text: "actually 250W" } }));
          return t.send(args);
        },
      }),
  });
  await shopperRequests(duo);
  const draft = await agentDrafts(duo);
  const r = await staffSendsDraft(duo, draft);
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(crossing.sentTime, r.result.sentTime, "the same millisecond");
  assert.deepEqual(r.result.crossed, [crossing.messageId]);
});

test("acceptanceOf and recomputeCrossed order by server time and then message id, whatever order messages were inserted in", () => {
  const msg = (messageId, sentTime, sender, type, content = {}, extra = {}) => ({ messageId, sentTime, sender, type, content, ...extra });
  const offer = msg("fm_2", 100, "staff", TYPES.OFFER, { draftId: "d_01" });
  const before = msg("fm_1", 100, "shopper", TYPES.OFFER_ACCEPTED, { draftId: "d_01" }); // same ms, lower id: before the offer
  const after = msg("fm_3", 100, "shopper", TYPES.OFFER_ACCEPTED, { draftId: "d_01" });
  const t1 = emptyThread("R-104", "u");
  for (const m of [after, offer, before]) insertMessage(t1, m);
  assert.equal(acceptanceOf(t1, offer)?.messageId, "fm_3", "only the acceptance with the later id counts");
  const t2 = emptyThread("R-104", "u");
  insertMessage(t2, offer);
  insertMessage(t2, before);
  assert.equal(acceptanceOf(t2, offer), null, "an acceptance that sorts before the offer is not an acceptance of it");

  const seen = msg("fm_10", 200, "shopper", TYPES.NOTE);
  const crossing = msg("fm_11", 200, "shopper", TYPES.NOTE);
  const staff = msg("fm_12", 200, "staff", TYPES.NOTE, {}, { seenThrough: { sentTime: 200, messageId: "fm_10" } });
  const t3 = emptyThread("R-104", "u");
  for (const m of [staff, seen, crossing]) insertMessage(t3, m);
  assert.deepEqual(recomputeCrossed(t3).map((c) => c.shopperMessageId), ["fm_11"], "the message the desk had seen is not crossed, the one after it is");
});

test("messagesOf stays in total order on a tied server", async () => {
  const duo = await makeChatDuo(allTied);
  await offerSent(duo);
  const ids = messagesOf(duo.desk, "R-104").map((m) => m.messageId);
  assert.deepEqual(ids, [...ids].sort());
});
