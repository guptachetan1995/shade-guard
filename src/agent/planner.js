// The deterministic planner: the agent. It is not a language model. nextCall(plan) is a pure
// function from what the agent has learned to its next tool call, and observe(plan, call,
// response) is a pure function that folds a tool's response back in. The agent knows only
// what the tools tell it, and runPlanner drives it through invoke() with actor "agent",
// pinned here in code.
import { decide } from "../rules/recommend.js";

export const AGENT = "agent";

export function initialPlan({ checkId = null, caseId = null }) {
  return {
    checkId,
    caseId,
    phase: checkId ? "lines" : "case",
    lines: [],
    covered: [],
    uncovered: [],
    budget: null,
    spentOnCheck: 0,
    unavailableReason: "budget",
    complexion: null,
    retake: null,
    shades: {},
    rankings: {},
    decisions: {},
    queue: [],
    previews: {},
    drafted: [],
    lineDrafts: {},
    rcase: null,
    outcome: null,
  };
}

const productsOf = (lines) => [...new Set(lines.map((l) => l.productId))];

function previewQueue(plan) {
  const seen = new Set();
  const queue = [];
  const push = (productId, shadeCode, finish) => {
    const key = `${productId}|${shadeCode}|${finish}`;
    if (!seen.has(key)) {
      seen.add(key);
      queue.push({ productId, shadeCode, finish });
    }
  };
  const suggested = plan.complexion.skinType.finish;
  for (const line of plan.covered) {
    const d = plan.decisions[line.lineId];
    const shades = plan.shades[line.productId];
    const finishFor = (code) => {
      const finishes = shades.find((s) => s.code === code).finishes;
      return finishes.includes(suggested) ? suggested : finishes.includes(line.finish) ? line.finish : finishes[0];
    };
    push(line.productId, line.shadeCode, line.finish);
    const others = d.decision === "swap" ? [d.shadeCode] : d.decision === "sample_duo" ? d.shadeCodes : d.decision === "no_match" ? [d.nearest] : [];
    for (const code of others) push(line.productId, code, finishFor(code));
  }
  return queue;
}

function remainingUnits(plan) {
  return plan.budget.unitCapPerCheck - plan.spentOnCheck;
}

function draftCall(plan, line) {
  const base = { checkId: plan.checkId, lineId: line.lineId };
  if (!plan.covered.includes(line)) {
    return { ...base, decision: "unavailable", evidence: { remainingUnits: remainingUnits(plan), reason: plan.unavailableReason } };
  }
  if (plan.retake) return { ...base, decision: "retake", evidence: { errorCode: plan.retake.errorCode } };
  const d = plan.decisions[line.lineId];
  const r = plan.rankings[line.productId];
  const de = (code) => r.ranking.find((x) => x.code === code).de00;
  if (d.decision === "no_match") {
    return { ...base, decision: "no_match", evidence: { bestDeltaE: r.ranking[0].de00, nearest: r.ranking[0].code } };
  }
  const codes = [line.shadeCode, ...(d.decision === "swap" ? [d.shadeCode] : d.decision === "sample_duo" ? d.shadeCodes : [])];
  const previewIds = (plan.previews[line.productId] ?? []).filter((p) => codes.includes(p.shadeCode)).map((p) => p.previewId);
  const evidence = { deltaE: Object.fromEntries(codes.map((c) => [c, de(c)])), band: r.band, previewIds };
  if (d.decision === "swap") return { ...base, decision: "swap", shadeCode: d.shadeCode, evidence };
  if (d.decision === "sample_duo") return { ...base, decision: "sample_duo", shadeCodes: d.shadeCodes, evidence };
  return { ...base, decision: "keep", evidence };
}

function resolutionFor(rcase, reading, lineDraft) {
  const decision = reading.draftDecision;
  const deltaE = (codes) => Object.fromEntries(codes.map((c) => [c, reading.ranking.find((r) => r.code === c).de00]));
  if (decision === "swap") {
    return { caseId: rcase.caseId, resolution: "exchange", shadeCode: reading.recommended[0], evidence: { deltaE: deltaE([rcase.shadeCode, reading.recommended[0]]) } };
  }
  if (decision === "sample_duo") {
    return {
      caseId: rcase.caseId,
      resolution: "exchange",
      shadeCode: lineDraft?.sampleDuoSku ?? rcase.sampleDuoSku,
      evidence: { deltaE: deltaE([rcase.shadeCode, ...reading.recommended]) },
    };
  }
  if (decision === "keep") return { caseId: rcase.caseId, resolution: "refund", evidence: { reason: "returned_shade_is_closest" } };
  return { caseId: rcase.caseId, resolution: "refund", evidence: { reason: "no_match" } };
}

export function nextCall(plan) {
  switch (plan.phase) {
    case "case":
    case "lines":
    case "refresh_case":
      return plan.caseId ? { tool: "list_return_cases", args: {} } : { tool: "get_cart", args: {} };
    case "budget":
      return { tool: "get_unit_budget", args: { checkId: plan.checkId } };
    case "measure":
      return { tool: "measure_complexion", args: { checkId: plan.checkId } };
    case "rank": {
      const productId = productsOf(plan.covered).find((p) => !plan.rankings[p] || !plan.shades[p]);
      if (!plan.rankings[productId]) return { tool: "rank_shades", args: { checkId: plan.checkId, productId } };
      return { tool: "list_shades", args: { productId } };
    }
    case "preview": {
      const { productId, shadeCode, finish } = plan.queue[0];
      return { tool: "preview_shade", args: { checkId: plan.checkId, productId, shadeCode, finish } };
    }
    case "draft": {
      const line = plan.lines.find((l) => !plan.drafted.includes(l.lineId));
      return { tool: "draft_recommendation", args: draftCall(plan, line) };
    }
    case "resolve":
      return { tool: "draft_return_resolution", args: resolutionFor(plan.rcase, plan.rcase.reading, plan.lineDrafts[plan.caseId]) };
    default:
      return null;
  }
}

// After a returns check's line is drafted, the agent re-reads the case to cite the reading
// now attached to it, then drafts the resolution.
function afterDrafts(plan) {
  const lineDraft = plan.lineDrafts[plan.caseId];
  if (plan.caseId && lineDraft && !["retake", "unavailable"].includes(lineDraft.decision)) {
    plan.phase = "refresh_case";
  } else {
    plan.phase = "done";
    plan.outcome = plan.outcome ?? "drafted";
  }
}

export function observe(previous, call, response) {
  const plan = structuredClone(previous);
  if (plan.budget && response.units) plan.spentOnCheck += response.units;
  const r = response.result;

  switch (call.tool) {
    case "get_cart":
      plan.lines = r.lines.filter((l) => l.complexion && l.shadeCode).map(({ lineId, productId, shadeCode, finish }) => ({ lineId, productId, shadeCode, finish }));
      plan.phase = "budget";
      break;
    case "list_return_cases": {
      const rcase = r.cases.find((c) => c.caseId === plan.caseId);
      if (plan.phase === "case" || plan.phase === "refresh_case") {
        plan.rcase = rcase;
        if (rcase?.reading && rcase.status === "open") plan.phase = "resolve";
        else {
          plan.phase = "done";
          plan.outcome = rcase?.status === "awaiting_check" ? "awaiting_shopper_check" : "nothing_to_draft";
        }
      } else {
        plan.rcase = rcase;
        plan.lines = [{ lineId: rcase.caseId, productId: rcase.productId, shadeCode: rcase.shadeCode, finish: rcase.finish }];
        plan.phase = "budget";
      }
      break;
    }
    case "get_unit_budget": {
      plan.budget = r;
      plan.spentOnCheck = r.unitsSpent;
      plan.lines = plan.lines.filter((l) => r.lineIds.includes(l.lineId));
      plan.covered = plan.lines.slice(0, r.linesAffordable);
      plan.uncovered = plan.lines.slice(r.linesAffordable);
      plan.phase = plan.covered.length ? "measure" : "draft";
      break;
    }
    case "measure_complexion":
      if (!response.ok) {
        plan.unavailableReason = response.error.code === "balance_low" ? "credit" : "budget";
        if (!["unit_cap", "balance_low"].includes(response.error.code)) {
          plan.phase = "done";
          plan.outcome = `failed:${response.error.code}`;
          break;
        }
        plan.covered = [];
        plan.phase = "draft";
      } else if (r.status === "measured") {
        plan.complexion = r.complexion;
        plan.phase = "rank";
      } else if (r.status === "stopped") {
        plan.phase = "done";
        plan.outcome = "stopped_waiting";
      } else if (r.status === "retake") {
        plan.retake = { errorCode: r.errorCode, guidance: r.guidance };
        plan.phase = "draft";
      } else {
        plan.unavailableReason = "credit";
        plan.covered = [];
        plan.phase = "draft";
      }
      break;
    case "rank_shades":
      plan.rankings[call.args.productId] = r;
      break;
    case "list_shades":
      plan.shades[call.args.productId] = r.shades;
      if (productsOf(plan.covered).every((p) => plan.rankings[p] && plan.shades[p])) {
        for (const line of plan.covered) {
          const rk = plan.rankings[line.productId];
          plan.decisions[line.lineId] = decide({ ranking: rk.ranking, cartShadeCode: line.shadeCode, band: rk.band });
        }
        plan.queue = previewQueue(plan);
        plan.phase = plan.queue.length ? "preview" : "draft";
      }
      break;
    case "preview_shade":
      plan.queue.shift();
      if (response.ok && r.status === "stopped") {
        plan.phase = "done";
        plan.outcome = "stopped_waiting";
        break;
      }
      if (response.ok && r.status === "rendered") {
        (plan.previews[call.args.productId] ??= []).push({ previewId: r.previewId, shadeCode: r.shadeCode });
      }
      if (!plan.queue.length) plan.phase = "draft";
      break;
    case "draft_recommendation":
      plan.drafted.push(call.args.lineId);
      if (response.ok) plan.lineDrafts[call.args.lineId] = r.draft;
      if (plan.drafted.length === plan.lines.length) afterDrafts(plan);
      break;
    case "draft_return_resolution":
      plan.phase = "done";
      plan.outcome = response.ok ? `resolution:${r.draft.resolution}` : `refused:${response.error.code}`;
      break;
  }
  return plan;
}

export async function runPlanner(invoke, { checkId = null, caseId = null }, { maxSteps = 80 } = {}) {
  let plan = initialPlan({ checkId, caseId });
  const transcript = [];
  for (let step = 0; step < maxSteps; step++) {
    const call = nextCall(plan);
    if (!call) break;
    const response = await invoke(call.tool, call.args, AGENT);
    transcript.push({ tool: call.tool, args: call.args, ok: response.ok, units: response.units, ...(response.ok ? {} : { code: response.error.code }) });
    plan = observe(plan, call, response);
  }
  return { plan, transcript };
}
