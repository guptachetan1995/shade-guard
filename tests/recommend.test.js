import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bandFor,
  decide,
  finishFor,
  rednessNote,
  rankShades,
  undertoneFromHue,
  LIGHTING_FACTOR,
  NO_GOOD_MATCH,
  REDNESS_FLAG,
  REPEAT_SPREAD_DE,
  SKIN_TYPE_LABELS,
} from "../src/rules/recommend.js";
import { hexToLab, hueAngle } from "../src/color/lab.js";
import { loadFixtures } from "../src/fixtures.js";

const rk = (...pairs) => pairs.map(([code, de00]) => ({ code, de00 }));

test("the thresholds are the planned values", () => {
  assert.equal(REPEAT_SPREAD_DE, 1.0);
  assert.equal(LIGHTING_FACTOR, 1.5);
  assert.equal(NO_GOOD_MATCH, 6.0);
});

test("band: REPEAT_SPREAD_DE when lighting is good, × LIGHTING_FACTOR otherwise", () => {
  assert.equal(bandFor({ lighting: "good" }), REPEAT_SPREAD_DE);
  assert.equal(bandFor({ lighting: "poor" }), REPEAT_SPREAD_DE * LIGHTING_FACTOR);
  assert.equal(bandFor({}), REPEAT_SPREAD_DE * LIGHTING_FACTOR, "a missing verdict is not good");
});

test("no_match: only when the best ΔE00 is greater than 6.0, even if the best is the cart shade", () => {
  assert.equal(decide({ ranking: rk(["A", 6.0], ["B", 9]), cartShadeCode: "B", band: 1 }).decision, "swap");
  assert.equal(decide({ ranking: rk(["A", 6.01], ["B", 9]), cartShadeCode: "B", band: 1 }).decision, "no_match");
  const own = decide({ ranking: rk(["A", 6.5], ["B", 9]), cartShadeCode: "A", band: 1 });
  assert.deepEqual(own, { decision: "no_match", nearest: "A" });
});

test("keep: the cart shade ranks first, or sits within the band of the best", () => {
  assert.equal(decide({ ranking: rk(["A", 2], ["B", 2.5]), cartShadeCode: "A", band: 1 }).decision, "keep");
  assert.equal(decide({ ranking: rk(["A", 2], ["B", 3.0]), cartShadeCode: "B", band: 1 }).decision, "keep", "at the band");
  assert.equal(decide({ ranking: rk(["A", 2], ["B", 3.01], ["C", 5]), cartShadeCode: "B", band: 1 }).decision, "swap", "just outside");
});

test("sample_duo: the best two are within the band and the cart shade is neither", () => {
  const at = decide({ ranking: rk(["A", 1.6], ["B", 2.6], ["C", 3.9]), cartShadeCode: "C", band: 1 });
  assert.deepEqual(at, { decision: "sample_duo", shadeCodes: ["A", "B"] });
  const outside = decide({ ranking: rk(["A", 1.6], ["B", 2.61], ["C", 3.9]), cartShadeCode: "C", band: 1 });
  assert.deepEqual(outside, { decision: "swap", shadeCode: "A" });
});

test("a wider band (poor lighting) turns a swap into a sample duo", () => {
  const ranking = rk(["245W", 1.93], ["250W", 3.1], ["220N", 4.62]);
  assert.equal(decide({ ranking, cartShadeCode: "220N", band: bandFor({ lighting: "good" }) }).decision, "swap");
  assert.equal(decide({ ranking, cartShadeCode: "220N", band: bandFor({ lighting: "poor" }) }).decision, "sample_duo");
});

test("all eight skin_type labels map to a finish and a redness flag, from the whole region", () => {
  const expected = {
    Normal: ["satin", false],
    Oily: ["matte", false],
    Dry: ["radiant", false],
    Combination: ["satin", false],
    Redness: ["satin", true],
    "Dry & Redness": ["radiant", true],
    "Oily & Redness": ["matte", true],
    "Combination & Redness": ["satin", true],
  };
  assert.deepEqual([...SKIN_TYPE_LABELS].sort(), Object.keys(expected).sort());
  for (const [label, [finish, redness]] of Object.entries(expected)) {
    const f = finishFor(label);
    assert.equal(f.finish, finish, label);
    assert.equal(f.rednessInLabel, redness, label);
    assert.equal(rednessNote(label, 99), redness, `${label} note with a high raw score`);
  }
  assert.throws(() => finishFor("Sensitive"), /unknown skin_type/);
});

test("the redness note also fires on a raw score below REDNESS_FLAG", () => {
  assert.equal(rednessNote("Normal", REDNESS_FLAG - 0.1), true);
  assert.equal(rednessNote("Normal", REDNESS_FLAG), false);
});

test("undertone reading from hue angle", () => {
  assert.equal(undertoneFromHue(50), "cool");
  assert.equal(undertoneFromHue(54), "neutral");
  assert.equal(undertoneFromHue(58.9), "neutral");
  assert.equal(undertoneFromHue(59), "warm");
});

test("the catalogue is consistent: lab is its hex in CIELAB, undertone labels follow the hue rule", () => {
  const { catalogue } = loadFixtures();
  for (const p of catalogue.products) {
    for (const s of p.shades) {
      const lab = hexToLab(s.hex);
      s.lab.forEach((v, i) => assert.ok(Math.abs(v - lab[i]) < 0.006, `${s.code} lab[${i}]`));
      assert.equal(s.undertone, undertoneFromHue(hueAngle(s.lab)), `${s.code} undertone`);
      const letter = { C: "cool", N: "neutral", W: "warm" }[s.code.at(-1)];
      if (letter) assert.equal(s.undertone, letter, `${s.code} code letter`);
    }
  }
});

test("rankShades sorts by ΔE00, rounded to 2 d.p.", () => {
  const { catalogue } = loadFixtures();
  const tint = catalogue.products.find((p) => p.productId === "skin-tint");
  const ranking = rankShades(hexToLab("#B9947C"), tint.shades);
  assert.deepEqual(ranking.slice(0, 3), rk(["245W", 1.93], ["250W", 3.1], ["220N", 4.62]));
  for (let i = 1; i < ranking.length; i++) assert.ok(ranking[i].de00 >= ranking[i - 1].de00);
});
