// A hand-written stand-in for the part of the @nexconn/chat 26.2.1 module that the adapter uses, for
// the offline tests. No SDK file is copied or read here: the NAMES (NCEngine and its static methods,
// MessageHandler, ConnectionStatusHandler, DirectChannel, DirectChannelIdentifier, BaseChannel's
// createMessagesQuery, SendMessageParams, ConnectionStatus, AreaCode, ChannelType, LogLevel, a result
// object with isOk / code / msg / data, a page as { data: [...] }) follow the package's published
// typings as read on 16 Nov 2026.
//
// The BEHAVIOUR behind those names is this mock's own choice and is UNVERIFIED against the real
// service until S1's live probe: whether startTime is exclusive, how ties inside one millisecond are
// ordered, the codes a kick or a refused send carries, whether a sender's other tabs get an echo. Each
// is a switch below, so a test can pin the adapter against more than one reading. The defaults follow
// what a review of the published 26.2.1 package reported on 16 Nov 2026: a query continues BY TIME
// (each next page asks again with startTime = the oldest time of the page before), a descending page
// comes newest first, and hasNext is the server's own "more" flag.
//
// The channel list and unread counts (BaseChannel.createChannelsQuery, a channel's unreadCount and
// clearUnreadCount, ChannelHandler's onChannelUnreadStatusSync, NCEngine.addChannelHandler) follow the
// same typings; what they do is again this mock's own choice: a receiver's count per channel grows by
// one for each message of a type some realm registered with isCounted, never for the sender's own;
// clearing sets it to 0 for every realm of that user and tells that user's other realms; the list is
// newest channel first, one page of pageSize. All UNVERIFIED until the live run.
//
// One server, many realms: realm() returns a fresh module namespace with its own NCEngine state, as
// each iframe of the page loads its own copy of the SDK.

export const CONNECTION_STATUS = Object.freeze({ CONNECTED: 0, CONNECTING: 1, DISCONNECTED: 2, SUSPENDED: 3 });
export const AREA_CODE = Object.freeze({ BJ: 1, SG: 2, NA: 3, SA: 5, OM: 6 });
export const CHANNEL_TYPE = Object.freeze({ DIRECT: 1, GROUP: 3, OPEN: 4, SYSTEM: 6, COMMUNITY: 10 });
export const LOG_LEVEL = Object.freeze({ DEBUG: 4, INFO: 3, WARN: 2, ERROR: 1 });
// ErrorCode values the mock answers with (the engine typings' ErrorCode enum; not exported by
// @nexconn/chat itself, so the adapter holds the numbers).
export const CODES = Object.freeze({ NET_CHANNEL_INVALID: 30001, MSG_RESP_TIMEOUT: 30003, TOKEN_INCORRECT: 31004, KICK: 31010, SAME_CLIENT_ON_LINE: 31023, CLIENT_NOT_INIT: 33001, METHOD_BUSY: 33103 });

const result = (code, data, msg = code === 0 ? "" : `code ${code}`) => Object.freeze({ isOk: code === 0, code, msg, data });
const channelKey = (a, b) => [a, b].sort().join("|");
const desc = (a, b) => b.sentTime - a.sentTime || (a.messageId < b.messageId ? 1 : a.messageId > b.messageId ? -1 : 0);
// The same, but ties inside one millisecond come oldest id first: a service whose tie order is not
// the app's (server time, then message id).
const descTiesReversed = (a, b) => b.sentTime - a.sentTime || (a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0);

// pageOrder: "newest_first" hands each page's messages newest first, "oldest_first" oldest first.
// tieOrder: "id_desc" orders a millisecond's ties by id as the app does; "id_asc" the other way.
// pageShape: "pagedata" answers a page as { data: [...] } (the typings' PageData), "array" as a bare list.
// startTimeExclusive: a query's startTime keeps only messages strictly older than it (else at or older).
// echo: a sent message also reaches the sender's other connected realms.
// statusCallback: the name the realm calls on a status handler: the typed interface's
// "onConnectionStatusChanged", or "onConnectionStateChanged" as the typings' own examples spell it.
export class MockNexconnServer {
  #clock;
  #lastTime = 0;
  #seq = 0;
  #channels = new Map();
  #tokens = new Map();
  #unread = new Map();

  constructor({ clock = () => 1_800_000_000_000, pageOrder = "newest_first", tieOrder = "id_desc", pageShape = "pagedata", startTimeExclusive = true, echo = false, statusCallback = "onConnectionStatusChanged", strictTimes = true } = {}) {
    Object.assign(this, { pageOrder, tieOrder, pageShape, startTimeExclusive, echo, statusCallback, strictTimes });
    this.#clock = clock;
    this.realms = [];
    this.connectAnswer = null;
    this.sendFailures = [];
    this.readFailure = null;
    this.emptyPagesWithHasNext = false;
    this.queriesCreated = [];
    // The types counted as unread, from the realms' registrations (isCounted).
    this.countedTypes = new Set();
    // A code (or "throw") the next channel-list loads answer with; a code the next clearUnreadCount answers with.
    this.channelListFailure = null;
    this.clearFailure = null;
  }

  now() {
    this.#lastTime = Math.max(this.#clock(), this.#lastTime + (this.strictTimes ? 1 : 0));
    return this.#lastTime;
  }

  addUser(userId) {
    const token = `mock-token-${userId}`;
    this.#tokens.set(token, userId);
    return token;
  }

  userOfToken(token) {
    return this.#tokens.get(token) ?? null;
  }

  // A message straight onto the server, as another client (or the console) would put it there.
  record(fromUserId, toUserId, messageType, content, { sentTime } = {}) {
    const raw = { messageId: `nx${String(++this.#seq).padStart(6, "0")}`, sentTime: sentTime ?? this.now(), senderUserId: fromUserId, targetUserId: toUserId, messageType, json: JSON.stringify(content) };
    const key = channelKey(fromUserId, toUserId);
    if (!this.#channels.has(key)) this.#channels.set(key, []);
    this.#channels.get(key).push(raw);
    if (this.countedTypes.has(messageType)) this.#unread.set(`${toUserId}|${fromUserId}`, this.unreadOf(toUserId, fromUserId) + 1);
    for (const r of this.realms) {
      if (r.userId === toUserId || (this.echo && r.userId === fromUserId)) r.inbox.push(raw);
    }
    return raw;
  }

  history(a, b) {
    return [...(this.#channels.get(channelKey(a, b)) ?? [])].sort(this.tieOrder === "id_asc" ? descTiesReversed : desc);
  }

  unreadOf(userId, peerUserId) {
    return this.#unread.get(`${userId}|${peerUserId}`) ?? 0;
  }

  // The user's direct channels, newest message first, as { peer, latest }.
  channelsOf(userId) {
    const out = [];
    for (const [key, list] of this.#channels) {
      const [a, b] = key.split("|");
      if (a !== userId && b !== userId) continue;
      out.push({ peer: a === userId ? b : a, latest: Math.max(...list.map((m) => m.sentTime)) });
    }
    return out.sort((x, y) => y.latest - x.latest);
  }

  clearUnread(userId, peerUserId, fromRealm) {
    this.#unread.set(`${userId}|${peerUserId}`, 0);
    for (const r of this.realms) if (r !== fromRealm && r.userId === userId) r.unreadSynced(peerUserId);
  }

  deliver(userId) {
    let n = 0;
    for (const r of this.realms) if (!userId || r.userId === userId) n += r.flush();
    return n;
  }

  // The SDK suspends a connected user's realms (it retries by itself), then brings them back. replay:
  // whether the messages that arrived meanwhile still reach the message handlers afterwards; by default
  // they do not. UNVERIFIED which the real SDK does.
  suspend(userId) {
    for (const r of this.realms) if (r.userId === userId) r.fireStatus(CONNECTION_STATUS.SUSPENDED);
  }

  resume(userId, { replay = false } = {}) {
    for (const r of this.realms) {
      if (r.userId !== userId || r.state.status !== CONNECTION_STATUS.SUSPENDED) continue;
      if (!replay) r.inbox.splice(0);
      r.fireStatus(CONNECTION_STATUS.CONNECTED);
    }
  }

  // The service ends a connected user's session, as a kick by another client would.
  kick(userId, code = CODES.KICK) {
    for (const r of this.realms) if (r.userId === userId) r.dropWith(CONNECTION_STATUS.DISCONNECTED, code);
  }

  realm() {
    const r = createRealm(this);
    this.realms.push(r.control);
    return r;
  }
}

function createRealm(server) {
  const calls = [];
  const note = (op, args) => calls.push({ op, args });
  const state = { initialized: null, registered: [], status: CONNECTION_STATUS.DISCONNECTED, userId: "", messageHandlers: new Map(), statusHandlers: new Map(), channelHandlers: new Map() };
  let control;

  class Handler {
    constructor(handleMap) {
      this._invoker = handleMap;
    }
  }
  class MessageHandler extends Handler {}
  class ConnectionStatusHandler extends Handler {}
  class ChannelHandler extends Handler {}

  class ChannelIdentifier {
    #type;
    #id;
    constructor(channelType, channelId) {
      this.#type = channelType;
      this.#id = channelId;
    }
    get channelType() {
      return this.#type;
    }
    get channelId() {
      return this.#id;
    }
  }
  class DirectChannelIdentifier extends ChannelIdentifier {
    constructor(channelId) {
      super(CHANNEL_TYPE.DIRECT, channelId);
    }
  }

  class Message {
    #identifier;
    #content;
    #type;
    constructor(identifier, content, messageType) {
      this.#identifier = identifier;
      this.#content = content;
      this.#type = messageType;
    }
    get content() {
      return this.#content;
    }
    get messageType() {
      return this.#type;
    }
    get channelIdentifier() {
      return this.#identifier;
    }
  }

  // A stored message as this realm's user sees it: in a direct channel the channel id is the other user.
  const view = (raw, channelType = CHANNEL_TYPE.DIRECT) => {
    const other = raw.senderUserId === state.userId ? raw.targetUserId : raw.senderUserId;
    const m = new Message(new ChannelIdentifier(channelType, other), JSON.parse(raw.json), raw.messageType);
    Object.assign(m, { messageId: raw.messageId, sentTime: raw.sentTime, senderUserId: raw.senderUserId, direction: raw.senderUserId === state.userId ? 1 : 2 });
    return m;
  };

  class SendMessageParams {
    #content;
    #type;
    constructor(content, messageType) {
      this.#content = content;
      this.#type = messageType;
    }
    get content() {
      return this.#content;
    }
    get messageType() {
      return this.#type;
    }
  }

  class MessagesQuery {
    #params;
    #hasNext = true;
    #loading = false;
    constructor(params) {
      this.#params = params;
      server.queriesCreated.push({ ...params, channelId: params.channelIdentifier.channelId });
    }
    get hasNext() {
      return this.#hasNext;
    }
    get isLoading() {
      return this.#loading;
    }
    async loadNextPage() {
      note("MessagesQuery.loadNextPage", { channelId: this.#params.channelIdentifier.channelId });
      if (this.#loading) return result(CODES.METHOD_BUSY);
      if (server.readFailure !== null) return result(server.readFailure);
      if (server.emptyPagesWithHasNext) return result(0, server.pageShape === "array" ? [] : { data: [] });
      this.#loading = true;
      await null;
      this.#loading = false;
      const size = this.#params.pageSize ?? 20;
      const start = this.#params.startTime;
      const all = server.history(state.userId, this.#params.channelIdentifier.channelId).filter((m) => !start || (server.startTimeExclusive ? m.sentTime < start : m.sentTime <= start));
      // Continued by time, not by position: the next load asks again from the oldest time of this page.
      const page = all.slice(0, size);
      this.#hasNext = all.length > size;
      if (page.length) this.#params = { ...this.#params, startTime: page.at(-1).sentTime };
      const ordered = server.pageOrder === "oldest_first" ? [...page].reverse() : page;
      const list = ordered.map((raw) => view(raw));
      return result(0, server.pageShape === "array" ? list : { data: list });
    }
  }

  class ChannelsQuery {
    #params;
    constructor(params) {
      this.#params = params;
    }
    async loadNextPage() {
      note("ChannelsQuery.loadNextPage", { pageSize: this.#params.pageSize });
      if (server.channelListFailure === "throw") throw new Error("the channel list request failed");
      if (server.channelListFailure !== null) return result(server.channelListFailure);
      await null;
      const list = server.channelsOf(state.userId).slice(0, this.#params.pageSize ?? 20);
      return result(0, { data: list.map(({ peer }) => new BaseChannel(new DirectChannelIdentifier(peer), server.unreadOf(state.userId, peer))) });
    }
  }

  class BaseChannel {
    #identifier;
    #unread;
    constructor(identifier, unread = 0) {
      this.#identifier = identifier;
      this.#unread = unread;
    }
    get identifier() {
      return this.#identifier;
    }
    get channelId() {
      return this.#identifier.channelId;
    }
    get channelType() {
      return this.#identifier.channelType;
    }
    get unreadCount() {
      return this.#unread;
    }
    async clearUnreadCount() {
      note("BaseChannel.clearUnreadCount", { channelId: this.channelId });
      if (state.status !== CONNECTION_STATUS.CONNECTED) return result(CODES.NET_CHANNEL_INVALID);
      if (server.clearFailure !== null) return result(server.clearFailure);
      server.clearUnread(state.userId, this.channelId, control);
      this.#unread = 0;
      return result(0);
    }
    static createChannelsQuery(params) {
      note("BaseChannel.createChannelsQuery", { pageSize: params.pageSize });
      return new ChannelsQuery(params);
    }
    async sendMessage(params) {
      note("BaseChannel.sendMessage", { channelId: this.channelId, messageType: params.messageType });
      if (state.status !== CONNECTION_STATUS.CONNECTED) return result(CODES.NET_CHANNEL_INVALID);
      const failure = server.sendFailures.shift();
      if (failure === "throw") throw new Error("the socket closed mid-send");
      if (failure !== undefined) return result(failure);
      const raw = server.record(state.userId, this.channelId, params.messageType, params.content);
      return result(0, view(raw));
    }
    static createMessagesQuery(params) {
      note("BaseChannel.createMessagesQuery", { channelId: params.channelIdentifier.channelId, pageSize: params.pageSize, isAscending: params.isAscending, startTime: params.startTime });
      return new MessagesQuery(params);
    }
  }
  class DirectChannel extends BaseChannel {
    constructor(channelId) {
      super(new DirectChannelIdentifier(channelId));
    }
  }

  const fireStatus = (status, code) => {
    state.status = status;
    for (const h of state.statusHandlers.values()) h._invoker[server.statusCallback]?.({ status, code });
  };

  class NCEngine {
    static initialize(params) {
      note("NCEngine.initialize", params);
      state.initialized = params;
    }
    static async connect(params) {
      note("NCEngine.connect", { tokenLength: params.token.length });
      if (!state.initialized) return result(CODES.CLIENT_NOT_INIT);
      if (server.connectAnswer === "hang") return new Promise(() => {});
      if (server.connectAnswer === "throw") throw new Error("navi request failed");
      fireStatus(CONNECTION_STATUS.CONNECTING);
      await null;
      if (typeof server.connectAnswer === "number") {
        fireStatus(CONNECTION_STATUS.DISCONNECTED, server.connectAnswer);
        return result(server.connectAnswer);
      }
      const userId = server.userOfToken(params.token);
      if (!userId) {
        fireStatus(CONNECTION_STATUS.DISCONNECTED, CODES.TOKEN_INCORRECT);
        return result(CODES.TOKEN_INCORRECT);
      }
      state.userId = userId;
      fireStatus(CONNECTION_STATUS.CONNECTED);
      return result(0, { userId: server.connectAsUser ?? userId });
    }
    static async disconnect() {
      note("NCEngine.disconnect");
      state.userId = "";
      fireStatus(CONNECTION_STATUS.DISCONNECTED, 2);
    }
    static registerCustomMessages(params) {
      note("NCEngine.registerCustomMessages", params.map((p) => ({ ...p })));
      state.registered = params.map((p) => ({ ...p }));
      for (const p of params) p.isCounted ? server.countedTypes.add(p.messageType) : server.countedTypes.delete(p.messageType);
    }
    static addChannelHandler(id, handler) {
      note("NCEngine.addChannelHandler", { id });
      state.channelHandlers.set(id, handler);
    }
    static removeChannelHandler(id) {
      note("NCEngine.removeChannelHandler", { id });
      state.channelHandlers.delete(id);
    }
    static addMessageHandler(id, handler) {
      note("NCEngine.addMessageHandler", { id });
      state.messageHandlers.set(id, handler);
    }
    static removeMessageHandler(id) {
      note("NCEngine.removeMessageHandler", { id });
      state.messageHandlers.delete(id);
    }
    static addConnectionStatusHandler(id, handler) {
      note("NCEngine.addConnectionStatusHandler", { id });
      state.statusHandlers.set(id, handler);
    }
    static removeConnectionStatusHandler(id) {
      note("NCEngine.removeConnectionStatusHandler", { id });
      state.statusHandlers.delete(id);
    }
    static getConnectionStatus() {
      return state.status;
    }
    static getCurrentUserId() {
      return state.userId;
    }
    static getServerTimeDelta() {
      return 0;
    }
  }

  const sdk = {
    NCEngine,
    MessageHandler,
    ConnectionStatusHandler,
    ChannelHandler,
    ChannelsQuery,
    ChannelIdentifier,
    DirectChannelIdentifier,
    BaseChannel,
    DirectChannel,
    Message,
    MessagesQuery,
    SendMessageParams,
    ConnectionStatus: CONNECTION_STATUS,
    AreaCode: AREA_CODE,
    ChannelType: CHANNEL_TYPE,
    LogLevel: LOG_LEVEL,
  };

  control = {
    calls,
    state,
    inbox: [],
    get userId() {
      return state.userId;
    },
    // Hands waiting messages to this realm's message handlers, as the SDK's socket would.
    flush() {
      // A suspended realm keeps what waits for it; a disconnected one loses it.
      if (state.status === CONNECTION_STATUS.SUSPENDED) return 0;
      const due = control.inbox.splice(0);
      if (!due.length || state.status !== CONNECTION_STATUS.CONNECTED) return 0;
      const messages = due.map((raw) => view(raw));
      for (const h of state.messageHandlers.values()) h._invoker.onMessageReceived?.({ messages });
      return due.length;
    },
    // A message of another channel type, as a system or group message would arrive.
    pushOther(raw, channelType) {
      const m = view(raw, channelType);
      for (const h of state.messageHandlers.values()) h._invoker.onMessageReceived?.({ messages: [m] });
    },
    // Another realm of this user marked the channel with peerUserId read: the SDK's "synced from
    // another device".
    unreadSynced(peerUserId) {
      for (const h of state.channelHandlers.values()) h._invoker.onChannelUnreadStatusSync?.({ channelIdentifier: new DirectChannelIdentifier(peerUserId) });
    },
    dropWith(status, code) {
      fireStatus(status, code);
      if (status === CONNECTION_STATUS.DISCONNECTED) state.userId = "";
    },
    fireStatus,
  };
  return { sdk, control };
}
