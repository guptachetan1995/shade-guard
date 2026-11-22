// The desk, as staff see it: the inbox of two shoppers' channels, the thread of the one open,
// the agent's draft, and staff's own verbs. This page is one side of the chat and runs its own
// app (its own store); the shopper's phone is another page, and the two share only the chat
// service. Every button here posts to the same chokepoint the agent's calls go through.
import { createPagesTransport } from "../../src/pages-entry.js";
import { TYPES } from "../../src/chat/messages.js";
import { MAX_PAGES, PAGE_SIZE, STATUS } from "../../src/chat/transport.js";
import { readBack } from "../../src/chat/history.js";
import { THREAD_NOT_VERIFIED } from "../../src/chat/states.js";
import { byServerTime, isClosed } from "../../src/threads.js";
import { $, clearsFor, coalesced, connectionBar, esc, f2, inboxUnread, messageHtml, oneAtATime, pageUrl, phoneLinkHtml, phoneLinkUrl, readCompletely, restoreFields, saveFields, settleCleared, settleRefusal, tail, unreadBadgeHtml, unreadCaptionHtml, viaOf } from "./common.js";

// svcUnread: the chat service's unread counts by case, or null when the transport gives none (or
// before the first read). lastCleared: the count each channel showed when the desk last cleared it.
const ui = { ready: false, caseId: null, seen: {}, busy: false, refusal: null, agent: {}, handled: new Set(), tryOut: null, unverified: {}, copied: "", phoneOpen: false, svcUnread: null, lastCleared: {}, queue: Promise.resolve() };
let t;
let state;
let session;
let root;

const S = () => state.state;
const thread = (caseId) => S().threads[caseId];
const peerName = (caseId) => Object.values(S().chat.peers).find((p) => p.caseId === caseId)?.name ?? caseId;
const newest = (caseId) => thread(caseId).messages.at(-1) ?? null;
const unsentDraft = (caseId) => S().replyDrafts.filter((d) => d.caseId === caseId).at(-1) ?? null;
const connected = () => S().chat.connection.state === STATUS.CONNECTED;

async function refresh() {
  state = await t.request("GET", "/api/state");
  const c = state.state.chat;
  if (!ui.caseId) ui.caseId = Object.values(c.peers)[0]?.caseId ?? null;
  if (ui.caseId) ui.refusal = settleRefusal(ui.refusal, newest(ui.caseId)?.messageId ?? "");
  render();
  autoDraft();
  unreadLoop();
}

// The service's counts are read after the redraw, in the background and one read at a time, outside
// any button's lock: a slow or hung read (it gives up after a timeout and the desk shows its own count)
// never holds a new message back or a click.
const unreadLoop = oneAtATime(refreshUnread);

// The clears are decided on the fresh counts before they are drawn, so a row about to be cleared never
// flashes the service's count first.
async function refreshUnread() {
  let counts = await t.chat.unreadCounts();
  const clears = clearsFor(clearRows(), counts, ui.lastCleared);
  for (const caseId of clears) {
    ui.lastCleared[caseId] = counts[caseId];
    await t.chat.clearUnread(caseId);
  }
  if (clears.length) counts = await t.chat.unreadCounts();
  ui.lastCleared = settleCleared(ui.lastCleared, counts);
  ui.svcUnread = counts;
  render();
}

const rowUnread = (caseId) => {
  const selected = caseId === ui.caseId;
  return inboxUnread({ selected, own: selected ? 0 : unreadOf(caseId), service: ui.svcUnread?.[caseId] });
};

// What the clear decision needs per row: a channel is marked read on the service when its thread is on
// screen, or when nothing of this visit is unread in it, and only once the desk has read it completely.
function clearRows() {
  return Object.keys(S().threads).map((caseId) => {
    const selected = caseId === ui.caseId;
    return { caseId, selected, own: selected ? 0 : unreadOf(caseId), read: readCompletely(thread(caseId)) };
  });
}

async function invoke(tool, args, actor, { remember = true } = {}) {
  const r = await t.request("POST", "/api/invoke", { tool, args, actor });
  if (remember) ui.refusal = r.ok ? null : { tool, code: r.error.code, message: r.error.message };
  if (r.ok === false && r.error.code === "thread_unverified") ui.unverified[args.caseId] = true;
  else if (r.ok) delete ui.unverified[args.caseId];
  return r;
}

async function runAgent(caseId) {
  const r = await t.request("POST", "/api/agent", { caseId, chat: true });
  ui.agent[caseId] = r.ok ? { outcome: r.outcome, tools: r.transcript.map((c) => c.tool) } : { outcome: r.error.code, tools: [] };
}

// The agent drafts on its own when a return request or a reading arrives: a draft is only a draft.
// Not while the history is still coming back after a reload, and not for a request staff have
// already answered with an offer.
function autoDraft() {
  if (!ui.ready) return;
  for (const caseId of Object.keys(S().threads)) {
    const messages = thread(caseId).messages;
    const at = messages.findLastIndex((m) => m.sender === "shopper" && (m.type === TYPES.RETURN_REQUEST || m.type === TYPES.READING));
    const trigger = messages[at];
    if (!trigger || ui.handled.has(trigger.messageId) || isClosed(thread(caseId))) continue;
    if (messages.slice(at).some((m) => m.type === TYPES.OFFER)) {
      ui.handled.add(trigger.messageId);
      continue;
    }
    ui.handled.add(trigger.messageId);
    ui.queue = ui.queue.then(async () => {
      await runAgent(caseId);
      await refresh();
    });
  }
}

const actions = {
  select: async (el) => {
    ui.caseId = el.dataset.case;
    ui.refusal = null;
    render();
    await refresh();
  },
  draft: async (el) => {
    await runAgent(el.dataset.case);
    await refresh();
  },
  send: async (el) => {
    const r = await invoke("send_reply", { caseId: el.dataset.case, draftId: el.dataset.draft, seen: el.dataset.seen }, "staff");
    await refresh();
    if (!r.ok && r.error.code === "thread_moved") {
      await runAgent(el.dataset.case);
      await refresh();
    }
  },
  note: async (el) => {
    const box = $(`#note-${CSS.escape(el.dataset.case)}`);
    const r = await invoke("staff_note", { caseId: el.dataset.case, text: box.value, seen: el.dataset.seen }, "staff");
    if (r.ok) box.value = "";
    await refresh();
  },
  "approve-exchange": async (el) => {
    await invoke("approve_exchange", { caseId: el.dataset.case, seen: el.dataset.seen }, "staff");
    await refresh();
  },
  "approve-refund": async (el) => {
    await invoke("approve_refund", { caseId: el.dataset.case, seen: el.dataset.seen }, "staff");
    await refresh();
  },
  close: async (el) => {
    await invoke("close_case", { caseId: el.dataset.case, seen: el.dataset.seen, reason: "resolved" }, "staff");
    await refresh();
  },
  "another-seat": () => {
    const seat = (session.seat % session.seatCount) + 1;
    (window.top ?? window).location.href = pageUrl({ seat, visit: session.visit });
  },
  "copy-phone-link": async (el) => {
    try {
      await navigator.clipboard.writeText(el.dataset.url);
      ui.copied = "Copied.";
    } catch {
      ui.copied = "This browser blocked the copy: select the address and copy it.";
    }
    render();
    setTimeout(() => {
      ui.copied = "";
      render();
    }, 4000);
  },
  try: async (el) => {
    const caseId = el.dataset.case;
    const before = await counts(caseId);
    const calls = {
      send_reply: ["send_reply", { caseId, draftId: unsentDraft(caseId)?.draftId ?? "d_01", seen: unsentDraft(caseId)?.fingerprint ?? "0" }],
      staff_note: ["staff_note", { caseId, text: "Your refund is on its way.", seen: newest(caseId)?.messageId ?? "" }],
      close_case: ["close_case", { caseId, seen: newest(caseId)?.messageId ?? "", reason: "resolved" }],
      accept_offer: ["accept_offer", { caseId, draftId: unsentDraft(caseId)?.draftId ?? "d_01" }],
      smuggle: ["draft_reply", { caseId, kind: "check_invite", evidence: {}, text: "Free refund, no questions asked" }],
    };
    const [tool, args] = calls[el.dataset.kind];
    const r = await invoke(tool, args, "agent", { remember: false });
    const after = await counts(caseId);
    ui.tryOut = { tool, ok: r.ok, code: r.ok ? "accepted" : r.error.code, message: r.ok ? "" : r.error.message, before, after };
    await refresh();
  },
};

async function counts(caseId) {
  const mirror = thread(caseId).messages.length;
  let service = null;
  try {
    service = (await readBack(t.chat.transport, thread(caseId).peerUserId)).messages.filter((m) => m.content?.visit === S().chat.visit).length;
  } catch {
    // unreadable: shown as unknown
  }
  return { mirror, service };
}

// ---------------------------------------------------------------- views

function unreadOf(caseId) {
  const shown = thread(caseId).messages.find((m) => m.messageId === ui.seen[caseId]);
  return thread(caseId).messages.filter((m) => m.sender === "shopper" && (!shown || byServerTime(m, shown) > 0)).length;
}

function connectionHtml() {
  return connectionBar(S().chat.connection, t.chat.transport.describe());
}

// The link that opens the shopper's side of this seat and visit on a phone (or, offline, in another
// window): the seat number and the visit id only.
function phoneHtml() {
  const url = phoneLinkUrl(location.href, { seat: session.seat, visit: session.visit });
  return phoneLinkHtml({ url, kind: t.chat.transport.describe().kind, copied: ui.copied, open: ui.phoneOpen });
}

function inboxHtml() {
  const via = viaOf(t.chat.transport);
  return `<nav class="inbox" aria-label="Customers">${Object.keys(S().threads)
    .map((caseId) => {
      const rc = S().returnCases.find((c) => c.caseId === caseId);
      const last = newest(caseId);
      const u = rowUnread(caseId);
      return `<button type="button" class="inbox-row" data-action="select" data-case="${esc(caseId)}" data-unread-source="${u.source}" ${caseId === ui.caseId ? 'aria-current="true"' : ""}>
        <span class="who"><b>${esc(peerName(caseId))}</b><span class="chip status-${esc(rc.status)}">${esc(rc.status.replace("_", " "))}</span></span>
        <span class="fine">${esc(caseId)} · ${last ? esc(previewOf(last)) : "no messages yet"}</span>
        ${unreadBadgeHtml(u, { via })}</button>`;
    })
    .join("")}${unreadCaptionHtml({ service: ui.svcUnread !== null, via })}</nav>`;
}

function previewOf(m) {
  const c = m.content;
  return { [TYPES.NOTE]: c.text, [TYPES.RETURN_REQUEST]: "Return request", [TYPES.READING]: "Shade reading", [TYPES.OFFER]: "Offer sent", [TYPES.OFFER_ACCEPTED]: "Accepted the offer", [TYPES.CASE_CLOSED]: "Case closed" }[m.type];
}

function readingHtml(rc) {
  const rd = rc.reading;
  if (!rd) return `<p class="fine"><b>No shade reading on this order.</b> The agent can only invite her to check; only her own photo starts a check.</p>`;
  return `<p class="fine">Reading, numbers only: ${rd.ranking.map((r) => `${esc(r.code)} ΔE00 ${f2(r.de00)}${r.code === rc.shadeCode ? " (returned)" : ""}`).join(" · ")} · band ± ${f2(rd.band)}${rd.viaChat ? " · shared by the shopper in the chat" : ""}</p>`;
}

function draftHtml(caseId, rc, th) {
  const d = unsentDraft(caseId);
  const shown = newest(caseId)?.messageId ?? "";
  const closed = isClosed(th) || rc.status === "exchange_approved" || rc.status === "refund_approved";
  const agent = ui.agent[caseId];
  const head = `<h3>The agent's draft</h3>`;
  const ran = agent ? `<p class="fine">Agent run: ${esc(agent.tools.join(" → ") || "no calls")} · ${esc(agent.outcome)}</p>` : "";
  const body = !d
    ? `<p class="empty">No draft yet.</p>`
    : `<blockquote class="draft"><span class="who">${d.sent ? "Sent" : "Not sent"} · ${esc(d.kind.replace("_", " "))} · fingerprint ${esc(tail(d.fingerprint))}${d.basedOn ? ` · written against message ${esc(String(d.basedOn.messageId))}` : ""}</span>${esc(d.text)}</blockquote>`;
  return `<section class="draft-box">${head}${body}${ran}
    <div class="actions">
      <button type="button" class="btn" data-action="draft" data-case="${esc(caseId)}" ${closed ? "disabled" : ""}>Draft a reply (agent)</button>
      <button type="button" class="btn primary" data-action="send" data-case="${esc(caseId)}" data-draft="${esc(d?.draftId ?? "")}" data-seen="${esc(d?.fingerprint ?? "")}" ${!d || d.sent || closed || !connected() ? "disabled" : ""}>Send</button>
    </div>
    <p class="fine">Only a staff click sends. A send reads the thread from the chat service first and is refused if the customer has written since the draft.</p></section>`;
}

function staffHtml(caseId, rc, th) {
  const closed = isClosed(th);
  const seen = newest(caseId)?.messageId ?? "";
  return `<section class="staff-box"><h3>Staff</h3>
    <label class="fine" for="note-${esc(caseId)}">Your own words to the customer</label>
    <textarea id="note-${esc(caseId)}" rows="2" maxlength="500" ${closed || !connected() ? "disabled" : ""}></textarea>
    <div class="actions">
      <button type="button" class="btn" data-action="note" data-case="${esc(caseId)}" data-seen="${esc(seen)}" ${closed || !connected() ? "disabled" : ""}>Send note</button>
      <button type="button" class="btn primary" data-action="approve-exchange" data-case="${esc(caseId)}" data-seen="${esc(seen)}" ${closed || rc.draft?.resolution !== "exchange" ? "disabled" : ""}>Approve exchange</button>
      <button type="button" class="btn" data-action="approve-refund" data-case="${esc(caseId)}" data-seen="${esc(seen)}" ${closed ? "disabled" : ""}>Approve refund</button>
      <button type="button" class="btn" data-action="close" data-case="${esc(caseId)}" data-seen="${esc(seen)}" ${closed || !connected() ? "disabled" : ""}>Close case</button>
    </div>
    ${rc.approval ? `<p class="outcome">${rc.approval.verb === "approve_exchange" ? `Exchange approved by staff: ${esc(rc.approval.replacement)} (simulated).` : "Refund approved by staff (simulated)."}</p>` : ""}</section>`;
}

function tryHtml(caseId) {
  const o = ui.tryOut;
  const row = (kind, label) => `<button type="button" class="btn small" data-action="try" data-kind="${kind}" data-case="${esc(caseId)}">${label}</button>`;
  const result = o
    ? `<p class="try-out" role="status"><b>${esc(o.tool)}</b> as the agent: <b class="${o.ok ? "bad" : "ok"}">${esc(o.code)}</b>${o.message ? ` — ${esc(o.message)}` : ""}<br>Messages in this thread before and after: desk ${o.before.mirror} → ${o.after.mirror}; chat service ${o.before.service ?? "?"} → ${o.after.service ?? "?"}. ${o.ok ? "" : "Nothing reached the thread."}</p>`
    : "";
  return `<details class="try" open><summary>Try it as the agent</summary>
    <p class="fine">The agent can read the thread and draft. It can't send, accept, close or write free text. These calls name the agent as the actor; each is refused at the chokepoint.</p>
    <div class="actions">${row("send_reply", "Send the draft")}${row("staff_note", "Send a note")}${row("close_case", "Close the case")}${row("accept_offer", "Accept for the shopper")}${row("smuggle", "Draft with free text")}</div>${result}</details>`;
}

function threadHtml(caseId) {
  const rc = S().returnCases.find((c) => c.caseId === caseId);
  const th = thread(caseId);
  const via = viaOf(t.chat.transport);
  ui.seen[caseId] = newest(caseId)?.messageId ?? null;
  const empty = connected() ? "No messages yet. The shopper starts the return from her order page." : "The thread is not loaded: this desk is not connected to the chat service.";
  const msgs = th.messages.length ? th.messages.map((m) => messageHtml(m, { via })).join("") : `<li class="empty">${empty}</li>`;
  const crossed = th.crossed.length
    ? `<p class="banner crossed" role="alert"><b>Sent over a message you had not seen.</b> The customer wrote while the last message was on its way (${th.crossed.map((c) => esc(String(c.shopperMessageId))).join(", ")}); the agent can draft again.</p>`
    : "";
  const truncated = th.historyTruncated ? `<p class="banner" role="note"><b>Older messages are not loaded.</b> This channel holds more messages than the desk reads back on a reload (${MAX_PAGES * PAGE_SIZE}); the thread shows the newest part.</p>` : "";
  const gap = th.readGap ? `<p class="banner" role="alert" data-read-gap="true"><b>Messages may be missing in the middle of this thread.</b> While the connection was away, more than ${MAX_PAGES * PAGE_SIZE} messages reached this channel, so the desk could not read back to where it had read before. Nothing is sent on this thread until a read reaches back that far; a reload shows the newest part, with the older messages not loaded.</p>` : "";
  const unverified = ui.unverified[caseId] ? `<p class="banner" role="alert"><b>${esc(THREAD_NOT_VERIFIED.label)}.</b> ${esc(THREAD_NOT_VERIFIED.words)}</p>` : "";
  const refusal = ui.refusal ? `<p class="refusal" role="alert"><b>Refused: ${esc(ui.refusal.code)}.</b> ${esc(ui.refusal.message)}</p>` : "";
  const closed = isClosed(th) ? `<p class="banner">This case was closed by staff. The thread is read-only.</p>` : "";
  return `<section class="thread" aria-labelledby="th-h"><header><h2 id="th-h">${esc(peerName(caseId))} · ${esc(caseId)}</h2><p class="fine">Order ${esc(rc.orderId)} · ${esc(rc.shadeCode)} · “${esc(rc.reason)}”</p>${readingHtml(rc)}</header>
    ${crossed}${unverified}${gap}${truncated}${closed}<ol class="msgs" aria-live="polite">${msgs}</ol>${refusal}${draftHtml(caseId, rc, th)}${staffHtml(caseId, rc, th)}${tryHtml(caseId)}</section>`;
}

function render() {
  const saved = saveFields(root);
  const c = S().chat;
  const body = c.connection.state === STATUS.SDK_NOT_LOADED ? "" : `<div class="desk-grid">${inboxHtml()}${ui.caseId ? threadHtml(ui.caseId) : ""}</div>`;
  root.innerHTML = `<header class="side-head"><h1>Returns desk · staff</h1><span class="fine">seat ${c.seat} · visit ${esc(c.visit)}</span></header>${connectionHtml()}${c.connection.state === STATUS.SDK_NOT_LOADED ? "" : phoneHtml()}${body}`;
  restoreFields(root, saved);
}

export async function bootDesk({ transport, seat, seatCount, visit, mount }) {
  root = mount;
  session = { seat: seat.n, seatCount, visit };
  t = await createPagesTransport({ tick: false, chat: { transport, seat, side: "desk", visit } });
  // The phone link's fold stays as staff left it across redraws (toggle does not bubble).
  root.addEventListener(
    "toggle",
    (e) => {
      if (e.target.classList?.contains("phone-link")) ui.phoneOpen = e.target.open;
    },
    true,
  );
  root.addEventListener("click", async (e) => {
    const el = e.target.closest("[data-action]");
    if (!el || el.disabled || ui.busy) return;
    const fn = actions[el.dataset.action];
    if (!fn) return;
    ui.busy = true;
    try {
      await fn(el);
    } finally {
      ui.busy = false;
    }
  });
  t.chat.onChange(coalesced(refresh));
  await refresh();
  await t.chat.connect();
  ui.ready = true;
  await refresh();
}
