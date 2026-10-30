import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { chooseMode, describeMode } from "../src/modes.js";
import { providerFor } from "../src/server.js";
import { YouCamProvider } from "../src/providers/youcam-live.js";
import { FakeYouCamProvider } from "../src/providers/youcam-fake.js";

const KEY = "test-only-not-a-real-key-7f3a";

test("an env file named by YOUCAM_ENV_FILE is loaded; a build without the live provider runs on sample data and says so", () => {
  const dir = mkdtempSync(join(tmpdir(), "shade-guard-config-"));
  const saved = { ...process.env };
  try {
    writeFileSync(join(dir, "test.env"), `YOUCAM_MODE=live\nYOUCAM_API_KEY=${KEY}\nPORT=5999\nUNIT_CAP_PER_CHECK=38\n`);
    process.env.YOUCAM_ENV_FILE = join(dir, "test.env");
    const config = loadConfig({ cwd: dir });
    assert.deepEqual([config.requestedMode, config.apiKey, config.port, config.unitCapPerCheck, config.envFileLoaded], ["live", KEY, 5999, 38, true]);
    const choice = chooseMode({ requested: config.requestedMode, hasKey: Boolean(config.apiKey) });
    assert.equal(choice.mode, "fake");
    const mode = describeMode(choice.mode, choice.notice);
    assert.equal(mode.label, "Sample data, not YouCam");
    assert.match(mode.notice, /sample data/);
    assert.equal(JSON.stringify(mode).includes(KEY), false, "the mode description never carries the key");
  } finally {
    process.env = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("with no env file and no key, the default request is replay, which falls back to sample data until a recording exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "shade-guard-config-"));
  const saved = { ...process.env };
  try {
    delete process.env.YOUCAM_ENV_FILE;
    delete process.env.YOUCAM_MODE;
    delete process.env.YOUCAM_API_KEY;
    const config = loadConfig({ cwd: dir });
    assert.deepEqual([config.requestedMode, config.apiKey, config.envFileLoaded], ["replay", null, false]);
    const choice = chooseMode({ requested: config.requestedMode, hasKey: false });
    assert.deepEqual(choice, { mode: "fake", notice: "No recording of the sample shopper exists yet, so the server runs on sample data." });
    assert.equal(chooseMode({ requested: "live", hasKey: false }).mode, "fake");
    assert.equal(chooseMode({ requested: "live", hasKey: true, liveAvailable: true }).mode, "live");
    assert.equal(chooseMode({ requested: "replay", hasKey: false, recordingAvailable: true }).mode, "replay");
  } finally {
    process.env = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the server runs the live provider only for YOUCAM_MODE=live with a key, and the banner names the mode without the key", () => {
  const base = { apiBase: "https://api.example.invalid", unitCapPerCheck: 40, port: 0 };
  const live = providerFor({ ...base, requestedMode: "live", apiKey: KEY });
  assert.ok(live.provider instanceof YouCamProvider);
  assert.deepEqual([live.provider.mode, live.mode.id, live.mode.badge, live.mode.notice], ["live", "live", "LIVE", null]);
  assert.match(live.mode.banner, /^Live: real YouCam API calls/);
  assert.equal(JSON.stringify([live.mode, live.provider]).includes(KEY), false);

  const noKey = providerFor({ ...base, requestedMode: "live", apiKey: null });
  assert.ok(noKey.provider instanceof FakeYouCamProvider);
  assert.deepEqual([noKey.mode.badge, noKey.mode.notice], ["FAKE", "YOUCAM_MODE is live but no YOUCAM_API_KEY is set, so the server runs on sample data."]);

  for (const requestedMode of ["fake", "replay"]) {
    const other = providerFor({ ...base, requestedMode, apiKey: KEY });
    assert.ok(other.provider instanceof FakeYouCamProvider, `${requestedMode} with a key stays off the network`);
    assert.equal(other.mode.id, "fake");
  }
});
