// The seven human-only verbs. They are never registered as agent tools: tools.js never imports
// this file, tool discovery never lists them, and invoke() refuses each one for every actor
// but its own (the agent included).
import { checkPhoto, PhotoError } from "./photo-check.js";
import { fromBase64 } from "./providers/fake-photos.js";
import { closeCheck, cartCheckSettled, stillWorkingTasks, STILL_WORKING_MS } from "./check-lifecycle.js";
import { refuse } from "./refusal.js";

const MAX_UNIT_CAP = 1000;

function mustCheck(store, checkId) {
  const check = store.getCheck(checkId);
  if (!check) refuse("unknown_check", `No check ${checkId} exists.`);
  return check;
}

function mustDecidableLine(store, checkId, lineId) {
  const check = mustCheck(store, checkId);
  if (check.origin.from !== "cart") refuse("not_a_cart_line", "A returns check is resolved by staff, not in the cart.");
  if (check.status !== "open") refuse("check_closed", `Check ${checkId} is closed.`);
  const line = check.lines[lineId];
  if (!line) refuse("line_not_in_check", `Check ${checkId} doesn't cover line ${lineId}.`);
  if (!line.draft) refuse("no_draft", `Line ${lineId} has no draft yet.`);
  if (line.outcome) refuse("line_decided", `Line ${lineId} was already decided.`);
  if (!store.getCartLine(lineId)) refuse("line_not_in_cart", `Line ${lineId} is no longer in the cart.`);
  check.lastActivityAt = store.now();
  return { check, line };
}

async function settle(store, provider, check) {
  if (cartCheckSettled(check)) await closeCheck(store, provider, check, "every_line_settled");
  return check.status === "closed" ? structuredClone(check.privacyReceipt) : null;
}

const start_check = {
  name: "start_check",
  actor: "shopper",
  args: {
    photo: { type: "string", required: true, description: "The normalised JPEG, base64." },
    capture: { type: "string", required: true, enum: ["camera-kit", "upload"] },
    caseId: { type: "string", description: "A return case awaiting a check." },
  },
  run({ photo, capture, caseId }, { store }) {
    let bytes;
    let info;
    try {
      bytes = fromBase64(photo);
      info = checkPhoto(bytes);
    } catch (e) {
      if (e instanceof PhotoError) refuse(e.code, e.message);
      refuse("photo_unreadable", "The photo is not valid base64.");
    }

    let origin;
    let lines;
    if (caseId) {
      const rcase = store.getCase(caseId);
      if (!rcase) refuse("unknown_case", `No return case ${caseId} exists.`);
      if (rcase.status !== "awaiting_check") refuse("case_not_awaiting_check", `${caseId} is ${rcase.status}; it doesn't need a check.`);
      if (store.state.checks.some((c) => c.status === "open" && c.origin.caseId === caseId)) refuse("check_already_open", `${caseId} already has an open check.`);
      origin = { from: "return", caseId };
      lines = [[caseId, { productId: rcase.productId, shadeCode: rcase.shadeCode, finish: rcase.finish }]];
    } else {
      const open = store.state.checks.find((c) => c.status === "open" && c.origin.from === "cart");
      if (open) refuse("check_already_open", `Check ${open.checkId} is still open for this cart.`);
      origin = { from: "cart" };
      lines = store.state.cart.lines
        .filter((l) => store.getProduct(l.productId)?.complexion && l.shadeCode)
        .map((l) => [l.lineId, { productId: l.productId, shadeCode: l.shadeCode, finish: l.finish }]);
      if (!lines.length) refuse("no_complexion_lines", "The cart has no complexion product to check.");
    }

    const checkId = store.nextCheckId();
    const at = store.now();
    store.state.checks.push({
      checkId,
      origin,
      lineIds: lines.map(([id]) => id),
      status: "open",
      consentAt: at,
      lastActivityAt: at,
      photo: { capture, contentType: info.contentType, width: info.width, height: info.height, bytes: info.bytes },
      fileId: null,
      tasks: [],
      complexion: null,
      retake: null,
      unavailable: null,
      lines: Object.fromEntries(lines.map(([id, l]) => [id, { ...l, ranking: null, previews: [], draft: null, outcome: null }])),
      unitsSpent: 0,
      privacyReceipt: null,
    });
    store.blobs.set(checkId, { photo: bytes, renders: new Map() });
    return { checkId, lineIds: lines.map(([id]) => id), origin };
  },
};

const apply_draft = {
  name: "apply_draft",
  actor: "shopper",
  args: {
    checkId: { type: "string", required: true },
    lineId: { type: "string", required: true },
  },
  async run({ checkId, lineId }, { store, provider }) {
    const { check, line } = mustDecidableLine(store, checkId, lineId);
    const cartLine = store.getCartLine(lineId);
    const d = line.draft;
    switch (d.decision) {
      case "swap":
        cartLine.shadeCode = d.shadeCode;
        cartLine.finish = d.finish;
        break;
      case "sample_duo":
        cartLine.shadeCode = null;
        cartLine.sampleDuo = { sku: d.sampleDuoSku, shadeCodes: [...d.shadeCodes] };
        break;
      case "no_match":
        store.state.cart.lines = store.state.cart.lines.filter((l) => l.lineId !== lineId);
        break;
      case "keep":
        break;
      default:
        refuse("nothing_to_apply", `A ${d.decision} draft has nothing to apply to the cart.`);
    }
    line.outcome = { verb: "apply_draft", actor: "shopper", decision: d.decision, at: store.now() };
    const receipt = await settle(store, provider, check);
    return { lineId, outcome: structuredClone(line.outcome), cart: structuredClone(store.state.cart), privacyReceipt: receipt };
  },
};

const keep_my_shade = {
  name: "keep_my_shade",
  actor: "shopper",
  args: {
    checkId: { type: "string", required: true },
    lineId: { type: "string", required: true },
    reason: { type: "string" },
  },
  async run({ checkId, lineId, reason }, { store, provider }) {
    const { check, line } = mustDecidableLine(store, checkId, lineId);
    line.outcome = { verb: "keep_my_shade", actor: "shopper", decision: line.draft.decision, ...(reason ? { reason } : {}), at: store.now() };
    const receipt = await settle(store, provider, check);
    return { lineId, outcome: structuredClone(line.outcome), privacyReceipt: receipt };
  },
};

function mustOpenCase(store, caseId) {
  const rcase = store.getCase(caseId);
  if (!rcase) refuse("unknown_case", `No return case ${caseId} exists.`);
  if (rcase.status === "exchange_approved" || rcase.status === "refund_approved") refuse("case_closed", `${caseId} is already ${rcase.status}.`);
  return rcase;
}

const approve_exchange = {
  name: "approve_exchange",
  actor: "staff",
  args: { caseId: { type: "string", required: true } },
  run({ caseId }, { store }) {
    const rcase = mustOpenCase(store, caseId);
    if (rcase.draft?.resolution !== "exchange") refuse("no_exchange_draft", `${caseId} has no drafted exchange to approve.`);
    const shade = store.getShade(rcase.productId, rcase.draft.shadeCode);
    if (shade) shade.stock -= 1;
    rcase.status = "exchange_approved";
    rcase.approval = { verb: "approve_exchange", actor: "staff", at: store.now(), replacement: rcase.draft.shadeCode, simulated: true };
    return { caseId, status: rcase.status, approval: structuredClone(rcase.approval) };
  },
};

const approve_refund = {
  name: "approve_refund",
  actor: "staff",
  args: { caseId: { type: "string", required: true } },
  run({ caseId }, { store }) {
    const rcase = mustOpenCase(store, caseId);
    rcase.status = "refund_approved";
    // Simulated: no real money exists anywhere in this entry.
    rcase.approval = { verb: "approve_refund", actor: "staff", at: store.now(), withDraft: rcase.draft?.resolution === "refund", simulated: true };
    return { caseId, status: rcase.status, approval: structuredClone(rcase.approval) };
  },
};

const set_unit_cap = {
  name: "set_unit_cap",
  actor: "merchant",
  args: { unitsPerCheck: { type: "integer", required: true } },
  run({ unitsPerCheck }, { store }) {
    if (unitsPerCheck < 0 || unitsPerCheck > MAX_UNIT_CAP) refuse("bad_args", `unitsPerCheck must be 0–${MAX_UNIT_CAP}.`);
    const before = store.state.budget.unitCapPerCheck;
    store.state.budget.unitCapPerCheck = unitsPerCheck;
    return { unitCapPerCheck: unitsPerCheck, before };
  },
};

// The shopper stops waiting for a task still running after STILL_WORKING_MS. It only marks the
// check: the call that is polling the task sees the mark, closes the check, and the running
// task goes to the background finisher. It is concurrent because that call is still in the
// chokepoint's queue; it spends nothing and touches no cart, case or cap.
const stop_waiting = {
  name: "stop_waiting",
  actor: "shopper",
  concurrent: true,
  args: { checkId: { type: "string", required: true } },
  run({ checkId }, { store }) {
    const check = mustCheck(store, checkId);
    if (check.status !== "open") refuse("check_closed", `Check ${checkId} is closed.`);
    if (!stillWorkingTasks(check, store.now()).length) {
      refuse("not_still_working", `No analysis of check ${checkId} has been running for ${STILL_WORKING_MS / 1000} seconds; it is still working normally.`);
    }
    check.stopRequested = { at: store.now() };
    return { checkId, stopping: true };
  },
};

export const HUMAN_VERBS = Object.freeze([start_check, apply_draft, keep_my_shade, approve_exchange, approve_refund, set_unit_cap, stop_waiting]);
