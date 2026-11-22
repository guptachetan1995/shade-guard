// The one page module that reaches for the offline chat service: its client, its config route,
// its banner and its walk-only controls. The static build leaves this file, and the service's
// own files, out: the static demo shows a real connection or says it has none.
import { createFakeClient } from "../../src/chat/fake-client.js";
import { esc } from "./common.js";

export function localTransportFor(userId) {
  return createFakeClient({ userId });
}

// The service's config when the local server was started with it, else null.
export async function localConfig() {
  const res = await fetch("/api/fake-chat/config");
  const body = await res.json();
  return body.ok ? { kind: "fake", banner: body.banner, seats: body.seats, maxConnections: body.maxConnections, deliveryDelayMs: body.deliveryDelayMs } : null;
}

export function bannerHtml(config) {
  return `<p class="mode-banner offline-banner" role="note"><b>FAKE CHAT (offline).</b> ${esc(config.banner.replace(/^FAKE CHAT \(offline\):\s*/, ""))}</p>`;
}

export function controlsHtml(seat, as) {
  return `<details class="offline-controls"><summary>Fake service controls (offline walk only)</summary>
    <p class="fine">These switch the fake service's own failure modes, so each state's words can be seen. The agent has no route to them.</p>
    <div class="actions">
      <button type="button" class="btn small" data-c="drop" data-u="${esc(seat.deskUserId)}">Drop the desk's connection</button>
      <button type="button" class="btn small" data-c="drop" data-u="${esc(seat.shoppers[as].userId)}">Drop the phone's connection</button>
      <button type="button" class="btn small" data-c="kick" data-u="${esc(seat.deskUserId)}">Another tab takes the desk's seat (kicked)</button>
      <button type="button" class="btn small" data-c="pause" data-u="${esc(seat.deskUserId)}">Pause the desk's connection</button>
      <button type="button" class="btn small" data-c="resume" data-u="${esc(seat.deskUserId)}">Bring the desk back (it reads back what it missed)</button>
      <button type="button" class="btn small" data-c="fail_reads">Thread reads fail</button>
      <button type="button" class="btn small" data-c="ok_reads">Thread reads work</button>
      <button type="button" class="btn small" data-c="unreachable">Service unreachable</button>
      <button type="button" class="btn small" data-c="reachable">Service reachable</button>
      <button type="button" class="btn small" data-c="fill" data-u="${esc(seat.deskUserId)}">Fill the desk's seat (the next connect is busy)</button>
      <button type="button" class="btn small" data-c="free" data-u="${esc(seat.deskUserId)}">Free the desk's seat</button>
    </div></details>`;
}

export function bindControls(mount) {
  mount.addEventListener("click", async (e) => {
    const el = e.target.closest("[data-c]");
    if (!el) return;
    await fetch("/api/fake-chat/control", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: el.dataset.c, userId: el.dataset.u }) });
  });
}
