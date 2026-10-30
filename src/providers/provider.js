// The interface every provider implements (fake, recorded replay, live):
//
//   uploadPhoto(bytes, contentType)  → { fileId }
//   runTask(feature, body)           → { taskId }
//   pollTask(feature, taskId)        → { status: "running" | "success" | "error", result?, error?, unitsCharged }
//   fetchResult(url)                 → { bytes, contentType }
//   deleteTask(taskId)               → { deleted: true }
//   getBalance()                     → { units }
//   getFeatureCosts()                → [{ feature, units }]
//
// Query errors (a refused key, an unknown task, 429, a running task on delete) throw a
// YouCamError. Engine errors on a task come back as status "error" with the error code.

export const FEATURES = Object.freeze(["skin-tone-analysis", "skin-analysis", "makeup-vto"]);

// The documented unit costs, used when the feature-cost endpoint can't be read.
export const DEFAULT_FEATURE_COSTS = Object.freeze({
  "skin-tone-analysis": 20,
  "skin-analysis": 9, // SD, 1–4 concerns
  "makeup-vto": 1,
});

export const PROVIDER_METHODS = Object.freeze([
  "uploadPhoto",
  "runTask",
  "pollTask",
  "fetchResult",
  "deleteTask",
  "getBalance",
  "getFeatureCosts",
]);

export function assertProvider(p) {
  const missing = PROVIDER_METHODS.filter((m) => typeof p?.[m] !== "function");
  if (missing.length) throw new TypeError(`provider is missing ${missing.join(", ")}`);
  if (!["fake", "replay", "live", "live-own-key"].includes(p.mode)) {
    throw new TypeError(`provider mode must be fake, replay, live or live-own-key; got ${p.mode}`);
  }
  return p;
}

export async function loadFeatureCosts(provider) {
  const costs = { ...DEFAULT_FEATURE_COSTS };
  try {
    for (const { feature, units } of await provider.getFeatureCosts()) {
      if (FEATURES.includes(feature) && Number.isInteger(units) && units >= 0) costs[feature] = units;
    }
  } catch {
    // The documented table above stands in when the free cost endpoint can't be read.
  }
  return Object.freeze(costs);
}
