// The in-memory store: cart, catalogue, checks, return cases, range gaps, budget and the
// activity log. `state` is plain data (what /api/state serves). Photo and render bytes live
// only in `blobs`, keyed by check, so they never reach the state, the log or an order.
import { DECISIONS } from "./rules/recommend.js";

export const DEFAULT_UNIT_CAP_PER_CHECK = 40;

export function createStore({ catalogue, cart, returns, unitCapPerCheck = DEFAULT_UNIT_CAP_PER_CHECK, now } = {}) {
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
  };
  const blobs = new Map();
  const seq = { chk: 0, pv: 0 };

  return {
    state,
    blobs,
    now: clock,
    nextCheckId: () => `chk_${String(++seq.chk).padStart(2, "0")}`,
    nextPreviewId: () => `pv_${++seq.pv}`,
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
