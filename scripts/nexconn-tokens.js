// npm run nexconn:tokens -- --seats 4 [--check]
// Mints one desk user and two shopper users per seat on the Nexconn server API, with
// non-sequential ids and fictional names, and writes the seats file (mode 600) the pages read.
// It prints the App Key, the user ids and each token's length, and never the App Secret or a token.
// --check signs POST /v4/user/get for every seat id and prints only whether each exists.
// --scan <dir> reads the App Secret from the env file and names every file under <dir> whose bytes
// hold its value (file names only, never the value); it fails on a hit, and when the env file can't
// be read. The Pages build runs the same scan on itself whenever it copies the seats file in.
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultNexconnSeatsFile, loadNexconnConfig, NexconnConfigError } from "../src/config.js";
import { DESK_NAME, SHOPPER_PROFILES } from "../src/chat/seats.js";
import { ApiError, basesFor, callApi, gitTreeOf, parseFlags, readSeatsFile } from "./nexconn-api.js";
export const FLAGS = Object.freeze(["--check", "--seats", "--env-file", "--seats-file", "--base", "--backup-base", "--scan"]);
const id = (prefix) => `${prefix}${randomBytes(4).toString("hex")}`;

// The seats file holds tokens, and publish.sh and `git add -A` take everything in a work tree: it
// must live outside every git work tree, not merely outside this entry's folder.
function seatsFileOutsideTheRepo(path) {
  if (gitTreeOf(path)) throw new ApiError("seats_file_in_repo", "The seats file holds tokens and must live outside the repository, and outside every git work tree.");
  return path;
}

// Every file under dir whose bytes hold the secret, as paths relative to dir (symbolic links are not
// followed), and how many files were read. The value itself is never returned or printed.
export function filesHoldingSecret(dir, secret) {
  const root = resolve(dir);
  const needle = Buffer.from(secret, "utf8");
  const hits = [];
  let scanned = 0;
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) {
        scanned += 1;
        if (readFileSync(p).includes(needle)) hits.push(relative(root, p).split("\\").join("/"));
      }
    }
  };
  walk(root);
  return { hits: hits.sort(), scanned };
}

function scan({ dir, secret, out, err }) {
  if (!existsSync(dir)) throw new ApiError("bad_flag", `--scan: no folder at ${dir}.`);
  const { hits, scanned } = filesHoldingSecret(dir, secret);
  if (hits.length) {
    err(`The App Secret's value appears in ${hits.length} file(s) under ${dir}:\n${hits.map((h) => `  ${h}\n`).join("")}`);
    return 1;
  }
  out(`No file under ${dir} holds the App Secret's value (${scanned} file${scanned === 1 ? "" : "s"} scanned).\n`);
  return 0;
}

export async function run(argv, { out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s) } = {}) {
  try {
    const flags = parseFlags(argv, FLAGS, "nexconn:tokens");
    const config = loadNexconnConfig({ envFile: flags.envFile });
    if (flags.scan) return scan({ dir: flags.scan, secret: config.secret, out, err });
    const seatsFile = seatsFileOutsideTheRepo(flags.seatsFile ?? defaultNexconnSeatsFile());
    const bases = basesFor(config, flags);
    const call = (path, body) => callApi({ bases, path, body, appKey: config.appKey, secret: config.secret });
    if (flags.check) return await check({ call, seatsFile, config, out, err });
    const count = flags.seats ?? 4;
    if (!Number.isInteger(count) || count < 1 || count > 10) throw new ApiError("bad_flag", "--seats must be 1 to 10.");
    if (existsSync(seatsFile)) throw new ApiError("seats_file_exists", `${seatsFile} already exists; expire its tokens and remove it first, so a seat is never minted twice.`);
    const seats = [];
    for (let n = 1; n <= count; n++) {
      const seat = { n, deskUserId: id("sgdesk"), shoppers: SHOPPER_PROFILES.map((p) => ({ userId: id("sgshop"), ...p })), tokens: {} };
      const users = [{ userId: seat.deskUserId, name: DESK_NAME }, ...seat.shoppers.map((s) => ({ userId: s.userId, name: s.name }))];
      for (const u of users) {
        const r = await call("/v4/auth/access-token/issue", { userId: u.userId, name: u.name });
        if (r.code !== 0 || typeof r.body?.result?.accessToken !== "string") throw new ApiError("issue_failed", `issuing ${u.userId} answered ${r.code}`);
        seat.tokens[u.userId] = r.body.result.accessToken;
      }
      seats.push(seat);
    }
    mkdirSync(dirname(seatsFile), { recursive: true });
    writeFileSync(seatsFile, `${JSON.stringify({ appKey: config.appKey, area: config.area, seats }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(seatsFile, 0o600);
    out(`App Key: ${config.appKey} (area ${config.area})\n`);
    for (const s of seats) {
      out(`seat ${s.n}: ${[s.deskUserId, ...s.shoppers.map((p) => p.userId)].map((u) => `${u} (token length ${s.tokens[u].length})`).join(", ")}\n`);
    }
    out(`seats file written, mode 600: ${seatsFile}\n`);
    return 0;
  } catch (e) {
    if (!(e instanceof ApiError || e instanceof NexconnConfigError)) throw e;
    err(`${e.message}\n`);
    return 1;
  }
}

async function check({ call, seatsFile, config, out, err }) {
  if (!existsSync(seatsFile)) throw new ApiError("no_seats_file", `No seats file at ${seatsFile}; mint the seats first.`);
  const file = readSeatsFile(seatsFile);
  if (file.appKey !== config.appKey) throw new ApiError("wrong_app", "The seats file belongs to a different App Key.");
  let missing = 0;
  for (const s of file.seats) {
    for (const userId of [s.deskUserId, ...s.shoppers.map((p) => p.userId)]) {
      const r = await call("/v4/user/get", { userId });
      const exists = r.code === 0;
      if (!exists) missing += 1;
      out(`${userId}: ${exists ? "exists" : `not found (answer ${r.code})`}\n`);
    }
  }
  if (missing) err(`${missing} seat id(s) are not registered.\n`);
  return missing ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
