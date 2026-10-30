// Shared by the scripts that call the live YouCam API (balance, record-fixtures). The key is
// read by src/config.js from the file YOUCAM_ENV_FILE names (or ./.env), handed to the live
// provider, and never printed: these scripts print units, codes, field names and paths only.
import { loadConfig } from "../src/config.js";
import { YouCamProvider } from "../src/providers/youcam-live.js";
import { messageFor, YouCamError } from "../src/providers/errors.js";

export function liveFromConfig(command, { fetch } = {}) {
  const config = loadConfig();
  if (!config.apiKey) {
    process.stderr.write(
      `${command}: no YouCam API key is configured, so nothing was sent.\n` +
        "Put YOUCAM_API_KEY=<your key> in the env file that YOUCAM_ENV_FILE names (or ./.env); this script never asks for it.\n",
    );
    process.exit(2);
  }
  return { config, provider: new YouCamProvider({ apiKey: config.apiKey, apiBase: config.apiBase, fetch }) };
}

export function describeError(e) {
  if (!(e instanceof YouCamError)) return `${e?.name ?? "Error"}: ${e?.message ?? e}\n`;
  let text = `${e.code}${e.status ? ` (HTTP ${e.status})` : ""}: ${messageFor(e.code)}\n`;
  if (e.code === "unexpected_shape") text += `  expected: ${e.field}\n  the response's fields: ${e.outline}\n`;
  return text;
}
