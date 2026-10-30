// The recommendation rules: the uncertainty band, the four ranking decisions, the finish
// from skin type, the redness note and the undertone reading. Thresholds are fixed here in
// advance and pinned by tests; they are never tuned to the demo.
import { deltaE00 } from "../color/ciede2000.js";

// PROVISIONAL. The largest ΔE00 between three tone readings of one face: the photo and two
// copies at ±15% brightness that the analyser still rates good lighting. Measured across
// shifted light, not identical re-sends, because a shopper's next photo differs mostly in
// light (an identical re-send may read the same hex every time). Recorded in
// docs/api-notes.md; 1.0 stands until then.
export const REPEAT_SPREAD_DE = 1.0;
export const REPEAT_SPREAD_PROVISIONAL = true;

// The band widens by this factor when the analyser's own lighting verdict is not "good": light
// worse than the measured shift covers. Fixed, not measured.
export const LIGHTING_FACTOR = 1.5;

// No shade closer than this ΔE00 means the range has no match for this reading.
export const NO_GOOD_MATCH = 6.0;

// PROVISIONAL. Below this SD redness raw_score a reading gets the "may run pinker" note.
// Set from the recorded raw scores.
export const REDNESS_FLAG = 40;
export const REDNESS_FLAG_PROVISIONAL = true;

// Hue angle h_ab (degrees) of a skin or swatch reading: lower is pinker, higher is yellower.
export const UNDERTONE_HUE = Object.freeze({ coolBelow: 54, warmFrom: 59 });

// All eight skin_type labels the Skin Analysis docs list for each region.
export const SKIN_TYPE_LABELS = Object.freeze([
  "Normal",
  "Oily",
  "Dry",
  "Combination",
  "Redness",
  "Dry & Redness",
  "Oily & Redness",
  "Combination & Redness",
]);

export const FINISH_BY_BASE = Object.freeze({
  Oily: "matte",
  Dry: "radiant",
  Normal: "satin",
  Combination: "satin",
  Redness: "satin",
});

export const DECISIONS = Object.freeze(["keep", "swap", "sample_duo", "no_match", "retake", "unavailable"]);

// Comparisons run on the 2-d.p. values the evidence cites, so a boundary case decides the
// same way the card reads.
const EPS = 1e-9;

export function round2(n) {
  return Math.round(n * 100) / 100;
}

export function bandFor(faceQuality) {
  const lightingGood = faceQuality?.lighting === "good";
  return round2(REPEAT_SPREAD_DE * (lightingGood ? 1 : LIGHTING_FACTOR));
}

export function undertoneFromHue(h) {
  if (h < UNDERTONE_HUE.coolBelow) return "cool";
  if (h < UNDERTONE_HUE.warmFrom) return "neutral";
  return "warm";
}

export function finishFor(label) {
  if (!SKIN_TYPE_LABELS.includes(label)) {
    throw new TypeError(`unknown skin_type label: ${label}`);
  }
  const [first] = label.split(" & ");
  return {
    label,
    base: first === "Redness" ? null : first,
    finish: FINISH_BY_BASE[first],
    rednessInLabel: label.includes("Redness"),
  };
}

export function rednessNote(label, rednessRaw) {
  return label.includes("Redness") || (typeof rednessRaw === "number" && rednessRaw < REDNESS_FLAG);
}

export function rankShades(lab, shades) {
  return shades
    .map((s, i) => ({ code: s.code, de00: round2(deltaE00(lab, s.lab)), i }))
    .sort((a, b) => a.de00 - b.de00 || a.i - b.i)
    .map(({ code, de00 }) => ({ code, de00 }));
}

// The first rule that matches wins: no_match, keep, sample_duo, swap.
export function decide({ ranking, cartShadeCode, band }) {
  const [best, second] = ranking;
  if (best.de00 > NO_GOOD_MATCH + EPS) {
    return { decision: "no_match", nearest: best.code };
  }
  const cart = ranking.find((r) => r.code === cartShadeCode);
  if (cart && (cart.code === best.code || cart.de00 - best.de00 <= band + EPS)) {
    return { decision: "keep", shadeCode: cart.code };
  }
  if (second && second.de00 - best.de00 <= band + EPS) {
    return { decision: "sample_duo", shadeCodes: [best.code, second.code] };
  }
  return { decision: "swap", shadeCode: best.code };
}

export function tooCloseToCall(ranking, band) {
  const [best, second] = ranking;
  return second && second.de00 - best.de00 <= band + EPS ? [best.code, second.code] : null;
}
