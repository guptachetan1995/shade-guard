// The in-memory store: cart, catalogue, checks, return cases, range gaps, budget and the
// activity log. `state` is plain data (what /api/state serves). Photo and render bytes live
// only in `blobs`, keyed by check, so they never reach the state, the log or an order.
import { DECISIONS } from "./rules/recommend.js";
import { emptyThread } from "./threads.js";

export const DEFAULT_UNIT_CAP_PER_CHECK = 40;

const randomTag = () => [...globalThis.crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, "0")).join("");

// chat: the session of one side of one seat (src/chat/seats.js sessionFor, plus the visit id), or
// null for an app with no chat. Each return case a chat peer belongs to gets a thread.
export function createStore({ catalogue, cart, returns, unitCapPerCheck = DEFAULT_UNIT_CAP_PER_CHECK, now, chat = null } = {}) {
  const clock = now ?? (() => new Date().toISOString());
  const state = {
    cart: { lines: cart.lines.map((l) => ({ ...l })) },
    catalogue: { products: catalogue.products },
    orders: returns.orders,
    checks: [],
    returnCases: returns.returnCases,
    rangeGaps: [],
    budget: {
      unitCapPerCheck,
      unitsSpentTotal: 0,
      balance: null,
      checksByOutcome: Object.fromEntries(DECISIONS.map((d) => [d, 0])),
      ledger: [],
    },
    activityLog: [],
    // otherVisitDropped: messages of other visits (the seat's channel is shared) dropped on arrival, counted and nothing else.
    chat: chat ? { ...structuredClone(chat), connection: { state: "idle", code: null, detail: null }, otherVisitDropped: 0 } : null,
    threads: {},
    replyDrafts: [],
  };
  for (const [userId, peer] of Object.entries(chat?.peers ?? {})) {
    if (peer.caseId) state.threads[peer.caseId] = emptyThread(peer.caseId, userId);
  }
  const blobs = new Map();
  const seq = { chk: 0, pv: 0, draft: 0 };
  const draftTag = randomTag();

  return {
    state,
    blobs,
    now: clock,
    nextCheckId: () => `chk_${String(++seq.chk).padStart(2, "0")}`,
    nextPreviewId: () => `pv_${++seq.pv}`,
    // A draft id names one offer in a thread, and her Accept names the offer by it. It carries this
    // store's own random tag, so two tabs of the desk, a reload, or a restore cut short before an
    // older offer never hand out the same id: no read of the mirror could promise that.
    nextDraftId: () => `d_${draftTag}_${String(++seq.draft).padStart(2, "0")}`,
    getCheck: (checkId) => state.checks.find((c) => c.checkId === checkId) ?? null,
    getProduct: (productId) => state.catalogue.products.find((p) => p.productId === productId) ?? null,
    getShade(productId, code) {
      return this.getProduct(productId)?.shades.find((s) => s.code === code) ?? null;
    },
    getCase: (caseId) => state.returnCases.find((c) => c.caseId === caseId) ?? null,
    getCartLine: (lineId) => state.cart.lines.find((l) => l.lineId === lineId) ?? null,
    snapshot: () => structuredClone(state),
  };
}

export function chargeUnits(store, check, { tool, feature, taskId, units }) {
  if (!units) return;
  check.unitsSpent += units;
  store.state.budget.unitsSpentTotal += units;
  store.state.budget.ledger.push({ at: store.now(), checkId: check.checkId, tool, feature, taskId, units });
}
