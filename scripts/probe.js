// npm run probe -- <costs | tone | skin | vto> [--photo <path>] [--type image/png] [--shade <code>] [--save <path>] [--cors]
// npm run probe -- gen --max-units <n> --save <dir> [--count 4] [--prompt <file>] [--variant bad-angle]
//
// One spike probe against the live API with the configured key. Each prints what the docs
// leave open (shapes as field outlines, codes, task statuses, colour and label values,
// latency and units) and never a key, a header value other than CORS, a signed URL or a
// body. Every task a probe creates is deleted, and the deletion checked with a status read.
// --cors adds browser preflights (Origin: the Pages demo) to the API server, the pre-signed
// upload host and the result host, and prints only their access-control-* headers.
//
// gen makes the sample shopper's face with the YouCam AI Image Generator V2.0: up to --count
// candidates (hard cap 6) from fixtures/persona-prompt.txt, one at a time (create, poll,
// download into --save, delete), so a surprise on the first costs one unit, not six. It refuses
// before any paid call when count × the per-image cost is over --max-units or the balance, and
// prints each file's sha256 and the balance delta.
import { parseArgs } from "node:util";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { outline } from "../src/providers/youcam-live.js";
import { YouCamError } from "../src/providers/errors.js";
import { makeupVtoBody } from "../src/rules/preview.js";
import { SKIN_ANALYSIS_ACTIONS } from "../src/tools.js";
import { loadFixtures } from "../src/fixtures.js";
import { describeError, liveFromConfig } from "./live-cli.js";
import { PERSONA_PROMPT_FILE, PromptError, personaRequest, sha256 } from "./persona-prompt.js";

export const PROBE_ORIGIN = "https://guptachetan1995.github.io";
const realWait = (ms) => new Promise((r) => setTimeout(r, ms));

export const GEN_FEATURE = "text-to-image/youcam";
export const GEN_COUNT = Object.freeze({ default: 4, max: 6 });
// "AI Image Generator V2.0 | 1" (docs.makeupar.com/reference/ai_image_generator.md, Unit
// Consumption, read 30 Oct 2026). The cost table's own row wins when one matches.
export const GEN_UNITS_DOCUMENTED = 1;
const GEN_COST_ROW = /text[-_ ]?to[-_ ]?image|image[-_ ]?generat/i;
const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

// A refusal before anything is spent (exit 2), as the recorder's.
export class ProbeRefusal extends Error {}

// The vto probe renders one catalogue shade: --shade <code>, else the first complexion shade.
function catalogueShade(code) {
  const shades = loadFixtures().catalogue.products.filter((p) => p.complexion).flatMap((p) => p.shades);
  const shade = code ? shades.find((s) => s.code === code) : shades[0];
  if (!shade) throw new Error(`no complexion shade has the code ${code}`);
  return { shade, finish: shade.finishes[0] };
}

const BODIES = {
  tone: ["skin-tone-analysis", (fileId) => ({ src_file_id: fileId, face_angle_strictness_level: "high" })],
  skin: ["skin-analysis", (fileId) => ({ src_file_id: fileId, dst_actions: SKIN_ANALYSIS_ACTIONS, format: "json" })],
  vto: ["makeup-vto", (fileId, code) => {
    const { shade, finish } = catalogueShade(code);
    return makeupVtoBody(fileId, shade, finish);
  }],
};

// The values worth reading from a result: colours, verdicts and labels, never a URL.
function readable(feature, result) {
  if (feature === "skin-tone-analysis") return { skin_color: result?.color?.skin_color, face_quality: result?.face_quality };
  if (feature === "skin-analysis" && Array.isArray(result?.output)) {
    return result.output.map(({ type, whole, t_zone, u_zone, ui_score, raw_score }) => ({ type, whole, t_zone, u_zone, ui_score, raw_score }));
  }
  return null;
}

function corsHeaders(res) {
  return Object.fromEntries([...res.headers].filter(([k]) => k.startsWith("access-control-")));
}

async function corsCheck(fetchFn, url, method, out) {
  try {
    const pre = await fetchFn(url, { method: "OPTIONS", headers: { origin: PROBE_ORIGIN, "access-control-request-method": method, "access-control-request-headers": "content-type" } });
    out(`  preflight ${method}: ${pre.status} ${JSON.stringify(corsHeaders(pre))}`);
  } catch {
    out(`  preflight ${method}: no answer`);
  }
}

// Polls with backoff until the task leaves running; a 429 waits and polls again.
async function pollToEnd(live, feature, taskId, wait) {
  const statuses = [];
  let r;
  let delay = 1000;
  for (;;) {
    try {
      r = await live.pollTask(feature, taskId);
    } catch (e) {
      if (e instanceof YouCamError && e.code === "RateLimited") {
        await wait(delay);
        continue;
      }
      throw e;
    }
    statuses.push(r.status);
    if (r.status !== "running") return { r, statuses };
    await wait(delay);
    delay = Math.min(delay * 1.5, 10_000);
  }
}

async function deleteAndConfirm(live, feature, taskId) {
  await live.deleteTask(taskId);
  try {
    await live.pollTask(feature, taskId);
    return "still readable";
  } catch (e) {
    return e instanceof YouCamError ? e.code : "error";
  }
}

// UNVERIFIED: where a finished text-to-image task puts its image. The poll page
// (…/text-to-image~1youcam~1%7Btask_id%7D/get.md, read 30 Oct 2026) lists one field, url ("Valid
// for 2 hours"), with no envelope; the other v2.0 tasks put results under data.results, which is
// what pollTask returns. Read here as results.url, else results[].url or results[].download_url
// (Makeup VTO's two documented forms). Anything else stops the run with the outline.
export function generatedUrls(result) {
  if (typeof result?.url === "string") return [result.url];
  if (Array.isArray(result)) {
    const urls = result.map((x) => x?.url ?? x?.download_url).filter((u) => typeof u === "string");
    if (urls.length === result.length && urls.length) return urls;
  }
  throw new YouCamError("unexpected_shape", { field: "results.url", outline: outline(result), message: `The text-to-image result has no url where the docs put it; its fields are ${outline(result)}.` });
}

// The per-image cost: the largest cost-table row that names the image generator, else the docs'.
async function genUnits(live, out) {
  try {
    const rows = (await live.getFeatureCosts()).filter((r) => GEN_COST_ROW.test(r.feature));
    if (rows.length) {
      out(`  cost table: ${rows.map((r) => `${r.feature} ${r.units}`).join(", ")}`);
      return Math.max(...rows.map((r) => r.units));
    }
    out(`  cost table: no image-generator row; using the docs' ${GEN_UNITS_DOCUMENTED} unit per image`);
  } catch (e) {
    out(`  cost table: not readable (${e instanceof YouCamError ? e.code : "error"}); using the docs' ${GEN_UNITS_DOCUMENTED} unit per image`);
  }
  return GEN_UNITS_DOCUMENTED;
}

// count candidates into the folder save. prompt: the prompt file's path. Throws ProbeRefusal
// before any paid call; a YouCamError after one (the task it was on is deleted first).
export async function runGen({ live, count = GEN_COUNT.default, maxUnits, save, prompt = PERSONA_PROMPT_FILE, variant = null, wait = realWait, out }) {
  if (!Number.isInteger(count) || count < 1 || count > GEN_COUNT.max) throw new ProbeRefusal(`--count must be 1 to ${GEN_COUNT.max}, not ${count}.`);
  if (!Number.isInteger(maxUnits) || maxUnits <= 0) throw new ProbeRefusal("gen needs --max-units <n>, so it can't spend more than you meant.");
  if (!save) throw new ProbeRefusal("gen needs --save <dir>, the local folder the candidates are written to.");
  let request;
  try {
    request = personaRequest(readFileSync(resolve(prompt)), variant);
  } catch (e) {
    throw new ProbeRefusal(e instanceof PromptError ? e.message : `the prompt file can't be read: ${e.message}`);
  }
  const { body, sha256: promptSha256 } = request;
  out(`gen: ${body.model}, size ${body.size}, prompt_extend ${body.prompt_extend}${variant ? `, variant ${variant}` : ""}; prompt file sha256 ${promptSha256}`);
  const each = await genUnits(live, out);
  const planned = count * each;
  if (planned > maxUnits) throw new ProbeRefusal(`${count} candidates cost up to ${planned} units, over --max-units ${maxUnits}. Nothing was sent.`);
  const before = (await live.getBalance()).units;
  if (planned > before) throw new ProbeRefusal(`${count} candidates cost up to ${planned} units but the balance is ${before}. Nothing was sent.`);
  out(`  planned: up to ${planned} units (${count} × ${each}); balance ${before}`);
  const dir = resolve(save);
  mkdirSync(dir, { recursive: true });
  const prefix = variant ?? "candidate";
  let made = 0;
  for (let i = 1; i <= count; i++) {
    const { taskId } = await live.runTask(GEN_FEATURE, body);
    let r;
    try {
      let statuses;
      ({ r, statuses } = await pollToEnd(live, GEN_FEATURE, taskId, wait));
      out(`${prefix} ${i}: polls ${statuses.join(" → ")}; latency ${live.latencies().at(-1)?.ms ?? "?"} ms`);
      if (r.status === "error") out(`  engine error: ${r.error} (no image; nothing charged for it)`);
      else {
        out(`  results shape: ${outline(r.result)}`);
        const urls = generatedUrls(r.result);
        for (const [j, url] of urls.entries()) {
          const image = await live.fetchResult(url);
          const name = `${prefix}-${i}${urls.length > 1 ? `-${j + 1}` : ""}.${EXT[image.contentType] ?? "img"}`;
          writeFileSync(join(dir, name), image.bytes);
          made += 1;
          out(`  ${name}: ${image.contentType}, ${image.bytes.length} bytes, sha256 ${sha256(image.bytes)}`);
        }
      }
    } catch (e) {
      // Polled to its end, deleted and the delete confirmed, even if it was still running.
      await live.finishInBackground(GEN_FEATURE, taskId).catch(() => {});
      throw e;
    }
    out(`  delete: ok; a status read afterwards answers ${await deleteAndConfirm(live, GEN_FEATURE, taskId)}`);
  }
  const after = (await live.getBalance()).units;
  out(`units: balance ${before} → ${after} (${before - after} spent for ${made} image${made === 1 ? "" : "s"}; planned up to ${planned})`);
  out(`saved in ${dir}`);
  return { before, after, spent: before - after, planned, made, promptSha256 };
}

// live: a YouCamProvider. out: one line at a time. Returns nothing; throws a YouCamError on a
// query error or an unrecorded shape (the caller prints its code and outline).
// With cors, the provider's fetch should be corsSpy's, so the pre-signed PUT is preflighted too.
export async function runProbe(name, { live, photo = null, contentType = "image/jpeg", shade = null, save = null, cors = false, fetchFn = globalThis.fetch, wait = realWait, out }) {
  if (name === "costs") {
    const rows = await live.getFeatureCosts();
    out(`feature-cost: ${rows.length} rows`);
    for (const { feature, units } of rows) out(`  ${feature}: ${units}`);
    return;
  }
  if (!BODIES[name]) throw new Error(`no probe named ${name}; the probes are costs, tone, skin and vto (and gen)`);
  if (!photo) throw new Error(`the ${name} probe needs --photo <path>`);
  const [feature, bodyFor] = BODIES[name];
  if (cors) await corsCheck(fetchFn, `${live.toJSON().apiBase}/s2s/v2.0/file`, "POST", (l) => out(`API server${l}`));
  const before = (await live.getBalance()).units;
  const { fileId } = await live.uploadPhoto(photo, contentType);
  out(`upload (${contentType}, ${photo.length} bytes): file init and PUT ok`);
  const { taskId } = await live.runTask(feature, bodyFor(fileId, shade));
  out(`${feature}: task created`);
  const { r, statuses } = await pollToEnd(live, feature, taskId, wait);
  out(`  polls: ${statuses.join(" → ")}; latency ${live.latencies().at(-1)?.ms ?? "?"} ms`);
  if (r.status === "error") out(`  engine error: ${r.error}`);
  else {
    out(`  results shape: ${outline(r.result)}`);
    const values = readable(feature, r.result);
    if (values) out(`  values: ${JSON.stringify(values)}`);
    if (feature === "makeup-vto") {
      const url = r.result?.url ?? r.result?.[0]?.download_url;
      if (typeof url === "string") {
        const image = await live.fetchResult(url);
        out(`  render: ${image.contentType}, ${image.bytes.length} bytes`);
        if (save) {
          writeFileSync(resolve(save), image.bytes);
          out(`  saved to ${save}`);
        }
        if (cors) await corsCheck(fetchFn, url, "GET", (l) => out(`  result host${l}`));
      }
    }
  }
  const after = (await live.getBalance()).units;
  out(`  units: balance ${before} → ${after} (${before - after} spent; the cost table says ${r.unitsCharged})`);
  out(`  delete: ok; a status read afterwards answers ${await deleteAndConfirm(live, feature, taskId)}`);
  // Only for the 1-unit render: does the uploaded file outlive its task's delete?
  if (feature !== "makeup-vto") return;
  try {
    const again = await live.runTask(feature, bodyFor(fileId, shade));
    out(`  a new task on the deleted task's file_id was accepted (the file outlived the delete)`);
    let rr;
    do {
      await wait(1000);
      rr = await live.pollTask(feature, again.taskId);
    } while (rr.status === "running");
    await live.deleteTask(again.taskId);
  } catch (e) {
    out(`  a new task on the deleted task's file_id: ${e instanceof YouCamError ? e.code : "error"}`);
  }
}

export function corsSpy(fetchFn, out) {
  return async (url, init) => {
    if (init?.method === "PUT") await corsCheck(fetchFn, url, "PUT", (l) => out(`  upload host${l}`));
    return fetchFn(url, init);
  };
}

async function main() {
  let positionals;
  let values;
  try {
    ({ positionals, values } = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: {
        photo: { type: "string" },
        shade: { type: "string" },
        save: { type: "string" },
        type: { type: "string", default: "image/jpeg" },
        cors: { type: "boolean" },
        count: { type: "string", default: String(GEN_COUNT.default) },
        "max-units": { type: "string" },
        prompt: { type: "string" },
        variant: { type: "string" },
      },
    }));
  } catch (e) {
    process.stderr.write(`npm run probe: ${e.message}\n`);
    process.exit(2);
  }
  const out = (line) => process.stdout.write(`${line}\n`);
  const { provider: live } = liveFromConfig("npm run probe", values.cors ? { fetch: corsSpy(globalThis.fetch, out) } : {});
  if (positionals[0] === "gen") {
    try {
      await runGen({
        live,
        count: Number(values.count),
        maxUnits: Number.parseInt(values["max-units"] ?? "", 10),
        save: values.save ?? null,
        prompt: values.prompt ?? PERSONA_PROMPT_FILE,
        variant: values.variant ?? null,
        out,
      });
    } catch (e) {
      process.stderr.write(`npm run probe: ${e instanceof ProbeRefusal ? `${e.message}\n` : describeError(e)}`);
      process.exit(e instanceof ProbeRefusal ? 2 : 1);
    }
    return;
  }
  try {
    await runProbe(positionals[0], {
      live,
      photo: values.photo ? new Uint8Array(readFileSync(resolve(values.photo))) : null,
      contentType: values.type,
      shade: values.shade ?? null,
      save: values.save ?? null,
      cors: Boolean(values.cors),
      out,
    });
  } catch (e) {
    process.stderr.write(`npm run probe: ${describeError(e)}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
