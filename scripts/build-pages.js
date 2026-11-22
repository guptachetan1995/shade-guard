// npm run build:pages -- <dir>
// The static demo: public/, the browser-safe src/ modules and the fixture JSON, copied
// unbundled. The page loads src/pages-entry.js, which runs the real api.js, invoke() and
// store in the visitor's tab. src/config.js (the only env reader) and src/server.js are never
// copied, and the build fails if anything it wrote reads the environment. When the sample
// shopper has been recorded, its recording.json, photo and renders are copied too and the page
// is marked to replay them; without a recording the page runs on sample data.
//
// With NEXCONN_SEATS_FILE set AND NEXCONN_PUBLISH_TOKENS=1, the Nexconn seats file it names (the App
// Key, the area and the demo users' ids and tokens; never the App Secret) is checked field by field
// and written into the build as nexconn-seats.json, so the chat page connects to Nexconn. Without
// both, no build carries tokens. A build that carries them refuses to be written inside a git work
// tree (they belong only in the gh-pages branch, never on main), needs the Nexconn env file (its App
// Key must be the seats file's), and scans every file it wrote for the App Secret's value, removing
// itself on a hit.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RECORDING_DIR, recordingFiles } from "../src/recording.js";
import { loadNexconnConfig, pagesSeatsSetting, readNexconnSeats } from "../src/config.js";
import { seatsFileOf } from "../src/chat/seats.js";
import { gitTreeOf } from "./nexconn-api.js";
import { filesHoldingSecret } from "./nexconn-tokens.js";

export const SEATS_FILE_NAME = "nexconn-seats.json";

export const SERVER_ONLY = Object.freeze(["config.js", "server.js"]);
// The fake chat service is for the offline walk. The static demo must show a real connection or say
// it has none, so none of these is ever copied (public/chat/local-transport.js is the one page
// module that reaches for them).
export const OFFLINE_ONLY = Object.freeze(["src/chat/fake-transport.js", "src/chat/fake-client.js", "src/chat/fake-http.js", "public/chat/local-transport.js"]);
const root = fileURLToPath(new URL("..", import.meta.url));

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

// recordingDir: where the recorded sample shopper is read from (tests point it elsewhere).
// seatsFile: a Nexconn seats file to copy in, or null (the CLI passes one only on both settings).
// envFile: the Nexconn env file the secret scan reads (default: NEXCONN_ENV_FILE, else ~/.config).
export function buildPages(outDir, { recordingDir = join(root, RECORDING_DIR), seatsFile = null, envFile } = {}) {
  const out = resolve(outDir);
  if (existsSync(out) && readdirSync(out).length) throw new Error(`${out} is not empty; build into a new or empty directory`);
  const seats = seatsFile ? readNexconnSeats(seatsFile) : null;
  if (seats && gitTreeOf(out)) throw new Error(`${out} is inside a git work tree; a build that carries the demo tokens must be built outside every one`);
  const nexconn = seats ? loadNexconnConfig({ envFile }) : null;
  if (seats && nexconn.appKey !== seats.appKey) throw new Error("the seats file belongs to another App Key than the Nexconn env file's");
  mkdirSync(out, { recursive: true });

  const recorded = existsSync(join(recordingDir, "recording.json"));
  const marker = recorded ? `data-transport="pages" data-recording="${RECORDING_DIR}/"` : 'data-transport="pages"';
  for (const page of ["index.html", "chat.html"]) {
    const html = readFileSync(join(root, page), "utf8");
    if (!html.includes('data-transport="http"')) throw new Error(`${page} has no data-transport marker`);
    writeFileSync(join(out, page), html.replace('data-transport="http"', marker));
  }
  if (recorded) {
    mkdirSync(join(out, RECORDING_DIR), { recursive: true });
    const rec = JSON.parse(readFileSync(join(recordingDir, "recording.json"), "utf8"));
    for (const name of recordingFiles(rec)) cpSync(join(recordingDir, name), join(out, RECORDING_DIR, name));
  }
  cpSync(join(root, "public"), join(out, "public"), { recursive: true, filter: (src) => !OFFLINE_ONLY.includes(relative(root, src)) });
  cpSync(join(root, "src"), join(out, "src"), {
    recursive: true,
    filter: (src) => !SERVER_ONLY.includes(relative(join(root, "src"), src)) && !OFFLINE_ONLY.includes(relative(root, src)),
  });
  mkdirSync(join(out, "fixtures"), { recursive: true });
  for (const f of readdirSync(join(root, "fixtures")).filter((n) => n.endsWith(".json"))) {
    cpSync(join(root, "fixtures", f), join(out, "fixtures", f));
  }
  if (seats) writeFileSync(join(out, SEATS_FILE_NAME), `${JSON.stringify(seatsFileOf(seats))}\n`);
  cpSync(join(root, "LICENSE"), join(out, "LICENSE"));
  writeFileSync(join(out, ".nojekyll"), "");

  const files = walk(out);
  const leaks = files.filter((f) => /\.(js|html|json)$/.test(f) && /process\.env|loadEnvFile/.test(readFileSync(f, "utf8")));
  if (leaks.length || existsSync(join(out, "src/config.js"))) {
    throw new Error(`the static build reads the environment: ${leaks.map((f) => relative(out, f)).join(", ") || "src/config.js"}`);
  }
  if (nexconn) {
    const { hits } = filesHoldingSecret(out, nexconn.secret);
    if (hits.length) {
      rmSync(out, { recursive: true, force: true });
      throw new Error(`the App Secret's value appears in the build (${hits.join(", ")}); the build was removed`);
    }
  }
  return { out, recorded, nexconn: Boolean(seats), files: files.map((f) => relative(out, f)).sort() };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) {
    process.stderr.write("usage: npm run build:pages -- <dir>\n");
    process.exit(2);
  }
  try {
    const { file, held } = pagesSeatsSetting();
    const { out, files, recorded, nexconn } = buildPages(dir, { seatsFile: file });
    const chat = nexconn
      ? `chat on Nexconn (${SEATS_FILE_NAME} copied in, scanned for the App Secret)`
      : held
        ? "no chat service: NEXCONN_SEATS_FILE is set but NEXCONN_PUBLISH_TOKENS is not 1, so no tokens were copied"
        : "no chat service (NEXCONN_SEATS_FILE not set)";
    process.stdout.write(`static demo: ${files.length} files in ${out}, ${recorded ? "replaying the recorded sample shopper" : "on sample data (no recording yet)"}, ${chat}\n`);
  } catch (e) {
    process.stderr.write(`build:pages failed: ${e.message}\n`);
    process.exit(1);
  }
}
