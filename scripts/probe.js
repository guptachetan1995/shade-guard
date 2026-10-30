// npm run probe -- <costs | tone | skin | vto> [--photo <path>] [--type image/png] [--shade <code>] [--save <path>] [--cors]
//
// One spike probe against the live API with the configured key. Each prints what the docs
// leave open (shapes as field outlines, codes, task statuses, colour and label values,
// latency and units) and never a key, a header value other than CORS, a signed URL or a
// body. Every task a probe creates is deleted, and the deletion checked with a status read.
// --cors adds browser preflights (Origin: the Pages demo) to the API server, the pre-signed
// upload host and the result host, and prints only their access-control-* headers.
import { parseArgs } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { outline } from "../src/providers/youcam-live.js";
import { YouCamError } from "../src/providers/errors.js";
import { makeupVtoBody } from "../src/rules/preview.js";
import { SKIN_ANALYSIS_ACTIONS } from "../src/tools.js";
import { loadFixtures } from "../src/fixtures.js";
import { describeError, liveFromConfig } from "./live-cli.js";

export const PROBE_ORIGIN = "https://guptachetan1995.github.io";
const realWait = (ms) => new Promise((r) => setTimeout(r, ms));

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
  if (!BODIES[name]) throw new Error(`no probe named ${name}; the probes are costs, tone, skin and vto`);
  if (!photo) throw new Error(`the ${name} probe needs --photo <path>`);
  const [feature, bodyFor] = BODIES[name];
  if (cors) await corsCheck(fetchFn, `${live.toJSON().apiBase}/s2s/v2.0/file`, "POST", (l) => out(`API server${l}`));
  const before = (await live.getBalance()).units;
  const { fileId } = await live.uploadPhoto(photo, contentType);
  out(`upload (${contentType}, ${photo.length} bytes): file init and PUT ok`);
  const { taskId } = await live.runTask(feature, bodyFor(fileId, shade));
  out(`${feature}: task created`);
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
    if (r.status !== "running") break;
    await wait(delay);
    delay = Math.min(delay * 1.5, 10_000);
  }
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
  await live.deleteTask(taskId);
  let gone;
  try {
    await live.pollTask(feature, taskId);
    gone = "still readable";
  } catch (e) {
    gone = e instanceof YouCamError ? e.code : "error";
  }
  out(`  delete: ok; a status read afterwards answers ${gone}`);
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
      options: { photo: { type: "string" }, shade: { type: "string" }, save: { type: "string" }, type: { type: "string", default: "image/jpeg" }, cors: { type: "boolean" } },
    }));
  } catch (e) {
    process.stderr.write(`npm run probe: ${e.message}\n`);
    process.exit(2);
  }
  const out = (line) => process.stdout.write(`${line}\n`);
  const { provider: live } = liveFromConfig("npm run probe", values.cors ? { fetch: corsSpy(globalThis.fetch, out) } : {});
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
