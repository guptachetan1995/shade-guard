// The pieces behind the flood handling (S0b review): the log cap and the page's redraw coalescer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_LOG_ENTRIES } from "../src/invoke.js";
import { coalesced } from "../public/chat/common.js";

test("the activity log keeps at most 2000 entries", () => {
  assert.equal(MAX_LOG_ENTRIES, 2000);
});

test("coalesced runs its function once per burst, however many times it is asked, and again for the next burst", async () => {
  let runs = 0;
  const later = [];
  const go = coalesced(() => runs++, (f) => later.push(f));
  for (let i = 0; i < 3000; i++) go();
  assert.equal(later.length, 1, "one run scheduled");
  later.shift()();
  assert.equal(runs, 1);
  go();
  go();
  assert.equal(later.length, 1);
  later.shift()();
  assert.equal(runs, 2);
});
