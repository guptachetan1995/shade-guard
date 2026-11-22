// Signed calls to the Nexconn server API, shared by the token and expire scripts. Node built-ins
// only. The signature is sha1(AppSecret + Nonce + Timestamp) in hex, sent with the App Key, the
// nonce and the timestamp in ms as headers (a reading of Nexconn's API request-signature page,
// 6 Nov 2026). The secret is used here and nowhere is it returned, printed or logged.
//
// Checked against the real service on Sun 22 Nov 2026 (Singapore): every call answers HTTP 200 with a
// body `code` of 0 on success. The issue call answers `{ code: 0, result: { userId, accessToken } }`;
// a user lookup answers `code: 0` for a known user and `code: 400` for an unknown one; the expire
// call answers `{ code: 0 }`. The request bodies (`userId`, `name`, `userIds`, `expiresAt`) were
// accepted as sent. The offline fake signer mirrors these answers.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export function signHeaders({ appKey, secret, nonce = randomBytes(8).toString("hex"), timestamp = Date.now() }) {
  const signature = createHash("sha1").update(`${secret}${nonce}${timestamp}`).digest("hex");
  return { "App-Key": appKey, Nonce: nonce, Timestamp: String(timestamp), Signature: signature };
}

// The seats file the token script writes and the expire and check paths read. It holds tokens, so a
// parse failure says only that it is not valid: node's own SyntaxError quotes the offending line.
export function readSeatsFile(path) {
  let file;
  try {
    file = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new ApiError("seats_file_invalid", `The seats file at ${path} is not valid JSON.`);
  }
  const ok = file !== null && typeof file === "object" && Array.isArray(file.seats) && file.seats.every((s) => typeof s?.deskUserId === "string" && Array.isArray(s.shoppers) && s.shoppers.every((p) => typeof p?.userId === "string"));
  if (!ok) throw new ApiError("seats_file_invalid", `The seats file at ${path} is not valid: it needs a seats list of desk and shopper user ids.`);
  return file;
}

// The directory of the git work tree a path would land in, or null when it is outside every one: the
// nearest existing ancestor (symlinks resolved) and each one above it, looking for a .git, which is a
// folder in a clone and a file in a linked worktree.
export function gitTreeOf(path) {
  let dir = resolve(path);
  while (!existsSync(dir)) dir = dirname(dir);
  dir = realpathSync(dir);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export class ApiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// bases: the primary base URL, then the backup. A timeout or a refused connection retries once on
// the backup; a 401 does not retry, it says the signature was refused.
export async function callApi({ bases, path, body, appKey, secret, fetchImpl = fetch, timeoutMs = 8000 }) {
  let lastError = null;
  for (const base of bases) {
    let res;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...signHeaders({ appKey, secret }) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      lastError = new ApiError("unreachable", `${new URL(base).host} did not answer`);
      continue;
    }
    if (res.status === 401) throw new ApiError("signature_refused", "signature refused");
    let json = null;
    try {
      json = await res.json();
    } catch {
      // not JSON: the status alone speaks
    }
    return { status: res.status, body: json, code: json?.code ?? res.status };
  }
  throw lastError ?? new ApiError("unreachable", "no host answered");
}

// Base URLs for a loaded config. A test points the scripts at a local fake signer with --base
// (and --backup-base); only a 127.0.0.1 URL is accepted, so the flag can't aim a real secret at
// another host.
export function basesFor(config, flags) {
  if (flags.base) {
    for (const b of [flags.base, flags.backupBase].filter(Boolean)) {
      if (new URL(b).hostname !== "127.0.0.1") throw new ApiError("base_not_local", "--base and --backup-base accept only a 127.0.0.1 URL (the offline fake signer).");
    }
    return [flags.base, flags.backupBase ?? flags.base];
  }
  return [`https://${config.host}`, `https://${config.backupHost}`];
}

// The flags that take a value, and the key each sets. A value that is missing, empty or itself a
// flag is refused: a lost value must never turn one mode into another (a --scan without its folder
// became a mint run), or let a bare --base fall back to the real hosts.
const VALUE_FLAGS = Object.freeze({ "--seats": "seats", "--env-file": "envFile", "--seats-file": "seatsFile", "--base": "base", "--backup-base": "backupBase", "--scan": "scan" });
const SWITCHES = Object.freeze({ "--check": "check", "--dry-run": "dryRun" });
// What to say when a script is handed a flag it does not take, where a wrong guess is costly.
const NOT_HERE = Object.freeze({ "nexconn:expire": "it has no dry check; --dry-run lists what it would expire and sends nothing" });

// allowed: the flags this script takes; anything else is refused, never ignored (an expire run handed
// --check, expecting a dry check, would otherwise expire every seat's tokens).
export function parseFlags(argv, allowed, script = "this script") {
  const flags = { check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!SWITCHES[a] && !VALUE_FLAGS[a]) throw new ApiError("bad_flag", `unknown argument ${a}`);
    if (!allowed.includes(a)) throw new ApiError("bad_flag", `${a} is not an option of ${script}${NOT_HERE[script] ? `: ${NOT_HERE[script]}` : ""}`);
    if (SWITCHES[a]) {
      flags[SWITCHES[a]] = true;
      continue;
    }
    const v = argv[i + 1];
    if (v === undefined || v === "" || v.startsWith("--")) throw new ApiError("bad_flag", `${a} needs a value`);
    i += 1;
    flags[VALUE_FLAGS[a]] = VALUE_FLAGS[a] === "seats" ? Number.parseInt(v, 10) : v;
  }
  if (flags.backupBase && !flags.base) throw new ApiError("bad_flag", "--backup-base needs --base (both point at the offline fake signer); alone it would leave the real hosts in place");
  return flags;
}
