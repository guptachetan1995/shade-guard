// npm run record -- --max-units 90 --photo <base.jpg> --light <brighter.jpg> --light <dimmer.jpg> [--phase all|readings|renders]
//   [--generated-persona [--persona-prompt <file>]]
//
// Records the sample shopper with the owner's key, for the replay demo:
//   readings: three Facial Color Tones readings (the photo and two copies at ±15% brightness,
//             for the band's spread across shifted light) and one SD Skin Analysis of the photo;
//   renders:  the demo's own check and the R-107 return check run through the real invoke()
//             and planner, with the readings served from the readings phase and only the
//             Makeup VTO renders live.
// Run the phases apart to adjust the catalogue around the reading before the renders.
//
// It refuses to start when the planned cost is over --max-units or the balance, deletes every
// task it created, and prints the units spent (the balance before minus after). It writes
// response bodies only, never request headers: every signed URL becomes a local image path or
// is scrubbed, request ids are dropped, and every file written is scanned for the key's value
// (the run fails, and removes what it wrote, if it is found).
//
// --generated-persona says the photo came from the YouCam AI Image Generator (npm run probe --
// gen): recording.json then carries persona { source, model, promptSha256 }, the sha256 of the
// prompt file it was made from, and the page stamps the face "AI-generated · not a real person".
import { parseArgs } from "node:util";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createApp } from "../src/app.js";
import { runPlanner } from "../src/agent/planner.js";
import { closeCheck } from "../src/check-lifecycle.js";
import { loadFeatureCosts } from "../src/providers/provider.js";
import { YouCamError } from "../src/providers/errors.js";
import { toBase64 } from "../src/providers/fake-photos.js";
import { checkPhoto } from "../src/photo-check.js";
import { parseTone } from "../src/readings.js";
import { runTaskToEnd } from "../src/tasks.js";
import { measurePrice, perLinePrice, SKIN_ANALYSIS_ACTIONS } from "../src/tools.js";
import { loadFixtures } from "../src/fixtures.js";
import { hexToLab } from "../src/color/lab.js";
import { deltaE00 } from "../src/color/ciede2000.js";
import { describeError, liveFromConfig } from "./live-cli.js";
import { generatedPersona, PERSONA_PROMPT_FILE } from "./persona-prompt.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const DEFAULT_OUT = join(ROOT, "fixtures/recorded/sample-shopper");
export const RETURN_CASE = "R-107";
const TONE_REQUEST = { face_angle_strictness_level: "high" };
const SD_REQUEST = { dst_actions: SKIN_ANALYSIS_ACTIONS, format: "json" };
const DROP_KEYS = /^(request_?id|x-request-id|token|access_token|signature|credential|authorization)$/i;
const realWait = (ms) => new Promise((r) => setTimeout(r, ms));
const r2 = (n) => Math.round(n * 100) / 100;

export class RecordRefusal extends Error {}

export function plannedUnits(phase, costs, fixtures = loadFixtures()) {
  const complexion = fixtures.cart.lines.filter((l) => fixtures.catalogue.products.find((p) => p.productId === l.productId)?.complexion).length;
  const readings = 2 * costs["skin-tone-analysis"] + measurePrice(costs);
  const renders = perLinePrice(costs) * (complexion + 1); // the cart's lines and the return case's one
  return { readings, renders, all: readings + renders }[phase];
}

// Signed URLs become the local name of the image downloaded from them, or are scrubbed;
// request ids and anything named like a credential are dropped.
export function scrub(value, localFor = new Map()) {
  if (typeof value === "string") {
    if (localFor.has(value)) return localFor.get(value);
    return /^https?:\/\//i.test(value) ? "[signed URL scrubbed]" : value;
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v, localFor));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !DROP_KEYS.test(k))
        .map(([k, v]) => [k, scrub(v, localFor)]),
    );
  }
  return value;
}

const responseOf = (r) => ({
  status: r.status,
  ...(r.result !== undefined ? { result: r.result } : {}),
  ...(r.error !== undefined ? { error: r.error } : {}),
  unitsCharged: r.unitsCharged,
});

async function deleteAll(live, created) {
  for (const { feature, taskId } of created) {
    try {
      await live.deleteTask(taskId);
    } catch (e) {
      if (!(e instanceof YouCamError)) throw e;
      if (e.code === "OperationInvalid") await live.finishInBackground(feature, taskId);
      else if (e.code !== "InvalidTaskId") throw e;
    }
  }
  await live.backgroundSettled();
}

async function recordReadings({ live, photo, lights, costs, wait, log }) {
  const created = [];
  const run = (feature, body) => runTaskToEnd(live, feature, body, { wait, onCreated: (taskId) => created.push({ feature, taskId }) });
  const tone = [];
  let skin = null;
  let fileId = null;
  try {
    for (const [role, bytes] of [["photo", photo], ["light-1", lights[0]], ["light-2", lights[1]]]) {
      const up = await live.uploadPhoto(bytes, "image/jpeg");
      if (role === "photo") fileId = up.fileId;
      const r = await run("skin-tone-analysis", { src_file_id: up.fileId, ...TONE_REQUEST });
      tone.push({ role, request: TONE_REQUEST, response: scrub(responseOf(r)) });
      // The band counts only light the analyser rates good, so each reading's verdict is shown.
      const lighting = r.status === "success" ? `, ${parseTone(r.result).skinHex}, lighting ${parseTone(r.result).faceQuality.lighting ?? "not reported"}` : "";
      log(`  tone reading (${role}): ${r.status}${r.error ? ` ${r.error}` : ""}${lighting}`);
      if (role === "photo") {
        const s = await run("skin-analysis", { src_file_id: up.fileId, ...SD_REQUEST });
        skin = { request: SD_REQUEST, response: scrub(responseOf(s)) };
        log(`  SD skin analysis (photo): ${s.status}${s.error ? ` ${s.error}` : ""}`);
      }
    }
  } finally {
    await deleteAll(live, created);
  }
  const readings = tone
    .filter((t) => t.response.status === "success")
    .map((t) => ({ role: t.role, ...(({ skinHex, faceQuality }) => ({ skinHex, lighting: faceQuality.lighting }))(parseTone(t.response.result)) }));
  readings.forEach((x) => (x.lab = hexToLab(x.skinHex).map(r2)));
  const pairs = [];
  for (let i = 0; i < readings.length; i++) {
    for (let j = i + 1; j < readings.length; j++) pairs.push({ a: readings[i].role, b: readings[j].role, de00: r2(deltaE00(readings[i].lab, readings[j].lab)) });
  }
  return { fileId, featureCosts: costs, tone, skin, spread: { readings, pairs, maxDe00: pairs.length ? Math.max(...pairs.map((p) => p.de00)) : null } };
}

// The readings phase answers the two analysers, and a render already made answers its repeat
// (the return check asks for some of the cart check's renders), so no unit is spent twice.
// Other renders, the upload, deletes and the balance go to the live API. Every finished task
// and every downloaded image is captured.
function hybridRecorder(live, readings) {
  const replayed = { "skin-tone-analysis": readings.tone.find((t) => t.role === "photo").response, "skin-analysis": readings.skin.response };
  const made = new Map(); // feature|request → the first finished response
  const keyOf = (feature, request) => `${feature}|${JSON.stringify(request)}`;
  const answerFor = (feature, request) => replayed[feature] ?? made.get(keyOf(feature, request));
  const local = new Map();
  const asked = new Map();
  const tasks = [];
  const images = new Map();
  let seq = 0;
  const provider = {
    mode: "live",
    uploadPhoto: (bytes, contentType) => live.uploadPhoto(bytes, contentType),
    async runTask(feature, body) {
      const { src_file_id: _file, ...request } = body;
      let taskId;
      const answer = answerFor(feature, request);
      if (answer) {
        taskId = `recorded-${feature}-${++seq}`;
        local.set(taskId, { feature, answer, deleted: false });
      } else taskId = (await live.runTask(feature, body)).taskId;
      asked.set(taskId, { feature, request });
      return { taskId };
    },
    async pollTask(feature, taskId) {
      const l = local.get(taskId);
      if (l?.deleted) throw new YouCamError("InvalidTaskId", { status: 404, feature, taskId });
      const r = l ? structuredClone(l.answer) : await live.pollTask(feature, taskId);
      const a = asked.get(taskId);
      if (r.status !== "running" && a) {
        asked.delete(taskId);
        tasks.push({ feature, request: a.request, response: responseOf(r) });
        if (!l && r.status === "success") made.set(keyOf(feature, a.request), responseOf(r));
      }
      return r;
    },
    async fetchResult(url) {
      if (images.has(url)) return images.get(url);
      const image = await live.fetchResult(url);
      images.set(url, image);
      return image;
    },
    async deleteTask(taskId) {
      const l = local.get(taskId);
      if (!l) return live.deleteTask(taskId);
      l.deleted = true;
      return { deleted: true };
    },
    getBalance: () => live.getBalance(),
    getFeatureCosts: () => live.getFeatureCosts(),
    finishInBackground: (feature, taskId) => live.finishInBackground(feature, taskId),
  };
  return { provider, tasks, images };
}

async function recordRenders({ live, photo, readings, cap, wait, log }) {
  const { provider, tasks, images } = hybridRecorder(live, readings);
  const app = await createApp({ provider, unitCapPerCheck: cap, wait });
  for (const caseId of [null, RETURN_CASE]) {
    const s = await app.invoke("start_check", { photo: toBase64(photo), capture: "upload", ...(caseId ? { caseId } : {}) }, "shopper");
    if (!s.ok) throw new RecordRefusal(`start_check was refused: ${s.error.code}`);
    const { checkId } = s.result;
    const { plan } = await runPlanner(app.invoke, { checkId, caseId });
    const check = app.store.getCheck(checkId);
    await closeCheck(app.store, provider, check, "recorded");
    log(`  ${caseId ? `return check ${caseId}` : "cart check"}: ${plan.outcome ?? plan.phase}, ${check.unitsSpent} units on the check`);
  }
  await live.backgroundSettled();
  // Each distinct request once, in the order first asked; the replay matches on the request.
  const seen = new Set();
  const unique = tasks.filter((t) => {
    const k = `${t.feature}|${JSON.stringify(t.request)}`;
    return !seen.has(k) && seen.add(k);
  });
  return { tasks: unique, images };
}

function writeOut(outDir, files, key) {
  mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const [name, data] of files) {
    const path = join(outDir, name);
    writeFileSync(path, data);
    written.push(path);
  }
  const needle = Buffer.from(key, "utf8");
  for (const path of written) {
    const bytes = readFileSync(path);
    const text = path.endsWith(".json") ? bytes.toString("utf8") : "";
    if (bytes.includes(needle) || /https?:\/\//i.test(text)) {
      for (const p of written) rmSync(p, { force: true });
      throw new RecordRefusal(`${relative(ROOT, path)} carried the key or a URL after scrubbing; everything this run wrote was removed.`);
    }
  }
  return written;
}

const json = (v) => `${JSON.stringify(v, null, 2)}\n`;

function latencyLines(live) {
  const by = new Map();
  for (const { feature, ms } of live.latencies()) by.set(feature, [...(by.get(feature) ?? []), ms]);
  return [...by].map(([feature, list]) => {
    const sorted = [...list].sort((a, b) => a - b);
    return `  ${feature}: ${list.length} task${list.length === 1 ? "" : "s"}, median ${sorted[Math.floor(sorted.length / 2)]} ms, max ${sorted.at(-1)} ms`;
  });
}

// live: a YouCamProvider holding the key; key: its value, only to scan the output for it.
// persona: where the photo came from (generatedPersona()), written into recording.json; null
// for a photo of a consenting person, which then carries no stamp.
export async function recordFixtures({ live, key, phase = "all", maxUnits, photo, lights = [], outDir = DEFAULT_OUT, cap = 40, persona = null, wait = realWait, log = () => {} }) {
  if (!["all", "readings", "renders"].includes(phase)) throw new RecordRefusal(`--phase must be all, readings or renders, not ${phase}.`);
  if (!Number.isInteger(maxUnits) || maxUnits <= 0) throw new RecordRefusal("--max-units <n> is required, so the run can't spend more than you meant.");
  if (!photo) throw new RecordRefusal("--photo <path> is required: the pre-sized sample-shopper photo.");
  if (phase !== "renders" && lights.length !== 2) throw new RecordRefusal("The readings need two --light <path> photos: the same photo, light-shifted up and down.");
  for (const bytes of [photo, ...lights]) checkPhoto(bytes);
  const readingsPath = join(outDir, "readings.json");
  if (phase === "renders" && !existsSync(readingsPath)) throw new RecordRefusal(`The renders need ${relative(ROOT, readingsPath)} from the readings phase.`);

  const costs = await loadFeatureCosts(live);
  const planned = plannedUnits(phase, costs);
  if (planned > maxUnits) throw new RecordRefusal(`The plan costs up to ${planned} units, over --max-units ${maxUnits}. Nothing was sent.`);
  const before = (await live.getBalance()).units;
  if (planned > before) throw new RecordRefusal(`The plan costs up to ${planned} units but the balance is ${before}. Nothing was sent.`);
  log(`Planned: up to ${planned} units (balance ${before}).`);

  const recordedAt = new Date().toISOString();
  const written = [];
  let readings;
  let after = null;
  if (phase === "renders") readings = JSON.parse(readFileSync(readingsPath, "utf8"));
  else {
    log("Readings:");
    readings = { recordedAt, ...(await recordReadings({ live, photo, lights, costs, wait, log })) };
    written.push(...writeOut(outDir, [["readings.json", json(readings)]], key));
    log(`  repeat spread (max ΔE00 between the three readings): ${readings.spread.maxDe00 ?? "not measured"}`);
  }
  if (phase !== "readings") {
    if (readings.tone.find((t) => t.role === "photo")?.response.status !== "success" || readings.skin?.response.status !== "success") {
      throw new RecordRefusal("The photo's readings did not both succeed, so there is nothing to render on. Re-run the readings with another photo.");
    }
    log("Renders:");
    const { tasks, images } = await recordRenders({ live, photo, readings, cap, wait, log });
    const localFor = new Map();
    const files = [["photo.jpg", photo]];
    let n = 0;
    for (const [url, image] of images) {
      const name = `render-${++n}.${image.contentType === "image/png" ? "png" : "jpg"}`;
      localFor.set(url, name);
      files.push([name, image.bytes]);
    }
    const recording = {
      recordedAt,
      readingsRecordedAt: readings.recordedAt,
      photo: "photo.jpg",
      ...(persona ? { persona } : {}),
      fileId: readings.fileId,
      featureCosts: costs,
      tasks: tasks.map((t) => scrub(t, localFor)),
      images: Object.fromEntries([...localFor.values()].map((name) => [name, { file: name, contentType: name.endsWith(".png") ? "image/png" : "image/jpeg" }])),
    };
    after = (await live.getBalance()).units;
    recording.balance = after;
    files.push(["recording.json", json(recording)]);
    written.push(...writeOut(outDir, files, key));
  }

  after ??= (await live.getBalance()).units;
  const predicted = live.latencies().reduce((sum, l) => sum + (l.status === "success" ? costs[l.feature] : 0), 0);
  return { planned, before, after, spent: before - after, predicted, written: written.map((p) => relative(ROOT, p)), latency: latencyLines(live), spread: readings.spread };
}

function parse(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      "max-units": { type: "string" },
      photo: { type: "string" },
      light: { type: "string", multiple: true, default: [] },
      phase: { type: "string", default: "all" },
      out: { type: "string" },
      cap: { type: "string", default: "40" },
      "generated-persona": { type: "boolean" },
      "persona-prompt": { type: "string" },
    },
  });
  return values;
}

async function main() {
  let args;
  try {
    args = parse(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`npm run record: ${e.message}\n`);
    process.exit(2);
  }
  const { config, provider: live } = liveFromConfig("npm run record");
  const read = (p) => new Uint8Array(readFileSync(resolve(p)));
  try {
    const r = await recordFixtures({
      live,
      key: config.apiKey,
      phase: args.phase,
      maxUnits: Number.parseInt(args["max-units"] ?? "", 10),
      photo: args.photo ? read(args.photo) : null,
      lights: args.light.map(read),
      outDir: args.out ? resolve(args.out) : DEFAULT_OUT,
      cap: Number.parseInt(args.cap, 10),
      persona: args["generated-persona"] ? generatedPersona(resolve(args["persona-prompt"] ?? PERSONA_PROMPT_FILE)) : null,
      log: (line) => process.stdout.write(`${line}\n`),
    });
    process.stdout.write(
      [
        `Units: spent ${r.spent} (balance ${r.before} → ${r.after}); planned up to ${r.planned}; the cost table predicted ${r.predicted}.`,
        ...(r.spent !== r.predicted ? ["  The balance moved by a different amount than the cost table predicts: check the per-feature costs."] : []),
        "Latency, task created to finished:",
        ...r.latency,
        "Written:",
        ...r.written.map((p) => `  ${p}`),
        "",
      ].join("\n"),
    );
  } catch (e) {
    const text = e instanceof RecordRefusal || e?.code?.startsWith?.("photo_") ? `${e.message}\n` : describeError(e);
    process.stderr.write(`npm run record: ${text}`);
    process.exit(e instanceof RecordRefusal ? 2 : 1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
