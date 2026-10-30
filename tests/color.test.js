import { test } from "node:test";
import assert from "node:assert/strict";
import { hexToLab, hueAngle, chroma, rgbToXyz, xyzToLab } from "../src/color/lab.js";
import { deltaE00 } from "../src/color/ciede2000.js";

// The 34 test pairs of Sharma, Wu & Dalal (2005), Table 1, as published in
// ciede2000testdata.txt on G. Sharma's CIEDE2000 page (University of Rochester), read
// 30 Oct 2026: L1 a1 b1 L2 a2 b2 ΔE00.
const SHARMA_2005 = [
  [50.0000, 2.6772, -79.7751, 50.0000, 0.0000, -82.7485, 2.0425],
  [50.0000, 3.1571, -77.2803, 50.0000, 0.0000, -82.7485, 2.8615],
  [50.0000, 2.8361, -74.0200, 50.0000, 0.0000, -82.7485, 3.4412],
  [50.0000, -1.3802, -84.2814, 50.0000, 0.0000, -82.7485, 1.0000],
  [50.0000, -1.1848, -84.8006, 50.0000, 0.0000, -82.7485, 1.0000],
  [50.0000, -0.9009, -85.5211, 50.0000, 0.0000, -82.7485, 1.0000],
  [50.0000, 0.0000, 0.0000, 50.0000, -1.0000, 2.0000, 2.3669],
  [50.0000, -1.0000, 2.0000, 50.0000, 0.0000, 0.0000, 2.3669],
  [50.0000, 2.4900, -0.0010, 50.0000, -2.4900, 0.0009, 7.1792],
  [50.0000, 2.4900, -0.0010, 50.0000, -2.4900, 0.0010, 7.1792],
  [50.0000, 2.4900, -0.0010, 50.0000, -2.4900, 0.0011, 7.2195],
  [50.0000, 2.4900, -0.0010, 50.0000, -2.4900, 0.0012, 7.2195],
  [50.0000, -0.0010, 2.4900, 50.0000, 0.0009, -2.4900, 4.8045],
  [50.0000, -0.0010, 2.4900, 50.0000, 0.0010, -2.4900, 4.8045],
  [50.0000, -0.0010, 2.4900, 50.0000, 0.0011, -2.4900, 4.7461],
  [50.0000, 2.5000, 0.0000, 50.0000, 0.0000, -2.5000, 4.3065],
  [50.0000, 2.5000, 0.0000, 73.0000, 25.0000, -18.0000, 27.1492],
  [50.0000, 2.5000, 0.0000, 61.0000, -5.0000, 29.0000, 22.8977],
  [50.0000, 2.5000, 0.0000, 56.0000, -27.0000, -3.0000, 31.9030],
  [50.0000, 2.5000, 0.0000, 58.0000, 24.0000, 15.0000, 19.4535],
  [50.0000, 2.5000, 0.0000, 50.0000, 3.1736, 0.5854, 1.0000],
  [50.0000, 2.5000, 0.0000, 50.0000, 3.2972, 0.0000, 1.0000],
  [50.0000, 2.5000, 0.0000, 50.0000, 1.8634, 0.5757, 1.0000],
  [50.0000, 2.5000, 0.0000, 50.0000, 3.2592, 0.3350, 1.0000],
  [60.2574, -34.0099, 36.2677, 60.4626, -34.1751, 39.4387, 1.2644],
  [63.0109, -31.0961, -5.8663, 62.8187, -29.7946, -4.0864, 1.2630],
  [61.2901, 3.7196, -5.3901, 61.4292, 2.2480, -4.9620, 1.8731],
  [35.0831, -44.1164, 3.7933, 35.0232, -40.0716, 1.5901, 1.8645],
  [22.7233, 20.0904, -46.6940, 23.0331, 14.9730, -42.5619, 2.0373],
  [36.4612, 47.8580, 18.3852, 36.2715, 50.5065, 21.2231, 1.4146],
  [90.8027, -2.0831, 1.4410, 91.1528, -1.6435, 0.0447, 1.4441],
  [90.9257, -0.5406, -0.9208, 88.6381, -0.8985, -0.7239, 1.5381],
  [6.7747, -0.2908, -2.4247, 5.8714, -0.0985, -2.2286, 0.6377],
  [2.0776, 0.0795, -1.1350, 0.9033, -0.0636, -0.5514, 0.9082],
];

test("CIEDE2000 matches all 34 Sharma et al. (2005) pairs to 4 d.p.", () => {
  assert.equal(SHARMA_2005.length, 34);
  SHARMA_2005.forEach(([L1, a1, b1, L2, a2, b2, expected], i) => {
    const got = deltaE00([L1, a1, b1], [L2, a2, b2]);
    assert.equal(got.toFixed(4), expected.toFixed(4), `pair ${i + 1}`);
  });
});

test("CIEDE2000 is symmetric and zero for identical colours", () => {
  SHARMA_2005.forEach(([L1, a1, b1, L2, a2, b2]) => {
    const ab = deltaE00([L1, a1, b1], [L2, a2, b2]);
    const ba = deltaE00([L2, a2, b2], [L1, a1, b1]);
    assert.ok(Math.abs(ab - ba) < 1e-9);
  });
  assert.equal(deltaE00([64.1, 10.4, 18.0], [64.1, 10.4, 18.0]), 0);
});

function near(actual, expected, tol, msg) {
  assert.ok(Math.abs(actual - expected) <= tol, `${msg}: ${actual} vs ${expected}`);
}

test("sRGB white and black land on the D65 white point and the origin", () => {
  const white = hexToLab("#FFFFFF");
  near(white[0], 100, 1e-5, "L* of white");
  near(white[1], 0, 1e-4, "a* of white");
  near(white[2], 0, 1e-4, "b* of white");
  assert.deepEqual(hexToLab("#000000"), [0, 0, 0]);
});

test("sRGB greys are neutral (a* and b* near 0)", () => {
  for (const hex of ["#202020", "#777777", "#C0C0C0"]) {
    const [, a, b] = hexToLab(hex);
    near(a, 0, 1e-3, `a* of ${hex}`);
    near(b, 0, 1e-3, `b* of ${hex}`);
  }
});

// The sRGB primaries in CIELAB (D65), as given by B. Lindbloom's reference calculator and
// reproduced in most colour-science references: red 53.24 80.09 67.20, green 87.73 -86.18
// 83.18, blue 32.30 79.19 -107.86.
test("sRGB primaries match the published CIELAB values to 2 d.p.", () => {
  const cases = [
    ["#FF0000", [53.24, 80.09, 67.2]],
    ["#00FF00", [87.73, -86.18, 83.18]],
    ["#0000FF", [32.3, 79.19, -107.86]],
  ];
  for (const [hex, lab] of cases) {
    const got = hexToLab(hex);
    lab.forEach((v, i) => near(got[i], v, 0.006, `${hex}[${i}]`));
  }
});

test("XYZ of white is the D65 white point", () => {
  const { X, Y, Z } = rgbToXyz([255, 255, 255]);
  near(X, 95.047, 1e-4, "X");
  near(Y, 100, 1e-4, "Y");
  near(Z, 108.883, 1e-4, "Z");
  assert.deepEqual(xyzToLab({ X: 0, Y: 0, Z: 0 }), [0, 0, 0]);
});

test("hue angle and chroma of a skin-like reading", () => {
  near(hueAngle([64.1, 10.4, 18.0]), 59.98, 0.01, "h_ab");
  near(chroma([64.1, 10.4, 18.0]), 20.79, 0.01, "C*");
  assert.equal(hueAngle([50, 0, 0]), 0);
  near(hueAngle([50, 0, -5]), 270, 1e-9, "h_ab of pure -b*");
});
