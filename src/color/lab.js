// sRGB (D65) → linear RGB → CIE XYZ → CIELAB, and the polar form (chroma, hue angle).

export const WHITE_D65 = Object.freeze({ X: 95.047, Y: 100, Z: 108.883 });

// The sRGB → XYZ matrix derived from the sRGB primaries and D65. Its rows sum to the white
// point above, so #FFFFFF lands on L* 100, a* 0, b* 0 exactly.
const M = [
  [0.4124564, 0.3575761, 0.1804375],
  [0.2126729, 0.7151522, 0.072175],
  [0.0193339, 0.119192, 0.9503041],
];

const EPSILON = 216 / 24389;
const KAPPA = 24389 / 27;

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new TypeError(`not a #RRGGBB colour: ${hex}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function srgbToLinear(channel255) {
  const c = channel255 / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function rgbToXyz([r, g, b]) {
  const lin = [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
  const [X, Y, Z] = M.map((row) => 100 * (row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2]));
  return { X, Y, Z };
}

function f(t) {
  return t > EPSILON ? Math.cbrt(t) : (KAPPA * t + 16) / 116;
}

export function xyzToLab({ X, Y, Z }, white = WHITE_D65) {
  const fx = f(X / white.X);
  const fy = f(Y / white.Y);
  const fz = f(Z / white.Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function hexToLab(hex) {
  return xyzToLab(rgbToXyz(hexToRgb(hex)));
}

export function chroma([, a, b]) {
  return Math.hypot(a, b);
}

// h_ab = atan2(b*, a*) in degrees, 0–360.
export function hueAngle([, a, b]) {
  if (a === 0 && b === 0) return 0;
  const h = (Math.atan2(b, a) * 180) / Math.PI;
  return h < 0 ? h + 360 : h;
}

export function round(n, places) {
  const p = 10 ** places;
  return Math.round(n * p) / p;
}

export function roundLab(lab, places = 1) {
  return lab.map((v) => round(v, places));
}
