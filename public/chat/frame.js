// The top page: the desk on one side, the shopper's phone on the other, each in its own iframe so
// each is its own JavaScript realm with its own app. The two share nothing but the chat service.
// When the service is the offline one, a banner says so on this page, and each side carries its own
// pill beside its connection state (the transport's own words), so one pane shown alone still reads
// as offline.
import { esc, loadChatConfig, pageUrl } from "./common.js";
import { wordsFor } from "../../src/chat/states.js";
import { STATUS } from "../../src/chat/transport.js";

function visitId() {
  try {
    const kept = sessionStorage.getItem("sg-visit");
    if (kept) return kept;
  } catch {
    // storage blocked: a fresh visit id each load
  }
  const id = crypto.randomUUID().slice(0, 8);
  try {
    sessionStorage.setItem("sg-visit", id);
  } catch {
    // not kept
  }
  return id;
}

export const NEXCONN_NOTE =
  "Both sides connect to the Nexconn chat service as fictional demo users, and every message crosses it. The demo users' tokens are in this public page, so anyone who opens it can write as them on this seat.";

export async function bootFrame({ mount, seat: seatParam, visit: visitParam, probe = false, isolate = false }) {
  const config = await loadChatConfig();
  const seatCount = config.seats.length;
  const seat = config.seats.find((s) => s.n === seatParam) ?? config.seats[Math.floor(Math.random() * seatCount)];
  const visit = visitParam || visitId();
  const as = 0;
  const query = (side, extra = {}) => pageUrl({ side, seat: seat.n, visit, ...(probe ? { probe: 1 } : {}), ...extra });
  const none = wordsFor(STATUS.SDK_NOT_LOADED);
  const why = config.detail ? ` (${esc(config.detail)})` : "";
  let banner = `<p class="mode-banner none-chat" role="note"><b>${esc(none.label)}.</b> ${esc(none.words)} There is no chat service in this build${why}, so no message can be sent or received here.</p>`;
  let controls = "";
  let local = null;
  if (config.kind === "fake") {
    local = await import("./local-transport.js");
    banner = local.bannerHtml(config);
    controls = local.controlsHtml(seat, as);
  } else if (config.kind === "nexconn") {
    banner = `<p class="mode-banner nexconn-chat" role="note"><b>On Nexconn.</b> ${esc(NEXCONN_NOTE)}</p>`;
  }
  mount.innerHTML = `<header class="frame-head"><div><h1>Shade Guard support chat</h1><p class="lede">A wrong-shade return as a live thread between a shopper and a store. The agent drafts; only staff send, approve or close.</p></div>
      <p class="fine">Seat ${seat.n} of ${seatCount} · visit ${esc(visit)} · <a href="${esc(pageUrl({ seat: (seat.n % seatCount) + 1 }))}">Open another seat</a> · <a href="index.html">The store</a></p></header>
    ${banner}${controls}
    <div class="panes">
      <section class="pane"><iframe title="Returns desk (staff)" src="${esc(query("desk"))}"></iframe></section>
      <section class="pane phone"><iframe title="The shopper's phone"${isolate ? " credentialless" : ""} src="${esc(query("shopper", { as }))}"></iframe></section>
    </div>`;
  local?.bindControls(mount);
}
