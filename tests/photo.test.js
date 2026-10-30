import { test } from "node:test";
import assert from "node:assert/strict";
import { readJpegInfo, checkPhoto, PHOTO_LIMITS } from "../src/photo-check.js";
import { fakePhoto, toBase64 } from "../src/providers/fake-photos.js";
import { makeApp } from "./helpers.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const HEIC = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0]);

test("the header reader finds dimensions after other segments", () => {
  assert.deepEqual(readJpegInfo(fakePhoto("x", { width: 768, height: 1024 })), { width: 768, height: 1024, comment: "shade-guard-fake:x" });
  const app1 = [0xff, 0xe1, 0x00, 0x06, 1, 2, 3, 4];
  const base = fakePhoto("y", { width: 1024, height: 768 });
  const withExif = new Uint8Array([0xff, 0xd8, ...app1, ...base.subarray(2)]);
  const info = readJpegInfo(withExif);
  assert.equal(info.width, 1024);
  assert.equal(info.height, 768);
});

test("a progressive (SOF2) header is read too", () => {
  const b = fakePhoto("p", { width: 600, height: 800 });
  const i = b.indexOf(0xc0, 2);
  b[i] = 0xc2;
  assert.deepEqual([readJpegInfo(b).width, readJpegInfo(b).height], [600, 800]);
});

test("PNG, HEIC, garbage and a header with no frame are refused by code", () => {
  assert.throws(() => readJpegInfo(PNG), { code: "photo_not_jpeg" });
  assert.throws(() => readJpegInfo(HEIC), { code: "photo_heic" });
  assert.throws(() => readJpegInfo(new Uint8Array([1, 2, 3, 4])), { code: "photo_not_jpeg" });
  assert.throws(() => readJpegInfo(new Uint8Array([0xff, 0xd8, 0xff, 0xd9])), { code: "photo_unreadable" });
});

test("limits: long side at most 1024, short side at least 480, under 10 MB", () => {
  assert.equal(checkPhoto(fakePhoto("a", { width: 768, height: 1024 })).width, 768);
  assert.equal(checkPhoto(fakePhoto("a", { width: 480, height: 640 })).height, 640);
  assert.throws(() => checkPhoto(fakePhoto("a", { width: 3024, height: 4032 })), { code: "photo_not_normalised" });
  assert.throws(() => checkPhoto(fakePhoto("a", { width: 1025, height: 768 })), { code: "photo_not_normalised" });
  assert.throws(() => checkPhoto(fakePhoto("a", { width: 479, height: 1024 })), { code: "photo_too_small" });
  const big = new Uint8Array(PHOTO_LIMITS.maxBytes + 1);
  big.set(fakePhoto("a"));
  assert.throws(() => checkPhoto(big), { code: "photo_too_large" });
});

test("start_check refuses PNG, HEIC and out-of-limit sizes, and opens no check", async () => {
  const app = await makeApp();
  const cases = [
    [toBase64(PNG), "photo_not_jpeg"],
    [toBase64(HEIC), "photo_heic"],
    [toBase64(fakePhoto("a", { width: 3024, height: 4032 })), "photo_not_normalised"],
    [toBase64(fakePhoto("a", { width: 300, height: 400 })), "photo_too_small"],
    ["not base64 at all!", "photo_unreadable"],
  ];
  for (const [photo, code] of cases) {
    const r = await app.invoke("start_check", { photo, capture: "upload" }, "shopper");
    assert.equal(r.ok, false);
    assert.equal(r.error.code, code);
  }
  assert.equal(app.store.state.checks.length, 0);
  assert.equal(app.provider.calls.length, 1, "only the start-up cost read reached the provider");
});
