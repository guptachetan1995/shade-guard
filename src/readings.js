// Parse the analysers' results into the numbers the store keeps. The shapes follow the
// documented result schemas until the first live run records the real ones. A shape
// that doesn't match fails loudly rather than guessing.
import { YouCamError } from "./providers/errors.js";
import { SKIN_TYPE_LABELS } from "./rules/recommend.js";

function shape(ok, what) {
  if (!ok) throw new YouCamError("unexpected_shape", { message: `unexpected ${what} result shape` });
}

export function parseTone(result) {
  const hex = result?.color?.skin_color;
  shape(typeof hex === "string" && /^#?[0-9a-f]{6}$/i.test(hex), "skin-tone-analysis");
  const fq = result.face_quality ?? {};
  return {
    skinHex: (hex.startsWith("#") ? hex : `#${hex}`).toUpperCase(),
    faceQuality: {
      lighting: fq.lighting ?? null,
      frontal: fq.frontal ?? null,
      area: fq.area ?? null,
      faceangle: fq.faceangle ?? null,
    },
  };
}

export function parseSkin(result) {
  const output = result?.output;
  shape(Array.isArray(output), "skin-analysis");
  const skinType = output.find((o) => o.type === "skin_type");
  shape(skinType && SKIN_TYPE_LABELS.includes(skinType.whole), "skin-analysis skin_type");
  const raw = {};
  for (const type of ["oiliness", "moisture", "redness"]) {
    const o = output.find((x) => x.type === type);
    shape(o && typeof o.raw_score === "number", `skin-analysis ${type}`);
    // Decisions use raw_score; the docs say ui_score is adjusted "to produce more favorable results".
    raw[type] = o.raw_score;
  }
  return { skinTypeWhole: skinType.whole, raw };
}

export function parseRenderUrl(result) {
  const url = result?.url ?? result?.[0]?.download_url;
  shape(typeof url === "string", "makeup-vto");
  return url;
}
