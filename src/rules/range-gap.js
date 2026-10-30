// A range gap: a reading with no shade within NO_GOOD_MATCH, kept as numbers only, with the
// direction from the nearest shade to the reading ("deeper, warmer than C5").
import { chroma, hueAngle } from "../color/lab.js";
import { NO_GOOD_MATCH, round2 } from "./recommend.js";

// Differences under these steps read as "the same" on that axis.
export const DEPTH_STEP = 1.0; // ΔL*
export const HUE_STEP = 2.0; // Δh_ab, degrees
export const CHROMA_STEP = 2.0; // ΔC*

export function gapDirection(readingLab, shadeLab) {
  const dL = readingLab[0] - shadeLab[0];
  const dC = chroma(readingLab) - chroma(shadeLab);
  let dh = hueAngle(readingLab) - hueAngle(shadeLab);
  if (dh > 180) dh -= 360;
  if (dh < -180) dh += 360;

  const parts = [];
  if (dL < -DEPTH_STEP) parts.push("deeper");
  else if (dL > DEPTH_STEP) parts.push("lighter");
  if (dh > HUE_STEP) parts.push("warmer");
  else if (dh < -HUE_STEP) parts.push("cooler");
  if (parts.length === 0) {
    if (dC > CHROMA_STEP) parts.push("more saturated");
    else if (dC < -CHROMA_STEP) parts.push("less saturated");
  }
  return { dL: round2(dL), dC: round2(dC), dh: round2(dh), label: parts.join(", ") || "close in depth and hue" };
}

export function rangeGapEntry({ productId, lab, nearestShade, nearestDe00, at }) {
  const direction = gapDirection(lab, nearestShade.lab);
  return {
    productId,
    at,
    lab: lab.map(round2),
    chroma: round2(chroma(lab)),
    hueAngle: round2(hueAngle(lab)),
    nearest: { code: nearestShade.code, de00: nearestDe00 },
    direction: direction.label,
    delta: { dL: direction.dL, dC: direction.dC, dh: direction.dh },
  };
}

function shortName(name) {
  return name.replace(/\s*\(.*\)\s*$/, "");
}

function andJoin(label) {
  const parts = label.split(", ");
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : label;
}

export function summariseRangeGaps(gaps, products) {
  const byProduct = new Map();
  for (const g of gaps) {
    if (!byProduct.has(g.productId)) byProduct.set(g.productId, []);
    byProduct.get(g.productId).push(g);
  }
  return [...byProduct].map(([productId, list]) => {
    const product = products.find((p) => p.productId === productId);
    const name = shortName(product?.name ?? productId);
    const n = list.length;
    const readings = `${n} reading${n === 1 ? "" : "s"}`;
    const nearestCodes = [...new Set(list.map((g) => g.nearest.code))];
    const directions = [...new Set(list.map((g) => g.direction))];
    let tail;
    if (nearestCodes.length === 1 && directions.length === 1) {
      tail = `${n === 1 ? "" : "all "}${andJoin(directions[0])} than ${nearestCodes[0]}`;
    } else {
      tail = `nearest shades ${nearestCodes.join(", ")}`;
    }
    return {
      productId,
      count: n,
      nearestCodes,
      directions,
      sentence: `${name}: ${readings} with no shade within ΔE00 ${NO_GOOD_MATCH}, ${tail}`,
    };
  });
}
