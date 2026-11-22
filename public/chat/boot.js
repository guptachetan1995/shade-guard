// chat.html is three pages in one file: with no ?side it is the frame holding two iframes; with
// ?side=desk or ?side=shopper it is that side, running its own app in this tab.
import { $, loadChatConfig, makeTransport, params, sideOf } from "./common.js";

const mount = $("#chat-root");
const p = params();

async function bootSide() {
  const config = await loadChatConfig();
  const { seat, visit, userId } = sideOf(p, config);
  const transport = await makeTransport(config, userId);
  // The live probe reads each side's connection from the console (frames[0].sgProbe in the frame), and
  // may page a channel or send a probe message itself. It holds nothing a visitor of the public demo
  // does not already hold: the seat's token is in the page either way.
  if (p.probe) globalThis.sgProbe = { side: p.side, userId, transport, describe: () => transport.describe(), status: () => transport.status(), diagnostics: () => transport.diagnostics?.() ?? [] };
  const common = { transport, seat, seatCount: config.seats.length, visit, mount };
  document.body.classList.add(`side-${p.side}`);
  if (p.side === "desk") {
    const { bootDesk } = await import("./desk.js");
    return bootDesk(common);
  }
  const { bootShopper } = await import("./shopper.js");
  return bootShopper({ ...common, as: p.as });
}

async function boot() {
  if (p.side === "desk" || p.side === "shopper") return bootSide();
  const { bootFrame } = await import("./frame.js");
  return bootFrame({ mount, seat: p.seat, visit: p.visit, probe: p.probe, isolate: p.isolate });
}

boot().catch((e) => {
  mount.innerHTML = `<p class="card branch problem">The support chat couldn't load: ${String(e.message).replace(/[<&]/g, "")}</p>`;
});
