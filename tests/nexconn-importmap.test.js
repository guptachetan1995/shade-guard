// The SDK's import map is pinned: exact versions, jsDelivr only, one integrity value per URL, the
// values the S0 probe and its review recomputed (6 Nov 2026). A changed byte on the CDN then fails in
// the browser ("Failed to find a valid digest") instead of running.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const MAPS = /<script type="importmap">([\s\S]*?)<\/script>/g;

const CHAT = "https://cdn.jsdelivr.net/npm/@nexconn/chat@26.2.1/index.mjs";
const ENGINE = "https://cdn.jsdelivr.net/npm/@nexconn/engine@26.2.1/index.mjs";
const PINNED = Object.freeze({
  [CHAT]: "sha384-g21sxlxq/rKOQLzU3/ZYF84igwc+s6d+/ZnZMY/f6D1UMlTHmbPX5nns2F7Hnn4H",
  [ENGINE]: "sha384-1rmNKbYPpmnbixitVw5+iAr+SZo8YMfCGvnrnGHJvzgbLai7wmQKzbTVFxGf4rbk",
});

test("chat.html carries exactly one import map, before its module script, naming both SDK files at exactly 26.2.1 on jsDelivr", () => {
  const html = read("chat.html");
  const maps = [...html.matchAll(MAPS)];
  assert.equal(maps.length, 1);
  assert.ok(maps[0].index < html.indexOf('<script type="module"'), "an import map must come before any module script");
  const map = JSON.parse(maps[0][1]);
  assert.deepEqual(Object.keys(map).sort(), ["imports", "integrity"]);
  assert.deepEqual(map.imports, { "@nexconn/chat": CHAT, "@nexconn/engine": ENGINE });
  for (const [name, url] of Object.entries(map.imports)) {
    const m = /^https:\/\/cdn\.jsdelivr\.net\/npm\/(@nexconn\/[a-z]+)@(\d+\.\d+\.\d+)\/index\.mjs$/.exec(url);
    assert.ok(m, `${url} is a jsDelivr npm URL with an exact version`);
    assert.deepEqual([m[1], m[2]], [name, "26.2.1"], "the URL names its own package, and both stay on one version as the docs ask");
  }
});

test("every URL in the import map has its own sha384 integrity value, and the values are the pinned ones", () => {
  const map = JSON.parse([...read("chat.html").matchAll(MAPS)][0][1]);
  assert.deepEqual(Object.keys(map.integrity).sort(), Object.values(map.imports).sort());
  for (const v of Object.values(map.integrity)) assert.match(v, /^sha384-[A-Za-z0-9+/]{64}$/);
  assert.deepEqual(map.integrity, PINNED);
});

test("no other page carries an import map, and no shipped module names the CDN but the server's CSP", () => {
  assert.equal([...read("index.html").matchAll(MAPS)].length, 0, "the store page loads no SDK");
  for (const f of ["public/chat-sdk.js", "public/chat/common.js", "public/chat/boot.js", "src/chat/nexconn-transport.js"]) {
    assert.doesNotMatch(read(f), /cdn\.jsdelivr\.net/, `${f} names the CDN; only chat.html's import map may`);
  }
});

