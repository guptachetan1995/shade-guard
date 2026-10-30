// FakeYouCamProvider: deterministic synthetic results keyed by the fake photo's scenario name,
// with no network. Every result carries synthetic: true; none is passed off as real.
import { YouCamError } from "./errors.js";
import { DEFAULT_FEATURE_COSTS } from "./provider.js";
import { FAKE_TAG, fakePhoto } from "./fake-photos.js";
import { readJpegInfo } from "../photo-check.js";

const GOOD = Object.freeze({ lighting: "good", frontal: "good", area: "good", faceangle: "good" });

const SAMPLE = Object.freeze({
  skinHex: "#B9947C",
  faceQuality: GOOD,
  skinType: { whole: "Combination", t_zone: "Oily", u_zone: "Normal" },
  raw: { oiliness: 58.1, moisture: 61.0, redness: 71.4 },
});

export const FAKE_SCENARIOS = Object.freeze({
  "sample-shopper": SAMPLE,
  "dim-light": { ...SAMPLE, faceQuality: { ...GOOD, lighting: "poor" } },
  "oily-redness": {
    ...SAMPLE,
    skinType: { whole: "Oily & Redness", t_zone: "Oily", u_zone: "Oily & Redness" },
    raw: { oiliness: 81.2, moisture: 40.3, redness: 31.5 },
  },
  "outside-range": { ...SAMPLE, skinHex: "#937848" },
  "angle-up": { ...SAMPLE, toneError: "error_face_angle_upward" },
  // The tone analysis keeps running until the shopper stops waiting (a delete of it is then
  // refused once, as a running task's is), and finishes on the next poll after that.
  "slow-analyser": { ...SAMPLE, stallUntilStopped: "skin-tone-analysis" },
  "no-face": { ...SAMPLE, toneError: "error_no_face" },
});

export class FakeYouCamProvider {
  // slow:        { [feature]: polls } before that feature's tasks finish (default pollsUntilDone)
  // failCreate:  { [feature]: code } thrown when a task is created, e.g. CreditInsufficiency
  // failPoll:    { [feature]: code } thrown when a task is polled, e.g. TaskTimeout
  // rateLimitOnce: the first runTask answers 429
  // invalidKey:  every call answers 401 InvalidAccessToken
  constructor({ balance = 1000, pollsUntilDone = 1, slow = {}, failCreate = {}, failPoll = {}, rateLimitOnce = false, invalidKey = false } = {}) {
    this.mode = "fake";
    this.balance = balance;
    this.pollsUntilDone = pollsUntilDone;
    this.slow = slow;
    this.failCreate = failCreate;
    this.failPoll = failPoll;
    this.rateLimitPending = rateLimitOnce;
    this.invalidKey = invalidKey;
    this.calls = [];
    this.files = new Map();
    this.tasks = new Map();
    this.seq = 0;
  }

  #guard(method, detail) {
    this.calls.push({ method, ...detail });
    if (this.invalidKey) throw new YouCamError("InvalidAccessToken", { status: 401 });
  }

  async uploadPhoto(bytes, contentType) {
    this.#guard("uploadPhoto", { contentType, size: bytes.length });
    const { comment } = readJpegInfo(bytes);
    const name = comment?.startsWith(FAKE_TAG) ? comment.slice(FAKE_TAG.length) : "sample-shopper";
    const fileId = `fake_file_${++this.seq}`;
    this.files.set(fileId, { scenario: FAKE_SCENARIOS[name] ? name : "sample-shopper", deleted: false, contentType, size: bytes.length });
    return { fileId };
  }

  async runTask(feature, body) {
    this.#guard("runTask", { feature });
    if (this.rateLimitPending) {
      this.rateLimitPending = false;
      throw new YouCamError("RateLimited", { status: 429, feature });
    }
    if (this.failCreate[feature]) throw new YouCamError(this.failCreate[feature], { status: 400, feature });
    const file = this.files.get(body.src_file_id);
    if (!file || file.deleted) throw new YouCamError("InvalidParameters", { status: 400, feature, message: "unknown src_file_id" });
    const cost = DEFAULT_FEATURE_COSTS[feature];
    if (cost === undefined) throw new YouCamError("InvalidParameters", { status: 400, feature });
    if (this.balance < cost) throw new YouCamError("CreditInsufficiency", { status: 400, feature });
    const taskId = `fake_task_${++this.seq}`;
    this.tasks.set(taskId, { taskId, feature, fileId: body.src_file_id, body, polls: 0, status: "running", deleted: false, outcome: null });
    return { taskId };
  }

  async pollTask(feature, taskId) {
    this.#guard("pollTask", { feature, taskId });
    const t = this.tasks.get(taskId);
    if (!t || t.deleted) throw new YouCamError("InvalidTaskId", { status: 404, feature, taskId });
    if (this.failPoll[feature]) throw new YouCamError(this.failPoll[feature], { status: 500, feature, taskId });
    t.polls += 1;
    const stalled = FAKE_SCENARIOS[this.files.get(t.fileId).scenario].stallUntilStopped === feature && !t.deleteRefused;
    if (t.status === "running" && !stalled && t.polls >= (this.slow[feature] ?? this.pollsUntilDone)) this.#finish(t);
    if (t.status === "running") return { status: "running", unitsCharged: 0 };
    return { ...t.outcome };
  }

  #finish(t) {
    const scenario = FAKE_SCENARIOS[this.files.get(t.fileId).scenario];
    if (t.feature === "skin-tone-analysis" && scenario.toneError) {
      t.status = "error";
      t.outcome = { status: "error", error: scenario.toneError, unitsCharged: 0 };
      return;
    }
    const units = DEFAULT_FEATURE_COSTS[t.feature];
    this.balance -= units;
    t.status = "success";
    t.outcome = { status: "success", result: this.#result(t, scenario), unitsCharged: units };
  }

  #result(t, scenario) {
    if (t.feature === "skin-tone-analysis") {
      return { synthetic: true, color: { skin_color: scenario.skinHex }, face_quality: { ...scenario.faceQuality } };
    }
    if (t.feature === "skin-analysis") {
      const output = t.body.dst_actions.map((type) =>
        type === "skin_type"
          ? { type, ...scenario.skinType }
          : { type, ui_score: Math.min(100, Math.round(scenario.raw[type] + 12)), raw_score: scenario.raw[type], mask_urls: [] },
      );
      return { synthetic: true, output };
    }
    return { synthetic: true, url: `https://fake-results.invalid/${t.taskId}.jpg` };
  }

  async fetchResult(url) {
    this.#guard("fetchResult", { url });
    const taskId = /\/([^/]+)\.jpg$/.exec(url)?.[1];
    if (!this.tasks.has(taskId)) throw new YouCamError("InvalidTaskId", { status: 404, taskId });
    return { bytes: fakePhoto(`render:${taskId}`, { width: 768, height: 1024 }), contentType: "image/jpeg" };
  }

  async deleteTask(taskId) {
    this.#guard("deleteTask", { taskId });
    const t = this.tasks.get(taskId);
    if (!t || t.deleted) throw new YouCamError("InvalidTaskId", { status: 404, taskId });
    if (t.status === "running") {
      t.deleteRefused = true;
      throw new YouCamError("OperationInvalid", { status: 400, taskId, message: "not finished yet" });
    }
    t.deleted = true;
    // Per the docs, deleting a finished task also removes its input file.
    this.files.get(t.fileId).deleted = true;
    return { deleted: true };
  }

  async getBalance() {
    this.#guard("getBalance", {});
    return { units: this.balance };
  }

  async getFeatureCosts() {
    this.#guard("getFeatureCosts", {});
    return Object.entries(DEFAULT_FEATURE_COSTS).map(([feature, units]) => ({ feature, units }));
  }

  // Tests read the fake's side of the world through this, never through the store.
  inspect() {
    return {
      files: [...this.files].map(([fileId, f]) => ({ fileId, ...f })),
      tasks: [...this.tasks.values()].map(({ taskId, feature, status, deleted, polls }) => ({ taskId, feature, status, deleted, polls })),
    };
  }
}
