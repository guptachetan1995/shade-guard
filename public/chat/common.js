// Helpers shared by the support chat's three pages (the frame, the desk and the shopper's phone).
import { createUnavailableTransport } from "../../src/chat/transport.js";
import { fakeSeats, parseNexconnSeats } from "../../src/chat/seats.js";
import { TYPES } from "../../src/chat/messages.js";
import { STATUS } from "../../src/chat/transport.js";
import { wordsFor } from "../../src/chat/states.js";

export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const f1 = (n) => Number(n).toFixed(1);
export const f2 = (n) => Number(n).toFixed(2);
export const $ = (sel, root = document) => root.querySelector(sel);

export function clockOf(serverTime) {
  return new Date(serverTime).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export const tail = (id) => `…${String(id).slice(-6)}`;

// fn at most once per burst of calls: a page asks to redraw on every inbound message, and a
// burst of them is one redraw. schedule runs fn later (a short timer by default).
export function coalesced(fn, schedule = (f) => setTimeout(f, 30)) {
  let queued = false;
  return () => {
    if (queued) return;
    queued = true;
    schedule(() => {
      queued = false;
      fn();
    });
  };
}

// probe=1 exposes each side's connection diagnostics to the browser console (the live probe);
// isolate=1 gives the shopper's iframe its own storage (credentialless), the first fallback if two
// SDK engines in one origin get in each other's way.
export function params(search = location.search) {
  const q = new URLSearchParams(search);
  return { side: q.get("side"), seat: Number.parseInt(q.get("seat") ?? "", 10) || null, as: q.get("as") === "1" ? 1 : 0, visit: q.get("visit"), probe: q.get("probe") === "1", isolate: q.get("isolate") === "1" };
}

// Who one side of the page is, from its parameters and the seats config: the frame's iframes and the
// desk's phone link both land here, so a phone opened from the link is the same user the iframe is.
export function sideOf(p, config) {
  const seat = config.seats.find((s) => s.n === p.seat) ?? config.seats[0];
  const visit = p.visit ?? "solo";
  const userId = p.side === "desk" ? seat.deskUserId : seat.shoppers[p.as].userId;
  return { side: p.side, seat, visit, as: p.as, userId };
}

// The desk's link to the shopper's side (§15.5.3 of the plan): this page with the side, the seat number
// and the visit id, and nothing else. No token travels in it: the phone reads the seat's token from the
// seats file beside the page, as the frame's iframe does.
export function phoneLinkUrl(href, { seat, visit }) {
  const url = new URL(href);
  url.search = new URLSearchParams({ side: "shopper", seat: String(seat), visit }).toString();
  url.hash = "";
  return url.href;
}

// Whether a page address is this computer: the local server listens on 127.0.0.1 only.
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\]|.+\.localhost)$/;
const onThisMachine = (url) => {
  try {
    return LOOPBACK.test(new URL(url).hostname);
  } catch {
    return false;
  }
};

// The link's box on the desk, in words that say where it works. kind is the transport's describe().kind.
// On Nexconn from a public address any phone can open it; a page served from this computer (the local
// server, offline or on Nexconn) can't be reached from a phone; with no chat service there is nothing to
// open. Folded, so it adds one line to the desk: the link itself; the address and the copy button are
// inside. open keeps it unfolded across a redraw.
export function phoneLinkHtml({ url, kind, copied = "", open = false }) {
  if (kind !== "nexconn" && kind !== "fake") return "";
  const where = kind === "nexconn" && !onThisMachine(url) ? "nexconn" : "local";
  const head =
    where === "nexconn"
      ? `<b>On a phone:</b> <a href="${esc(url)}" target="_blank" rel="noopener">open the shopper's side</a>, or copy its address to a phone.`
      : `<b>In another window:</b> <a href="${esc(url)}" target="_blank" rel="noopener">open the shopper's side</a>.`;
  const fine =
    where === "nexconn"
      ? "The address carries only this seat's number and this visit's id, no token: the phone reads the seat's public demo token from this site, as this page did, and connects to Nexconn as the seat's fictional shopper. Anyone holding the address can write as her in this visit."
      : "On this machine only: this page is served from this computer (127.0.0.1), so a phone can't reach it. The address carries only this seat's number and this visit's id.";
  return `<details class="phone-link" data-phone-link="${where}"${open || copied ? " open" : ""}><summary>${head}</summary>
    <p class="phone-row"><code class="phone-url">${esc(url)}</code><button type="button" class="btn small" data-action="copy-phone-link" data-url="${esc(url)}">Copy</button>${copied ? `<span class="fine" role="status">${esc(copied)}</span>` : ""}</p>
    <p class="fine">${fine}</p></details>`;
}

export function pageUrl(query) {
  const url = new URL(location.href);
  url.search = new URLSearchParams(query).toString();
  return url.href;
}

const onPages = () => document.documentElement.dataset.transport === "pages";

// The Nexconn seats file beside this page: served by the local server, or copied into a Pages build
// that was given one. null when there is none.
async function fetchSeatsFile() {
  const res = await fetch("nexconn-seats.json", { cache: "no-store" });
  return res.ok ? res.json() : null;
}

// The chat service this page was given. On the local server running its offline service, a module that
// is not in the static build reaches the offline service. Otherwise a Nexconn seats file beside the
// page means Nexconn. Without either the page has no service, and says so (detail says why, when a
// seats file was there but could not be used).
export async function loadChatConfig({ pages = onPages(), seatsFile = fetchSeatsFile } = {}) {
  if (!pages) {
    try {
      const local = await import("./local-transport.js");
      const config = await local.localConfig();
      if (config) return config;
    } catch {
      // no local module, or no service behind it: fall through
    }
  }
  let json;
  try {
    json = await seatsFile();
  } catch {
    return { kind: "none", seats: fakeSeats(), detail: "the Nexconn seats file could not be fetched" };
  }
  if (!json) return { kind: "none", seats: fakeSeats() };
  try {
    return parseNexconnSeats(json);
  } catch (e) {
    return { kind: "none", seats: fakeSeats(), detail: e.message };
  }
}

const loadSdk = async () => (await import("../chat-sdk.js")).loadNexconnSdk();

// The transport for one user. Where there is no service, or the SDK did not load, the page gets
// the transport that says so and does nothing else.
export async function makeTransport(config, userId, { pages = onPages(), sdk = loadSdk } = {}) {
  if (config.kind === "nexconn") {
    const { transportFromSeats } = await import("../../src/chat/nexconn-transport.js");
    return transportFromSeats({ config, userId, loadSdk: sdk });
  }
  if (config.kind === "fake" && !pages) {
    try {
      const local = await import("./local-transport.js");
      return local.localTransportFor(userId);
    } catch {
      // fall through
    }
  }
  return createUnavailableTransport({ userId, detail: config.detail ?? null });
}

export function sentBy(m) {
  if (m.sender === "shopper") return "Shopper";
  if (m.type === TYPES.NOTE && m.content.by === "draft") return "Staff · the agent's draft, sent by staff";
  if (m.type === TYPES.NOTE) return "Staff · their own words";
  return "Staff";
}

// One message, with the evidence that it crossed the service: its server time and id.
export function messageHtml(m, { via, extra = "" }) {
  const c = m.content;
  let body;
  switch (m.type) {
    case TYPES.NOTE:
      body = `<p class="msg-text">${esc(c.text)}</p>`;
      break;
    case TYPES.RETURN_REQUEST:
      body = `<p class="msg-text"><b>Return request</b> for order ${esc(c.orderId)}: ${esc(c.reason)}.</p>`;
      break;
    case TYPES.READING:
      body = `<div class="msg-card reading"><b>Shade reading, numbers only</b><span>L* ${f1(c.lab[0])} · a* ${f1(c.lab[1])} · b* ${f1(c.lab[2])} · hue ${f1(c.hueAngle)}° · band ± ${f1(c.band)} · light ${esc(c.lighting ?? "unknown")}</span><span class="fine">No photo is ever in the thread.</span></div>`;
      break;
    case TYPES.OFFER:
      body = `<div class="msg-card offer"><b>${c.resolution === "refund" ? "Refund offer" : c.shadeCode ? `Exchange offer: ${esc(c.shadeCode)}` : "Offer"}</b><span>${esc(c.text)}</span>${extra}</div>`;
      break;
    case TYPES.OFFER_ACCEPTED:
      body = `<p class="msg-text"><b>Accepted</b> the store's offer. <span class="fine">Offer ${esc(c.draftId)}</span></p>`;
      break;
    case TYPES.CASE_CLOSED:
      body = `<p class="msg-text"><b>Case closed</b> by staff (${esc(c.reason)}).</p>`;
      break;
    default:
      body = `<p class="msg-text">${esc(m.type)}</p>`;
  }
  return `<li class="msg ${m.sender}" data-id="${esc(m.messageId)}"><span class="msg-by">${esc(sentBy(m))}</span>${body}<span class="msg-via">via ${esc(via)}, ${clockOf(m.sentTime)}, ${esc(String(m.messageId))}</span></li>`;
}

export const viaOf = (transport) => transport.describe().via;

// The connection bar of a pane: the state, its words (the transport may replace them, as the fake
// does so that a pane never reads as a live service), and the transport's pill if it has one.
export function connectionBar(connection, description) {
  const w = wordsFor(connection.state);
  const words = description?.stateWords?.[connection.state] ?? w.words;
  const pill = description?.pill ? `<span class="pill fake" data-fake="true">${esc(description.pill)}</span>` : "";
  const busy = connection.state === STATUS.BUSY ? `<button type="button" class="btn small" data-action="another-seat">Open another seat</button>` : "";
  const detail = connection.detail ? ` <span class="fine">(${esc(connection.detail)})</span>` : "";
  return `<div class="conn ${esc(w.tone)}" role="status">${pill}<span class="pill ${esc(w.tone)}" data-conn="${esc(connection.state)}">${esc(w.label)}</span><span>${esc(words)}${detail}</span>${busy}</div>`;
}

// The unread count an inbox row shows, and whose it is. own: the desk's count of this visit's shopper
// messages it has not shown. service: the chat service's count for the row's channel, or
// undefined/null when the transport gives none or the service did not list the channel. The service's
// count is shown unless it is lower than own: then another tab or visit on the seat marked the channel
// read, or the service does not count these messages, and the badge must not say fewer than the desk
// knows. The open thread shows none: it is on screen.
export function inboxUnread({ selected, own, service }) {
  const listed = Number.isInteger(service);
  const fromService = listed && service >= own;
  return { count: selected ? 0 : fromService ? service : own, source: fromService ? "service" : "desk", own, service: listed ? service : null };
}

// Whether the desk marks the row's channel read on the service: the service counts messages there,
// the desk has read the thread completely (read: a complete read and no gap, so an own count of 0 is
// not just a history read that failed), and either staff have it on screen or nothing of this visit is
// unread in it (the count is another visit's on the shared seat, or an earlier visit's nobody opened).
// lastCleared: the count this channel showed when the desk last cleared it; the same count again is
// not cleared again, so a clear that doesn't take can't loop with the service's change event.
export const shouldClearUnread = ({ selected, own, service, read, lastCleared }) =>
  Number.isInteger(service) && service > 0 && read === true && service !== lastCleared && (selected || own === 0);

// Whether the desk has read a thread completely: a read point, no gap in the middle, and no older
// history cut off by a reload's page budget. Only then does an own count of 0 mean nothing is unread.
export const readCompletely = (thread) => thread.readThrough !== null && !thread.readGap && !thread.historyTruncated;

// rows: [{ caseId, selected, own, read }]. The cases to mark read, given the service's counts.
export function clearsFor(rows, counts, lastCleared = {}) {
  if (!counts) return [];
  return rows.filter((r) => shouldClearUnread({ ...r, service: counts[r.caseId], lastCleared: lastCleared[r.caseId] })).map((r) => r.caseId);
}

// After a fresh read: a channel whose count moved since the desk cleared it is forgotten (the clear took,
// or a new message came), so its next count can be cleared again.
export function settleCleared(lastCleared, counts) {
  if (!counts) return { ...lastCleared };
  return Object.fromEntries(Object.entries(lastCleared).filter(([caseId, n]) => counts[caseId] === n));
}

export function unreadBadgeHtml(u, { via }) {
  if (!u.count) return "";
  const why =
    u.source === "service"
      ? `${u.count} unread: the chat service's own count for this channel (via ${via}; every visit on this seat shares the channel). This desk counts ${u.own}.`
      : `${u.count} unread: this desk's own count of what it has not shown${u.service === null ? "" : ` (the chat service's channel list says ${u.service})`}.`;
  return `<span class="unread" data-unread-source="${u.source}" title="${esc(why)}" aria-label="${esc(why)}">${u.count}</span>`;
}

// The line under the inbox that says whose counts the badges are.
export function unreadCaptionHtml({ service, via }) {
  return service
    ? `<p class="fine unread-source" data-unread-source="service">Unread counts: the chat service's own, from its channel list (via ${esc(via)}). A channel it does not list, or lists with fewer than this desk has not shown, shows this desk's own count.</p>`
    : `<p class="fine unread-source" data-unread-source="desk">Unread counts: kept by this desk from what it has shown; the chat service gives none here.</p>`;
}

// An async fn run one at a time: a call made while a run is going is folded into one more run after
// it, so a burst of redraws asks the chat service once or twice, never in parallel. A failed run is
// dropped. run.idle() resolves once nothing is running or queued.
export function oneAtATime(fn) {
  let current = null;
  let again = false;
  const loop = async () => {
    do {
      again = false;
      try {
        await fn();
      } catch (e) {
        // The next run tries again; the error is said, so a bug in fn never vanishes.
        console.warn("shade-guard: a background run failed", e);
      }
    } while (again);
    current = null;
  };
  const run = () => {
    if (current) {
      again = true;
      return current;
    }
    current = loop();
    return current;
  };
  run.idle = () => current ?? Promise.resolve();
  return run;
}

// A refusal on the desk describes the thread as it was. The first look after it stamps the newest
// message the thread showed; once a newer one has arrived, the refusal is gone.
export function settleRefusal(refusal, newestId) {
  if (!refusal) return null;
  if (refusal.at === undefined) return { ...refusal, at: newestId };
  return refusal.at === newestId ? refusal : null;
}

// Keeps what is typed into a field, and its caret, across a redraw of the view.
export function saveFields(root) {
  const out = {};
  for (const el of root.querySelectorAll("textarea[id], input[type=text][id]")) {
    out[el.id] = { value: el.value, focused: document.activeElement === el, at: el.selectionStart };
  }
  return out;
}

export function restoreFields(root, saved) {
  for (const [id, s] of Object.entries(saved)) {
    const el = root.querySelector(`#${CSS.escape(id)}`);
    if (!el) continue;
    el.value = s.value;
    if (s.focused) {
      el.focus({ preventScroll: true });
      try {
        el.setSelectionRange(s.at, s.at);
      } catch {
        // not a text field
      }
    }
  }
}
