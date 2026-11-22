// The fake chat service and its transport, for the offline tests and the offline walk. It is
// NOT in the static build: the Pages demo must show a real connection or say that it has none.
//
// The fake server models what the app must survive, so every path has a test:
//  - it hands out its own message ids and its own server times (strictly increasing, whatever
//    the local clocks say), and the newest-page query reads them back, newest first;
//  - delivery to a receiving connection is delayed: a message is on the server (a newest-page
//    read sees it) before it reaches the other side's real-time handler;
//  - a fixed pool of seats, and a per-user connection limit (the docs say up to 10 simultaneous
//    Web connections for one user).
//
// UNVERIFIED: which connection loses when the limit is passed. The fake refuses the newcomer
// and reports it as "busy", the way the page says "this demo seat is busy"; the real kick
// behaviour and its code are recorded when the real adapter is probed.
import { ChatError, PAGE_SIZE, STATUS } from "./transport.js";
import { fakeSeats, SEAT_COUNT } from "./seats.js";
import { isKnownType, registrationObjects } from "./messages.js";
import { byServerTime } from "../threads.js";

export const FAKE_BANNER =
  "FAKE CHAT (offline): this chat runs on a fake in-memory service on this machine. No message crosses the Nexconn service, and nothing here is evidence of an SDK integration.";
export const DOCUMENTED_CONNECTION_LIMIT = 10;

// What a transport says about itself (the interface's describe()). pill and stateWords are the words
// every pane shows beside its connection state, so one pane photographed alone still reads as fake.
export function fakeDescription(userId) {
  return {
    kind: "fake",
    banner: FAKE_BANNER,
    pill: "FAKE CHAT (offline)",
    stateWords: { connected: "Connected to the fake in-memory service on this machine. Nothing here crosses Nexconn." },
    userId,
    via: "fake chat (offline)",
  };
}

const channelKey = (a, b) => [a, b].sort().join("|");
const clone = (v) => structuredClone(v);
// The types a receiver's unread count includes: the registration's isCounted (a case-closed message is
// not counted). UNVERIFIED whether the real service counts custom messages by their registration.
const COUNTED = new Set(registrationObjects().filter((r) => r.isCounted).map((r) => r.messageType));

export class FakeChatServer {
  #clock;
  #lastTime = 0;
  #seq = 0;

  #channels = new Map();
  #conns = new Map();
  #gone = new Map();
  // `${userId}|${peerUserId}` → that user's unread count on the channel with that peer: one per user,
  // shared by all of the user's connections, as a service's would be.
  #unread = new Map();

  // clock: the server's raw time source (ms). deliveryDelayMs: null holds every delivery until
  // deliver() is called (manual, for tests); a number makes a message due that long after it was
  // sent, for a poll to collect (the offline walk). strictTimes: false lets two messages share a
  // server millisecond (UNVERIFIED whether the real service can), so a test can pin the ties.
  constructor({ clock = () => Date.now(), maxConnections = DOCUMENTED_CONNECTION_LIMIT, seatCount = SEAT_COUNT, deliveryDelayMs = null, strictTimes = true } = {}) {
    this.#clock = clock;
    this.strictTimes = strictTimes;
    this.maxConnections = maxConnections;
    this.seats = fakeSeats(seatCount);
    this.deliveryDelayMs = deliveryDelayMs;
    this.reachable = true;
    this.failReads = false;
    this.log = [];
  }

  // Server time: strictly increasing by default, so two messages never share a time. With
  // strictTimes off it only never goes backwards, and the message id breaks a tie.
  now() {
    this.#lastTime = Math.max(this.#clock(), this.#lastTime + (this.strictTimes ? 1 : 0));
    return this.#lastTime;
  }

  knowsUser(userId) {
    return this.seats.some((s) => s.deskUserId === userId || s.shoppers.some((p) => p.userId === userId));
  }

  transport(userId) {
    return new FakeChatTransport(this, userId);
  }

  connectionCount(userId) {
    return [...this.#conns.values()].filter((c) => c.userId === userId).length;
  }

  // ---- connections (called by transports) ----

  // handlers: { onMessage(message), onDrop(status) }. A polling client (the offline walk's
  // pages) passes none and collects its messages with drain().
  open(userId, handlers = {}) {
    if (!this.reachable) return { ok: false, status: { state: STATUS.OFFLINE, code: null, detail: "the fake service is unreachable" } };
    if (!this.knowsUser(userId)) return { ok: false, status: { state: STATUS.OFFLINE, code: null, detail: `no user ${userId} is registered in this fake app` } };
    if (this.connectionCount(userId) >= this.maxConnections) {
      return { ok: false, status: { state: STATUS.BUSY, code: null, detail: `${this.maxConnections} connections already use ${userId}` } };
    }
    // Not a sequence: the id is the only credential a polling page holds for its connection.
    const id = `fc_${globalThis.crypto.randomUUID()}`;
    this.#conns.set(id, { id, userId, handlers, inbox: [] });
    return { ok: true, connectionId: id };
  }

  close(connectionId) {
    this.#conns.delete(connectionId);
  }

  userOf(connectionId) {
    return this.#conns.get(connectionId)?.userId ?? null;
  }

  // ---- messages ----

  record(fromUserId, toUserId, type, content) {
    if (!this.reachable) throw new ChatError("chat_offline", "The fake service is unreachable.");
    if (!this.knowsUser(toUserId)) throw new ChatError("unknown_peer", `No user ${toUserId} is registered in this fake app.`);
    const message = {
      messageId: `fm_${String(++this.#seq).padStart(6, "0")}`,
      type,
      senderUserId: fromUserId,
      targetUserId: toUserId,
      sentTime: this.now(),
      content: clone(content),
    };
    const key = channelKey(fromUserId, toUserId);
    if (!this.#channels.has(key)) this.#channels.set(key, []);
    this.#channels.get(key).push(message);
    if (COUNTED.has(type)) this.#unread.set(`${toUserId}|${fromUserId}`, (this.#unread.get(`${toUserId}|${fromUserId}`) ?? 0) + 1);
    for (const c of this.#conns.values()) {
      if (c.userId === toUserId) {
        c.inbox.push({ message: clone(message), dueAt: this.deliveryDelayMs === null ? Infinity : this.#clock() + this.deliveryDelayMs });
      }
    }
    this.log.push({ at: message.sentTime, event: "sent", messageId: message.messageId, from: fromUserId, to: toUserId, type });
    return clone(message);
  }

  newest(userId, withUserId, limit, before = null) {
    if (!this.reachable || this.failReads) throw new ChatError("read_failed", "The fake service could not be read.");
    const all = this.#channels.get(channelKey(userId, withUserId)) ?? [];
    return all
      .filter((m) => !before || byServerTime(m, before) < 0)
      .sort((a, b) => byServerTime(b, a))
      .slice(0, Math.min(limit, PAGE_SIZE))
      .map(clone);
  }

  // ---- unread counts ----

  // The user's unread count on the channel with each peer. A peer the user has never exchanged a message
  // with has no channel, and is not listed.
  unreadCounts(userId, peerUserIds) {
    if (!this.reachable || this.failReads) throw new ChatError("read_failed", "The fake service could not be read.");
    const out = {};
    for (const p of peerUserIds) if (this.#channels.has(channelKey(userId, p))) out[p] = this.#unread.get(`${userId}|${p}`) ?? 0;
    return out;
  }

  // Marks the channel read for every connection of the user, and tells the user's other connections.
  clearUnread(userId, peerUserId, fromConnectionId = null) {
    if (!this.reachable) throw new ChatError("chat_offline", "The fake service is unreachable.");
    if (this.failReads) throw new ChatError("clear_failed", "The fake service could not mark the channel read.");
    this.#unread.set(`${userId}|${peerUserId}`, 0);
    for (const c of this.#conns.values()) if (c.userId === userId && c.id !== fromConnectionId) c.handlers.onUnread?.(peerUserId);
  }

  // ---- delayed delivery ----

  // Messages on the server that the user's connections have not yet received, oldest first.
  pending(userId) {
    return [...this.#conns.values()].filter((c) => c.userId === userId).flatMap((c) => c.inbox.map((e) => clone(e.message)));
  }

  // Hands a user's waiting messages to their connections' real-time handlers. ids picks which
  // (in the order given, so a test can deliver out of order); without ids every waiting message
  // goes, in send order.
  deliver(userId, ids = null) {
    let count = 0;
    for (const c of this.#conns.values()) {
      if (c.userId !== userId || c.suspended) continue;
      const take = ids ? ids.map((id) => c.inbox.find((e) => e.message.messageId === id)).filter(Boolean) : [...c.inbox];
      for (const e of take) {
        c.inbox.splice(c.inbox.indexOf(e), 1);
        c.handlers.onMessage?.(clone(e.message));
        count += 1;
      }
    }
    return count;
  }

  deliverAll() {
    return this.seats.flatMap((s) => [s.deskUserId, ...s.shoppers.map((p) => p.userId)]).reduce((n, id) => n + this.deliver(id), 0);
  }

  // What a polling client (the offline walk's pages) collects: the messages now due, removed.
  drain(connectionId) {
    const c = this.#conns.get(connectionId);
    if (!c) return null;
    if (c.suspended) return [];
    const due = c.inbox.filter((e) => e.dueAt <= this.#clock());
    c.inbox = c.inbox.filter((e) => !due.includes(e));
    return due.map((e) => e.message);
  }

  // ---- failure injection ----

  setReachable(reachable) {
    this.reachable = reachable;
    if (!reachable) this.#dropAll(STATUS.OFFLINE, "the fake service became unreachable");
  }

  drop(userId, detail = "the connection was dropped") {
    this.#dropAll(STATUS.OFFLINE, detail, userId);
  }

  // The service takes a connected user's seat away mid-session (UNVERIFIED which code the real one
  // uses): the connection is dropped and reports busy, as a newcomer over the limit is.
  kick(userId, detail = "another connection took this seat") {
    this.#dropAll(STATUS.BUSY, detail, userId);
  }

  // The service pauses a user's connections without ending them, as the SDK's suspended state does
  // (UNVERIFIED how the real one behaves): each reads as connecting, nothing is delivered to it, and its
  // transport neither sends nor reads until resume() brings it back connected by itself.
  suspend(userId, detail = "the connection paused; it reconnects by itself") {
    for (const c of this.#conns.values()) {
      if (c.userId !== userId || c.suspended) continue;
      c.suspended = true;
      c.handlers.onPause?.({ state: STATUS.CONNECTING, code: null, detail });
    }
  }

  // replay: whether the messages that reached the service meanwhile still reach the real-time handler
  // afterwards. By default they do not: the case the app's catch-up read after a reconnect is for.
  resume(userId, { replay = false } = {}) {
    for (const c of this.#conns.values()) {
      if (c.userId !== userId || !c.suspended) continue;
      c.suspended = false;
      if (!replay) c.inbox = [];
      c.handlers.onResume?.();
    }
  }

  // Whether a polling client's connection is paused (the poll route says so).
  isSuspended(connectionId) {
    return Boolean(this.#conns.get(connectionId)?.suspended);
  }

  // Why a polling client's connection is gone, or null when it was never dropped.
  goneStatus(connectionId) {
    return this.#gone.get(connectionId) ?? null;
  }

  #dropAll(state, detail, userId = null) {
    for (const c of [...this.#conns.values()]) {
      if (userId && c.userId !== userId) continue;
      this.#conns.delete(c.id);
      this.#gone.set(c.id, { state, detail });
      c.handlers.onDrop?.({ state, code: null, detail });
    }
  }
}

export class FakeChatTransport {
  #server;
  #userId;
  #status = { state: STATUS.IDLE, code: null, detail: null };
  #handlers = { message: new Set(), status: new Set(), unread: new Set() };
  #registered = new Set();
  #connectionId = null;

  constructor(server, userId) {
    this.#server = server;
    this.#userId = userId;
  }

  get userId() {
    return this.#userId;
  }

  #set(status) {
    this.#status = Object.freeze({ code: null, detail: null, ...status });
    for (const h of this.#handlers.status) h(this.#status);
  }

  registerCustomMessages(registrations) {
    if (this.#status.state !== STATUS.IDLE) throw new ChatError("register_after_connect", "Custom messages must be registered before connect.");
    for (const r of registrations) {
      const keys = Object.keys(r).sort().join(",");
      if (keys !== "isCounted,isPersisted,messageType") throw new ChatError("bad_registration", `a registration carries ${keys}`);
      this.#registered.add(r.messageType);
    }
  }

  async connect() {
    if (this.#connectionId) return this.#status;
    this.#set({ state: STATUS.CONNECTING });
    const opened = this.#server.open(this.#userId, {
      onMessage: (m) => {
        for (const h of this.#handlers.message) h(m);
      },
      onDrop: (status) => {
        this.#connectionId = null;
        this.#set(status);
      },
      onUnread: (peerUserId) => {
        for (const h of this.#handlers.unread) h(peerUserId);
      },
      onPause: (status) => this.#set(status),
      onResume: () => this.#set({ state: STATUS.CONNECTED }),
    });
    if (!opened.ok) {
      this.#set(opened.status);
      return this.#status;
    }
    this.#connectionId = opened.connectionId;
    this.#set({ state: STATUS.CONNECTED });
    return this.#status;
  }

  disconnect() {
    if (this.#connectionId) this.#server.close(this.#connectionId);
    this.#connectionId = null;
    this.#set({ state: STATUS.IDLE });
  }

  status() {
    return this.#status;
  }

  onStatus(fn) {
    this.#handlers.status.add(fn);
    return () => this.#handlers.status.delete(fn);
  }

  onMessage(fn) {
    this.#handlers.message.add(fn);
    return () => this.#handlers.message.delete(fn);
  }

  async send({ toUserId, type, content }) {
    if (this.#status.state !== STATUS.CONNECTED) throw new ChatError("chat_offline", "Not connected.");
    if (!isKnownType(type) || !this.#registered.has(type)) throw new ChatError("unregistered_type", `${type} was not registered before connect.`);
    return this.#server.record(this.#userId, toUserId, type, content);
  }

  async newest({ withUserId, limit = PAGE_SIZE, before = null }) {
    if (this.#status.state !== STATUS.CONNECTED) throw new ChatError("chat_offline", "Not connected.");
    return this.#server.newest(this.#userId, withUserId, limit, before);
  }

  async unreadCounts(peerUserIds) {
    if (this.#status.state !== STATUS.CONNECTED) throw new ChatError("chat_offline", "Not connected.");
    return this.#server.unreadCounts(this.#userId, peerUserIds);
  }

  async clearUnread(peerUserId) {
    if (this.#status.state !== STATUS.CONNECTED) throw new ChatError("chat_offline", "Not connected.");
    this.#server.clearUnread(this.#userId, peerUserId, this.#connectionId);
  }

  onUnreadChange(fn) {
    this.#handlers.unread.add(fn);
    return () => this.#handlers.unread.delete(fn);
  }

  describe() {
    return fakeDescription(this.#userId);
  }
}
