// The chat transport interface. The Nexconn adapter (written later) and the fake transport
// (tests and the offline walk) both implement it, so the verbs, the tools and the pages never
// learn which one they run on. Browser-safe; this file loads no SDK and makes no network call.
//
// A transport is one connection of one user. It speaks in user ids: `send` names the peer to
// write to, `newest` names the peer whose channel to read. A message is
//   { messageId, type, senderUserId, targetUserId, sentTime, content }
// where messageId and sentTime (ms) are the SERVER's own: the ids and times the app orders and
// compares by, never a local clock.
//
//   registerCustomMessages(registrations)   before connect, once; the registration objects
//   connect()                    → Promise<status>; never throws for an expected failure
//   disconnect()
//   status()                     → { state, code, detail }
//   onStatus(fn) / onMessage(fn) → unsubscribe function (real-time receipt, possibly delayed)
//   send({ toUserId, type, content }) → Promise<message>; rejects ChatError "chat_offline"
//   newest({ withUserId, limit, before? }) → Promise<message[]>, newest first, at most PAGE_SIZE;
//                                   always asks the server; rejects ChatError "read_failed" when it
//                                   can't be reached. Newest is in the total order of (sentTime,
//                                   messageId): two messages may share a server millisecond, and
//                                   their ids then decide. `before` is a cursor, { messageId,
//                                   sentTime } of a message the caller already holds (the oldest
//                                   of the previous page): the page then holds only messages
//                                   strictly older than it. A page shorter than PAGE_SIZE means
//                                   nothing older exists. The caller reads a thread back page by
//                                   page with this (src/chat/history.js); a transport that wraps
//                                   an SDK query implements the cursor by continuing that query.
//                                   UNVERIFIED against the Nexconn SDK until the adapter is probed.
//   describe()                   → { kind, banner, userId, via, pill?, stateWords? }; via is how a
//                                  message's evidence line names the service it crossed. pill, when
//                                  present, is a short label every pane shows beside its connection
//                                  state (the fake sets one); stateWords replaces the words of a state.
//
// Optional (OPTIONAL_TRANSPORT_METHODS): the chat service's own unread counts. A transport without
// them leaves the desk counting unread from what it has shown, and the desk says which count it shows.
//   unreadCounts(peerUserIds)    → Promise<{ [peerUserId]: count }>, this user's unread count of the
//                                  direct channel with each peer, as the service keeps it (every visit
//                                  on the seat shares the channel, so every visit's messages count). A
//                                  peer the service did not list is absent, never a guessed 0. Rejects
//                                  ChatError "chat_offline" when not connected, "read_failed" when the
//                                  service can't be read.
//   clearUnread(peerUserId)      → Promise<void>; marks that channel read on the service, for every
//                                  connection of this user. Rejects "chat_offline" or "clear_failed".
//   onUnreadChange(fn)           → unsubscribe; fn(peerUserId) when another connection of this user
//                                  changed that channel's unread state (the SDK's "synced from another
//                                  device"). A new message is not reported here: it reaches onMessage.
// UNVERIFIED against the Nexconn SDK until the live run; docs/nexconn-notes.md lists each assumption.
//
// Whether onMessage also delivers a message this user sent is UNVERIFIED for the Nexconn SDK (the
// fake never echoes). It does not matter to the app: the verb that sends records its own message
// (with own and seenThrough) while it still holds the chokepoint, and an inbound copy, echo or not,
// is only recorded afterwards, as a duplicate of a message id already held.

export const STATUS = Object.freeze({
  IDLE: "idle",
  CONNECTING: "connecting",
  CONNECTED: "connected",
  OFFLINE: "offline",
  BUSY: "busy",
  SDK_NOT_LOADED: "sdk_not_loaded",
});

// The page size the thread read uses; the docs' createMessagesQuery default is also 20.
export const PAGE_SIZE = 20;
// How many pages one thread read goes back through (src/chat/history.js) before it gives up.
export const MAX_PAGES = 25;

export const TRANSPORT_METHODS = Object.freeze([
  "registerCustomMessages",
  "connect",
  "disconnect",
  "status",
  "onStatus",
  "onMessage",
  "send",
  "newest",
  "describe",
]);

export const OPTIONAL_TRANSPORT_METHODS = Object.freeze(["unreadCounts", "clearUnread", "onUnreadChange"]);

// Whether the transport reports the service's own unread counts (and can clear them).
export const hasUnreadCounts = (t) => typeof t?.unreadCounts === "function" && typeof t?.clearUnread === "function";

export class ChatError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function assertChatTransport(t) {
  const missing = TRANSPORT_METHODS.filter((m) => typeof t?.[m] !== "function");
  if (missing.length) throw new TypeError(`a chat transport must implement ${missing.join(", ")}`);
  return t;
}

// The transport used when no chat service is configured or the SDK did not load: it says so
// and does nothing else. It fakes no message and reports no connection.
export function createUnavailableTransport({ state = STATUS.SDK_NOT_LOADED, detail = null, userId = null } = {}) {
  const status = Object.freeze({ state, code: null, detail });
  return {
    registerCustomMessages() {},
    async connect() {
      return status;
    },
    disconnect() {},
    status: () => status,
    onStatus: () => () => {},
    onMessage: () => () => {},
    async send() {
      throw new ChatError("chat_offline", "There is no chat connection.");
    },
    async newest() {
      throw new ChatError("read_failed", "There is no chat connection.");
    },
    describe: () => ({ kind: "unavailable", banner: null, userId, via: "no chat service" }),
  };
}
