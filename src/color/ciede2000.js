// CIEDE2000 colour difference, kL = kC = kH = 1, following the formulation and the
// implementation notes in Sharma, Wu & Dalal (2005), "The CIEDE2000 Color-Difference Formula:
// Implementation Notes, Supplementary Test Data, and Mathematical Observations".

const DEG = Math.PI / 180;
const POW25_7 = 25 ** 7;

function huePrime(a, b) {
  if (a === 0 && b === 0) return 0;
  const h = Math.atan2(b, a) / DEG;
  return h < 0 ? h + 360 : h;
}

export function deltaE00([L1, a1, b1], [L2, a2, b2], { kL = 1, kC = 1, kH = 1 } = {}) {
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const Cbar7 = Cbar ** 7;
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + POW25_7)));

  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const h1p = huePrime(a1p, b1);
  const h2p = huePrime(a2p, b2);

  const dLp = L2 - L1;
  const dCp = C2p - C1p;

  // When either chroma is zero the hue difference is defined as zero (note 1 in the paper).
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * DEG);

  const Lbarp = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;

  let hbarp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) <= 180) hbarp = (h1p + h2p) / 2;
    else if (h1p + h2p < 360) hbarp = (h1p + h2p + 360) / 2;
    else hbarp = (h1p + h2p - 360) / 2;
  }

  const T =
    1 -
    0.17 * Math.cos((hbarp - 30) * DEG) +
    0.24 * Math.cos(2 * hbarp * DEG) +
    0.32 * Math.cos((3 * hbarp + 6) * DEG) -
    0.2 * Math.cos((4 * hbarp - 63) * DEG);

  const dTheta = 30 * Math.exp(-(((hbarp - 275) / 25) ** 2));
  const Cbarp7 = Cbarp ** 7;
  const RC = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + POW25_7));
  const Lm50sq = (Lbarp - 50) ** 2;
  const SL = 1 + (0.015 * Lm50sq) / Math.sqrt(20 + Lm50sq);
  const SC = 1 + 0.045 * Cbarp;
  const SH = 1 + 0.015 * Cbarp * T;
  const RT = -Math.sin(2 * dTheta * DEG) * RC;

  const l = dLp / (kL * SL);
  const c = dCp / (kC * SC);
  const h = dHp / (kH * SH);
  return Math.sqrt(l * l + c * c + h * h + RT * c * h);
}
