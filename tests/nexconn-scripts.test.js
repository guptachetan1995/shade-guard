// The token and expire scripts against a local fake signer on 127.0.0.1. Every secret, key and
// token here is a dummy made up for this file. No test touches ~/.config or any real env file:
// the env file and the seats file are always passed, and the default env file is pointed at a
// path that does not exist.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadNexconnConfig, NEXCONN_HOSTS, defaultNexconnEnvFile } from "../src/config.js";
import { signHeaders, basesFor, parseFlags, gitTreeOf } from "../scripts/nexconn-api.js";
import { run as runTokens, FLAGS as TOKEN_FLAGS } from "../scripts/nexconn-tokens.js";
import { run as runExpire, IDS_PER_REQUEST, FLAGS as EXPIRE_FLAGS } from "../scripts/nexconn-expire.js";

const DUMMY_SECRET = "dummy-secret-for-the-offline-tests";
const DUMMY_KEY = "dummyappkey0001";
let dir;
let signer;
let url;
let requests;
let issued;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "shade-guard-nexconn-"));
  process.env.NEXCONN_ENV_FILE = join(dir, "never-exists.env");
  requests = [];
  issued = new Map();
  signer = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      const h = req.headers;
      const want = createHash("sha1").update(`${DUMMY_SECRET}${h.nonce}${h.timestamp}`).digest("hex");
      requests.push({ path: req.url, appKey: h["app-key"], signatureOk: h.signature === want, body });
      const send = (status, json) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      };
      if (h["app-key"] !== DUMMY_KEY || h.signature !== want) return send(401, { code: 401 });
      if (req.url === "/v4/auth/access-token/issue") {
        const token = `FAKE-TOKEN-${body.userId}-${"x".repeat(20)}`;
        issued.set(body.userId, token);
        return send(200, { code: 0, result: { userId: body.userId, accessToken: token } });
      }
      if (req.url === "/v4/auth/access-token/expire") return send(200, { code: 0 });
      if (req.url === "/v4/user/get") return send(200, { code: issued.has(body.userId) ? 0 : 400, result: { name: "", avatarUrl: "", createdAt: "" } });
      send(404, { code: 404 });
    });
  });
  await new Promise((r) => signer.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${signer.address().port}`;
});
after(async () => {
  delete process.env.NEXCONN_ENV_FILE;
  await new Promise((r) => signer.close(r));
  rmSync(dir, { recursive: true, force: true });
});

const envFile = (over = {}) => {
  const f = join(dir, `env-${Math.random().toString(36).slice(2)}.env`);
  const v = { NEXCONN_APP_KEY: DUMMY_KEY, NEXCONN_AREA: "SG", NEXCONN_API_HOST: "api.sg-light-api.com", NEXCONN_APP_SECRET: DUMMY_SECRET, ...over };
  writeFileSync(f, Object.entries(v).map(([k, x]) => `${k}=${x}`).join("\n") + "\n", { mode: 0o600 });
  return f;
};
const capture = () => {
  const o = { out: "", err: "" };
  return { o, io: { out: (s) => (o.out += s), err: (s) => (o.err += s) } };
};
const seatsPath = () => join(dir, `seats-${Math.random().toString(36).slice(2)}.json`);
const tokens = (flags, env = envFile()) => {
  const c = capture();
  return runTokens(["--env-file", env, "--base", url, ...flags], c.io).then((code) => ({ code, ...c.o }));
};

test("the config reader parses the four names without touching process.env, and refuses a host outside its area", () => {
  const before = { ...process.env };
  const c = loadNexconnConfig({ envFile: envFile() });
  assert.deepEqual([c.appKey, c.area, c.host, c.backupHost], [DUMMY_KEY, "SG", "api.sg-light-api.com", "api-b.sg-light-api.com"]);
  assert.equal(process.env.NEXCONN_APP_SECRET, before.NEXCONN_APP_SECRET, "parsed, not loaded into the environment");
  assert.equal(loadNexconnConfig({ envFile: envFile({ NEXCONN_AREA: "NA", NEXCONN_API_HOST: "api-b.us-light-api.com" }) }).backupHost, "api.us-light-api.com");
  const code = (over) => { try { loadNexconnConfig({ envFile: envFile(over) }); } catch (e) { return e.code; } return "ok"; };
  assert.equal(code({ NEXCONN_API_HOST: "api.us-light-api.com" }), "host_not_allowed", "another area's host");
  assert.equal(code({ NEXCONN_API_HOST: "evil.example.invalid" }), "host_not_allowed");
  assert.equal(code({ NEXCONN_AREA: "EU" }), "bad_area");
  assert.equal(code({ NEXCONN_APP_SECRET: "" }), "no_app_secret");
  assert.equal(code({ NEXCONN_APP_KEY: "" }), "no_app_key");
  assert.equal((() => { try { loadNexconnConfig({ envFile: join(dir, "absent.env") }); } catch (e) { return e.code; } })(), "no_env_file");
  assert.deepEqual(Object.keys(NEXCONN_HOSTS), ["SG", "NA", "SAU"]);
  assert.match(defaultNexconnEnvFile(), /\.config\/shade-guard\/nexconn\.env$/);
});

test("a signed request carries the App Key, a nonce, a ms timestamp and sha1(secret + nonce + timestamp)", () => {
  const h = signHeaders({ appKey: "k", secret: "s", nonce: "abc", timestamp: 1700000000000 });
  assert.deepEqual(h, { "App-Key": "k", Nonce: "abc", Timestamp: "1700000000000", Signature: createHash("sha1").update("sabc1700000000000").digest("hex") });
  assert.throws(() => basesFor({ host: "h", backupHost: "b" }, { base: "https://api.sg-light-api.com" }), (e) => e.code === "base_not_local");
  assert.deepEqual(basesFor({ host: "h", backupHost: "b" }, {}), ["https://h", "https://b"]);
  assert.throws(() => parseFlags(["--nope"], TOKEN_FLAGS), (e) => e.code === "bad_flag");
});

test("nexconn:tokens mints 4 seats of 3 non-sequential ids, writes the seats file at mode 600, and prints no token and no secret", async () => {
  requests.length = 0;
  const seats = seatsPath();
  const r = await tokens(["--seats", "4", "--seats-file", seats]);
  assert.equal(r.code, 0, r.err);
  assert.equal(requests.length, 12);
  assert.ok(requests.every((q) => q.path === "/v4/auth/access-token/issue" && q.signatureOk && q.appKey === DUMMY_KEY));
  const file = JSON.parse(readFileSync(seats, "utf8"));
  assert.equal((statSync(seats).mode & 0o777).toString(8), "600");
  assert.deepEqual([file.appKey, file.area, file.seats.length], [DUMMY_KEY, "SG", 4]);
  const ids = file.seats.flatMap((s) => [s.deskUserId, ...s.shoppers.map((p) => p.userId)]);
  assert.equal(new Set(ids).size, 12);
  for (const s of file.seats) {
    assert.match(s.deskUserId, /^sgdesk[0-9a-f]{8}$/);
    assert.ok(s.shoppers.every((p) => /^sgshop[0-9a-f]{8}$/.test(p.userId)));
    assert.deepEqual(s.shoppers.map((p) => [p.caseId, p.orderId]), [["R-104", "O-5521"], ["R-107", "O-5530"]]);
    assert.ok(Object.values(s.tokens).every((t) => t.startsWith("FAKE-TOKEN-")));
  }
  const names = requests.map((q) => q.body.name);
  assert.equal(names.filter((n) => n === "Shade Guard desk (demo)").length, 4);
  assert.ok(names.includes("Maya (fictional shopper, O-5521)") && names.includes("Asha (fictional shopper, O-5530)"));
  assert.match(r.out, new RegExp(`App Key: ${DUMMY_KEY}`));
  assert.match(r.out, /token length \d+/);
  for (const secretish of [DUMMY_SECRET, "FAKE-TOKEN"]) {
    assert.equal(r.out.includes(secretish), false, `stdout carries ${secretish}`);
    assert.equal(r.err.includes(secretish), false);
  }
  for (const id of ids) assert.ok(r.out.includes(id));
});

test("nexconn:tokens refuses to mint twice into one seats file, to write inside the repository, and to aim a secret at a non-local base", async () => {
  const seats = seatsPath();
  assert.equal((await tokens(["--seats", "1", "--seats-file", seats])).code, 0);
  const again = await tokens(["--seats", "1", "--seats-file", seats]);
  assert.equal(again.code, 1);
  assert.match(again.err, /already exists/);
  // Only where the entry is in a git work tree (the monorepo, a clone); an exported copy with no
  // .git is a plain folder, where the next test's temp repo checks the same refusal.
  if (gitTreeOf(new URL("..", import.meta.url).pathname)) {
    const inRepo = await tokens(["--seats", "1", "--seats-file", new URL("../nexconn-seats.json", import.meta.url).pathname]);
    assert.equal(inRepo.code, 1);
    assert.match(inRepo.err, /outside the repository/);
    assert.equal(existsSync(new URL("../nexconn-seats.json", import.meta.url).pathname), false);
  }
  const c = capture();
  const code = await runTokens(["--env-file", envFile(), "--base", "https://api.sg-light-api.com", "--seats-file", seatsPath()], c.io);
  assert.equal(code, 1);
  assert.match(c.o.err, /127\.0\.0\.1/);
  assert.equal((await tokens(["--seats", "11", "--seats-file", seatsPath()])).code, 1);
});

test("a refused signature says so, mints nothing and writes nothing", async () => {
  const seats = seatsPath();
  const r = await tokens(["--seats", "1", "--seats-file", seats], envFile({ NEXCONN_APP_SECRET: "the-wrong-secret" }));
  assert.equal(r.code, 1);
  assert.match(r.err, /signature refused/);
  assert.equal(existsSync(seats), false);
});

test("a host that does not answer is retried once on the backup", async () => {
  requests.length = 0;
  const c = capture();
  const code = await runTokens(["--env-file", envFile(), "--base", "http://127.0.0.1:1", "--backup-base", url, "--seats", "1", "--seats-file", seatsPath()], c.io);
  assert.equal(code, 0, c.o.err);
  assert.equal(requests.length, 3, "all three ids went through the backup");
  const down = await runTokens(["--env-file", envFile(), "--base", "http://127.0.0.1:1", "--seats", "1", "--seats-file", seatsPath()], capture().io);
  assert.equal(down, 1);
});

test("--check signs POST /v4/user/get for every seat id and prints only whether each exists", async () => {
  const seats = seatsPath();
  await tokens(["--seats", "2", "--seats-file", seats]);
  requests.length = 0;
  const ok = await tokens(["--check", "--seats-file", seats]);
  assert.equal(ok.code, 0, ok.err);
  assert.equal(requests.length, 6);
  assert.ok(requests.every((q) => q.path === "/v4/user/get" && q.signatureOk));
  assert.equal(ok.out.split("\n").filter((l) => l.endsWith(": exists")).length, 6);
  assert.equal(ok.out.includes("FAKE-TOKEN"), false);
  issued.clear();
  const gone = await tokens(["--check", "--seats-file", seats]);
  assert.equal(gone.code, 1);
  assert.match(gone.out, /not found/);
  assert.match(gone.err, /6 seat id\(s\) are not registered/);
  assert.equal((await tokens(["--check", "--seats-file", seatsPath()])).code, 1, "no seats file");
});

test("nexconn:expire expires every seat id, 20 a request, as of now, and prints ids and answer codes only", async () => {
  const seats = seatsPath();
  await tokens(["--seats", "4", "--seats-file", seats]);
  requests.length = 0;
  const c = capture();
  const code = await runExpire(["--env-file", envFile(), "--base", url, "--seats-file", seats], { ...c.io, now: () => 1_800_000_000_000 });
  assert.equal(code, 0, c.o.err);
  assert.equal(IDS_PER_REQUEST, 20);
  assert.equal(requests.length, 1, "12 ids fit one request");
  assert.deepEqual([requests[0].path, requests[0].body.expiresAt, requests[0].body.userIds.length, requests[0].signatureOk], ["/v4/auth/access-token/expire", 1_800_000_000_000, 12, true]);
  assert.match(c.o.out, /answer 0/);
  assert.match(c.o.out, /12 id\(s\) in 1 request\(s\)/);
  for (const secretish of [DUMMY_SECRET, "FAKE-TOKEN"]) assert.equal((c.o.out + c.o.err).includes(secretish), false);

  // 21 ids: two requests, 20 and then 1.
  const big = seatsPath();
  const seven = Array.from({ length: 7 }, (_, i) => ({ n: i + 1, deskUserId: `sgdesk${i}`, shoppers: [{ userId: `sgshopa${i}` }, { userId: `sgshopb${i}` }] }));
  writeFileSync(big, JSON.stringify({ appKey: DUMMY_KEY, area: "SG", seats: seven }));
  requests.length = 0;
  const c2 = capture();
  assert.equal(await runExpire(["--env-file", envFile(), "--base", url, "--seats-file", big], c2.io), 0);
  assert.deepEqual(requests.map((q) => q.body.userIds.length), [20, 1]);
});

test("nexconn:expire with no seats file, a refused signature or an unreachable host exits non-zero and says why", async () => {
  const c = capture();
  assert.equal(await runExpire(["--env-file", envFile(), "--base", url, "--seats-file", seatsPath()], c.io), 1);
  assert.match(c.o.err, /nothing to expire/);
  const seats = seatsPath();
  await tokens(["--seats", "1", "--seats-file", seats]);
  const c2 = capture();
  assert.equal(await runExpire(["--env-file", envFile({ NEXCONN_APP_SECRET: "wrong" }), "--base", url, "--seats-file", seats], c2.io), 1);
  assert.match(c2.o.err, /signature refused/);
});

test("the seats file may not be written inside ANY git work tree: not the entry, not the monorepo around it, not a hidden folder, not a temp folder that has a .git", async () => {
  const entry = new URL("..", import.meta.url).pathname;
  // The git work tree this copy sits in: the monorepo around the entry, or the entry itself in a
  // clone. Never assumed from the folder layout, so a clone writes nothing above itself. A copy with
  // no .git at all (an exported tree) is not a work tree, so writing there is allowed and its cases
  // are skipped; the temp repo and the linked worktree below test the rule in every copy.
  const worktreeRoot = gitTreeOf(entry);
  const inside = [];
  if (worktreeRoot) {
    inside.push(
      join(entry, "nexconn-seats.json"),
      join(entry, "..hidden", "seats.json"), // a name that merely begins with two dots is still inside
      join(entry, "docs", "new-folder", "seats.json"), // the folder does not exist yet
      join(worktreeRoot, "nexconn-seats.json"), // the work tree's root, outside the entry directory in the monorepo
      join(worktreeRoot, "bin", "seats.json"),
    );
  }
  const repo = mkdtempSync(join(dir, "repo-"));
  mkdirSync(join(repo, ".git"));
  inside.push(join(repo, "seats.json"), join(repo, "deeper", "still", "seats.json"));
  const linked = mkdtempSync(join(dir, "linked-"));
  writeFileSync(join(linked, ".git"), "gitdir: /elsewhere\n"); // a linked worktree has a .git FILE
  inside.push(join(linked, "seats.json"));
  const minted = () => requests.filter((q) => q.path === "/v4/auth/access-token/issue").length;
  const mintedBefore = minted();
  for (const path of inside) {
    const r = await tokens(["--seats", "1", "--seats-file", path]);
    assert.equal(r.code, 1, path);
    assert.match(r.err, /outside the repository/, path);
    assert.equal(existsSync(path), false, `${path} was written`);
  }
  assert.equal(minted(), mintedBefore, "and every refusal came before any token was minted");
  const fine = join(mkdtempSync(join(dir, "plain-")), "sub", "seats.json");
  assert.equal((await tokens(["--seats", "1", "--seats-file", fine])).code, 0, "a plain folder outside every git tree is fine, new subfolder and all");
});

test("a seats file that is not valid JSON is named as such by --check and expire, and nothing from it is printed", async () => {
  const bad = seatsPath();
  writeFileSync(bad, '{\n  "seats": [{ "tokens": { "sgdesk1": "TOPSECRETTOKENLINE" }, oops }]\n}\n');
  const check = await tokens(["--check", "--seats-file", bad]);
  assert.equal(check.code, 1);
  assert.match(check.err, /not valid JSON/);
  const c = capture();
  assert.equal(await runExpire(["--env-file", envFile(), "--base", url, "--seats-file", bad], c.io), 1);
  assert.match(c.o.err, /not valid JSON/);
  for (const text of [check.err, check.out, c.o.err, c.o.out]) assert.doesNotMatch(text, /TOPSECRET|oops|SyntaxError|position/);
  // Valid JSON of the wrong shape is refused the same way.
  const odd = seatsPath();
  writeFileSync(odd, JSON.stringify({ seats: "nope" }));
  assert.match((await tokens(["--check", "--seats-file", odd])).err, /not valid/);
});

test("every flag that takes a value refuses a missing one, or one that is the next flag", () => {
  for (const flag of ["--seats", "--env-file", "--seats-file", "--base", "--backup-base", "--scan"]) {
    for (const argv of [[flag], [flag, "--check"], [flag, ""], ["--check", flag]]) {
      assert.throws(() => parseFlags(argv, TOKEN_FLAGS), (e) => e.code === "bad_flag" && e.message.includes(flag), JSON.stringify(argv));
    }
  }
  assert.deepEqual(parseFlags(["--seats", "4", "--scan", "/tmp/x", "--check"], TOKEN_FLAGS), { check: true, seats: 4, scan: "/tmp/x" });
  assert.throws(() => parseFlags(["--scan=/tmp/x"], TOKEN_FLAGS), (e) => e.code === "bad_flag", "an unknown spelling is an error, not ignored");
});

// Only ever run against the local fake signer: --base comes first, so even a parser that lost the
// --scan value could reach nothing but 127.0.0.1.
test("--scan with no folder is refused and mints nothing: no request reaches the signer and no seats file is written", async () => {
  const seats = seatsPath();
  const before = requests.length;
  const r = await tokens(["--seats-file", seats, "--scan"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /--scan needs a value/);
  assert.equal(requests.length, before, "not one call to the signer");
  assert.equal(existsSync(seats), false);
});

test("each script takes only its own flags: nexconn:expire refuses --check, --seats and --scan, and has an explicit --dry-run instead", () => {
  assert.deepEqual([...TOKEN_FLAGS].sort(), ["--backup-base", "--base", "--check", "--env-file", "--scan", "--seats", "--seats-file"]);
  assert.deepEqual([...EXPIRE_FLAGS].sort(), ["--backup-base", "--base", "--dry-run", "--env-file", "--seats-file"]);
  for (const argv of [["--check"], ["--seats", "4"], ["--scan", "/tmp/x"]]) {
    assert.throws(() => parseFlags(argv, EXPIRE_FLAGS, "nexconn:expire"), (e) => e.code === "bad_flag" && /not an option of nexconn:expire/.test(e.message), JSON.stringify(argv));
  }
  assert.throws(() => parseFlags(["--dry-run"], TOKEN_FLAGS, "nexconn:tokens"), (e) => e.code === "bad_flag" && /not an option of nexconn:tokens/.test(e.message));
  assert.deepEqual(parseFlags(["--dry-run", "--seats-file", "/x.json"], EXPIRE_FLAGS, "nexconn:expire"), { check: false, dryRun: true, seatsFile: "/x.json" });
});

test("--backup-base without --base is refused, so it can never leave the real hosts in place", () => {
  for (const flags of [TOKEN_FLAGS, EXPIRE_FLAGS]) {
    assert.throws(() => parseFlags(["--backup-base", "http://127.0.0.1:9"], flags), (e) => e.code === "bad_flag" && /--backup-base needs --base/.test(e.message));
    assert.deepEqual(parseFlags(["--backup-base", "http://127.0.0.1:9", "--base", "http://127.0.0.1:8"], flags).base, "http://127.0.0.1:8", "order does not matter");
  }
});

// --base comes first in every call below, so even a script that ignored a flag could reach nothing but
// the local fake signer.
test("nexconn:expire --check is refused and expires nothing; --dry-run lists what it would expire and sends no request", async () => {
  const seats = seatsPath();
  await tokens(["--seats", "2", "--seats-file", seats]);
  const before = requests.length;
  const checked = capture();
  assert.equal(await runExpire(["--base", url, "--env-file", envFile(), "--seats-file", seats, "--check"], checked.io), 1);
  assert.match(checked.o.err, /--check is not an option of nexconn:expire.*--dry-run/);
  assert.equal(requests.length, before, "not one expire call");
  const dry = capture();
  assert.equal(await runExpire(["--base", url, "--env-file", envFile(), "--seats-file", seats, "--dry-run"], dry.io), 0, dry.o.err);
  assert.equal(requests.length, before, "a dry run sends nothing");
  assert.match(dry.o.out, /dry run: would expire 6 id\(s\) in 1 request\(s\); nothing was sent/);
  assert.equal(dry.o.out.includes("FAKE-TOKEN"), false);
});
