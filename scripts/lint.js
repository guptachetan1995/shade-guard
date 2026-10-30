// Lint with Node built-ins only: `node --check` on every .js file, then a few static rules
// that guard this entry's own invariants. Nothing is installed, so there is no eslint.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const DIRS = ["src", "public", "scripts", "tests", "fixtures"];
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

const importRe = /^\s*(?:import|export)\s[^;]*?\sfrom\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/gm;

for (const f of jsFiles) {
  const src = readFileSync(f, "utf8");
  const name = rel(f);
  const specs = [...src.matchAll(importRe)].map((m) => m[1] || m[2] || m[3]);

  // Zero installs: only Node built-ins and this entry's own files may be imported.
  for (const s of specs) {
    if (!s.startsWith(".") && !s.startsWith("node:")) {
      problems.push(`${name}: imports "${s}"; only node: built-ins and relative paths are allowed`);
    }
  }

  // The human-only verbs are wired into invoke() in one place and never reach the agent's
  // registry, so no source file but the app wiring may import them.
  if (name.startsWith("src/") && name !== "src/app.js" && specs.some((s) => /human-verbs(\.js)?$/.test(s))) {
    problems.push(`${name}: imports human-verbs.js; only src/app.js may`);
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
