// The only module that reads the environment. Server-only: the static demo never copies it,
// so no build of the page can carry a key. The key value is returned to the caller that
// builds the live provider and is never printed, logged or put in the mode description.
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export const MODES = Object.freeze(["fake", "replay", "live"]);
export const DEFAULT_PORT = 5178;

function envFileToLoad(cwd) {
  if (process.env.YOUCAM_ENV_FILE) return resolve(cwd, process.env.YOUCAM_ENV_FILE);
  const local = resolve(cwd, ".env");
  return existsSync(local) ? local : null;
}

function intOr(value, fallback) {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isInteger(n) ? n : fallback;
}

export function loadConfig({ cwd = process.cwd() } = {}) {
  const envFile = envFileToLoad(cwd);
  if (envFile) process.loadEnvFile(envFile);
  const env = process.env;
  const requested = MODES.includes(env.YOUCAM_MODE) ? env.YOUCAM_MODE : "replay";
  const apiKey = env.YOUCAM_API_KEY?.trim() || null;
  return {
    requestedMode: requested,
    apiKey,
    apiBase: env.YOUCAM_API_BASE || "https://yce-api-01.makeupar.com",
    unitCapPerCheck: intOr(env.UNIT_CAP_PER_CHECK, 40),
    port: intOr(env.PORT, DEFAULT_PORT),
    envFileLoaded: Boolean(envFile),
  };
}
