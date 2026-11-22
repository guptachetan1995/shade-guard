// The only module that reads the environment. Server-only: the static demo never copies it,
// so no build of the page can carry a key. The key value is returned to the caller that
// builds the live provider and is never printed, logged or put in the mode description.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { parseNexconnSeats } from "./chat/seats.js";

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

// ---------------------------------------------------------------------------------------
// The Nexconn side. The App Key is not secret; the App Secret is, and it only ever reaches the
// token scripts, which sign requests with it. It is never returned from a describe, printed or
// served.

// The hosts the server API answers on, by the data centre the app was created in (Nexconn's
// base-URL documentation page, read 6 Nov 2026): the primary, then the backup.
export const NEXCONN_HOSTS = Object.freeze({
  SG: Object.freeze(["api.sg-light-api.com", "api-b.sg-light-api.com"]),
  NA: Object.freeze(["api.us-light-api.com", "api-b.us-light-api.com"]),
  SAU: Object.freeze(["api.sau-light-api.com", "api-b.sau-light-api.com"]),
});

export const defaultNexconnEnvFile = () => join(homedir(), ".config", "shade-guard", "nexconn.env");

export class NexconnConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// envFile: where the four NEXCONN_ names live (default: NEXCONN_ENV_FILE, else the file under
// ~/.config). The file is parsed, not loaded: nothing is added to process.env.
export function loadNexconnConfig({ envFile = process.env.NEXCONN_ENV_FILE || defaultNexconnEnvFile() } = {}) {
  let text;
  try {
    text = readFileSync(envFile, "utf8");
  } catch {
    throw new NexconnConfigError("no_env_file", `No env file at ${envFile}.`);
  }
  const env = parseEnv(text);
  const appKey = env.NEXCONN_APP_KEY?.trim();
  const area = env.NEXCONN_AREA?.trim();
  const host = env.NEXCONN_API_HOST?.trim();
  const secret = env.NEXCONN_APP_SECRET?.trim();
  if (!appKey) throw new NexconnConfigError("no_app_key", "NEXCONN_APP_KEY is empty.");
  if (!secret) throw new NexconnConfigError("no_app_secret", "NEXCONN_APP_SECRET is empty.");
  const hosts = NEXCONN_HOSTS[area];
  if (!hosts) throw new NexconnConfigError("bad_area", `NEXCONN_AREA must be one of ${Object.keys(NEXCONN_HOSTS).join(", ")}.`);
  if (!hosts.includes(host)) throw new NexconnConfigError("host_not_allowed", `${host} is not the primary or backup host of area ${area}.`);
  const backup = hosts.find((h) => h !== host);
  return { appKey, area, host, backupHost: backup, secret };
}

// The seats file scripts/nexconn-tokens.js writes (the demo users' ids and tokens), outside every git
// work tree. The local server serves the one NEXCONN_SEATS_FILE names, else this default; the Pages
// build copies one only when NEXCONN_SEATS_FILE is set, so no build picks up tokens by accident.
export const defaultNexconnSeatsFile = () => join(homedir(), ".config", "shade-guard", "nexconn-seats.json");

export function nexconnSeatsFileSetting() {
  return process.env.NEXCONN_SEATS_FILE?.trim() || null;
}

// The seats file a Pages build copies in. Tokens go into a public build only on two explicit
// settings, NEXCONN_SEATS_FILE and NEXCONN_PUBLISH_TOKENS=1, so a NEXCONN_SEATS_FILE exported for
// npm start can't put tokens into the gh-pages history on its own. held: a file was named but not
// published.
export function pagesSeatsSetting() {
  const file = nexconnSeatsFileSetting();
  if (!file) return { file: null, held: false };
  return process.env.NEXCONN_PUBLISH_TOKENS === "1" ? { file, held: false } : { file: null, held: true };
}

// The parsed seats config (src/chat/seats.js parseNexconnSeats), or a NexconnConfigError. A parse
// failure never quotes the file: it holds tokens.
export function readNexconnSeats(path) {
  let json;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new NexconnConfigError("seats_file_invalid", `The seats file at ${path} could not be read as JSON.`);
  }
  try {
    return parseNexconnSeats(json);
  } catch (e) {
    throw new NexconnConfigError("seats_file_invalid", `The seats file at ${path} is not valid: ${e.message}.`);
  }
}
