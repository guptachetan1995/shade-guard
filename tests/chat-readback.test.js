// readBack: the one way a thread is read from the channel (S0b review G2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeChatServer } from "../src/chat/fake-transport.js";
import { MAX_PAGES, readBack } from "../src/chat/history.js";
import { PAGE_SIZE } from "../src/chat/transport.js";
import { registrationObjects, TYPES } from "../src/chat/messages.js";

async function channelOf(count, { strictTimes = true } = {}) {
  const server = new FakeChatServer({ clock: () => 1_000, strictTimes });
  const [seat] = server.seats;
  const shopper = server.transport(seat.shoppers[0].userId);
  const desk = server.transport(seat.deskUserId);
  for (const t of [shopper, desk]) {
    t.registerCustomMessages(registrationObjects());
    await t.connect();
  }
  const sent = [];
  for (let i = 0; i < count; i++) sent.push(await shopper.send({ toUserId: seat.deskUserId, type: TYPES.NOTE, content: { visit: "v", caseId: "R-104", text: `m${i}` } }));
  return { server, seat, desk, withUserId: seat.shoppers[0].userId, sent };
}

test("readBack pages newest first by a cursor, once per message, to the start of history", async () => {
  const { desk, withUserId, sent } = await channelOf(45);
  const read = await readBack(desk, withUserId);
  assert.equal(read.reached, "start");
  assert.deepEqual(read.messages.map((m) => m.messageId), sent.map((m) => m.messageId).reverse());
});

test("readBack stops at the page that reaches its anchor, and not before", async () => {
  const { desk, withUserId, sent } = await channelOf(45);
  const reads = [];
  const spy = new Proxy(desk, { get: (t, k) => (k === "newest" ? (a) => (reads.push(a), t.newest(a)) : t[k].bind(t)) });
  const anchor = sent[30]; // 14 messages are newer than it: one page reaches it
  const near = await readBack(spy, withUserId, { anchor });
  assert.deepEqual([near.reached, reads.length], ["anchor", 1]);
  reads.length = 0;
  const far = await readBack(spy, withUserId, { anchor: sent[5] }); // 39 newer: three pages
  assert.deepEqual([far.reached, reads.length], ["anchor", 2]);
  assert.ok(far.messages.some((m) => m.messageId === sent[5].messageId));
  assert.equal(reads[1].before.messageId, far.messages[PAGE_SIZE - 1].messageId, "the cursor is the previous page's oldest message");
});

test("readBack says capped when neither the start nor the anchor was reached within its page budget", async () => {
  const { desk, withUserId } = await channelOf(45);
  const read = await readBack(desk, withUserId, { maxPages: 2 });
  assert.deepEqual([read.reached, read.messages.length], [null, 2 * PAGE_SIZE]);
});

test("the page budget is 25 pages of 20, so a thread read goes back through 500 messages", () => {
  assert.deepEqual([MAX_PAGES, PAGE_SIZE, MAX_PAGES * PAGE_SIZE], [25, 20, 500]);
});
