// Lint with Node built-ins only: `node --check` on every .js file, then a few static rules
// that guard this entry's own invariants. Nothing is installed, so there is no eslint.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// A directory may be named to lint instead of this entry (the tests lint small trees that break a rule).
const root = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL("..", import.meta.url));
const DIRS = ["src", "public", "scripts", "tests", "fixtures"];
const SDK_MODULE = "@nexconn/chat";
const SDK_LOADER = "public/chat-sdk.js";
const SDK_WIRING = "public/chat/common.js";
const problems = [];

function walk(dir) {
  let out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out = out.concat(walk(p));
    else out.push(p);
  }
  return out;
}

const files = DIRS.flatMap((d) => walk(join(root, d)));
const jsFiles = files.filter((f) => f.endsWith(".js"));
const rel = (f) => relative(root, f);

for (const f of jsFiles) {
  const r = spawnSync(process.execPath, ["--check", f], { encoding: "utf8" });
  if (r.status !== 0) problems.push(`${rel(f)}: syntax error\n${r.stderr.trim()}`);
}

for (const f of files.filter((p) => p.endsWith(".json"))) {
  try {
    JSON.parse(readFileSync(f, "utf8"));
  } catch (e) {
    problems.push(`${rel(f)}: invalid JSON (${e.message})`);
  }
}

// Static imports and re-exports (spaces around the braces, the star and from are optional), bare
// side-effect imports, and dynamic imports with or without a space before the parenthesis.
const importRe = /^\s*(?:import|export)\b[^;'"]*?\bfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/gm;

for (const f of jsFiles) {
  const src = readFileSync(f, "utf8");
  const name = rel(f);
  const specs = [...src.matchAll(importRe)].map((m) => m[1] || m[2] || m[3]);

  // Zero installs: only Node built-ins and this entry's own files may be imported. The one
  // exception is the Nexconn SDK, loaded in the browser through chat.html's pinned import map, by
  // one module only.
  for (const s of specs) {
    if (s === SDK_MODULE && name === SDK_LOADER) continue;
    if (!s.startsWith(".") && !s.startsWith("node:")) {
      problems.push(`${name}: imports "${s}"; only node: built-ins and relative paths are allowed${s.startsWith("@nexconn/") ? ` (only ${SDK_LOADER} may import ${SDK_MODULE})` : ""}`);
    }
  }

  // The SDK loader and the adapter are reached from the chat pages' one wiring helper and from
  // nothing else that ships, so no other page code or src/ module holds a path to the service.
  const shippedFile = name.startsWith("src/") || name.startsWith("public/");
  if (shippedFile && name !== SDK_WIRING && specs.some((s) => /(^|\/)(chat-sdk|nexconn-transport)(\.js)?/.test(s))) {
    problems.push(`${name}: imports the Nexconn SDK loader or adapter; only ${SDK_WIRING} may`);
  }

  // A shipped file imports only plain string paths, so every rule below sees every import it makes.
  if ((name.startsWith("src/") || name.startsWith("public/")) && /\bimport\s*\(\s*(?!["'][^"'`\n]*["']\s*\))/.test(src)) {
    problems.push(`${name}: imports a path that is not a plain string literal; every import a shipped file makes must be readable here`);
  }

  // The human-only verbs are wired into invoke() in one place and never reach the agent's
  // registry, so no source file but the app wiring may import them. (No end anchor: a query string or
  // a fragment on the path is still that module.)
  if (name.startsWith("src/") && name !== "src/app.js" && specs.some((s) => /human-verbs(\.js)?/.test(s))) {
    problems.push(`${name}: imports human-verbs.js; only src/app.js may`);
  }

  // The agent's side (the tools, the planner, the thread mirror's helpers) may not import the chat
  // transport, the chat verbs or the SDK module, so a tool has no path to the chat service.
  const agentSide = name === "src/tools.js" || name === "src/thread-tools.js" || name === "src/threads.js" || name === "src/message-types.js" || name.startsWith("src/agent/");
  if (agentSide && specs.some((s) => /(^|\/)(chat\/|chat-verbs|chat-sdk)/.test(s))) {
    problems.push(`${name}: the agent's side imports the chat transport, the chat verbs or the SDK module`);
  }
  if (agentSide && /sgProbe/.test(src)) {
    problems.push(`${name}: the agent's side names sgProbe, the live probe's hook on the page's transport`);
  }
  if (name.startsWith("src/") && name !== "src/human-verbs.js" && specs.some((s) => /chat-verbs(\.js)?/.test(s))) {
    problems.push(`${name}: imports chat-verbs.js; only src/human-verbs.js may`);
  }

  // The environment is read in one server-only file, so the static demo can never carry a key.
  const shipped = name.startsWith("src/") || name.startsWith("public/");
  if (shipped && name !== "src/config.js" && /process\.env|loadEnvFile/.test(src)) {
    problems.push(`${name}: reads the environment; only src/config.js may`);
  }

  if (shipped && /\bconsole\.log\(|\bdebugger\b/.test(src)) {
    problems.push(`${name}: console.log or debugger left in source`);
  }
}

if (problems.length) {
  console.error(problems.join("\n"));
  console.error(`lint: ${problems.length} problem(s)`);
  process.exit(1);
}
console.log(`lint: ${jsFiles.length} .js files checked, no problems`);
