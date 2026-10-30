// What the merchant panel shows: drafts by outcome, units per check against the cap, and the
// range-gap list. Numbers only; nothing here can lead back to a face.
import { summariseRangeGaps } from "./rules/range-gap.js";

export function merchantSummary(state) {
  return {
    unitCapPerCheck: state.budget.unitCapPerCheck,
    unitsSpentTotal: state.budget.unitsSpentTotal,
    checksByOutcome: { ...state.budget.checksByOutcome },
    unitsPerCheck: state.checks.map((c) => ({
      checkId: c.checkId,
      origin: c.origin.from,
      units: c.unitsSpent,
      lines: c.lineIds.length,
      outcomes: Object.fromEntries(Object.entries(c.lines).map(([id, l]) => [id, l.draft?.decision ?? null])),
    })),
    rangeGaps: summariseRangeGaps(state.rangeGaps, state.catalogue.products),
  };
}
