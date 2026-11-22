// The lint rules that keep the agent away from the chat are checked by running the linter on trees that
// break them, not only by reading its source (S0b review).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const lintJs = fileURLToPath(new URL("../scripts/lint.js", import.meta.url));

function lint(files) {
  const dir = mkdtempSync(join(tmpdir(), "sg-lint-"));
  for (const [name, src] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), src);
  }
  const r = spawnSync(process.execPath, [lintJs, dir], { encoding: "utf8" });
  return { status: r.status, out: r.stdout + r.stderr };
}

const transport = { "src/chat/transport.js": "export const X = 1;\n" };

test("a clean tree passes", () => {
  const r = lint({ ...transport, "src/tools.js": "export const T = 1;\n", "src/app.js": 'import "./chat/transport.js";\n' });
  assert.equal(r.status, 0, r.out);
});

test("a tool that imports anything under src/chat/ fails the lint, and so do the other agent-side files", () => {
  for (const file of ["src/tools.js", "src/thread-tools.js", "src/threads.js", "src/message-types.js", "src/agent/planner.js"]) {
    for (const spec of ["./chat/transport.js", "../chat/transport.js", "./chat-verbs.js", "./chat-sdk.js"]) {
      const rel = file.startsWith("src/agent/") ? spec.replace("./", "../") : spec;
      const r = lint({ ...transport, "src/chat-verbs.js": "export const V = 1;\n", "src/chat-sdk.js": "export const S = 1;\n", [file]: `import "${rel}";\n` });
      assert.equal(r.status, 1, `${file} importing ${rel}: ${r.out}`);
      assert.match(r.out, /the agent's side imports the chat transport/, `${file} ${rel}`);
    }
  }
});

test("nothing but human-verbs.js may import chat-verbs.js, and nothing but app.js may import human-verbs.js", () => {
  const a = lint({ "src/chat-verbs.js": "export const V = 1;\n", "src/other.js": 'import "./chat-verbs.js";\n' });
  assert.equal(a.status, 1);
  assert.match(a.out, /imports chat-verbs\.js; only src\/human-verbs\.js may/);
  const b = lint({ "src/human-verbs.js": "export const H = 1;\n", "src/other.js": 'import "./human-verbs.js";\n' });
  assert.equal(b.status, 1);
  assert.match(b.out, /imports human-verbs\.js; only src\/app\.js may/);
});

test("the environment is read in src/config.js alone", () => {
  const r = lint({ "src/other.js": "export const k = process.env.YOUCAM_API_KEY;\n" });
  assert.equal(r.status, 1);
  assert.match(r.out, /reads the environment; only src\/config\.js may/);
});

// The bare names are built at run time so this file's own source holds no import of them.
const dynamicImport = (name) => `export const load = () => import(${JSON.stringify(name)});\n`;
const SDK = ["@nexconn", "chat"].join("/");

test("public/chat-sdk.js alone may import the Nexconn SDK by its bare name, and only @nexconn/chat", () => {
  const loader = dynamicImport(SDK);
  assert.equal(lint({ "public/chat-sdk.js": loader }).status, 0);
  for (const [file, src] of [
    ["public/chat/desk.js", loader],
    ["src/chat/nexconn-transport.js", `import * as sdk from ${JSON.stringify(SDK)};\n`],
    ["public/chat-sdk.js", dynamicImport(["@nexconn", "engine"].join("/"))],
    ["public/chat-sdk.js", dynamicImport(["some", "other", "package"].join("-"))],
  ]) {
    const r = lint({ [file]: src });
    assert.equal(r.status, 1, `${file}: ${src}`);
    assert.match(r.out, /only node: built-ins and relative paths are allowed/);
  }
  assert.match(lint({ "public/chat/desk.js": loader }).out, /only public\/chat-sdk\.js may import @nexconn\/chat/);
});

test("only the chat pages' wiring helper may import the SDK loader or the Nexconn adapter", () => {
  const files = { "public/chat-sdk.js": "export const S = 1;\n", "src/chat/nexconn-transport.js": "export const N = 1;\n" };
  assert.equal(lint({ ...files, "public/chat/common.js": 'import "../chat-sdk.js";\nimport "../../src/chat/nexconn-transport.js";\n' }).status, 0);
  for (const [file, spec] of [
    ["public/chat/desk.js", "../chat-sdk.js"],
    ["public/chat/shopper.js", "../../src/chat/nexconn-transport.js"],
    ["src/app.js", "./chat/nexconn-transport.js"],
    ["src/human-verbs.js", "../public/chat-sdk.js"],
  ]) {
    const r = lint({ ...files, [file]: `import "${spec}";\n` });
    assert.equal(r.status, 1, `${file} importing ${spec}`);
    assert.match(r.out, /imports the Nexconn SDK loader or adapter; only public\/chat\/common\.js may/);
  }
  const tool = lint({ ...files, "src/tools.js": 'import "./chat/nexconn-transport.js";\n' });
  assert.match(tool.out, /the agent's side imports the chat transport/, "a tool is refused by the agent-side rule too");
});

test("a shipped file may import only a literal path: no variable, template or concatenated import(", () => {
  for (const src of ["const m = 'x'; export const l = () => import(m);\n", "export const l = (n) => import(`./${n}.js`);\n", 'export const l = (n) => import("./" + n);\n']) {
    const r = lint({ "public/chat/desk.js": src });
    assert.equal(r.status, 1, src);
    assert.match(r.out, /imports a path that is not a plain string literal/);
  }
  assert.equal(lint({ "public/chat/desk.js": 'export const l = () => import("./shopper.js");\nexport const u = import.meta.url;\n' }).status, 0);
  assert.equal(lint({ "scripts/tool.js": "export const l = (n) => import(n);\n" }).status, 0, "scripts are not shipped");
});

test("a query string or a fragment does not get an import of the loader, the adapter or the chat verbs past the rules", () => {
  const files = { "src/chat/nexconn-transport.js": "export const N = 1;\n", "src/chat-verbs.js": "export const V = 1;\n" };
  const a = lint({ ...files, "public/chat/desk.js": 'import "../../src/chat/nexconn-transport.js?v=1";\n' });
  assert.match(a.out, /imports the Nexconn SDK loader or adapter/);
  const b = lint({ ...files, "src/other.js": 'import "./chat-verbs.js#x";\n' });
  assert.match(b.out, /imports chat-verbs\.js; only src\/human-verbs\.js may/);
});

test("the agent's side may not name the live probe's hook", () => {
  const r = lint({ "src/tools.js": "export const p = () => globalThis.sgProbe;\n" });
  assert.equal(r.status, 1);
  assert.match(r.out, /the agent's side names sgProbe/);
});

test("the import scan sees imports written without spaces: import (, import{…}from\"…\", export*from\"…\"", () => {
  const spaced = `export const load = () => import (${JSON.stringify(SDK)});\n`;
  const r1 = lint({ "public/chat/desk.js": spaced });
  assert.equal(r1.status, 1);
  assert.match(r1.out, /only public\/chat-sdk\.js may import @nexconn\/chat/);
  const files = { "src/chat/nexconn-transport.js": "export const N = 1;\n", "src/chat-verbs.js": "export const V = 1;\n", "src/chat/transport.js": "export const X = 1;\n" };
  for (const [file, src, why] of [
    ["src/app.js", 'import{N}from"./chat/nexconn-transport.js";\n', /imports the Nexconn SDK loader or adapter/],
    ["public/chat/desk.js", 'export*from"../../src/chat/nexconn-transport.js";\n', /imports the Nexconn SDK loader or adapter/],
    ["src/other.js", 'export{V}from"./chat-verbs.js";\n', /imports chat-verbs\.js; only src\/human-verbs\.js may/],
    ["src/agent/planner.js", 'import*as t from"../chat/transport.js";\n', /the agent's side imports the chat transport/],
  ]) {
    const r = lint({ ...files, [file]: src });
    assert.equal(r.status, 1, `${file}: ${src}`);
    assert.match(r.out, why, `${file}: ${src}`);
  }
  const nonLiteral = lint({ "public/chat/desk.js": "export const l = (n) => import (n);\n" });
  assert.match(nonLiteral.out, /not a plain string literal/);
});
