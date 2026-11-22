// Draft ids (S0b review, S1 prep): an id names one offer in a thread. Each desk tab tags its ids
// with its own random tag, so two tabs, a reload or a cut-short restore never hand out the same id,
// and an old acceptance never carries over to a newer offer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runPlanner } from "../src/agent/planner.js";
import { createApp } from "../src/app.js";
import { FakeYouCamProvider } from "../src/providers/youcam-fake.js";
import { TYPES } from "../src/chat/messages.js";
import { ChatError } from "../src/chat/transport.js";
import { agentDrafts, EV104, makeChatDuo, messagesOf, newestIdOf, offerSent, R104, shopperAccepts, shopperRequests, staffSendsDraft, wrapTransport } from "./chat-helpers.js";

const offerContent = (draftId, over = {}) => ({
  visit: "visit-a",
  caseId: "R-104",
  draftId,
  text: "We can exchange it for 245W. Tap Accept.",
  resolution: "exchange",
  shadeCode: "245W",
  deltaE: { "245W": 2.1 },
  ...over,
});

test("a desk that reloads does not hand out a draft id already in the restored thread", async () => {
  const duo = await makeChatDuo();
  const { draft } = await offerSent(duo);
  await shopperAccepts(duo, draft);
  const desk2 = await createApp({ provider: new FakeYouCamProvider(), wait: async () => {}, chat: { transport: duo.server.transport(duo.seat.deskUserId), seat: duo.seat, side: "desk", visit: "visit-a" } });
  await desk2.chat.connect();
  await duo.shopper.invoke("shopper_send", { kind: "note", text: "actually, could I have a refund instead?" }, "shopper");
  duo.server.deliverAll();
  await desk2.chat.settled();
  const run = await runPlanner(desk2.invoke, { caseId: "R-104", chat: true });
  assert.equal(run.plan.outcome, "reply:exchange_offer");
  const second = desk2.store.state.replyDrafts.at(-1);
  assert.notEqual(second.draftId, draft.draftId, "a reloaded desk tags its ids anew");
  const sent = await desk2.invoke("send_reply", { ...R104, draftId: second.draftId, seen: second.fingerprint }, "staff");
  assert.equal(sent.ok, true, JSON.stringify(sent.error));
  duo.server.deliverAll();
  await duo.shopper.chat.settled();
  // The new offer is a new offer: she can accept it, and her old Accept does not stand in for it.
  assert.equal((await duo.shopper.invoke("accept_offer", { ...R104, draftId: second.draftId }, "shopper")).ok, true);
  duo.server.deliverAll();
  await desk2.chat.settled();
  const approve = await desk2.invoke("approve_exchange", { ...R104, seen: newestIdOf(desk2) }, "staff");
  assert.equal(approve.ok, true, JSON.stringify(approve.error));
});

test("two tabs of the desk that draft and send inside one round trip never put two offers under one id", async () => {
  const duo = await makeChatDuo();
  await shopperRequests(duo);
  const desk2 = await createApp({ provider: new FakeYouCamProvider(), wait: async () => {}, chat: { transport: duo.server.transport(duo.seat.deskUserId), seat: duo.seat, side: "desk", visit: "visit-a" } });
  await desk2.chat.connect();
  const first = await agentDrafts(duo);
  const r2 = await desk2.invoke("draft_return_resolution", { ...R104, resolution: "exchange", shadeCode: "245W", evidence: { deltaE: { "220N": 5.0, "245W": 2.1 } } }, "agent");
  assert.equal(r2.ok, true, JSON.stringify(r2.error));
  const d2 = await desk2.invoke("draft_reply", { ...R104, kind: "exchange_offer", evidence: EV104 }, "agent");
  assert.equal(d2.ok, true, JSON.stringify(d2.error));
  assert.match(first.draftId, /^d_[0-9a-f]{8}_01$/);
  assert.notEqual(d2.result.draft.draftId, first.draftId, "each tab tags its own ids");
  // Both send before either sees the other's offer: the race no read can close.
  assert.equal((await staffSendsDraft(duo, first)).ok, true);
  assert.equal((await desk2.invoke("send_reply", { ...R104, draftId: d2.result.draft.draftId, seen: d2.result.draft.fingerprint }, "staff")).ok, true);
  await duo.settle();
  const ids = messagesOf(duo.shopper, "R-104").filter((m) => m.type === TYPES.OFFER).map((m) => m.content.draftId);
  assert.equal(ids.length, 2);
  assert.equal(new Set(ids).size, 2, "her Accept of one offer can never name the other");
});

test("a send whose answer was lost, retried, is already_sent and marks the draft sent, with one offer on the service", async () => {
  let lose = true;
  const duo = await makeChatDuo({
    deskTransport: (t) =>
      wrapTransport(t, {
        send: async (m) => {
          const sent = await t.send(m);
          if (lose && m.type === TYPES.OFFER) {
            lose = false;
            throw new ChatError("send_failed", "The service did not answer.");
          }
          return sent;
        },
      }),
  });
  await shopperRequests(duo);
  const draft = await agentDrafts(duo);
  const failed = await staffSendsDraft(duo, draft);
  assert.equal(failed.error?.code, "send_failed");
  assert.match(failed.error.message, /Send the same draft again/, "a new draft would go out as a second offer");
  const again = await staffSendsDraft(duo, draft);
  assert.equal(again.error?.code, "already_sent", "the service already holds this very offer");
  const offers = duo.server.log.filter((m) => m.type === TYPES.OFFER);
  assert.equal(offers.length, 1, "the retry sent nothing");
  const held = duo.desk.store.state.replyDrafts.at(-1);
  assert.equal(held.sent?.messageId, offers[0].messageId, "the desk shows the draft as sent, by the offer the service holds");
  assert.equal((await staffSendsDraft(duo, draft)).error?.code, "already_sent");
});

test("an acceptance placed before an offer that reuses its draft id is not an acceptance of that offer: the approval is not_accepted", async () => {
  const duo = await makeChatDuo();
  await shopperRequests(duo);
  const draft = await agentDrafts(duo);
  // An Accept for the desk's next id lands before that offer exists (a seat token is public, so
  // anyone holding it can send one), then the agent drafts again, having seen it, under that id.
  const next = draft.draftId.replace(/_01$/, "_02");
  await duo.shopperTransport.send({ toUserId: duo.seat.deskUserId, type: TYPES.OFFER_ACCEPTED, content: { visit: "visit-a", caseId: "R-104", draftId: next } });
  await duo.settle();
  const d = await duo.desk.invoke("draft_reply", { ...R104, kind: "exchange_offer", evidence: EV104 }, "agent");
  assert.equal(d.result.draft.draftId, next);
  assert.equal((await staffSendsDraft(duo, d.result.draft)).ok, true);
  await duo.settle();
  const r = await duo.desk.invoke("approve_exchange", { ...R104, seen: newestIdOf(duo.desk) }, "staff");
  assert.equal(r.error?.code, "not_accepted", "the Accept is older than the offer");
  assert.equal(duo.desk.store.getCase("R-104").status, "drafted");
});

test("accept_offer's already_accepted means accepted after this offer: an older Accept of a reused id doesn't count", async () => {
  const duo = await makeChatDuo();
  const to = duo.seat.shoppers[0].userId;
  await duo.deskTransport.send({ toUserId: to, type: TYPES.OFFER, content: offerContent("d_01") });
  await duo.settle();
  assert.equal((await duo.shopper.invoke("accept_offer", { ...R104, draftId: "d_01" }, "shopper")).ok, true);
  await duo.settle();
  assert.equal((await duo.shopper.invoke("accept_offer", { ...R104, draftId: "d_01" }, "shopper")).error.code, "already_accepted");
  // A newer offer under the same id (a desk that lost count): it is a new offer, and she can accept it.
  await duo.deskTransport.send({ toUserId: to, type: TYPES.OFFER, content: offerContent("d_01", { text: "We can exchange it for 245W instead. Tap Accept." }) });
  await duo.settle();
  const again = await duo.shopper.invoke("accept_offer", { ...R104, draftId: "d_01" }, "shopper");
  assert.equal(again.ok, true, JSON.stringify(again.error));
  assert.equal(messagesOf(duo.shopper, "R-104").filter((m) => m.type === TYPES.OFFER_ACCEPTED).length, 2);
  assert.equal((await duo.shopper.invoke("accept_offer", { ...R104, draftId: "d_01" }, "shopper")).error.code, "already_accepted", "and only once");
});

test("send_reply refuses a draft whose id an offer with other terms already carries on the service (draft_id_taken), sends nothing, and the next draft takes a free id", async () => {
  const duo = await makeChatDuo();
  await shopperRequests(duo);
  const draft = await agentDrafts(duo);
  // An offer under this draft's id but with other words is on the service and not yet in this
  // mirror: the desk's token is public, so anyone holding it can send one.
  await duo.deskTransport.send({ toUserId: duo.seat.shoppers[0].userId, type: TYPES.OFFER, content: offerContent(draft.draftId) });
  const before = duo.server.log.length;
  const r = await staffSendsDraft(duo, draft);
  assert.equal(r.error?.code, "draft_id_taken", "two offers under one id would let an Accept of the old card stand for the new one");
  assert.equal(duo.server.log.length, before, "nothing was sent");
  assert.equal(duo.desk.store.state.replyDrafts.at(-1).sent, null, "the draft is not marked sent");
  assert.equal(messagesOf(duo.desk, "R-104").filter((m) => m.type === TYPES.OFFER).length, 1, "the other tab's offer is now on the screen");
  const again = await duo.desk.invoke("draft_reply", { ...R104, kind: "exchange_offer", evidence: EV104 }, "agent");
  assert.equal(again.ok, true, JSON.stringify(again.error));
  assert.notEqual(again.result.draft.draftId, draft.draftId);
  const sent = await staffSendsDraft(duo, again.result.draft);
  assert.equal(sent.ok, true, JSON.stringify(sent.error));
});

test("a check_invite note carries no draft id, so draft_id_taken never applies to it", async () => {
  const duo = await makeChatDuo({ shopperIndex: 1 });
  const r = await duo.shopper.invoke("shopper_send", { kind: "return_request" }, "shopper");
  assert.equal(r.ok, true, JSON.stringify(r.error));
  await duo.settle();
  const caseId = duo.caseId;
  const d = await duo.desk.invoke("draft_reply", { caseId, kind: "check_invite", evidence: {} }, "agent");
  assert.equal(d.ok, true, JSON.stringify(d.error));
  await duo.deskTransport.send({ toUserId: duo.seat.shoppers[1].userId, type: TYPES.OFFER, content: offerContent(d.result.draft.draftId, { caseId }) });
  const sent = await duo.desk.invoke("send_reply", { caseId, draftId: d.result.draft.draftId, seen: d.result.draft.fingerprint }, "staff");
  assert.equal(sent.ok, true, JSON.stringify(sent.error));
});

test("a lost send retried as already_sent still flags a shopper message that crossed it", async () => {
  let lose = true;
  let crossing;
  const duo = await makeChatDuo({
    deskTransport: (t) =>
      wrapTransport(t, {
        send: async (m) => {
          if (!(lose && m.type === TYPES.OFFER)) return t.send(m);
          lose = false;
          crossing = await duo.shopperTransport.send({ toUserId: duo.seat.deskUserId, type: TYPES.NOTE, content: { visit: "visit-a", caseId: "R-104", text: "actually I prefer 250W" } });
          await t.send(m);
          throw new ChatError("send_failed", "The service did not answer.");
        },
      }),
  });
  await shopperRequests(duo);
  const draft = await agentDrafts(duo);
  assert.equal((await staffSendsDraft(duo, draft)).error?.code, "send_failed");
  assert.equal((await staffSendsDraft(duo, draft)).error?.code, "already_sent");
  const thread = duo.desk.store.state.threads["R-104"];
  assert.deepEqual(thread.crossed, [{ shopperMessageId: crossing.messageId, staffMessageId: duo.desk.store.state.replyDrafts.at(-1).sent.messageId }], "sent over a message the desk had not seen");
});
