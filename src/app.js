// Wires one store, one provider and the one chokepoint together. This is the only module that
// sees both the agent's tools and the human-only verbs.
import { createStore, DEFAULT_UNIT_CAP_PER_CHECK } from "./store.js";
import { createInvoke } from "./invoke.js";
import { TOOLS, listTools } from "./tools.js";
import { HUMAN_VERBS } from "./human-verbs.js";
import { assertProvider, loadFeatureCosts } from "./providers/provider.js";
import { loadFixtures } from "./fixtures.js";
import { assertChatTransport, hasUnreadCounts, STATUS } from "./chat/transport.js";
import { readBack } from "./chat/history.js";
import { VISIT_PATTERN } from "./chat/messages.js";
import { markGap, markRead } from "./threads.js";
import { registrationObjects } from "./chat/messages.js";
import { sessionFor } from "./chat/seats.js";

// How long the desk waits for the chat service's unread count or clear before it shows its own count.
export const UNREAD_TIMEOUT_MS = 5_000;

// The promise's value, or `fallback` once timeoutMs has passed (the late answer is then ignored).
function within(promise, timeoutMs, fallback) {
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), timeoutMs);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

// chat: { transport, seat, side: "desk" | "shopper", as, visit } wires one side of one seat to a
// chat transport (the fake in tests and the offline walk, the Nexconn adapter in the browser).
// The transport reaches the app in two ways only: human verbs hold it in their context, and its
// inbound messages are recorded by the nexconn actor through invoke().
export async function createApp({ provider, unitCapPerCheck = DEFAULT_UNIT_CAP_PER_CHECK, now, wait, fixtures = loadFixtures(), chat = null }) {
  assertProvider(provider);
  if (chat && !(typeof chat.visit === "string" && VISIT_PATTERN.test(chat.visit))) {
    throw new RangeError("chat.visit must be 1-64 letters, digits, dashes or underscores.");
  }
  const session = chat ? { ...sessionFor({ seat: chat.seat, side: chat.side, as: chat.as }), visit: chat.visit } : null;
  const store = createStore({ ...fixtures, unitCapPerCheck, now, chat: session });
  const costs = await loadFeatureCosts(provider);
  const transport = chat ? assertChatTransport(chat.transport) : null;
  const invoke = createInvoke({ store, provider, tools: TOOLS, verbs: HUMAN_VERBS, costs, chat: transport, wait });
  const app = { store, provider, costs, invoke, listTools, chat: null };
  if (transport) app.chat = wireChat({ store, invoke, transport, session });
  return app;
}

function wireChat({ store, invoke, transport, session }) {
  let inbound = Promise.resolve();
  const listeners = new Set();
  const changed = () => {
    for (const fn of listeners) fn();
  };
  // A message of another visit is not this visit's to record: the channel is shared by every visit
  // of the seat, and anyone holding the seat's tokens can write to it. record_inbound drops it too;
  // filtering here keeps a flood out of the chokepoint's queue, the activity log and the redraws. It
  // is counted and nothing else, so its content is never held.
  const record = (m) => {
    if (m?.content?.visit !== session.visit) {
      store.state.chat.otherVisitDropped += 1;
      return inbound;
    }
    const args = { messageId: m.messageId, type: m.type, senderUserId: m.senderUserId, sentTime: m.sentTime, content: m.content };
    inbound = inbound.then(() => invoke("record_inbound", args, "nexconn")).catch(() => {});
    inbound = inbound.then(changed);
    return inbound;
  };
  // An automatic reconnect: the transport reports connected again after having been connected, without
  // the page calling connect() (the SDK's suspended connection retries by itself). Messages sent while
  // it was away may never reach onMessage, so each thread is read back through restore(), with the same
  // budgets; a reconnect during connect()'s own restore is read back once that restore ends.
  let wasConnected = false;
  let connecting = false;
  let missed = false;
  let catchingUp = Promise.resolve();
  const catchUp = () => {
    catchingUp = catchingUp.then(restore).catch(() => {});
    return catchingUp;
  };
  const setConnection = (status) => {
    const before = store.state.chat.connection.state;
    store.state.chat.connection = { state: status.state, code: status.code ?? null, detail: status.detail ?? null };
    if (status.state === STATUS.CONNECTED && before !== STATUS.CONNECTED) {
      if (wasConnected && connecting) missed = true;
      else if (wasConnected) catchUp();
      wasConnected = true;
    }
    changed();
  };
  transport.registerCustomMessages(registrationObjects());
  transport.onStatus(setConnection);
  transport.onMessage(record);
  // Another connection of this user marked a channel read: the page reads the counts again.
  transport.onUnreadChange?.(changed);
  setConnection(transport.status());

  const peerOfCase = (caseId) => Object.entries(session.peers).find(([, p]) => p.caseId === caseId)?.[0] ?? null;
  const unreadReady = () => hasUnreadCounts(transport) && store.state.chat.connection.state === STATUS.CONNECTED;

  // After a connect, the threads come back from the service's history, oldest first, through
  // the same record_inbound a live message uses. Each channel is read back page by page to its
  // start or to the page budget (another visit's messages are skipped, not counted against it
  // beyond the pages they fill); a channel longer than the budget leaves the thread showing its
  // newest part and flagged historyTruncated. A read that fails leaves the thread empty and the
  // first send reads it again (thread_unverified when it still cannot).
  //
  // A read that stops at the budget short of a read point the mirror already had (a catch-up after a
  // reconnect, or any later call) missed messages in the middle, not older history: readThrough stays
  // where it was (so every staff send still refuses as thread_unverified until a read reaches back past
  // the gap) and the thread is flagged readGap. Moving readThrough there would let a send go out over a
  // message of this visit that no read ever reached (the 17 Nov review's repros). Only a thread with no
  // read point yet (the first restore of this tab) takes the newest part as its history, truncated.
  async function restore() {
    for (const [userId, peer] of Object.entries(session.peers)) {
      if (!peer.caseId) continue;
      const thread = store.state.threads[peer.caseId];
      let read;
      try {
        read = await readBack(transport, userId, { anchor: thread.readThrough });
      } catch {
        continue;
      }
      for (const m of [...read.messages].reverse()) await record(m);
      if (read.reached === null && thread.readThrough !== null) markGap(thread);
      else markRead(thread, read.messages, { truncated: read.reached === null });
      changed();
    }
  }

  return {
    transport,
    async connect() {
      connecting = true;
      try {
        const status = await transport.connect();
        setConnection(status);
        missed = false;
        if (status.state === STATUS.CONNECTED) await restore();
        while (missed) {
          missed = false;
          await restore();
        }
        return status;
      } finally {
        connecting = false;
      }
    },
    restore,
    // Resolves once the catch-up reads started by automatic reconnects so far have ended.
    caughtUp: () => catchingUp,
    // The chat service's own unread count for each case's channel, { [caseId]: count }, holding only
    // the channels the service listed; null when the transport has no unread counts, is not connected,
    // or could not read them (the desk then shows its own count). The count is the channel's, so every
    // visit on the seat adds to it.
    async unreadCounts({ timeoutMs = UNREAD_TIMEOUT_MS } = {}) {
      if (!unreadReady()) return null;
      const peers = Object.entries(session.peers).filter(([, p]) => p.caseId);
      let byPeer;
      try {
        byPeer = await within(transport.unreadCounts(peers.map(([u]) => u)), timeoutMs, null);
      } catch {
        return null;
      }
      if (byPeer === null) return null;
      const out = {};
      for (const [u, p] of peers) if (Number.isInteger(byPeer?.[u]) && byPeer[u] >= 0) out[p.caseId] = byPeer[u];
      return out;
    },
    // Marks a case's channel read on the service. true when the service took it in time.
    async clearUnread(caseId, { timeoutMs = UNREAD_TIMEOUT_MS } = {}) {
      const peer = peerOfCase(caseId);
      if (!peer || !unreadReady()) return false;
      try {
        return await within(
          transport.clearUnread(peer).then(() => true),
          timeoutMs,
          false,
        );
      } catch {
        return false;
      }
    },
    // Resolves once every message handed to the app so far has been recorded.
    settled: () => inbound,
    // fn() runs after every inbound message and every connection change, so a page can redraw.
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
