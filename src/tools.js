// The nine agent tools: the registry the agent can discover and call. The seven human-only
// verbs live in human-verbs.js, which this file never imports. Every tool runs only through
// invoke(), which checks the actor, the arguments and the unit cap first.
import { hexToLab, hueAngle, chroma, round } from "./color/lab.js";
import {
  bandFor,
  decide,
  finishFor,
  rankShades,
  rednessNote,
  tooCloseToCall,
  undertoneFromHue,
  DECISIONS,
  NO_GOOD_MATCH,
  REPEAT_SPREAD_PROVISIONAL,
  round2,
} from "./rules/recommend.js";
import { gapDirection, rangeGapEntry } from "./rules/range-gap.js";
import { makeupVtoBody } from "./rules/preview.js";
import { parseRenderUrl, parseSkin, parseTone } from "./readings.js";
import { runTaskToEnd, StoppedWaiting } from "./tasks.js";
import { chargeUnits } from "./store.js";
import { closeCheck, cartCheckSettled, returnCheckDeadEnded } from "./check-lifecycle.js";
import { isRetake, messageFor, YouCamError } from "./providers/errors.js";
import { refuse } from "./refusal.js";

const CITE_TOLERANCE = 0.05 + 1e-9;
export const SKIN_ANALYSIS_ACTIONS = ["skin_type", "oiliness", "moisture", "redness"];
const RENDERS_PER_LINE = 3;

export function measurePrice(costs) {
  return costs["skin-tone-analysis"] + costs["skin-analysis"];
}

export function perLinePrice(costs) {
  return RENDERS_PER_LINE * costs["makeup-vto"];
}

function mustCheck(store, checkId) {
  const check = store.getCheck(checkId);
  if (!check) refuse("unknown_check", `No check ${checkId} exists.`);
  return check;
}

function mustOpen(store, checkId) {
  const check = mustCheck(store, checkId);
  if (check.status !== "open") refuse("check_closed", `Check ${checkId} is closed; its photo is gone.`);
  check.lastActivityAt = store.now();
  return check;
}

function mustProduct(store, productId) {
  const product = store.getProduct(productId);
  if (!product) refuse("unknown_product", `No product ${productId} is in the catalogue.`);
  return product;
}

function linesOfProduct(check, productId) {
  return Object.entries(check.lines).filter(([, l]) => l.productId === productId);
}

function cites(cited, actual) {
  return typeof cited === "number" && Math.abs(cited - actual) <= CITE_TOLERANCE;
}

async function runPaidTask(ctx, check, tool, feature, body) {
  const { store, provider, wait } = ctx;
  let r;
  try {
    r = await runTaskToEnd(provider, feature, body, {
      wait,
      onCreated: (taskId) => check.tasks.push({ taskId, feature, units: 0, deletedAt: null, pending: false, status: "running", startedAt: store.now() }),
      stopped: () => Boolean(check.stopRequested),
    });
  } catch (e) {
    if (e instanceof StoppedWaiting) return { taskId: e.taskId, status: "stopped", unitsCharged: 0 };
    // A timed-out task is reported like an engine error: nothing usable came back.
    if (e instanceof YouCamError && e.code === "TaskTimeout" && e.taskId) return { taskId: e.taskId, status: "error", error: e.code, unitsCharged: 0 };
    throw e;
  }
  const task = check.tasks.find((t) => t.taskId === r.taskId);
  task.units = r.unitsCharged ?? 0;
  task.status = r.status;
  chargeUnits(store, check, { tool, feature, taskId: r.taskId, units: task.units });
  return r;
}

// ---------------------------------------------------------------------------------------

// The shopper stopped waiting (stop_waiting): the check closes now, and the running task goes
// to the background finisher, so the receipt reads pending until it is deleted.
async function closeStopped(ctx, check) {
  await closeCheck(ctx.store, ctx.provider, check, "stopped_waiting");
  return { status: "stopped", pendingTasks: check.privacyReceipt.pending, unitsCharged: check.unitsSpent };
}

const get_cart = {
  name: "get_cart",
  description:
    "Read the shopper's cart. Returns each line: lineId, productId, product name, shade code and shade name, finish, quantity, and complexion (true for a foundation-type product whose shade can be checked against a face). A line the shopper changed to a two-shade sample shows its sample SKU and the two shade codes instead of one shade. " +
    "Does NOT change the cart, and calls no YouCam API (0 units).",
  args: {},
  run(_args, { store }) {
    return {
      lines: store.state.cart.lines.map((l) => {
        const product = store.getProduct(l.productId);
        const shade = l.shadeCode ? store.getShade(l.productId, l.shadeCode) : null;
        return {
          lineId: l.lineId,
          productId: l.productId,
          productName: product?.name ?? l.productId,
          complexion: Boolean(product?.complexion),
          shadeCode: l.shadeCode,
          shadeName: shade?.name ?? null,
          finish: l.finish,
          qty: l.qty,
          ...(l.sampleDuo ? { sampleDuo: l.sampleDuo } : {}),
        };
      }),
    };
  },
};

const list_shades = {
  name: "list_shades",
  description:
    "List every shade of one product in the store's catalogue: code, name, swatch colour as hex and as CIELAB, undertone label (cool, neutral or warm, from the swatch's hue angle), the finishes it comes in, and stock. Also returns the product's two-shade sample SKU. " +
    "Does NOT call YouCam (0 units), and does NOT rank or recommend; use rank_shades for that.",
  args: { productId: { type: "string", required: true, description: "The product to list, e.g. skin-tint." } },
  run({ productId }, { store }) {
    const p = mustProduct(store, productId);
    return {
      productId: p.productId,
      name: p.name,
      complexion: p.complexion,
      sampleDuoSku: p.sampleDuoSku,
      shades: p.shades.map((s) => ({ ...s, lab: [...s.lab], finishes: [...s.finishes] })),
    };
  },
};

const measure_complexion = {
  name: "measure_complexion",
  description:
    "Measure the shopper's face for an open check, once. Uploads the check's photo (already normalised to a JPEG, long side 1024 px), then runs the YouCam AI Facial Color Tones Analyzer (20 units) and AI Skin Analysis SD for skin_type, oiliness, moisture and redness (9 units). " +
    "Returns status 'measured' with the skin colour (hex, CIELAB, hue angle, chroma), the undertone reading, the analyser's own face_quality verdicts (lighting, frontal, area, face angle), the uncertainty band (wider when lighting is not good), skin type for the whole face with the finish it suggests, whether to add the 'may run pinker' note, the raw scores, and the units charged. " +
    "If the face can't be read it returns status 'retake' with the error code and one sentence of guidance, at 0 units. If the store's YouCam budget runs out it returns status 'unavailable'. If the shopper stops waiting for an analysis still running after 90 s, it returns status 'stopped': the check is closed, nothing is drafted, and the running task is deleted when it finishes. " +
    "Does NOT rank or recommend. Does NOT run on a closed check or measure a check twice. Does NOT start when the check's unit cap can't cover both analyses plus one line's renders (32 units): it refuses before anything is uploaded. Does NOT keep the photo after the check closes, and can't start a check: only the shopper can.",
  args: { checkId: { type: "string", required: true, description: "The open check, from the shopper's start_check." } },
  gate({ checkId }, { costs }) {
    return { checkId, units: measurePrice(costs) + perLinePrice(costs) };
  },
  async run({ checkId }, ctx) {
    const { store, provider, costs } = ctx;
    const check = mustOpen(store, checkId);
    if (check.complexion || check.retake || check.fileId) refuse("already_measured", `Check ${checkId} was already measured.`);

    const { units: balance } = await provider.getBalance();
    store.state.budget.balance = balance;
    if (balance < measurePrice(costs)) {
      refuse("balance_low", `${messageFor("CreditInsufficiency")} The YouCam balance is ${balance} units; a measurement needs ${measurePrice(costs)}. Nothing was uploaded.`);
    }

    const photo = store.blobs.get(checkId)?.photo;
    const { fileId } = await provider.uploadPhoto(photo, "image/jpeg");
    check.fileId = fileId;

    let tone;
    try {
      tone = await runPaidTask(ctx, check, "measure_complexion", "skin-tone-analysis", {
        src_file_id: fileId,
        face_angle_strictness_level: "high",
      });
    } catch (e) {
      if (e instanceof YouCamError && e.code === "CreditInsufficiency" && check.tasks.length === 0) {
        check.uploadOnlyReason = "CreditInsufficiency";
        check.unavailable = { reason: "credit", message: messageFor(e.code) };
        return { status: "unavailable", reason: "credit", message: messageFor(e.code), unitsCharged: 0 };
      }
      throw e;
    }
    if (tone.status === "stopped") return closeStopped(ctx, check);
    if (tone.status === "error") {
      check.retake = { errorCode: tone.error, guidance: messageFor(tone.error), retake: isRetake(tone.error) };
      return { status: "retake", errorCode: tone.error, guidance: messageFor(tone.error), unitsCharged: check.unitsSpent };
    }
    const { skinHex, faceQuality } = parseTone(tone.result);

    const skin = await runPaidTask(ctx, check, "measure_complexion", "skin-analysis", {
      src_file_id: fileId,
      dst_actions: SKIN_ANALYSIS_ACTIONS,
      format: "json",
    });
    if (skin.status === "stopped") return closeStopped(ctx, check);
    if (skin.status === "error") {
      check.retake = { errorCode: skin.error, guidance: messageFor(skin.error), retake: isRetake(skin.error) };
      return { status: "retake", errorCode: skin.error, guidance: messageFor(skin.error), unitsCharged: check.unitsSpent };
    }
    const { skinTypeWhole, raw } = parseSkin(skin.result);

    const lab = hexToLab(skinHex);
    const h = hueAngle(lab);
    const type = finishFor(skinTypeWhole);
    check.complexion = {
      skinHex,
      lab: lab.map(round2),
      hueAngle: round(h, 1),
      chroma: round2(chroma(lab)),
      undertoneReading: undertoneFromHue(h),
      faceQuality,
      band: bandFor(faceQuality),
      bandProvisional: REPEAT_SPREAD_PROVISIONAL,
      skinType: { whole: type.label, base: type.base, finish: type.finish },
      rednessNote: rednessNote(type.label, raw.redness),
      raw,
      measuredAt: store.now(),
      ...(tone.result.synthetic ? { synthetic: true } : {}),
      ...(tone.replay ? { replay: true, recordedAt: tone.recordedAt } : {}),
    };
    return { status: "measured", complexion: structuredClone(check.complexion), unitsCharged: check.unitsSpent };
  },
};

const rank_shades = {
  name: "rank_shades",
  description:
    "Rank one product's shades against the measured skin colour of a check, by CIEDE2000 colour difference (ΔE00, smaller is closer). Returns every shade in order with its ΔE00, the band (how far one reading can move), the cart's shade and its rank, tooCloseToCall (the best two shades when they sit within the band of each other), noGoodMatch (true when even the best shade is more than ΔE00 6.0 away) and the nearest shade with the direction from it to the reading (for example 'deeper, warmer'). " +
    "Does NOT call YouCam (0 units). Does NOT change any state other than remembering the ranking on the check. Does NOT decide; the draft does.",
  args: {
    checkId: { type: "string", required: true, description: "A check that measure_complexion has measured." },
    productId: { type: "string", required: true, description: "A product on one of the check's lines." },
  },
  run({ checkId, productId }, { store }) {
    const check = mustCheck(store, checkId);
    if (!check.complexion) refuse("not_measured", `Check ${checkId} has no reading yet; run measure_complexion first.`);
    const product = mustProduct(store, productId);
    const lines = linesOfProduct(check, productId);
    if (!lines.length) refuse("product_not_in_check", `${productId} is not on any line this check covers.`);
    const { lab, band } = check.complexion;
    const ranking = rankShades(lab, product.shades);
    for (const [, line] of lines) line.ranking = ranking;
    const best = ranking[0];
    const nearestShade = store.getShade(productId, best.code);
    return {
      productId,
      band,
      shadesRanked: ranking.length,
      ranking,
      cartShades: lines.map(([lineId, l]) => ({
        lineId,
        code: l.shadeCode,
        de00: ranking.find((r) => r.code === l.shadeCode)?.de00 ?? null,
        rank: ranking.findIndex((r) => r.code === l.shadeCode) + 1,
      })),
      tooCloseToCall: tooCloseToCall(ranking, band),
      noGoodMatch: best.de00 > NO_GOOD_MATCH,
      nearest: { code: best.code, de00: best.de00, direction: gapDirection(lab, nearestShade.lab).label },
    };
  },
};

const preview_shade = {
  name: "preview_shade",
  description:
    "Render one catalogue shade, in one of its finishes, on the shopper's own photo with YouCam AI Makeup Virtual Try-On (a foundation palette with skin smoothing at 0, so the preview shows the shade, not a beauty filter). 1 unit. The image is downloaded and cached at once, because YouCam result links expire after 2 hours. Returns a previewId to cite in a draft. Asking again for the same shade and finish returns the cached preview at 0 units. If the shopper stops waiting for a render still running after 90 s, it returns status 'stopped' and the check is closed. " +
    "Does NOT change the cart. Does NOT render a colour that is not a catalogue shade of this product, or a finish the shade doesn't come in. Does NOT exceed the check's unit cap, and does NOT run on a closed or unmeasured check.",
  args: {
    checkId: { type: "string", required: true, description: "A measured, open check." },
    productId: { type: "string", required: true, description: "A product on one of the check's lines." },
    shadeCode: { type: "string", required: true, description: "A shade code from list_shades for that product." },
    finish: { type: "string", required: true, description: "matte, satin or radiant; must be one the shade comes in." },
  },
  gate({ checkId, productId, shadeCode, finish }, { store, costs }) {
    const check = store.getCheck(checkId);
    const cached = check && linesOfProduct(check, productId).some(([, l]) => l.previews.some((p) => p.shadeCode === shadeCode && p.finish === finish));
    return { checkId, units: cached ? 0 : costs["makeup-vto"] };
  },
  async run({ checkId, productId, shadeCode, finish }, ctx) {
    const { store, provider } = ctx;
    const check = mustOpen(store, checkId);
    if (!check.complexion) refuse("not_measured", `Check ${checkId} has no reading yet; run measure_complexion first.`);
    mustProduct(store, productId);
    const lines = linesOfProduct(check, productId);
    if (!lines.length) refuse("product_not_in_check", `${productId} is not on any line this check covers.`);
    const shade = store.getShade(productId, shadeCode);
    if (!shade) refuse("not_a_catalogue_shade", `${shadeCode} is not a shade of ${productId}; only catalogue shades can be rendered.`);
    if (!shade.finishes.includes(finish)) refuse("finish_not_offered", `${shadeCode} comes in ${shade.finishes.join(", ")}, not ${finish}.`);

    const existing = lines.flatMap(([, l]) => l.previews).find((p) => p.shadeCode === shadeCode && p.finish === finish);
    if (existing) return { status: "rendered", cached: true, ...existing };

    const r = await runPaidTask(ctx, check, "preview_shade", "makeup-vto", makeupVtoBody(check.fileId, shade, finish));
    if (r.status === "stopped") return closeStopped(ctx, check);
    if (r.status === "error") return { status: "failed", errorCode: r.error, message: messageFor(r.error) };
    const image = await provider.fetchResult(parseRenderUrl(r.result));
    const previewId = store.nextPreviewId();
    store.blobs.get(checkId).renders.set(previewId, image);
    const preview = { previewId, shadeCode, finish, taskId: r.taskId };
    for (const [, l] of lines) l.previews.push(preview);
    return { status: "rendered", cached: false, ...preview };
  },
};

function requiredCodes(decision, cartCode, rule) {
  if (decision === "keep") return [cartCode];
  if (decision === "swap") return [cartCode, rule.shadeCode];
  return [cartCode, ...rule.shadeCodes];
}

function summarise({ decision, line, check, product, draft }) {
  const c = check.complexion;
  const f1 = (n) => n.toFixed(1);
  const de = (code) => line.ranking.find((r) => r.code === code).de00;
  const context = () =>
    `(best of ${line.ranking.length}; reading ± ${f1(c.band)}). Undertone reads ${c.undertoneReading} (h ${Math.round(c.hueAngle)}°), ` +
    `lighting ${c.faceQuality.lighting ?? "unknown"}. ${c.skinType.whole} skin → ${c.skinType.finish}.` +
    (c.rednessNote ? " Redness can pull a colour reading pinker, so the preview is the better guide." : "");
  // The preview ids stay in draft.evidence for the citation check; the shopper reads plain words.
  const shown = draft.evidence.previewIds?.length ?? 0;
  const pv = shown > 1 ? " Both shades are previewed on your face, side by side." : shown === 1 ? " The shade is previewed on your face." : "";
  switch (decision) {
    case "keep":
      return `${line.shadeCode} is ΔE00 ${f1(de(line.shadeCode))} from your reading, within the band of the closest shade ${context()}${pv}`;
    case "swap":
      return `${line.shadeCode} is ΔE00 ${f1(de(line.shadeCode))} from your reading; ${draft.shadeCode} is ${f1(de(draft.shadeCode))} ${context()}${pv}`;
    case "sample_duo": {
      const [a, b] = draft.shadeCodes;
      return `${a} (ΔE00 ${f1(de(a))}) and ${b} (${f1(de(b))}) are too close to call ${context()} ${line.shadeCode} is ${f1(de(line.shadeCode))}. The two-shade sample (${product.sampleDuoSku}) settles it.${pv}`;
    }
    case "no_match":
      return `No shade of ${product.name} is within ΔE00 ${f1(NO_GOOD_MATCH)} of your reading. The nearest, ${draft.nearest.code}, is ${f1(draft.nearest.de00)}, and your reading is ${draft.nearest.direction} than it. We won't guess.`;
    case "retake":
      return `The photo couldn't be read (${check.retake.errorCode}). ${check.retake.guidance}`;
    default:
      return `Not checked: this check's unit cap has ${draft.evidence.remainingUnits} units left, not enough for this line.`;
  }
}

function attachReadingToCase(store, check, lineId, line, draft) {
  const rcase = store.getCase(check.origin.caseId);
  const top = line.ranking.slice(0, 3);
  if (!top.some((r) => r.code === line.shadeCode)) top.push(line.ranking.find((r) => r.code === line.shadeCode));
  rcase.reading = {
    checkedAt: check.complexion.measuredAt,
    checkId: check.checkId,
    lab: [...check.complexion.lab],
    band: check.complexion.band,
    ranking: top.map((r) => ({ ...r })),
    draftDecision: draft.decision,
    recommended: draft.decision === "swap" ? [draft.shadeCode] : draft.decision === "sample_duo" ? [...draft.shadeCodes] : draft.decision === "keep" ? [line.shadeCode] : [],
    shopperOutcome: null,
  };
  if (rcase.status === "awaiting_check") rcase.status = "open";
}

const draft_recommendation = {
  name: "draft_recommendation",
  description:
    "Write the draft recommendation for one line of a check, for the shopper to accept or decline. decision is one of: keep; swap (give shadeCode, and optionally finish); sample_duo (give the two shadeCodes); no_match; retake; unavailable. " +
    "evidence must cite the check's own numbers: for keep, swap and sample_duo, deltaE as { shadeCode: ΔE00 } for the cart shade and each recommended shade, the band, and the previewIds; for no_match, bestDeltaE and nearest (the nearest shade code); for retake, errorCode; for unavailable, remainingUnits (the check's cap minus its spend) and reason ('budget' or 'credit'). " +
    "The decision must be the one the store's rules give for the ranking (no_match above ΔE00 6.0, keep when the cart shade is within the band of the best, sample_duo when the best two are within the band, swap otherwise). A no_match is also kept, as numbers only, in the merchant's range-gap list. " +
    "Does NOT change the cart: only the shopper's apply_draft or keep_my_shade does, and any cart or status field in the arguments is refused and logged, not dropped. Does NOT accept evidence that doesn't match the check's numbers, or a decision the rules don't support. Does NOT redraft a line the shopper already decided.",
  args: {
    checkId: { type: "string", required: true, description: "The check." },
    lineId: { type: "string", required: true, description: "A line the check covers (a cart lineId, or the return case id for a returns check)." },
    decision: { type: "string", required: true, enum: DECISIONS, description: "keep, swap, sample_duo, no_match, retake or unavailable." },
    shadeCode: { type: "string", description: "For swap: the shade to swap to." },
    shadeCodes: { type: "array", description: "For sample_duo: the two shade codes." },
    finish: { type: "string", description: "For swap: the finish; defaults to the one skin type suggests, if the shade has it." },
    evidence: { type: "object", required: true, description: "The check's own numbers, as described above." },
  },
  async run(args, { store, provider }) {
    const { checkId, lineId, decision, evidence } = args;
    const check = mustOpen(store, checkId);
    const line = check.lines[lineId];
    if (!line) refuse("line_not_in_check", `Check ${checkId} doesn't cover line ${lineId}.`);
    if (line.outcome) refuse("line_decided", `The shopper already decided line ${lineId}.`);
    const product = store.getProduct(line.productId);
    const draft = { decision, evidence: structuredClone(evidence), at: store.now() };

    if (decision === "retake") {
      if (!check.retake) refuse("decision_unsupported", "This check's photo was read; retake applies only after a read error.");
      if (evidence.errorCode !== check.retake.errorCode) refuse("evidence_mismatch", `The check's error code is ${check.retake.errorCode}.`);
      draft.guidance = check.retake.guidance;
    } else if (decision === "unavailable") {
      const remaining = store.state.budget.unitCapPerCheck - check.unitsSpent;
      if (evidence.remainingUnits !== remaining) refuse("evidence_mismatch", `The check has ${remaining} units left under its cap.`);
      if (!["budget", "credit"].includes(evidence.reason)) refuse("evidence_mismatch", "reason must be 'budget' or 'credit'.");
      if (line.ranking) refuse("decision_unsupported", `Line ${lineId} is already ranked, so it was not unavailable.`);
    } else {
      if (!line.ranking) refuse("not_ranked", `Line ${lineId} has no ranking yet; run rank_shades first.`);
      const rule = decide({ ranking: line.ranking, cartShadeCode: line.shadeCode, band: check.complexion.band });
      if (rule.decision !== decision) refuse("decision_unsupported", `The store's rules give ${rule.decision} for this ranking, not ${decision}.`, { rule });
      if (decision === "no_match") {
        const best = line.ranking[0];
        if (evidence.nearest !== best.code || !cites(evidence.bestDeltaE, best.de00)) {
          refuse("evidence_mismatch", `The nearest shade is ${best.code} at ΔE00 ${best.de00}.`);
        }
        const direction = gapDirection(check.complexion.lab, store.getShade(line.productId, best.code).lab).label;
        draft.nearest = { code: best.code, de00: best.de00, direction };
      } else {
        if (decision === "swap") {
          if (args.shadeCode !== rule.shadeCode) refuse("decision_unsupported", `The closest shade is ${rule.shadeCode}.`);
          draft.shadeCode = rule.shadeCode;
          const shade = store.getShade(line.productId, rule.shadeCode);
          const suggested = check.complexion.skinType.finish;
          const finish = args.finish ?? (shade.finishes.includes(suggested) ? suggested : line.finish);
          if (!shade.finishes.includes(finish)) refuse("finish_not_offered", `${rule.shadeCode} comes in ${shade.finishes.join(", ")}.`);
          draft.finish = finish;
        }
        if (decision === "sample_duo") {
          const given = [...(args.shadeCodes ?? [])].sort().join(",");
          if (given !== [...rule.shadeCodes].sort().join(",")) refuse("decision_unsupported", `The two closest shades are ${rule.shadeCodes.join(" and ")}.`);
          draft.shadeCodes = [...rule.shadeCodes];
          draft.sampleDuoSku = product.sampleDuoSku;
        }
        const cited = evidence.deltaE ?? {};
        for (const code of requiredCodes(decision, line.shadeCode, rule)) {
          const actual = line.ranking.find((r) => r.code === code).de00;
          if (!cites(cited[code], actual)) refuse("evidence_mismatch", `${code} is ΔE00 ${actual} on this check, and the evidence must cite it.`);
        }
        if (!cites(evidence.band, check.complexion.band)) refuse("evidence_mismatch", `The band on this check is ${check.complexion.band}.`);
        const codes = new Set(requiredCodes(decision, line.shadeCode, rule));
        for (const pid of evidence.previewIds ?? []) {
          const p = line.previews.find((x) => x.previewId === pid);
          if (!p || !codes.has(p.shadeCode)) refuse("evidence_mismatch", `Preview ${pid} is not a render of this line's shades on this check.`);
        }
      }
    }

    if (decision !== "keep" && decision !== "swap") {
      for (const k of ["shadeCode", "finish"]) if (args[k] !== undefined) refuse("bad_args", `${k} applies only to keep or swap.`);
    }

    draft.summary = summarise({ decision, line, check, product, draft });
    line.draft = draft;
    store.state.budget.checksByOutcome[decision] += 1;
    if (decision === "no_match") {
      store.state.rangeGaps.push(
        rangeGapEntry({
          productId: line.productId,
          lab: check.complexion.lab,
          nearestShade: store.getShade(line.productId, draft.nearest.code),
          nearestDe00: draft.nearest.de00,
          at: store.now(),
        }),
      );
    }
    if (check.origin.from === "return" && line.ranking) attachReadingToCase(store, check, lineId, line, draft);
    if (cartCheckSettled(check)) await closeCheck(store, provider, check, "every_line_settled");
    else if (returnCheckDeadEnded(check)) await closeCheck(store, provider, check, "no_reading_possible");
    return { lineId, draft: structuredClone(draft) };
  },
};

function caseView(c, store) {
  return structuredClone({
    caseId: c.caseId,
    orderId: c.orderId,
    productId: c.productId,
    sampleDuoSku: store.getProduct(c.productId)?.sampleDuoSku ?? null,
    shadeCode: c.shadeCode,
    finish: c.finish,
    reason: c.reason,
    status: c.status,
    reading: c.reading,
    draft: c.draft,
  });
}

const CASE_STATUSES = ["open", "awaiting_check", "drafted", "exchange_approved", "refund_approved"];

const list_return_cases = {
  name: "list_return_cases",
  description:
    "List the store's return requests, optionally only those with one status (open, awaiting_check, drafted, exchange_approved, refund_approved). Each has its reason, the order line (product and shade), status, any draft, and the shade reading attached to the order as numbers only: CIELAB, band, the closest shades with their ΔE00, what was recommended and what the shopper chose. " +
    "Does NOT show or fetch any photo; none is kept. Does NOT approve, exchange or refund. Does NOT ask a shopper for a check: only the shopper's own photo can start one.",
  args: { status: { type: "string", enum: CASE_STATUSES, description: "Only cases with this status." } },
  run({ status }, { store }) {
    return { cases: store.state.returnCases.filter((c) => !status || c.status === status).map((c) => caseView(c, store)) };
  },
};

const REFUND_REASONS = {
  no_match: (r) => r?.draftDecision === "no_match",
  returned_shade_is_closest: (r) => r?.draftDecision === "keep",
  no_reading: (r) => !r,
};

const draft_return_resolution = {
  name: "draft_return_resolution",
  description:
    "Draft a resolution of one return case for staff to approve. resolution 'exchange' needs shadeCode: the shade the attached reading recommended, or the product's two-shade sample SKU when the reading found two shades too close to call; evidence.deltaE must cite the reading's ΔE00 for the returned shade and the recommended one(s). resolution 'refund' needs evidence.reason: 'no_match' (the reading found no shade within ΔE00 6.0), 'returned_shade_is_closest' (the returned shade already was the best), or 'no_reading'. " +
    "An exchange on a case with no reading is refused as no_reading: the shopper's return page offers them a check first. " +
    "Does NOT approve anything: only staff's approve_exchange or approve_refund does. Does NOT move money, change stock or start a check. Does NOT draft an exchange the reading doesn't support, or a refund when the reading supports an exchange.",
  args: {
    caseId: { type: "string", required: true, description: "The return case, e.g. R-104." },
    resolution: { type: "string", required: true, enum: ["exchange", "refund"], description: "exchange or refund." },
    shadeCode: { type: "string", description: "For exchange: the shade code or the two-shade sample SKU." },
    evidence: { type: "object", required: true, description: "The reading's own numbers, as described above." },
  },
  async run({ caseId, resolution, shadeCode, evidence }, { store, provider }) {
    const rcase = store.getCase(caseId);
    if (!rcase) refuse("unknown_case", `No return case ${caseId} exists.`);
    if (rcase.status === "exchange_approved" || rcase.status === "refund_approved") refuse("case_closed", `${caseId} is already ${rcase.status}.`);
    const reading = rcase.reading;
    const product = store.getProduct(rcase.productId);
    let summary;
    if (resolution === "exchange") {
      if (!reading) refuse("no_reading", `${caseId} has no shade reading, so an exchange can't cite one. The shopper's return page offers a check.`);
      let target;
      if (reading.draftDecision === "swap") target = reading.recommended[0];
      else if (reading.draftDecision === "sample_duo") target = product.sampleDuoSku;
      else refuse("reading_does_not_support_exchange", reading.draftDecision === "keep" ? "The returned shade already was the closest; draft a refund." : `No shade is within ΔE00 ${NO_GOOD_MATCH}; draft a refund.`);
      if (shadeCode !== target) refuse("evidence_mismatch", `The reading supports an exchange for ${target}.`);
      if (shadeCode === rcase.shadeCode) refuse("same_shade", "That is the shade being returned.");
      const shade = store.getShade(rcase.productId, shadeCode);
      if (shade && shade.stock < 1) refuse("out_of_stock", `${shadeCode} is out of stock.`);
      const codes = [rcase.shadeCode, ...reading.recommended];
      for (const code of codes) {
        const actual = reading.ranking.find((r) => r.code === code)?.de00;
        if (actual === undefined || !cites(evidence.deltaE?.[code], actual)) refuse("evidence_mismatch", `The reading has ${code} at ΔE00 ${actual}, and the evidence must cite it.`);
      }
      const f1 = (code) => reading.ranking.find((r) => r.code === code).de00.toFixed(1);
      summary =
        reading.draftDecision === "swap"
          ? `Exchange for ${shadeCode}: the reading on the order put ${shadeCode} at ΔE00 ${f1(shadeCode)} and the returned ${rcase.shadeCode} at ${f1(rcase.shadeCode)}.`
          : `Exchange for the two-shade sample (${shadeCode}): the reading put ${reading.recommended.map((c) => `${c} at ${f1(c)}`).join(" and ")}, too close to call; the returned ${rcase.shadeCode} was ${f1(rcase.shadeCode)}.`;
      if (reading.shopperOutcome === "keep_my_shade") summary += " The shopper kept the cart shade at checkout.";
    } else {
      if (shadeCode !== undefined) refuse("bad_args", "shadeCode applies only to an exchange.");
      const check = REFUND_REASONS[evidence.reason];
      if (!check) refuse("evidence_mismatch", "reason must be no_match, returned_shade_is_closest or no_reading.");
      if (reading && (reading.draftDecision === "swap" || reading.draftDecision === "sample_duo")) {
        refuse("reading_supports_exchange", `The reading supports an exchange (${reading.draftDecision}); draft that instead.`);
      }
      if (!check(reading)) refuse("evidence_mismatch", `The case's reading doesn't support the reason ${evidence.reason}.`);
      summary = {
        no_match: `Refund: no shade of ${product.name} is within ΔE00 ${NO_GOOD_MATCH} of the reading.`,
        returned_shade_is_closest: `Refund: the returned ${rcase.shadeCode} already was the closest shade in the range.`,
        no_reading: "Refund: the order has no shade reading to support an exchange.",
      }[evidence.reason];
    }
    rcase.draft = { resolution, ...(shadeCode ? { shadeCode } : {}), evidence: structuredClone(evidence), summary, at: store.now() };
    rcase.status = "drafted";
    const check = reading?.checkId ? store.getCheck(reading.checkId) : null;
    if (check && check.status === "open") await closeCheck(store, provider, check, "resolution_drafted");
    return caseView(rcase, store);
  },
};

const get_unit_budget = {
  name: "get_unit_budget",
  description:
    "Read the YouCam unit budget for a check (checkId, or the most recent open check when omitted): units spent on it, the per-check cap, units remaining, the lines it covers, the price of the full path (29 units to measure, plus up to 3 renders at 1 unit per line), how many lines the remaining cap can cover, the session ledger of paid calls, and the live unit balance (a free call). " +
    "Does NOT spend units. Does NOT change the cap: only the merchant's set_unit_cap does.",
  args: { checkId: { type: "string", description: "The check; defaults to the most recent open check." } },
  async run({ checkId }, { store, provider, costs }) {
    const check = checkId ? mustCheck(store, checkId) : store.state.checks.filter((c) => c.status === "open").at(-1) ?? null;
    let balance = null;
    let balanceError = null;
    try {
      balance = (await provider.getBalance()).units;
      store.state.budget.balance = balance;
    } catch (e) {
      if (!(e instanceof YouCamError)) throw e;
      balanceError = messageFor(e.code);
    }
    const cap = store.state.budget.unitCapPerCheck;
    const base = {
      unitCapPerCheck: cap,
      unitsSpentTotal: store.state.budget.unitsSpentTotal,
      balance,
      ...(balanceError ? { balanceError } : {}),
      mode: provider.mode,
    };
    if (!check) return { checkId: null, ...base, ledger: structuredClone(store.state.budget.ledger) };
    const measured = Boolean(check.complexion || check.retake || check.fileId);
    const remaining = cap - check.unitsSpent;
    const lines = check.lineIds.length;
    const perLine = perLinePrice(costs);
    const affordable = measured ? Math.floor(remaining / perLine) : Math.floor((remaining - measurePrice(costs)) / perLine);
    return {
      checkId: check.checkId,
      lineIds: [...check.lineIds],
      measured,
      unitsSpent: check.unitsSpent,
      remaining,
      price: { measure: measurePrice(costs), perLine, lines, fullPath: measurePrice(costs) + perLine * lines },
      linesAffordable: Math.max(0, Math.min(lines, affordable)),
      ...base,
      ledger: structuredClone(store.state.budget.ledger.filter((e) => e.checkId === check.checkId)),
    };
  },
};

export const TOOLS = Object.freeze([
  get_cart,
  list_shades,
  measure_complexion,
  rank_shades,
  preview_shade,
  draft_recommendation,
  list_return_cases,
  draft_return_resolution,
  get_unit_budget,
]);

// What tool discovery (GET /api/tools) serves: names, descriptions and arguments only.
export function listTools() {
  return TOOLS.map(({ name, description, args }) => ({ name, description, args: structuredClone(args) }));
}
