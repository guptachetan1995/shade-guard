// Every pane says what it runs on (S0b review): a single-pane screenshot or video take of the desk or
// the phone must not look like a live service. The words come from the transport's own description, so
// they live only in the offline files and never reach the static build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { connectionBar, settleRefusal } from "../public/chat/common.js";
import { createFakeClient } from "../src/chat/fake-client.js";
import { FakeChatServer } from "../src/chat/fake-transport.js";
import { createUnavailableTransport, STATUS } from "../src/chat/transport.js";

const fake = () => new FakeChatServer().transport("fakedesk1").describe();

test("a pane on the fake service carries the FAKE CHAT pill in every state, and its connected words say so", () => {
  for (const state of Object.values(STATUS)) {
    const html = connectionBar({ state, detail: null }, fake());
    assert.match(html, /FAKE CHAT \(offline\)/, `${state} has no pill`);
  }
  const connected = connectionBar({ state: STATUS.CONNECTED, detail: null }, fake());
  assert.match(connected, /fake in-memory service/i);
  assert.doesNotMatch(connected, /Messages cross the chat service/, "the plain connected words would read as a live service");
});

test("the browser client for the fake service describes itself the same way", () => {
  const html = connectionBar({ state: STATUS.CONNECTED, detail: null }, createFakeClient({ userId: "fakedesk1" }).describe());
  assert.match(html, /FAKE CHAT \(offline\)/);
  assert.match(html, /fake in-memory service/i);
});

test("a pane with no service says the SDK is not loaded and carries no fake pill; a real connection would read as connected", () => {
  const none = connectionBar({ state: STATUS.SDK_NOT_LOADED, detail: null }, createUnavailableTransport().describe());
  assert.match(none, /SDK is not loaded/);
  assert.doesNotMatch(none, /data-fake|FAKE CHAT/);
  const real = connectionBar({ state: STATUS.CONNECTED, detail: null }, { kind: "nexconn", banner: null, userId: "u", via: "Nexconn" });
  assert.match(real, /Messages cross the chat service/);
  assert.doesNotMatch(real, /data-fake|FAKE CHAT/);
});

test("a busy seat offers another seat, an offline state shows its detail, and the detail is escaped", () => {
  const busy = connectionBar({ state: STATUS.BUSY, detail: "10 connections already use <u>" }, fake());
  assert.match(busy, /data-action="another-seat"/);
  assert.match(busy, /&lt;u&gt;/);
  assert.doesNotMatch(connectionBar({ state: STATUS.CONNECTED, detail: null }, fake()), /another-seat/);
});

test("a refusal stays while the thread is as it was, and clears once a newer message has arrived", () => {
  const r = { tool: "approve_exchange", code: "not_accepted", message: "m", caseId: "R-104" };
  const stamped = settleRefusal(r, "fm_3");
  assert.equal(stamped.at, "fm_3", "the first look stamps what the thread showed");
  assert.equal(settleRefusal(stamped, "fm_3"), stamped, "same thread, same refusal");
  assert.equal(settleRefusal(stamped, "fm_4"), null, "she accepted: the old refusal no longer describes the screen");
  assert.equal(settleRefusal(null, "fm_4"), null);
});

test("the desk's 'Try it as the agent' result box is light with dark ink, not the store's dark panel it shares a class name with", async () => {
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(new URL("../public/chat.css", import.meta.url), "utf8");
  const rule = /(^|\n)\.try-out\s*\{([^}]*)\}/.exec(css)?.[2] ?? "";
  assert.match(rule, /background:\s*var\(--surface-2\)/, "chat.css must reset the #2c2529 styles.css gives .try-out");
  assert.match(rule, /color:\s*var\(--ink\)/);
});
