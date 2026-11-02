// YouCamProvider: real REST calls to the YouCam API server, as the developer docs describe them
// (read 28 Sep 2026). Browser-safe, so "Live with your own key" can run it in a tab: global
// fetch only, no Node APIs, and it never reads the environment. The caller passes the key in.
//
// The key lives in one private field. It is sent in exactly one place, the Authorization
// header of a request to the API server; never to the pre-signed upload host or a result
// host, and never into a returned value, an error, the request log or a thrown message.
//
// Every response is parsed strictly. A shape other than the documented one throws
// unexpected_shape naming the field, with an outline of the field names and value types; it
// never guesses. Shapes marked UNVERIFIED below are the docs' (or, where the docs give none,
// this file's) assumption until the first keyed run records the real one.
import { KEY_NOT_ACCEPTED, YouCamError } from "./errors.js";
import { DEFAULT_FEATURE_COSTS } from "./provider.js";
import { createPacer } from "./pacer.js";
import { POLL } from "../tasks.js";

export const API_BASE = "https://yce-api-01.makeupar.com";

// Skin Analysis also has a /s2s/v2.1/ path; v2.0 stands until the keyed run compares the two.
// text-to-image/youcam is the AI Image Generator V2.0, used only by `npm run probe -- gen` to
// make the sample shopper's face; the app never calls it.
export const TASK_VERSION = Object.freeze({ "skin-tone-analysis": "v2.0", "skin-analysis": "v2.0", "makeup-vto": "v2.0", "text-to-image/youcam": "v2.0" });

export const PATHS = Object.freeze({
  file: "/s2s/v2.0/file",
  task: (feature) => `/s2s/${TASK_VERSION[feature]}/task/${feature}`,
  poll: (feature, taskId) => `/s2s/${TASK_VERSION[feature]}/task/${feature}/${encodeURIComponent(taskId)}`,
  delete: "/s2s/v2.0/task/delete",
  credit: "/s2s/v1.0/client/credit",
  featureCost: "/s2s/v2.0/credit/feature-cost",
});

// The name the photo is declared under. It says nothing about the shopper.
export const UPLOAD_FILE_NAME = "photo.jpg";
export const TASK_STATUSES = Object.freeze(["running", "success", "error"]);
// Without a Retry-After header, a 429 holds every request back this long.
export const RATE_LIMIT_HOLD_MS = 2000;
// The background finisher stops after this many failed polls in a row (network or server).
export const BACKGROUND_FAILURES_MAX = 10;
const LOG_MAX = 500;

// Field names and value types only, never values: safe to print, because a URL, an id or a
// key is always a value.
export function outline(value, depth = 0) {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (depth > 6) return "[…]";
    return `[${value.length ? outline(value[0], depth + 1) : ""}]${value.length > 1 ? `×${value.length}` : ""}`;
  }
  if (typeof value === "object") {
    if (depth > 6) return "{…}";
    return `{${Object.keys(value)
      .map((k) => `${k}:${outline(value[k], depth + 1)}`)
      .join(",")}}`;
  }
  return typeof value;
}

function shapeError(field, body, ctx = {}) {
  return new YouCamError("unexpected_shape", {
    ...ctx,
    field,
    outline: outline(body),
    message: `The YouCam response has no ${field} where the docs put it; its fields are ${outline(body)}.`,
  });
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const realWait = (ms) => new Promise((r) => setTimeout(r, ms));

export class YouCamProvider {
  #key;
  #base;
  #fetch;
  #pacer;
  #wait;
  #now;
  #costs;
  #log = [];
  #created = new Map(); // taskId → { feature, at }
  #latencies = [];
  #background = new Map(); // taskId → promise

  constructor({ apiKey, apiBase = API_BASE, mode = "live", fetch = globalThis.fetch, pacer, wait = realWait, now = () => Date.now(), costs = DEFAULT_FEATURE_COSTS }) {
    if (typeof apiKey !== "string" || !apiKey.trim()) throw new TypeError("YouCamProvider needs an API key");
    this.mode = mode;
    this.#key = apiKey.trim();
    this.#base = apiBase.replace(/\/+$/, "");
    this.#fetch = fetch;
    this.#wait = wait;
    this.#now = now;
    this.#pacer = pacer ?? createPacer({ now });
    this.#costs = { ...costs };
  }

  // JSON.stringify of the provider never shows the key.
  toJSON() {
    return { mode: this.mode, apiBase: this.#base };
  }

  #record(entry) {
    this.#log.push(entry);
    if (this.#log.length > LOG_MAX) this.#log.shift();
  }

  // method, path (or a label for a pre-signed host), status and milliseconds. No header, no
  // body, no pre-signed URL.
  requestLog() {
    return this.#log.map((e) => ({ ...e }));
  }

  // Creation to the first terminal poll, per task; the spike's latency baseline.
  latencies() {
    return this.#latencies.map((e) => ({ ...e }));
  }

  async #api(method, path, { body = null, feature = null, taskId = null } = {}) {
    await this.#pacer.take();
    const started = this.#now();
    const headers = { authorization: `Bearer ${this.#key}` };
    if (body) headers["content-type"] = "application/json";
    let res;
    try {
      res = await this.#fetch(this.#base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    } catch {
      this.#record({ method, path, status: null, ms: this.#now() - started });
      throw new YouCamError("network_error", { feature, taskId, message: `Could not reach the YouCam API server (${method} ${path}).` });
    }
    const text = await res.text();
    this.#record({ method, path, status: res.status, ms: this.#now() - started });
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON: handled below as a shape error, or by the status for 401 and 429.
    }
    if (res.ok) {
      if (!isObject(json)) throw shapeError("a JSON object body", json, { status: res.status, feature, taskId });
      return json;
    }
    throw this.#queryError(res, json, { feature, taskId });
  }

  // UNVERIFIED: the error envelope's code field. The docs' Error Codes page names the codes
  // (InvalidApiKey, CreditInsufficiency, InvalidTaskId, TaskTimeout, InvalidParameters,
  // OperationInvalid); this reads them from error_code. A 401 and a 429 are decided by the
  // status alone, so those two work whatever the envelope turns out to be.
  #queryError(res, json, ctx) {
    const code = isObject(json) && typeof json.error_code === "string" ? json.error_code : null;
    if (res.status === 429) {
      const seconds = Number(res.headers.get("retry-after"));
      this.#pacer.backoff(Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : RATE_LIMIT_HOLD_MS);
      return new YouCamError("RateLimited", { status: 429, ...ctx });
    }
    if (res.status === 401) {
      // Both documented codes (InvalidApiKey per the docs, InvalidAccessToken as observed)
      // read the same to a person: the key was not accepted.
      return new YouCamError(KEY_NOT_ACCEPTED.has(code) ? code : "InvalidAccessToken", {
        status: 401,
        ...ctx,
        message: `The API key was not accepted (401${code ? ` ${code}` : ""}).`,
      });
    }
    if (code) return new YouCamError(code, { status: res.status, ...ctx });
    return shapeError("error_code", json, { status: res.status, ...ctx });
  }

  // Two steps, per the docs' File API: declare the file, then PUT the bytes to the pre-signed
  // URL with exactly the headers it came with. Declaring alone uploads nothing.
  async uploadPhoto(bytes, contentType = "image/jpeg") {
    const json = await this.#api("POST", PATHS.file, {
      body: { files: [{ content_type: contentType, file_name: UPLOAD_FILE_NAME, file_size: bytes.length }] },
    });
    const file = json.data?.files?.[0];
    if (!isObject(file)) throw shapeError("data.files[0]", json);
    if (typeof file.file_id !== "string" || !file.file_id) throw shapeError("data.files[0].file_id", json);
    const req = file.requests?.[0];
    if (!isObject(req)) throw shapeError("data.files[0].requests[0]", json);
    if (req.method !== "PUT") throw shapeError("data.files[0].requests[0].method (PUT)", json);
    if (typeof req.url !== "string" || !/^https?:\/\//.test(req.url)) throw shapeError("data.files[0].requests[0].url", json);
    if (!isObject(req.headers)) throw shapeError("data.files[0].requests[0].headers", json);

    // The pre-signed URL carries its own authorisation, so the key is not sent with it.
    const started = this.#now();
    let put;
    try {
      put = await this.#fetch(req.url, { method: "PUT", headers: { ...req.headers }, body: bytes });
    } catch {
      this.#record({ method: "PUT", path: "(pre-signed upload)", status: null, ms: this.#now() - started });
      throw new YouCamError("network_error", { message: "Could not reach the pre-signed upload host." });
    }
    await put.arrayBuffer();
    this.#record({ method: "PUT", path: "(pre-signed upload)", status: put.status, ms: this.#now() - started });
    if (!put.ok) throw new YouCamError("upload_failed", { status: put.status, message: `The pre-signed upload answered ${put.status}.` });
    return { fileId: file.file_id };
  }

  async runTask(feature, body) {
    const json = await this.#api("POST", PATHS.task(feature), { body, feature });
    const taskId = json.data?.task_id;
    if (typeof taskId !== "string" || !taskId) throw shapeError("data.task_id", json, { feature });
    this.#created.set(taskId, { feature, at: this.#now() });
    return { taskId };
  }

  // UNVERIFIED: an engine error's code in data.error, and the success result in data.results.
  // Units are charged only on success; the poll response is not documented to carry the
  // amount, so it is read from the cost table (feature-cost, else the documented one). The
  // fixture recorder compares that with the balance before and after.
  async pollTask(feature, taskId) {
    const json = await this.#api("GET", PATHS.poll(feature, taskId), { feature, taskId });
    const data = json.data;
    if (!isObject(data)) throw shapeError("data", json, { feature, taskId });
    const status = data.task_status;
    if (!TASK_STATUSES.includes(status)) throw shapeError("data.task_status (running, success or error)", json, { feature, taskId });
    if (status === "running") return { status, unitsCharged: 0 };
    this.#noteLatency(taskId, status);
    if (status === "error") {
      if (typeof data.error !== "string" || !data.error) throw shapeError("data.error", json, { feature, taskId });
      return { status, error: data.error, unitsCharged: 0 };
    }
    if (data.results === null || typeof data.results !== "object") throw shapeError("data.results", json, { feature, taskId });
    return { status, result: data.results, unitsCharged: this.#costs[feature] ?? 0 };
  }

  #noteLatency(taskId, status) {
    const c = this.#created.get(taskId);
    if (!c) return;
    this.#created.delete(taskId);
    this.#latencies.push({ feature: c.feature, status, ms: this.#now() - c.at });
  }

  // A result URL is pre-signed on another host, so the key is not sent with it.
  async fetchResult(url) {
    const started = this.#now();
    let res;
    try {
      res = await this.#fetch(url, { method: "GET" });
    } catch {
      this.#record({ method: "GET", path: "(result image)", status: null, ms: this.#now() - started });
      throw new YouCamError("network_error", { message: "Could not reach the result image host." });
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    this.#record({ method: "GET", path: "(result image)", status: res.status, ms: this.#now() - started });
    if (!res.ok) throw new YouCamError("result_fetch_failed", { status: res.status, message: `The result image answered ${res.status}.` });
    const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim();
    if (!contentType.startsWith("image/")) {
      throw new YouCamError("unexpected_shape", { field: "content-type (image/*)", outline: contentType || "none", message: `The result image came back as ${contentType || "no content type"}.` });
    }
    return { bytes, contentType };
  }

  // Per the docs this deletes a finished task with its input files and outputs; a running
  // task is refused with OperationInvalid. The response body is not used.
  async deleteTask(taskId) {
    await this.#api("POST", PATHS.delete, { body: { task_id: taskId }, taskId });
    return { deleted: true };
  }

  // UNVERIFIED: the credit response's shape is not in the docs read on 28 Sep. Read here as
  // results[] of credit entries with a numeric amount, summed; npm run balance prints the
  // outline if the real shape differs.
  async getBalance() {
    const json = await this.#api("GET", PATHS.credit);
    const entries = json.results;
    if (!Array.isArray(entries) || !entries.length) throw shapeError("results[]", json);
    if (!entries.every((e) => isObject(e) && Number.isFinite(e.amount))) throw shapeError("results[].amount", json);
    return { units: entries.reduce((sum, e) => sum + e.amount, 0) };
  }

  // UNVERIFIED: the feature-cost response's shape (paged) is not in the docs read on 28 Sep.
  // Read here as data.features[] of { feature, units }, one page of up to 30. When it doesn't
  // parse, loadFeatureCosts keeps the documented table.
  async getFeatureCosts() {
    const json = await this.#api("GET", `${PATHS.featureCost}?page_size=30`);
    const rows = json.data?.features;
    if (!Array.isArray(rows)) throw shapeError("data.features[]", json);
    if (!rows.every((r) => isObject(r) && typeof r.feature === "string" && Number.isInteger(r.units))) {
      throw shapeError("data.features[].feature and .units", json);
    }
    const costs = rows.map(({ feature, units }) => ({ feature, units }));
    for (const { feature, units } of costs) if (feature in this.#costs) this.#costs[feature] = units;
    return costs;
  }

  // The UI stopped waiting, or the check closed while this task ran. Polling continues here at
  // the usual cadence, because the docs say a task nobody polls times out with its units
  // still charged; once it finishes it is deleted, and the deletion is confirmed by a status
  // read that no longer finds it. Resolves { taskId, deleted, confirmed, error? }.
  finishInBackground(feature, taskId) {
    if (this.#background.has(taskId)) return this.#background.get(taskId);
    const run = this.#finish(feature, taskId).finally(() => this.#background.delete(taskId));
    this.#background.set(taskId, run);
    return run;
  }

  backgroundTasks() {
    return [...this.#background.keys()];
  }

  // Resolves when every background finisher has ended.
  async backgroundSettled() {
    return Promise.all([...this.#background.values()]);
  }

  async #finish(feature, taskId) {
    let delay = POLL.firstMs;
    let failures = 0;
    const pause = async () => {
      await this.#wait(delay);
      delay = Math.min(delay * POLL.factor, POLL.maxMs);
    };
    for (;;) {
      let finished = false;
      try {
        finished = (await this.pollTask(feature, taskId)).status !== "running";
        failures = 0;
      } catch (e) {
        if (!(e instanceof YouCamError)) throw e;
        if (e.code === "InvalidTaskId") return { taskId, deleted: true, confirmed: true };
        if (e.code === "TaskTimeout") finished = true;
        else if (e.code !== "RateLimited" && ++failures >= BACKGROUND_FAILURES_MAX) return { taskId, deleted: false, confirmed: false, error: e.code };
      }
      if (finished) {
        try {
          await this.deleteTask(taskId);
          return { taskId, deleted: true, confirmed: await this.#gone(feature, taskId) };
        } catch (e) {
          if (!(e instanceof YouCamError)) throw e;
          if (e.code === "InvalidTaskId") return { taskId, deleted: true, confirmed: true };
          if (e.code !== "OperationInvalid" && e.code !== "RateLimited" && ++failures >= BACKGROUND_FAILURES_MAX) {
            return { taskId, deleted: false, confirmed: false, error: e.code };
          }
        }
      }
      await pause();
    }
  }

  async #gone(feature, taskId) {
    try {
      await this.pollTask(feature, taskId);
      return false;
    } catch (e) {
      if (e instanceof YouCamError && e.code === "InvalidTaskId") return true;
      return false;
    }
  }
}
