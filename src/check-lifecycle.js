// Closing a check is policy, not a verb: once every line has an outcome, once a return-flow
// check's resolution is drafted, or after 15 minutes idle. Closing deletes every YouCam task
// the check created (which per the docs also removes the uploaded photo), confirms each
// deletion with a status read, drops the cached photo and renders, and writes the receipt.
import { YouCamError } from "./providers/errors.js";

export const IDLE_CLOSE_MS = 15 * 60 * 1000;
// After a task has run this long the page says "still working" and the shopper may stop
// waiting (§6: the docs suggest polling about every 10 s, and there is no hard give-up).
export const STILL_WORKING_MS = 90 * 1000;

// The check's tasks that have been running for STILL_WORKING_MS or more at nowIso.
export function stillWorkingTasks(check, nowIso) {
  return check.tasks.filter((t) => t.status === "running" && Date.parse(nowIso) - Date.parse(t.startedAt) >= STILL_WORKING_MS);
}
const TERMINAL_DRAFTS = new Set(["retake", "unavailable"]);

export function lineSettled(line) {
  return Boolean(line.outcome) || (line.draft && TERMINAL_DRAFTS.has(line.draft.decision));
}

export function cartCheckSettled(check) {
  return check.origin.from === "cart" && Object.values(check.lines).every(lineSettled);
}

// A return-flow check whose line ended in retake or unavailable will never draft a
// resolution, so it closes there; otherwise the shopper's next photo would wait 15 minutes.
export function returnCheckDeadEnded(check) {
  return check.origin.from === "return" && Object.values(check.lines).every((l) => l.draft && TERMINAL_DRAFTS.has(l.draft.decision));
}

// A provider that can finish a task in the background (the live one) polls it at its own
// cadence and deletes it when it ends; the receipt is rewritten then. Others are settled by
// settlePendingDeletes on the server's tick.
function handOver(store, provider, check, task) {
  if (typeof provider.finishInBackground !== "function" || task.background) return;
  task.background = true;
  provider
    .finishInBackground(task.feature, task.taskId)
    .then((r) => {
      if (r.deleted && r.confirmed) {
        task.deletedAt = store.now();
        task.pending = false;
      } else if (r.error) task.lastError = r.error;
    })
    .catch((e) => {
      task.lastError = e instanceof YouCamError ? e.code : "background_failed";
    })
    .finally(() => {
      task.background = false;
      writeReceipt(store, check);
    });
}

async function deleteAndConfirm(store, provider, check, task) {
  if (task.deletedAt) return;
  try {
    await provider.deleteTask(task.taskId);
  } catch (e) {
    if (!(e instanceof YouCamError)) throw e;
    if (e.code === "OperationInvalid") {
      // A running task can't be deleted; it is polled to the end and deleted then.
      task.pending = true;
      handOver(store, provider, check, task);
      return;
    }
    if (e.code !== "InvalidTaskId") {
      task.pending = true;
      task.lastError = e.code;
      return;
    }
  }
  try {
    await provider.pollTask(task.feature, task.taskId);
    task.pending = true; // still readable, so the deletion is not confirmed
  } catch (e) {
    if (!(e instanceof YouCamError) || e.code !== "InvalidTaskId") throw e;
    task.deletedAt = store.now();
    task.pending = false;
  }
}

function photoFate(check, pending) {
  if (!check.fileId) {
    return {
      photoOnYouCam: "never_uploaded",
      note: "Your photo was never sent for analysis, and this store's copy is deleted.",
    };
  }
  if (check.tasks.length === 0) {
    return {
      photoOnYouCam: "kept_up_to_30_days",
      note:
        `Your photo was uploaded, but no analysis started (${check.uploadOnlyReason ?? "unknown reason"}). ` +
        "The YouCam API has no way to delete an uploaded photo that no task used, so it stays on YouCam's servers for up to 30 days.",
    };
  }
  if (pending > 0) {
    return {
      photoOnYouCam: "pending",
      note: `${pending} analysis task${pending === 1 ? " is" : "s are"} still finishing; each is deleted, with your photo, as soon as it ends.`,
    };
  }
  return {
    photoOnYouCam: "deleted_with_tasks",
    note: "Every analysis task was deleted on YouCam's servers, which removes the uploaded photo, and this store's copy is deleted.",
  };
}

function writeReceipt(store, check) {
  const deleted = check.tasks.filter((t) => t.deletedAt).length;
  const pending = check.tasks.length - deleted;
  check.privacyReceipt = {
    deletedTasks: deleted,
    pending,
    confirmedAt: pending === 0 ? store.now() : null,
    localPhotoDropped: true,
    ...photoFate(check, pending),
  };
}

export async function closeCheck(store, provider, check, reason) {
  if (check.status === "closed") return check.privacyReceipt;
  check.status = "closed";
  check.closedAt = store.now();
  check.closeReason = reason;
  store.blobs.delete(check.checkId);
  for (const task of check.tasks) await deleteAndConfirm(store, provider, check, task);
  writeReceipt(store, check);
  return check.privacyReceipt;
}

// Polls each pending task of a closed check; a finished one is deleted and confirmed.
export async function settlePendingDeletes(store, provider) {
  for (const check of store.state.checks.filter((c) => c.status === "closed")) {
    const pending = check.tasks.filter((t) => !t.deletedAt && !t.background);
    if (!pending.length) continue;
    for (const task of pending) {
      try {
        const r = await provider.pollTask(task.feature, task.taskId);
        if (r.status === "running") continue;
      } catch (e) {
        if (!(e instanceof YouCamError)) throw e;
        if (e.code !== "InvalidTaskId") continue;
      }
      await deleteAndConfirm(store, provider, check, task);
    }
    writeReceipt(store, check);
  }
}

export async function closeIdleChecks(store, provider, nowMs = Date.now()) {
  for (const check of store.state.checks.filter((c) => c.status === "open")) {
    if (nowMs - Date.parse(check.lastActivityAt) >= IDLE_CLOSE_MS) await closeCheck(store, provider, check, "idle");
  }
}
