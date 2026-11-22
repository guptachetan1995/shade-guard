// A connection the service takes away mid-session, and a service that echoes a user's own messages back
// (S0b review): both are things the real service may do that the fake never did.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TYPES } from "../src/chat/messages.js";
import { STATUS } from "../src/chat/transport.js";
import { connectionBar } from "../public/chat/common.js";
import { agentDrafts, makeChatDuo, messagesOf, newestIdOf, R104, shopperRequests, staffSendsDraft, wrapTransport } from "./chat-helpers.js";

test("a kick: the service takes the seat from a connected desk, which then says seat busy, offers another seat, and sends nothing", async () => {
  const duo = await makeChatDuo();
  await shopperRequests(duo);
  const draft = await agentDrafts(duo);
  assert.equal(duo.desk.store.state.chat.connection.state, STATUS.CONNECTED);
  duo.server.kick(duo.seat.deskUserId, "another connection took this seat");
  const c = duo.desk.store.state.chat.connection;
  assert.deepEqual([c.state, c.detail], [STATUS.BUSY, "another connection took this seat"]);
  assert.match(connectionBar(c, duo.deskTransport.describe()), /another-seat/);
  const before = duo.server.log.length;
  assert.equal((await staffSendsDraft(duo, draft)).error.code, "chat_offline");
  assert.equal((await duo.desk.invoke("staff_note", { ...R104, text: "hi", seen: newestIdOf(duo.desk) }, "staff")).error.code, "chat_offline");
  assert.equal(duo.server.log.length, before);
  assert.equal(duo.server.connectionCount(duo.seat.deskUserId), 0, "the kicked connection is gone from the service");
  // The other side is untouched, and the seat can be taken again.
  assert.equal(duo.shopper.store.state.chat.connection.state, STATUS.CONNECTED);
  assert.equal((await duo.deskTransport.connect()).state, STATUS.CONNECTED);
});

test("a kicked polling client (the offline walk's pages) is told why on its next poll", async () => {
  const { createFakeChatRoutes } = await import("../src/chat/fake-http.js");
  const { FakeChatServer } = await import("../src/chat/fake-transport.js");
  const server = new FakeChatServer();
  const routes = createFakeChatRoutes(server);
  const user = server.seats[0].deskUserId;
  const connected = await routes.handle("POST", "/api/fake-chat/connect", { userId: user, registered: [] });
  const connectionId = connected.body.connectionId;
  assert.equal((await routes.handle("GET", `/api/fake-chat/poll?connectionId=${connectionId}`)).status, 200);
  assert.equal((await routes.handle("POST", "/api/fake-chat/control", { action: "kick", userId: user })).status, 200);
  const gone = await routes.handle("GET", `/api/fake-chat/poll?connectionId=${connectionId}`);
  assert.deepEqual([gone.status, gone.body.error.code, gone.body.error.state], [410, "gone", STATUS.BUSY]);
});

// An SDK may deliver a user's own message to its own onMessage handler as well as resolving send().
function echoing(t) {
  const handlers = new Set();
  return wrapTransport(t, {
    onMessage: (fn) => {
      handlers.add(fn);
      const off = t.onMessage(fn);
      return () => {
        handlers.delete(fn);
        off();
      };
    },
    send: async (args) => {
      const m = await t.send(args);
      for (const h of handlers) h(structuredClone(m)); // the echo arrives before send() has resolved to its caller
      return m;
    },
  });
}

test("a service that echoes the desk's own message before send() resolves: the verb's copy is the one held, so own and seenThrough stay and crossed still works", async () => {
  let duo;
  let crossing;
  duo = await makeChatDuo({
    deskTransport: (t) => {
      const e = echoing(t);
      const send = e.send;
      return Object.assign(e, {
        send: async (args) => {
          if (args.type === TYPES.OFFER) crossing = await duo.shopperTransport.send({ toUserId: duo.seat.deskUserId, type: TYPES.NOTE, content: { visit: "visit-a", caseId: "R-104", text: "actually 250W" } });
          return send(args);
        },
      });
    },
  });
  await shopperRequests(duo);
  const draft = await agentDrafts(duo);
  const r = await staffSendsDraft(duo, draft);
  assert.equal(r.ok, true, JSON.stringify(r.error));
  await duo.desk.chat.settled();
  const held = messagesOf(duo.desk, "R-104").filter((m) => m.messageId === r.result.messageId);
  assert.equal(held.length, 1, "one copy, not two");
  assert.equal(held[0].own, true);
  assert.equal(typeof held[0].seenThrough.sentTime, "number");
  assert.deepEqual(r.result.crossed, [crossing.messageId]);
});
