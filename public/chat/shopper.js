// The shopper's phone: her order, the chat with the store, her own check and the cards the
// store sends. One side of the chat, with its own app and store; it shares only the chat
// service with the desk. Her buttons are the human-only shopper verbs (shopper_send,
// share_reading, accept_offer); the agent can't press any of them.
import { createPagesTransport } from "../../src/pages-entry.js";
import { fakePhoto, toBase64 } from "../../src/providers/fake-photos.js";
import { TYPES } from "../../src/chat/messages.js";
import { MAX_PAGES, PAGE_SIZE, STATUS } from "../../src/chat/transport.js";
import { acceptanceOf, isClosed, newestOffer } from "../../src/threads.js";
import { $, coalesced, connectionBar, esc, messageHtml, pageUrl, restoreFields, saveFields, viaOf } from "./common.js";

const ui = { busy: false, refusal: null, checking: false };
let t;
let state;
let session;
let root;

const S = () => state.state;
const me = () => S().chat.me;
const rcase = () => S().returnCases.find((c) => c.caseId === me().caseId);
const thread = () => S().threads[me().caseId];
const connected = () => S().chat.connection.state === STATUS.CONNECTED;

async function refresh() {
  state = await t.request("GET", "/api/state");
  render();
}

async function invoke(tool, args) {
  const r = await t.request("POST", "/api/invoke", { tool, args, actor: "shopper" });
  ui.refusal = r.ok ? null : { tool, code: r.error.code, message: r.error.message };
  return r;
}

function latestReturnCheck() {
  return S().checks.filter((c) => c.origin.from === "return" && c.origin.caseId === me().caseId).at(-1) ?? null;
}

const actions = {
  "start-return": async () => {
    await invoke("shopper_send", { kind: "return_request" });
    await refresh();
  },
  send: async () => {
    const box = $("#say");
    const r = await invoke("shopper_send", { kind: "note", text: box.value });
    if (r.ok) box.value = "";
    await refresh();
  },
  accept: async (el) => {
    await invoke("accept_offer", { caseId: me().caseId, draftId: el.dataset.draft });
    await refresh();
  },
  // The check runs on the app's synthetic sample shopper, never a real face; the full capture
  // page is the store's own return page.
  check: async () => {
    const caseId = me().caseId;
    const started = await invoke("start_check", { photo: toBase64(fakePhoto("sample-shopper")), capture: "upload", caseId });
    if (!started.ok) return refresh();
    ui.checking = true;
    render();
    await t.request("POST", "/api/agent", { checkId: started.result.checkId, caseId });
    ui.checking = false;
    await refresh();
  },
  share: async (el) => {
    await invoke("share_reading", { checkId: el.dataset.check, caseId: me().caseId });
    await refresh();
  },
  "another-seat": () => {
    const seat = (session.seat % session.seatCount) + 1;
    (window.top ?? window).location.href = pageUrl({ seat, visit: session.visit });
  },
};

function connectionHtml() {
  return connectionBar(S().chat.connection, t.chat.transport.describe());
}

function whoHtml() {
  const other = session.as === 0 ? 1 : 0;
  const names = ["Maya", "Asha"];
  return `<p class="fine">You are ${esc(me().name)}. <a href="${esc(pageUrl({ side: "shopper", seat: session.seat, as: other, visit: session.visit }))}">Switch to ${names[other]}'s phone</a></p>`;
}

function orderHtml() {
  const rc = rcase();
  const th = thread();
  const requested = th.messages.some((m) => m.type === TYPES.RETURN_REQUEST);
  const lines = S().orders.find((o) => o.orderId === rc.orderId)?.lines[0];
  const p = S().catalogue.products.find((x) => x.productId === rc.productId);
  const button = requested
    ? `<p class="outcome">Return requested. The store has your request.</p>`
    : `<button type="button" class="btn primary" data-action="start-return" ${!connected() || isClosed(th) ? "disabled" : ""}>Start a return: wrong shade, opened</button>`;
  return `<section class="card order"><h2>Order ${esc(rc.orderId)}</h2><p>${esc(p.name.replace(/\s*\(.*\)\s*$/, ""))} · ${esc(rc.shadeCode)} · ${esc(lines?.finish ?? rc.finish)}</p>${button}</section>`;
}

function checkHtml() {
  const rc = rcase();
  const check = latestReturnCheck();
  if (ui.checking) return `<section class="card"><p>Checking your shade…</p></section>`;
  if (rc.reading && !check) return `<section class="card"><h2>Your shade reading</h2><p class="fine">Your order already carries a reading, as numbers only. The store reads it from the chat when you share one.</p></section>`;
  const ready = check && check.status === "closed" && check.complexion && !check.sharedReading;
  const shared = check?.sharedReading;
  return `<section class="card"><h2>Check your shade</h2>
    <p class="fine">Sample data: this check uses the app's synthetic sample shopper, not a real face. Your photo is deleted when the check closes; only numbers are ever shared.</p>
    <div class="actions"><button type="button" class="btn" data-action="check" ${shared ? "disabled" : ""}>Check my shade</button>
    ${ready ? `<button type="button" class="btn primary" data-action="share" data-check="${esc(check.checkId)}" ${!connected() || isClosed(thread()) ? "disabled" : ""}>Share my reading</button>` : ""}</div>
    ${shared ? `<p class="outcome">Reading shared as numbers only.</p>` : ""}</section>`;
}

function threadHtml() {
  const th = thread();
  const via = viaOf(t.chat.transport);
  const offer = newestOffer(th);
  const accepted = offer && acceptanceOf(th, offer);
  const acceptBtn = (m) =>
    m === offer && !accepted && !isClosed(th)
      ? `<button type="button" class="btn primary small" data-action="accept" data-draft="${esc(m.content.draftId)}" ${connected() ? "" : "disabled"}>Accept</button>`
      : m === offer && accepted
        ? `<span class="chip ok">Accepted</span>`
        : "";
  const msgs = th.messages.length
    ? th.messages.map((m) => messageHtml(m, { via, extra: m.type === TYPES.OFFER ? acceptBtn(m) : "" })).join("")
    : `<li class="empty">No messages yet.</li>`;
  const closed = isClosed(th);
  const truncated = th.historyTruncated ? `<p class="banner" role="note"><b>Older messages are not loaded.</b> This channel holds more than the last ${MAX_PAGES * PAGE_SIZE} messages; the chat shows the newest part.</p>` : "";
  const gap = th.readGap ? `<p class="banner" role="note" data-read-gap="true"><b>Some messages may be missing.</b> While your connection was away, more than ${MAX_PAGES * PAGE_SIZE} messages reached this chat; it shows the newest ones.</p>` : "";
  const refusal = ui.refusal ? `<p class="refusal" role="alert"><b>Not done: ${esc(ui.refusal.code)}.</b> ${esc(ui.refusal.message)}</p>` : "";
  return `<section class="card thread"><h2>Chat with the store</h2><ol class="msgs" aria-live="polite">${msgs}</ol>${gap}${truncated}${refusal}
    ${closed ? `<p class="banner">The store closed this case. The chat is read-only.</p>` : ""}
    <div class="composer"><label class="sr-only" for="say">Your message</label><input type="text" id="say" maxlength="500" placeholder="Write to the store" ${!connected() || closed ? "disabled" : ""}>
    <button type="button" class="btn" data-action="send" ${!connected() || closed ? "disabled" : ""}>Send</button></div></section>`;
}

function render() {
  const saved = saveFields(root);
  const c = S().chat;
  const body = c.connection.state === STATUS.SDK_NOT_LOADED ? "" : `${whoHtml()}${orderHtml()}${checkHtml()}${threadHtml()}`;
  root.innerHTML = `<header class="side-head"><h1>Tint &amp; Tone · your phone</h1><span class="fine">seat ${c.seat} · visit ${esc(c.visit)}</span></header>${connectionHtml()}${body}`;
  restoreFields(root, saved);
}

export async function bootShopper({ transport, seat, seatCount, as, visit, mount }) {
  root = mount;
  session = { seat: seat.n, seatCount, as, visit };
  t = await createPagesTransport({ tick: true, chat: { transport, seat, side: "shopper", as, visit } });
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
  root.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter" || e.target.id !== "say" || ui.busy) return;
    ui.busy = true;
    try {
      await actions.send();
    } finally {
      ui.busy = false;
    }
  });
  t.chat.onChange(coalesced(refresh));
  await refresh();
  await t.chat.connect();
  await refresh();
}
