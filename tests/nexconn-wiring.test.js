// How the page gets to Nexconn: the seats file read strictly, served by the local server only to its
// own chat page, copied into a Pages build only when NEXCONN_SEATS_FILE names it, and turned into the
// adapter (or the transport that says why not) by the pages' one wiring helper. Dummy values only:
// no file under ~/.config is read and nothing connects to Nexconn.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NEXCONN_AREAS, parseNexconnSeats, seatsFileOf, SHOPPER_PROFILES } from "../src/chat/seats.js";
import { AREA_KEYS } from "../src/chat/nexconn-transport.js";
import { defaultNexconnSeatsFile, nexconnSeatsFileSetting, readNexconnSeats } from "../src/config.js";
import { startServer, SEATS_PATH } from "../src/server.js";
import { describeMode } from "../src/modes.js";
import { FakeChatServer } from "../src/chat/fake-transport.js";
import { buildPages, SEATS_FILE_NAME } from "../scripts/build-pages.js";
import { filesHoldingSecret, run as runTokens } from "../scripts/nexconn-tokens.js";
import { pagesSeatsSetting } from "../src/config.js";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadChatConfig, makeTransport } from "../public/chat/common.js";
import { STATUS } from "../src/chat/transport.js";
import { MockNexconnServer } from "./nexconn-sdk-mock.js";
import { makeApp } from "./helpers.js";

const dir = mkdtempSync(join(tmpdir(), "sg-nexconn-wiring-"));
after(() => rmSync(dir, { recursive: true, force: true }));

// A dummy env file in the shape the owner's has. The secret is made up for this file.
const DUMMY_SECRET = "dummy-app-secret-for-the-wiring-tests";
const envFile = (over = {}) => {
  const v = { NEXCONN_APP_KEY: "dummyAppKey123", NEXCONN_AREA: "SG", NEXCONN_API_HOST: "api.sg-light-api.com", NEXCONN_APP_SECRET: DUMMY_SECRET, ...over };
  return write(`env-${Math.random().toString(36).slice(2)}.env`, Object.entries(v).map(([k, x]) => `${k}=${x}`).join("\n") + "\n");
};

// The shape scripts/nexconn-tokens.js writes, with dummy ids and tokens.
function seatsFile(count = 2) {
  return {
    appKey: "dummyAppKey123",
    area: "SG",
    seats: Array.from({ length: count }, (_, i) => {
      const n = i + 1;
      const desk = `sgdesk0000000${n}`;
      const shoppers = SHOPPER_PROFILES.map((p, k) => ({ userId: `sgshop000000${n}${k}`, ...p }));
      return { n, deskUserId: desk, shoppers, tokens: Object.fromEntries([desk, ...shoppers.map((s) => s.userId)].map((u) => [u, `dummy-token-for-${u}`])) };
    }),
  };
}
const write = (name, value) => {
  const path = join(dir, name);
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  return path;
};
const refusal = (json) => {
  try {
    parseNexconnSeats(json);
  } catch (e) {
    return e.message;
  }
  return null;
};

// ---------------------------------------------------------------------------- the seats file

test("a seats file in the token script's shape parses into the seats the pages use and one token map, and writes back unchanged", () => {
  const file = seatsFile();
  const c = parseNexconnSeats(file);
  assert.deepEqual(Object.keys(c).sort(), ["appKey", "area", "kind", "seats", "tokens"]);
  assert.deepEqual([c.kind, c.appKey, c.area, c.seats.length, Object.keys(c.tokens).length], ["nexconn", "dummyAppKey123", "SG", 2, 6]);
  assert.deepEqual(c.seats[0], { n: 1, deskUserId: "sgdesk00000001", shoppers: file.seats[0].shoppers });
  assert.equal(Object.hasOwn(c.seats[0], "tokens"), false, "the seats the app is given carry no token");
  assert.deepEqual(seatsFileOf(c), file);
  assert.deepEqual(NEXCONN_AREAS, Object.keys(AREA_KEYS), "every area the seats file may name has an SDK AreaCode key");
});

test("the seats file is read strictly: an unknown field, a bad area or id, a repeated id, a missing token, or a changed shopper is refused, and no token is ever quoted", () => {
  const f = seatsFile;
  const cases = [
    [{ ...f(), appSecret: "never-here" }, /top level carries appSecret/],
    [{ ...f(), area: "EU" }, /area must be one of SG, NA, SAU/],
    [{ ...f(), appKey: "has a space" }, /appKey/],
    [{ ...f(), seats: [] }, /1 to 10 seats/],
    [{ ...f(11) }, /1 to 10 seats/],
    [(() => { const x = f(); x.seats[1].n = 1; return x; })(), /unique number/],
    [(() => { const x = f(); x.seats[0].deskUserId = "bad id!"; x.seats[0].tokens = { "bad id!": "t", ...x.seats[0].tokens }; delete x.seats[0].tokens.sgdesk00000001; return x; })(), /user id that is not/],
    [(() => { const x = f(); x.seats[1].deskUserId = x.seats[0].deskUserId; x.seats[1].tokens[x.seats[0].deskUserId] = "t"; delete x.seats[1].tokens.sgdesk00000002; return x; })(), /appears twice/],
    [(() => { const x = f(); delete x.seats[0].tokens.sgdesk00000001; return x; })(), /no usable token/],
    [(() => { const x = f(); x.seats[0].tokens.someoneElse = "t"; return x; })(), /tokens carries someoneElse/],
    [(() => { const x = f(); x.seats[0].shoppers[0].caseId = "R-999"; return x; })(), /must be Maya/],
    [(() => { const x = f(); x.seats[0].shoppers[1].extra = 1; return x; })(), /shopper 2 carries extra/],
  ];
  for (const [json, why] of cases) {
    const msg = refusal(json);
    assert.ok(msg, `not refused: ${why}`);
    assert.match(msg, why);
    assert.doesNotMatch(msg, /dummy-token-for/);
  }
});

test("config.js: the server's seats file is NEXCONN_SEATS_FILE or the default under ~/.config; a broken file is a NexconnConfigError that quotes nothing of it", () => {
  assert.match(defaultNexconnSeatsFile(), /\.config\/shade-guard\/nexconn-seats\.json$/);
  const saved = process.env.NEXCONN_SEATS_FILE;
  try {
    delete process.env.NEXCONN_SEATS_FILE;
    assert.equal(nexconnSeatsFileSetting(), null);
    process.env.NEXCONN_SEATS_FILE = " /some/where.json ";
    assert.equal(nexconnSeatsFileSetting(), "/some/where.json");
  } finally {
    if (saved === undefined) delete process.env.NEXCONN_SEATS_FILE;
    else process.env.NEXCONN_SEATS_FILE = saved;
  }
  assert.equal(readNexconnSeats(write("ok.json", seatsFile())).kind, "nexconn");
  for (const [name, text] of [["notjson.json", '{"tokens": "dummy-token-for-x"'], ["badshape.json", { ...seatsFile(), extra: "dummy-token-for-x" }]]) {
    assert.throws(() => readNexconnSeats(write(name, text)), (e) => e.code === "seats_file_invalid" && !/dummy-token-for/.test(e.message));
  }
});

// ---------------------------------------------------------------------------- the local server

const mapHash = (html) => `'sha256-${createHash("sha256").update(/<script type="importmap">([\s\S]*?)<\/script>/.exec(html)[1]).digest("base64")}'`;

test("the local server serves the seats file to its own chat page, no-store, and lets chat.html load the pinned SDK from jsDelivr and connect out", async () => {
  const seats = parseNexconnSeats(seatsFile());
  const srv = await startServer({ app: await makeApp(), mode: describeMode("fake"), nexconnSeats: seats });
  try {
    const res = await fetch(`${srv.url}${SEATS_PATH}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(await res.json(), seatsFileOf(seats));
    const page = await fetch(`${srv.url}/chat.html`);
    const csp = page.headers.get("content-security-policy");
    const html = await page.text();
    assert.match(csp, new RegExp(`script-src 'self' ${mapHash(html).replace(/[+/]/g, "\\$&")} https://cdn\\.jsdelivr\\.net/npm/@nexconn/;`), "the CDN only under the SDK's own path");
    const map = JSON.parse(/<script type="importmap">([\s\S]*?)<\/script>/.exec(html)[1]);
    for (const u of Object.values(map.imports)) assert.ok(u.startsWith("https://cdn.jsdelivr.net/npm/@nexconn/"), `${u} is outside the policy's script source`);
    assert.match(csp, /connect-src 'self' https: wss:;/);
    assert.match(csp, /frame-ancestors 'self'/);
    const index = (await fetch(`${srv.url}/index.html`)).headers.get("content-security-policy");
    assert.doesNotMatch(index, /jsdelivr|https:/, "the store page loads no SDK");
    const other = await new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: srv.server.address().port, path: SEATS_PATH, headers: { host: "attacker.invalid" } }, (r) => {
        r.resume();
        resolve(r.statusCode);
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(other, 403, "a page on another name (DNS rebinding) gets nothing");
  } finally {
    await srv.close();
  }
});

test("without a seats config, or with the offline service, the server serves no seats file and chat.html may run only its own import map", async () => {
  for (const extra of [{}, { fakeChat: new FakeChatServer(), nexconnSeats: parseNexconnSeats(seatsFile()) }]) {
    const srv = await startServer({ app: await makeApp(), mode: describeMode("fake"), ...extra });
    try {
      assert.equal((await fetch(`${srv.url}${SEATS_PATH}`)).status, 404);
      const page = await fetch(`${srv.url}/chat.html`);
      const csp = page.headers.get("content-security-policy");
      assert.match(csp, new RegExp(`script-src 'self' ${mapHash(await page.text()).replace(/[+/]/g, "\\$&")};`));
      assert.doesNotMatch(csp, /jsdelivr/);
      assert.match(csp, /connect-src 'self';/);
    } finally {
      await srv.close();
    }
  }
});

// ---------------------------------------------------------------------------- the Pages build

test("the Pages build copies the seats file in only when it is given one, field by field, and keeps the import map as written", () => {
  const without = buildPages(join(dir, "site-plain"), { recordingDir: join(dir, "none") });
  assert.equal(without.nexconn, false);
  assert.equal(without.files.includes(SEATS_FILE_NAME), false);
  const withSeats = buildPages(join(dir, "site-nexconn"), { recordingDir: join(dir, "none"), seatsFile: write("build-seats.json", seatsFile()), envFile: envFile() });
  assert.equal(withSeats.nexconn, true);
  assert.ok(withSeats.files.includes(SEATS_FILE_NAME));
  assert.deepEqual(JSON.parse(readFileSync(join(withSeats.out, SEATS_FILE_NAME), "utf8")), seatsFile());
  assert.ok(withSeats.files.includes("public/chat-sdk.js") && withSeats.files.includes("src/chat/nexconn-transport.js"));
  const src = readFileSync(new URL("../chat.html", import.meta.url), "utf8");
  const built = readFileSync(join(withSeats.out, "chat.html"), "utf8");
  assert.equal(mapHash(built), mapHash(src), "the built page's import map is byte for byte the source's");
});

test("the Pages build refuses a seats file it can't vouch for, and refuses to write tokens inside a git work tree", () => {
  assert.throws(() => buildPages(join(dir, "site-bad"), { recordingDir: join(dir, "none"), seatsFile: write("bad-seats.json", { ...seatsFile(), appSecret: "dummy" }), envFile: envFile() }), /not valid/);
  const repo = join(dir, "a-repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  assert.throws(() => buildPages(join(repo, "out"), { recordingDir: join(dir, "none"), seatsFile: write("ok-seats.json", seatsFile()), envFile: envFile() }), /inside a git work tree/);
  assert.equal(buildPages(join(repo, "out-plain"), { recordingDir: join(dir, "none") }).nexconn, false, "a build without tokens may go anywhere");
});

// ---------------------------------------------------------------------------- the App Secret scan

test("the secret scan names every file under a folder whose bytes hold the App Secret's value, at any depth and in any kind of file, and never the value", () => {
  const tree = join(dir, "scan-tree");
  mkdirSync(join(tree, "a", "b"), { recursive: true });
  writeFileSync(join(tree, "clean.txt"), "nothing here");
  writeFileSync(join(tree, "a", "b", "deep.js"), `const s = "${DUMMY_SECRET}";`);
  writeFileSync(join(tree, "a", "photo.bin"), Buffer.concat([Buffer.from([0, 255, 1]), Buffer.from(DUMMY_SECRET), Buffer.from([7])]));
  const { hits, scanned } = filesHoldingSecret(tree, DUMMY_SECRET);
  assert.deepEqual(hits, ["a/b/deep.js", "a/photo.bin"]);
  assert.equal(scanned, 3);
});

test("npm run nexconn:tokens -- --scan <dir> prints file names only and fails on a hit; it fails closed without a readable env file", async () => {
  const tree = join(dir, "scan-cli");
  mkdirSync(tree, { recursive: true });
  writeFileSync(join(tree, "ok.html"), "<p>clean</p>");
  const io = () => {
    const o = { out: "", err: "" };
    return { o, io: { out: (x) => (o.out += x), err: (x) => (o.err += x) } };
  };
  const clean = io();
  assert.equal(await runTokens(["--scan", tree, "--env-file", envFile()], clean.io), 0);
  assert.match(clean.o.out, /No file under .* holds the App Secret's value \(1 file scanned\)/);
  writeFileSync(join(tree, "leak.json"), JSON.stringify({ s: DUMMY_SECRET }));
  const hit = io();
  assert.equal(await runTokens(["--scan", tree, "--env-file", envFile()], hit.io), 1);
  assert.match(hit.o.err, /leak\.json/);
  assert.equal((hit.o.out + hit.o.err).includes(DUMMY_SECRET), false, "the value is never printed");
  const none = io();
  assert.equal(await runTokens(["--scan", tree, "--env-file", join(dir, "no-such.env")], none.io), 1);
});

test("a Pages build that copies the seats file in scans itself for the App Secret, removes itself on a hit, and fails closed without the env file or with another App Key", () => {
  const seats = write("scan-seats.json", seatsFile());
  const leaky = join(dir, "site-leaky");
  // A "secret" that is text the build really carries (chat.html's title) stands in for a leak.
  assert.throws(() => buildPages(leaky, { recordingDir: join(dir, "none"), seatsFile: seats, envFile: envFile({ NEXCONN_APP_SECRET: "Shade Guard support chat" }) }), /App Secret's value appears in the build \(chat\.html/);
  assert.equal(existsSync(leaky), false, "the leaking build is removed");
  assert.throws(() => buildPages(join(dir, "site-noenv"), { recordingDir: join(dir, "none"), seatsFile: seats, envFile: join(dir, "no-such.env") }), /No env file/);
  assert.throws(() => buildPages(join(dir, "site-otherkey"), { recordingDir: join(dir, "none"), seatsFile: seats, envFile: envFile({ NEXCONN_APP_KEY: "anotherAppKey9" }) }), /another App Key/);
  assert.equal(buildPages(join(dir, "site-clean"), { recordingDir: join(dir, "none"), seatsFile: seats, envFile: envFile() }).nexconn, true);
});

test("a Pages build copies tokens only on two explicit settings: NEXCONN_SEATS_FILE and NEXCONN_PUBLISH_TOKENS=1", () => {
  const saved = { f: process.env.NEXCONN_SEATS_FILE, p: process.env.NEXCONN_PUBLISH_TOKENS };
  try {
    delete process.env.NEXCONN_SEATS_FILE;
    delete process.env.NEXCONN_PUBLISH_TOKENS;
    assert.deepEqual(pagesSeatsSetting(), { file: null, held: false });
    process.env.NEXCONN_SEATS_FILE = "/x/seats.json";
    assert.deepEqual(pagesSeatsSetting(), { file: null, held: true }, "a seats file exported for npm start is not enough");
    process.env.NEXCONN_PUBLISH_TOKENS = "yes";
    assert.deepEqual(pagesSeatsSetting(), { file: null, held: true });
    process.env.NEXCONN_PUBLISH_TOKENS = "1";
    assert.deepEqual(pagesSeatsSetting(), { file: "/x/seats.json", held: false });
  } finally {
    for (const [k, v] of [["NEXCONN_SEATS_FILE", saved.f], ["NEXCONN_PUBLISH_TOKENS", saved.p]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  const cli = fileURLToPath(new URL("../scripts/build-pages.js", import.meta.url));
  const seats = write("cli-seats.json", seatsFile());
  const env = { ...process.env, NEXCONN_SEATS_FILE: seats, NEXCONN_ENV_FILE: envFile() };
  delete env.NEXCONN_PUBLISH_TOKENS;
  const held = spawnSync(process.execPath, [cli, join(dir, "cli-held")], { env, encoding: "utf8" });
  assert.equal(held.status, 0, held.stderr);
  assert.match(held.stdout, /NEXCONN_PUBLISH_TOKENS is not 1/);
  assert.equal(existsSync(join(dir, "cli-held", SEATS_FILE_NAME)), false);
  const published = spawnSync(process.execPath, [cli, join(dir, "cli-published")], { env: { ...env, NEXCONN_PUBLISH_TOKENS: "1" }, encoding: "utf8" });
  assert.equal(published.status, 0, published.stderr);
  assert.equal(existsSync(join(dir, "cli-published", SEATS_FILE_NAME)), true);
});

test("the entry's .gitignore keeps any seats file out of git", () => {
  const lines = readFileSync(new URL("../.gitignore", import.meta.url), "utf8").split("\n");
  assert.ok(lines.includes("nexconn-seats*.json"));
});

// ---------------------------------------------------------------------------- the pages' wiring helper

test("the page reads a seats file beside it as Nexconn; none means no service; a broken or unreachable one says why", async () => {
  const c = await loadChatConfig({ pages: true, seatsFile: async () => seatsFile() });
  assert.deepEqual([c.kind, c.seats.length], ["nexconn", 2]);
  assert.equal((await loadChatConfig({ pages: true, seatsFile: async () => null })).kind, "none");
  const broken = await loadChatConfig({ pages: true, seatsFile: async () => ({ ...seatsFile(), area: "EU" }) });
  assert.deepEqual([broken.kind, /area/.test(broken.detail)], ["none", true]);
  const unreachable = await loadChatConfig({ pages: true, seatsFile: async () => { throw new TypeError("Failed to fetch"); } });
  assert.match(unreachable.detail, /could not be fetched/);
});

test("the page's transport for a Nexconn config is the adapter; the SDK failing to load, or no service, is the transport that says so", async () => {
  const config = parseNexconnSeats(seatsFile());
  const { sdk } = new MockNexconnServer().realm();
  const t = await makeTransport(config, "sgdesk00000001", { pages: true, sdk: async () => sdk });
  assert.deepEqual([t.describe().kind, t.describe().via, t.status().state], ["nexconn", "Nexconn", STATUS.IDLE]);
  const dead = await makeTransport(config, "sgdesk00000001", { pages: true, sdk: async () => { throw new TypeError("Failed to find a valid digest in the 'integrity' attribute"); } });
  assert.equal(dead.status().state, STATUS.SDK_NOT_LOADED);
  assert.match(dead.status().detail, /valid digest/);
  const none = await makeTransport({ kind: "none", detail: "the seats file's area must be one of SG, NA, SAU" }, "fakedesk1", { pages: true });
  assert.deepEqual([none.status().state, none.status().detail], [STATUS.SDK_NOT_LOADED, "the seats file's area must be one of SG, NA, SAU"]);
  const fakeOnPages = await makeTransport({ kind: "fake" }, "fakedesk1", { pages: true });
  assert.equal(fakeOnPages.describe().kind, "unavailable", "the offline service is never reached from a Pages build");
});

test("a message the adapter carried shows the evidence line 'via Nexconn, <server time>, <full message id>', in .msg-via", async () => {
  const { messageHtml, viaOf } = await import("../public/chat/common.js");
  const { sdk } = new MockNexconnServer().realm();
  const t = await makeTransport(parseNexconnSeats(seatsFile()), "sgdesk00000001", { pages: true, sdk: async () => sdk });
  const html = messageHtml({ messageId: "nx000123a91f3c", type: "SG:Note", sender: "shopper", sentTime: Date.UTC(2026, 10, 17, 8, 32, 11), content: { visit: "v", text: "hi" } }, { via: viaOf(t) });
  // The full id: on the live service the last characters repeat across one sender's messages (22 Nov 2026).
  assert.match(html, /<span class="msg-via">via Nexconn, \d\d:\d\d:\d\d, nx000123a91f3c<\/span>/);
});
