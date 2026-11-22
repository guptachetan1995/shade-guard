// The Nexconn adapter: the chat transport interface (transport.js) on the @nexconn/chat 26.2.1 Web
// SDK. It never imports the SDK. public/chat-sdk.js is the one module that loads it, and the page
// hands the module's namespace in as `sdk`, so the offline tests run this file on a hand-written
// stand-in and nothing on the agent's side can reach it (scripts/lint.js). Browser-safe.
//
// The names and signatures used here come from the SDK's published typings (26.2.1). What the real
// service does behind them is UNVERIFIED until the live probe; each assumption is marked UNVERIFIED
// where the code relies on it.
import { ChatError, createUnavailableTransport, PAGE_SIZE, STATUS } from "./transport.js";
import { byServerTime } from "../threads.js";

// Every name the adapter reads from the module namespace. A namespace that lacks one is treated as
// "the SDK did not load", with the missing names on screen.
export const SDK_NAMES = Object.freeze(["NCEngine", "BaseChannel", "DirectChannel", "DirectChannelIdentifier", "SendMessageParams", "MessageHandler", "ConnectionStatusHandler", "ConnectionStatus", "AreaCode", "ChannelType", "LogLevel"]);
const ENGINE_METHODS = Object.freeze(["initialize", "connect", "disconnect", "registerCustomMessages", "addMessageHandler", "removeMessageHandler", "addConnectionStatusHandler", "removeConnectionStatusHandler"]);

// The env file's area (SG, NA, SAU: the server-API hosts in src/config.js) to the SDK's AreaCode key.
// The typings name SG and NA plainly; SAU → SA is UNVERIFIED (the typings describe SA only vaguely).
export const AREA_KEYS = Object.freeze({ SG: "SG", NA: "NA", SAU: "SA" });

// ErrorCode values (the engine's ErrorCode enum; @nexconn/chat does not re-export it). UNVERIFIED
// which of the two a kick by an eleventh Web connection carries; both read as a busy seat.
export const KICK_CODES = Object.freeze([31010, 31023]);
// A failed send whose code says the connection itself is gone, so the page says offline rather than
// "the send failed": channel invalid, network unavailable, socket not created, socket disconnected,
// network down, client not initialised.
export const OFFLINE_SEND_CODES = Object.freeze([30001, 30002, 30010, 30011, 30019, 33001]);
// Words for the codes a demo page is likely to meet, in this file's own words.
const CODE_WORDS = Object.freeze({
  20604: "sending too fast",
  30002: "the network is unavailable",
  31004: "the token is incorrect or expired",
  31008: "the Nexconn app is blocked or deleted",
  31009: "this demo user is blocked",
  31010: "another connection took this seat",
  31020: "the token has expired",
  31023: "this user is already online elsewhere",
  33007: "the app's cloud message history is not enabled",
  34006: "the connection timed out",
});
const withWords = (code) => `code ${code}${CODE_WORDS[code] ? `: ${CODE_WORDS[code]}` : ""}`;

export const CONNECT_TIMEOUT_MS = 20_000;
const HANDLER_ID = "shade-guard";
// A page short of `limit` must mean the start of history, never "the SDK handed less", so a page is
// topped up by further loads; more than this many loads for one page is a failed read.
const MAX_LOADS_PER_PAGE = 10;
const MAX_DIAGNOSTICS = 200;
// One page of the channel list, at the typings' default size: a desk has two channels per seat.
const CHANNEL_PAGE = 20;

const initializedEngines = new WeakSet();
const registeredEngines = new WeakSet();

export function missingSdkNames(sdk) {
  const missing = SDK_NAMES.filter((n) => sdk?.[n] === undefined || sdk[n] === null);
  if (!missing.includes("NCEngine")) missing.push(...ENGINE_METHODS.filter((m) => typeof sdk.NCEngine[m] !== "function").map((m) => `NCEngine.${m}`));
  if (!missing.includes("BaseChannel") && typeof sdk.BaseChannel.createMessagesQuery !== "function") missing.push("BaseChannel.createMessagesQuery");
  return missing;
}

const codeDetail = (code) => (code === undefined || code === null ? null : `Nexconn ${withWords(code)}`);

// One SDK connection state (and the code that came with it) as the page's state.
export function statusFromSdk(sdk, status, code) {
  const S = sdk.ConnectionStatus;
  const c = code ?? null;
  if (status === S.CONNECTED) return { state: STATUS.CONNECTED, code: null, detail: null };
  if (status === S.CONNECTING) return { state: STATUS.CONNECTING, code: c, detail: null };
  // UNVERIFIED: the typings say a suspended connection is retried by the SDK after 5 s.
  if (status === S.SUSPENDED) return { state: STATUS.CONNECTING, code: c, detail: "the connection paused; the SDK reconnects by itself" };
  if (KICK_CODES.includes(c)) return { state: STATUS.BUSY, code: c, detail: codeDetail(c) };
  if (status === S.DISCONNECTED) return { state: STATUS.OFFLINE, code: c, detail: codeDetail(c) };
  return { state: STATUS.OFFLINE, code: c, detail: `unknown Nexconn connection state ${String(status)}` };
}

// An SDK Message as the interface's plain message, or null when it is not one this app reads (no
// server id or time, or not a direct channel). In a direct channel the channel id is the other user.
// UNVERIFIED: that a custom message's content round-trips as the JSON object that was sent.
function plainMessage(m, { sdk, selfUserId }) {
  if (!m || typeof m.messageId !== "string" || m.messageId === "" || !Number.isFinite(m.sentTime)) return { skip: "no_server_place" };
  const channel = m.channelIdentifier;
  if (channel?.channelType !== sdk.ChannelType.DIRECT) return { skip: "not_direct" };
  let content;
  try {
    content = JSON.parse(JSON.stringify(m.content ?? null));
  } catch {
    return { skip: "content_not_json" };
  }
  const senderUserId = m.senderUserId;
  return {
    message: { messageId: m.messageId, type: m.messageType, senderUserId, targetUserId: senderUserId === selfUserId ? channel.channelId : selfUserId, sentTime: m.sentTime, content },
  };
}

const short = (e) => String(e?.message ?? e).slice(0, 200);

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Nexconn did not answer within ${Math.round(ms / 1000) || ms / 1000} s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// sdk: the @nexconn/chat module namespace (or a stand-in with the same names). area: SG, NA or SAU.
// One transport per realm: NCEngine is the SDK's one static engine, initialised once per page.
export function createNexconnTransport({ sdk, appKey, area, userId, token, connectTimeoutMs = CONNECT_TIMEOUT_MS }) {
  const E = sdk.NCEngine;
  let status = Object.freeze({ state: STATUS.IDLE, code: null, detail: null });
  let registrations = null;
  let registeredTypes = new Set();
  let started = false;
  const handlers = { message: new Set(), status: new Set(), unread: new Set() };
  // The unread counts are optional on the interface: a module without the channel list, or without a
  // channel's clearUnreadCount, gives a transport without them, and the desk keeps its own count.
  const hasChannelList = typeof sdk.BaseChannel?.createChannelsQuery === "function" && typeof sdk.DirectChannel?.prototype?.clearUnreadCount === "function";
  const hasChannelHandler = typeof sdk.ChannelHandler === "function" && typeof E.addChannelHandler === "function" && typeof E.removeChannelHandler === "function";
  const log = [];

  const diag = (entry) => {
    log.push({ at: Date.now(), ...entry });
    if (log.length > MAX_DIAGNOSTICS) log.splice(0, log.length - MAX_DIAGNOSTICS);
  };
  const set = (next) => {
    status = Object.freeze({ code: null, detail: null, ...next });
    diag({ op: "status", state: status.state, code: status.code });
    for (const h of handlers.status) h(status);
  };

  const onSdkStatus = (event) => {
    if (!started) return;
    set(statusFromSdk(sdk, event?.status, event?.code));
  };
  const onSdkMessages = (event) => {
    for (const m of event?.messages ?? []) {
      const r = plainMessage(m, { sdk, selfUserId: userId });
      if (r.skip) {
        diag({ op: "dropped", why: r.skip });
        continue;
      }
      if (!registeredTypes.has(r.message.type)) {
        diag({ op: "dropped", why: "unregistered_type" });
        continue;
      }
      // For the probe: the server time against this tab's clock and the SDK's own delta, so the
      // send-to-arrival time can be worked out without trusting either clock alone.
      diag({ op: "received", messageId: r.message.messageId, sentTime: r.message.sentTime, serverTimeDelta: typeof E.getServerTimeDelta === "function" ? E.getServerTimeDelta() : null });
      for (const h of handlers.message) h(r.message);
    }
  };

  // Another connection of this user changed a channel's unread state (the typings: "synced from another
  // device"). UNVERIFIED that the SDK calls it for another tab of the same user.
  const onSdkUnreadSync = (event) => {
    if (!started) return;
    const channel = event?.channelIdentifier;
    if (channel?.channelType !== sdk.ChannelType.DIRECT) return;
    diag({ op: "unread_sync" });
    for (const h of handlers.unread) h(channel.channelId);
  };

  // Lets go of the engine: no handler of ours is left to report a late "connected" (which would show
  // the page connected with no user id checked and no history restored).
  function release() {
    started = false;
    try {
      if (hasChannelHandler) E.removeChannelHandler(HANDLER_ID);
      E.removeMessageHandler(HANDLER_ID);
      E.removeConnectionStatusHandler(HANDLER_ID);
      E.disconnect().catch(() => {});
    } catch {
      // an engine that never initialised has nothing to let go of
    }
  }

  // ---- history ----
  //
  // The SDK continues a query by time: each next page asks again from the oldest time of the page
  // before, so where the service's startTime is exclusive, a message that shares that millisecond but
  // missed the page is never handed over (a review of the published 26.2.1 package, 16 Nov 2026). So
  // no query is ever continued here. Each load is a fresh MessagesQuery from startTime = (the oldest
  // time this read has seen, or the cursor's) + 1, and keeps only what is strictly older than the
  // cursor in (sentTime, messageId), which holds whether startTime is inclusive or exclusive
  // (UNVERIFIED which). A page is handed out only once its oldest millisecond is complete: a message
  // older than that millisecond has been seen (the service sorts by time, so nothing of that
  // millisecond can come later), or the channel has ended. The service's order inside one
  // millisecond is UNVERIFIED and need not be the app's. A run of ties as long as a load (one
  // millisecond with an exclusive startTime, two adjacent ones with an inclusive) can't be paged past
  // by time, so a load that hands over nothing new while the service still says there is more is a
  // failed read, never the start of the channel.
  async function load(read) {
    const params = { channelIdentifier: new sdk.DirectChannelIdentifier(read.withUserId), pageSize: read.pageSize, isAscending: false };
    if (read.start !== null) params.startTime = read.start;
    diag({ op: "query", withUserId: read.withUserId, startTime: params.startTime ?? null });
    const query = sdk.BaseChannel.createMessagesQuery(params);
    let r;
    try {
      r = await query.loadNextPage();
    } catch (e) {
      throw new ChatError("read_failed", `The Nexconn history read failed: ${short(e)}`);
    }
    if (!r?.isOk) {
      diag({ op: "page", code: r?.code ?? null });
      throw new ChatError("read_failed", `Nexconn refused the history read (${withWords(r?.code)}).`);
    }
    // The typings give a page as PageData ({ data: [...] }); a bare list is taken too.
    const raw = Array.isArray(r.data) ? r.data : Array.isArray(r.data?.data) ? r.data.data : [];
    const hasNext = query.hasNext;
    read.exhausted = hasNext === false || (hasNext === undefined && raw.length < read.pageSize);
    let fresh = 0;
    let kept = 0;
    for (const m of raw) {
      if (typeof m?.messageId !== "string" || !Number.isFinite(m?.sentTime)) continue;
      read.oldest = Math.min(read.oldest, m.sentTime);
      if (read.seen.has(m.messageId) || (read.cursor && byServerTime(m, read.cursor) >= 0)) continue;
      read.seen.add(m.messageId);
      fresh += 1;
      const p = plainMessage(m, { sdk, selfUserId: userId });
      if (p.skip || !registeredTypes.has(p.message.type)) continue;
      read.buffer.push(p.message);
      kept += 1;
    }
    if (Number.isFinite(read.oldest)) read.start = read.oldest + 1;
    read.buffer.sort((a, b) => byServerTime(b, a));
    diag({ op: "page", code: r.code, size: raw.length, fresh, kept, hasNext: hasNext ?? null });
    if (!read.exhausted && fresh === 0) {
      throw new ChatError("read_failed", "The Nexconn history read can't go further back: it handed over nothing new while saying there is more (one millisecond may hold more messages than a page).");
    }
  }

  const settled = (read, size) => read.exhausted || (read.buffer.length >= size && read.oldest < read.buffer[size - 1].sentTime);

  async function newest({ withUserId, limit = PAGE_SIZE, before = null }) {
    if (status.state !== STATUS.CONNECTED) throw new ChatError("chat_offline", "Not connected to Nexconn.");
    const size = Math.min(limit, PAGE_SIZE);
    // One message more than the page from the top, two from a cursor (the cursor's own message comes
    // back first): the extra one, older than the page, usually proves its oldest millisecond complete
    // in a single load. The typings allow a page size of 1 to 100.
    const read = { withUserId, pageSize: size + (before ? 2 : 1), start: before ? before.sentTime + 1 : null, cursor: before, oldest: Infinity, seen: new Set(), buffer: [], exhausted: false };
    for (let loads = 0; !settled(read, size); loads++) {
      if (loads >= MAX_LOADS_PER_PAGE) throw new ChatError("read_failed", `The Nexconn history read took more than ${MAX_LOADS_PER_PAGE} loads to fill one page of this thread.`);
      await load(read);
    }
    return read.buffer.slice(0, size);
  }

  // ---- unread counts ----
  //
  // UNVERIFIED, all of it, until the live run: that the channel list's first page holds the desk's
  // direct channels with an unreadCount that grows by one per received message of a type registered
  // with isCounted (never for this user's own sends); that a channel with no message is simply not
  // listed; that clearUnreadCount sets the count to 0 on the service for every connection of the user;
  // and whether the list reads the server or the SDK's local copy.
  async function unreadCounts(peerUserIds) {
    if (status.state !== STATUS.CONNECTED) throw new ChatError("chat_offline", "Not connected to Nexconn.");
    let r;
    try {
      r = await sdk.BaseChannel.createChannelsQuery({ pageSize: CHANNEL_PAGE }).loadNextPage();
    } catch (e) {
      throw new ChatError("read_failed", `The Nexconn channel list read failed: ${short(e)}`);
    }
    if (!r?.isOk) {
      diag({ op: "channels", code: r?.code ?? null });
      throw new ChatError("read_failed", `Nexconn refused the channel list (${withWords(r?.code)}).`);
    }
    // The typings give the page as PageData ({ data: [...] }); a bare list is taken too.
    const list = Array.isArray(r.data) ? r.data : Array.isArray(r.data?.data) ? r.data.data : [];
    const want = new Set(peerUserIds);
    const out = {};
    for (const ch of list) {
      if (ch?.channelType !== sdk.ChannelType.DIRECT || !want.has(ch.channelId)) continue;
      if (Number.isInteger(ch.unreadCount) && ch.unreadCount >= 0) out[ch.channelId] = ch.unreadCount;
    }
    diag({ op: "channels", code: r.code, size: list.length, listed: Object.keys(out).length });
    return out;
  }

  async function clearUnread(peerUserId) {
    if (status.state !== STATUS.CONNECTED) throw new ChatError("chat_offline", "Not connected to Nexconn.");
    let r;
    try {
      r = await new sdk.DirectChannel(peerUserId).clearUnreadCount();
    } catch (e) {
      throw new ChatError("clear_failed", `Marking the Nexconn channel read failed: ${short(e)}`);
    }
    diag({ op: "clear_unread", code: r?.code ?? null });
    if (!r?.isOk) throw new ChatError("clear_failed", `Nexconn refused to mark the channel read (${withWords(r?.code)}).`);
  }

  const transport = {
    registerCustomMessages(regs) {
      if (status.state !== STATUS.IDLE || started) throw new ChatError("register_after_connect", "Custom messages must be registered before connect.");
      for (const r of regs) {
        const keys = Object.keys(r).sort().join(",");
        if (keys !== "isCounted,isPersisted,messageType" || typeof r.isPersisted !== "boolean" || typeof r.isCounted !== "boolean") {
          throw new ChatError("bad_registration", `a registration carries ${keys}; the typings name messageType, isPersisted and isCounted`);
        }
      }
      registrations = regs.map((r) => ({ messageType: r.messageType, isPersisted: r.isPersisted, isCounted: r.isCounted }));
      registeredTypes = new Set(registrations.map((r) => r.messageType));
    },

    async connect() {
      if (status.state === STATUS.CONNECTED) return status;
      started = true;
      set({ state: STATUS.CONNECTING });
      let result;
      try {
        if (!initializedEngines.has(E)) {
          E.initialize({ appKey, areaCode: sdk.AreaCode[AREA_KEYS[area]], logLevel: sdk.LogLevel.WARN });
          initializedEngines.add(E);
        }
        // The typings: registerCustomMessages after initialize and before any message of these types.
        if (!registeredEngines.has(E)) {
          E.registerCustomMessages(registrations ?? []);
          registeredEngines.add(E);
        }
        E.addMessageHandler(HANDLER_ID, new sdk.MessageHandler({ onMessageReceived: onSdkMessages }));
        // The typed handler interface's name (the typings' examples spell it onConnectionStateChanged;
        // the 16 Nov review found the package calls the typed one).
        E.addConnectionStatusHandler(HANDLER_ID, new sdk.ConnectionStatusHandler({ onConnectionStatusChanged: onSdkStatus }));
        if (hasChannelHandler) E.addChannelHandler(HANDLER_ID, new sdk.ChannelHandler({ onChannelUnreadStatusSync: onSdkUnreadSync }));
        result = await withTimeout(E.connect({ token }), connectTimeoutMs);
      } catch (e) {
        release();
        set({ state: STATUS.OFFLINE, detail: short(e) });
        return status;
      }
      diag({ op: "connect", code: result?.code ?? null });
      if (!result?.isOk) {
        // Let go here too: after the SDK's own timeout (34006) a late "connected" must not show the page
        // connected with no user id checked and no history restored.
        release();
        set(statusFromSdk(sdk, sdk.ConnectionStatus.DISCONNECTED, result?.code));
        return status;
      }
      if (result.data?.userId !== userId) {
        release();
        set({ state: STATUS.OFFLINE, detail: "Nexconn connected this token as another user; the seats file does not match" });
        return status;
      }
      set({ state: STATUS.CONNECTED });
      return status;
    },

    disconnect() {
      if (!started) return;
      release();
      set({ state: STATUS.IDLE });
    },

    status: () => status,

    onStatus(fn) {
      handlers.status.add(fn);
      return () => handlers.status.delete(fn);
    },

    onMessage(fn) {
      handlers.message.add(fn);
      return () => handlers.message.delete(fn);
    },

    // UNVERIFIED: that the sent message's messageId and sentTime are the server's own, the same ones
    // a history read returns for it.
    async send({ toUserId, type, content }) {
      if (status.state !== STATUS.CONNECTED) throw new ChatError("chat_offline", "Not connected to Nexconn.");
      if (!registeredTypes.has(type)) throw new ChatError("unregistered_type", `${type} was not registered before connect.`);
      let r;
      try {
        r = await new sdk.DirectChannel(toUserId).sendMessage(new sdk.SendMessageParams(JSON.parse(JSON.stringify(content)), type));
      } catch (e) {
        diag({ op: "send", threw: true });
        throw new ChatError(status.state === STATUS.CONNECTED ? "send_failed" : "chat_offline", `The Nexconn send failed: ${short(e)}`);
      }
      diag({ op: "send", code: r?.code ?? null, messageId: r?.data?.messageId ?? null, sentTime: r?.data?.sentTime ?? null });
      if (!r?.isOk) {
        const offline = OFFLINE_SEND_CODES.includes(r?.code);
        throw new ChatError(offline ? "chat_offline" : "send_failed", `Nexconn refused the send (${withWords(r?.code)}).`);
      }
      const m = r.data;
      if (!m || typeof m.messageId !== "string" || m.messageId === "" || !Number.isFinite(m.sentTime)) {
        throw new ChatError("send_failed", "Nexconn answered the send without a message id and server time.");
      }
      return { messageId: m.messageId, type, senderUserId: userId, targetUserId: toUserId, sentTime: m.sentTime, content: JSON.parse(JSON.stringify(m.content ?? content)) };
    },

    newest,

    describe: () => ({ kind: "nexconn", banner: null, userId, via: "Nexconn" }),

    // Not part of the interface: the last SDK answers (codes, page sizes, hasNext, receipt times), for
    // the live probe to read. Holds no token and no message content.
    diagnostics: () => log.map((e) => ({ ...e })),
  };
  if (hasChannelList) Object.assign(transport, { unreadCounts, clearUnread });
  if (hasChannelHandler) {
    transport.onUnreadChange = (fn) => {
      handlers.unread.add(fn);
      return () => handlers.unread.delete(fn);
    };
  }
  return transport;
}

// The transport for one user of a seats config (src/chat/seats.js parseNexconnSeats), with the SDK
// loaded by loadSdk (public/chat-sdk.js in the page). Anything that stops a real connection gives
// the transport that says so and fakes nothing.
export async function transportFromSeats({ config, userId, loadSdk }) {
  const token = config.tokens?.[userId];
  if (!token) return createUnavailableTransport({ state: STATUS.OFFLINE, userId, detail: "the seats file holds no token for this user" });
  let sdk;
  try {
    sdk = await loadSdk();
  } catch (e) {
    return createUnavailableTransport({ userId, detail: `the Nexconn SDK could not load from the CDN (${short(e)})` });
  }
  const missing = missingSdkNames(sdk);
  if (missing.length) return createUnavailableTransport({ userId, detail: `the Nexconn SDK loaded without ${missing.join(", ")}` });
  if (sdk.AreaCode[AREA_KEYS[config.area]] === undefined) {
    return createUnavailableTransport({ userId, detail: `the Nexconn SDK has no AreaCode for area ${config.area}` });
  }
  return createNexconnTransport({ sdk, appKey: config.appKey, area: config.area, userId, token });
}
