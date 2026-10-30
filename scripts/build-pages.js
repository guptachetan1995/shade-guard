// npm run build:pages -- <dir>
// The static demo: public/, the browser-safe src/ modules and the fixture JSON, copied
// unbundled. The page loads src/pages-entry.js, which runs the real api.js, invoke() and
// store in the visitor's tab. src/config.js (the only env reader) and src/server.js are never
// copied, and the build fails if anything it wrote reads the environment. When the sample
// shopper has been recorded, its recording.json, photo and renders are copied too and the page
// is marked to replay them; without a recording the page runs on sample data.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RECORDING_DIR, recordingFiles } from "../src/recording.js";

export const SERVER_ONLY = Object.freeze(["config.js", "server.js"]);
const root = fileURLToPath(new URL("..", import.meta.url));

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

// recordingDir: where the recorded sample shopper is read from (tests point it elsewhere).
export function buildPages(outDir, { recordingDir = join(root, RECORDING_DIR) } = {}) {
  const out = resolve(outDir);
  if (existsSync(out) && readdirSync(out).length) throw new Error(`${out} is not empty; build into a new or empty directory`);
  mkdirSync(out, { recursive: true });

  const html = readFileSync(join(root, "index.html"), "utf8");
  if (!html.includes('data-transport="http"')) throw new Error("index.html has no data-transport marker");
  const recorded = existsSync(join(recordingDir, "recording.json"));
  const marker = recorded ? `data-transport="pages" data-recording="${RECORDING_DIR}/"` : 'data-transport="pages"';
  writeFileSync(join(out, "index.html"), html.replace('data-transport="http"', marker));
  if (recorded) {
    mkdirSync(join(out, RECORDING_DIR), { recursive: true });
    const rec = JSON.parse(readFileSync(join(recordingDir, "recording.json"), "utf8"));
    for (const name of recordingFiles(rec)) cpSync(join(recordingDir, name), join(out, RECORDING_DIR, name));
  }
  cpSync(join(root, "public"), join(out, "public"), { recursive: true });
  cpSync(join(root, "src"), join(out, "src"), {
    recursive: true,
    filter: (src) => !SERVER_ONLY.includes(relative(join(root, "src"), src)),
  });
  mkdirSync(join(out, "fixtures"), { recursive: true });
  for (const f of readdirSync(join(root, "fixtures")).filter((n) => n.endsWith(".json"))) {
    cpSync(join(root, "fixtures", f), join(out, "fixtures", f));
  }
  cpSync(join(root, "LICENSE"), join(out, "LICENSE"));
  writeFileSync(join(out, ".nojekyll"), "");

  const files = walk(out);
  const leaks = files.filter((f) => /\.(js|html|json)$/.test(f) && /process\.env|loadEnvFile/.test(readFileSync(f, "utf8")));
  if (leaks.length || existsSync(join(out, "src/config.js"))) {
    throw new Error(`the static build reads the environment: ${leaks.map((f) => relative(out, f)).join(", ") || "src/config.js"}`);
  }
  return { out, recorded, files: files.map((f) => relative(out, f)).sort() };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) {
    process.stderr.write("usage: npm run build:pages -- <dir>\n");
    process.exit(2);
  }
  try {
    const { out, files, recorded } = buildPages(dir);
    process.stdout.write(`static demo: ${files.length} files in ${out}, ${recorded ? "replaying the recorded sample shopper" : "on sample data (no recording yet)"}\n`);
  } catch (e) {
    process.stderr.write(`build:pages failed: ${e.message}\n`);
    process.exit(1);
  }
}
