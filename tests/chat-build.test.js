import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildPages, OFFLINE_ONLY } from "../scripts/build-pages.js";
import { startServer } from "../src/server.js";
import { describeMode } from "../src/modes.js";
import { makeApp } from "./helpers.js";

let dir;
let built;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "shade-guard-chat-build-"));
  built = buildPages(join(dir, "site"), { recordingDir: join(dir, "no-recording") });
});
after(() => rmSync(dir, { recursive: true, force: true }));

const allFiles = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? allFiles(join(d, n)) : [join(d, n)]));

test("the Pages build carries the chat's pages and its real code, and none of the offline fake service", () => {
  for (const f of ["chat.html", "public/chat.css", "public/chat/boot.js", "public/chat/frame.js", "public/chat/desk.js", "public/chat/shopper.js", "public/chat/common.js", "src/chat/transport.js", "src/chat/messages.js", "src/chat/states.js", "src/chat/seats.js", "src/chat-verbs.js", "src/thread-tools.js", "src/threads.js", "src/invoke.js"]) {
    assert.ok(built.files.includes(f), `${f} is missing from the build`);
  }
  assert.deepEqual(OFFLINE_ONLY.filter((f) => built.files.includes(f)), [], "an offline-only file was copied");
  assert.equal(OFFLINE_ONLY.length, 4);
  assert.match(readFileSync(join(built.out, "chat.html"), "utf8"), /data-transport="pages"/);
});

test("no built file mentions the fake service, its client, its routes or its banner", () => {
  const re = /fake[- ]chat|FakeChat|fake-(transport|client|http)/i;
  for (const f of allFiles(built.out)) {
    if (!/\.(js|html|css|json)$/.test(f)) continue;
    assert.doesNotMatch(readFileSync(f, "utf8"), re, f);
  }
  const files = allFiles(built.out).map((f) => f.slice(built.out.length + 1));
  assert.equal(files.some((f) => /fake-(transport|client|http)/.test(f)), false);
});

test("every relative import in the built chat code resolves to a built file", () => {
  const importRe = /(?:from\s+|import\(\s*)["'](\.[^"']+)["']/g;
  const present = new Set(allFiles(built.out).map((f) => f.slice(built.out.length + 1)));
  for (const f of allFiles(built.out).filter((p) => /\/(chat|src)\//.test(p) && p.endsWith(".js"))) {
    const rel = f.slice(built.out.length + 1);
    for (const m of readFileSync(f, "utf8").matchAll(importRe)) {
      const target = join(rel, "..", m[1]).replace(/^\.\//, "");
      // The one optional module: reached only from the local server's page, never in the static build.
      if (target === "public/chat/local-transport.js") continue;
      assert.ok(present.has(target), `${rel} imports ${m[1]}, which the build does not hold`);
    }
  }
});

test("the built chat, with no service, runs the app on the transport that says the SDK is not loaded, and fakes nothing", async () => {
  const { createPagesTransport } = await import(pathToFileURL(join(built.out, "src/pages-entry.js")).href);
  const { createUnavailableTransport } = await import(pathToFileURL(join(built.out, "src/chat/transport.js")).href);
  const { fakeSeats } = await import(pathToFileURL(join(built.out, "src/chat/seats.js")).href);
  const [seat] = fakeSeats();
  const t = await createPagesTransport({ tick: false, chat: { transport: createUnavailableTransport(), seat, side: "shopper", as: 0, visit: "static" } });
  const status = await t.chat.connect();
  assert.equal(status.state, "sdk_not_loaded");
  const { state } = await t.request("GET", "/api/state");
  assert.equal(state.chat.connection.state, "sdk_not_loaded");
  const send = await t.request("POST", "/api/invoke", { tool: "shopper_send", args: { kind: "note", text: "hello" }, actor: "shopper" });
  assert.equal(send.ok, false);
  assert.equal(send.error.code, "chat_offline", "nothing is sent, and nothing is faked");
  const after = await t.request("GET", "/api/state");
  assert.equal(after.state.threads["R-104"].messages.length, 0);
  assert.equal((await t.request("POST", "/api/invoke", { tool: "record_inbound", args: {}, actor: "nexconn" })).error.code, "wrong_actor", "and the page can't name the adapter");
});

test("the local server serves chat.html so its own iframes can frame it, and nothing else frameable", async () => {
  const srv = await startServer({ app: await makeApp(), mode: describeMode("fake") });
  try {
    const chat = await fetch(`${srv.url}/chat.html`);
    assert.equal(chat.status, 200);
    assert.match(chat.headers.get("content-security-policy"), /frame-ancestors 'self'/);
    const index = await fetch(`${srv.url}/index.html`);
    assert.match(index.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.equal((await fetch(`${srv.url}/public/chat/desk.js`)).status, 200);
    assert.equal((await fetch(`${srv.url}/src/server.js`)).status, 404, "the server itself is still never served");
  } finally {
    await srv.close();
  }
});
