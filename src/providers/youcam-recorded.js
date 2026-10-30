// RecordedYouCamProvider: serves real responses recorded from live calls (the fixture recorder writes them to
// fixtures/recorded/). It never synthesizes: a request that was never recorded answers
// not_recorded, and a photo other than the recorded one answers new_photo_needs_live.
//
// A recording is { recordedAt, photo: Uint8Array, fileId, balance, featureCosts?, tasks:
// [{ feature, request, response: { status, result?, error?, unitsCharged } }], images:
// { [url]: { bytes, contentType } } }. A task's request omits src_file_id.
import { YouCamError } from "./errors.js";
import { DEFAULT_FEATURE_COSTS } from "./provider.js";

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export class RecordedYouCamProvider {
  constructor(recording) {
    this.mode = "replay";
    this.recording = recording;
    this.live = new Map(); // local task id → { index, deleted }
    this.seq = 0;
  }

  #stamp(obj) {
    return { ...obj, replay: true, recordedAt: this.recording.recordedAt };
  }

  async uploadPhoto(bytes) {
    if (!this.recording.photo || !sameBytes(bytes, this.recording.photo)) {
      throw new YouCamError("new_photo_needs_live");
    }
    return this.#stamp({ fileId: this.recording.fileId });
  }

  async runTask(feature, body) {
    const { src_file_id: fileId, ...request } = body;
    if (fileId !== this.recording.fileId) throw new YouCamError("not_recorded", { feature });
    const key = stable(request);
    const index = this.recording.tasks.findIndex((t) => t.feature === feature && stable(t.request) === key);
    if (index < 0) throw new YouCamError("not_recorded", { feature });
    const taskId = `replay_task_${++this.seq}`;
    this.live.set(taskId, { index, deleted: false });
    return this.#stamp({ taskId });
  }

  async pollTask(feature, taskId) {
    const t = this.live.get(taskId);
    if (!t || t.deleted) throw new YouCamError("InvalidTaskId", { status: 404, feature, taskId });
    return this.#stamp(structuredClone(this.recording.tasks[t.index].response));
  }

  async fetchResult(url) {
    const image = this.recording.images?.[url];
    if (!image) throw new YouCamError("not_recorded");
    return this.#stamp({ bytes: image.bytes, contentType: image.contentType });
  }

  async deleteTask(taskId) {
    const t = this.live.get(taskId);
    if (!t || t.deleted) throw new YouCamError("InvalidTaskId", { status: 404, taskId });
    t.deleted = true;
    return this.#stamp({ deleted: true });
  }

  // The recorded photo, so the page can offer the one photo this recording answers for.
  samplePhoto() {
    return { bytes: this.recording.photo, contentType: "image/jpeg", recordedAt: this.recording.recordedAt };
  }

  async getBalance() {
    return this.#stamp({ units: this.recording.balance });
  }

  async getFeatureCosts() {
    const costs = this.recording.featureCosts ?? DEFAULT_FEATURE_COSTS;
    return Object.entries(costs).map(([feature, units]) => ({ feature, units }));
  }
}
