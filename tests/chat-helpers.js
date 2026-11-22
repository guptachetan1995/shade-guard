// Two apps, one fake chat service: the desk's and one shopper's. Each is its own createApp with
// its own store, as the two iframes are in the page; they share nothing but the service.
import { createApp } from "../src/app.js";
import { FakeYouCamProvider } from "../src/providers/youcam-fake.js";
import { FakeChatServer } from "../src/chat/fake-transport.js";
import { TRANSPORT_METHODS } from "../src/chat/transport.js";
import { fixedClock, noWait } from "./helpers.js";

export const SERVER_EPOCH = 1_800_000_000_000;

export async function makeChatDuo({ seatIndex = 0, shopperIndex = 0, visit = "visit-a", serverOptions = {}, deskNow, shopperNow, deskTransport, connect = true } = {}) {
  const server = new FakeChatServer({ clock: () => SERVER_EPOCH, ...serverOptions });
  const seat = server.seats[seatIndex];
  const dt = deskTransport ? deskTransport(server.transport(seat.deskUserId)) : server.transport(seat.deskUserId);
  const st = server.transport(seat.shoppers[shopperIndex].userId);
  const desk = await createApp({ provider: new FakeYouCamProvider(), now: deskNow ?? fixedClock(), wait: noWait, chat: { transport: dt, seat, side: "desk", visit } });
  const shopper = await createApp({ provider: new FakeYouCamProvider(), now: shopperNow ?? fixedClock("2026-10-30T07:00:00.000Z"), wait: noWait, chat: { transport: st, seat, side: "shopper", as: shopperIndex, visit } });
  if (connect) {
    await desk.chat.connect();
    await shopper.chat.connect();
  }
  // Delivers everything waiting on the service, then waits for the chokepoint to record it.
  async function settle() {
    for (let i = 0; i < 6; i++) {
      server.deliverAll();
      await desk.chat.settled();
      await shopper.chat.settled();
    }
  }
  return { server, seat, desk, shopper, settle, deskTransport: dt, shopperTransport: st, caseId: seat.shoppers[shopperIndex].caseId };
}

// A transport that behaves as `t` but lets a test run code just before or instead of one call:
// the way to stage the one round trip between a thread read and a send.
export function wrapTransport(t, overrides = {}) {
  const out = {};
  for (const m of TRANSPORT_METHODS) out[m] = (...args) => t[m](...args);
  return Object.assign(out, overrides);
}

export const messagesOf = (app, caseId) => app.store.state.threads[caseId].messages;
export const textsOf = (app, caseId) => messagesOf(app, caseId).map((m) => m.content.text ?? m.type);

// ---- the shared walk: the shopper asks, the agent drafts, staff send, she accepts ----

export const EV104 = { shadeCode: "245W", deltaE: { "245W": 2.1, "250W": 3.51, "220N": 5.0 }, band: 1 };
export const R104 = { caseId: "R-104" };

export async function shopperRequests(duo) {
  const r = await duo.shopper.invoke("shopper_send", { kind: "return_request" }, "shopper");
  if (!r.ok) throw new Error(`shopper_send refused: ${r.error.code}`);
  await duo.settle();
  return r.result;
}

export async function agentDrafts(duo) {
  const r = await duo.desk.invoke("draft_return_resolution", { ...R104, resolution: "exchange", shadeCode: "245W", evidence: { deltaE: { "220N": 5.0, "245W": 2.1 } } }, "agent");
  if (!r.ok) throw new Error(`draft_return_resolution refused: ${r.error.code}`);
  const d = await duo.desk.invoke("draft_reply", { ...R104, kind: "exchange_offer", evidence: EV104 }, "agent");
  if (!d.ok) throw new Error(`draft_reply refused: ${d.error.code}`);
  return d.result.draft;
}

export const staffSendsDraft = (duo, draft) => duo.desk.invoke("send_reply", { ...R104, draftId: draft.draftId, seen: draft.fingerprint }, "staff");

export async function offerSent(duo) {
  await shopperRequests(duo);
  const draft = await agentDrafts(duo);
  const sent = await staffSendsDraft(duo, draft);
  if (!sent.ok) throw new Error(`send_reply refused: ${sent.error.code}`);
  await duo.settle();
  return { draft, sent: sent.result };
}

export async function shopperAccepts(duo, draft) {
  const r = await duo.shopper.invoke("accept_offer", { ...R104, draftId: draft.draftId }, "shopper");
  if (!r.ok) throw new Error(`accept_offer refused: ${r.error.code}`);
  await duo.settle();
  return r.result;
}

export const newestIdOf = (app, caseId = "R-104") => messagesOf(app, caseId).at(-1)?.messageId ?? "";
