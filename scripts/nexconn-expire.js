// npm run nexconn:expire [-- --dry-run]
// Expires the access tokens issued to every seat id, as of now, 20 ids a request. Prints the ids
// and the service's answer codes, never a token or the App Secret. Expiring a token does not end
// a connection already open with it; a reconnect then fails, so the live demo's chat stops.
// --dry-run lists the ids and requests it would make and sends nothing. There is no --check: any
// flag this script does not take is refused, never ignored.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultNexconnSeatsFile, loadNexconnConfig, NexconnConfigError } from "../src/config.js";
import { ApiError, basesFor, callApi, parseFlags, readSeatsFile } from "./nexconn-api.js";

export const IDS_PER_REQUEST = 20;
export const FLAGS = Object.freeze(["--env-file", "--seats-file", "--base", "--backup-base", "--dry-run"]);

export async function run(argv, { out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s), now = () => Date.now() } = {}) {
  try {
    const flags = parseFlags(argv, FLAGS, "nexconn:expire");
    const config = loadNexconnConfig({ envFile: flags.envFile });
    const seatsFile = flags.seatsFile ?? defaultNexconnSeatsFile();
    if (!existsSync(seatsFile)) throw new ApiError("no_seats_file", `No seats file at ${seatsFile}; nothing to expire.`);
    const file = readSeatsFile(seatsFile);
    const ids = file.seats.flatMap((s) => [s.deskUserId, ...s.shoppers.map((p) => p.userId)]);
    const requestsNeeded = Math.ceil(ids.length / IDS_PER_REQUEST);
    if (flags.dryRun) {
      out(`${ids.join(", ")}\n`);
      out(`dry run: would expire ${ids.length} id(s) in ${requestsNeeded} request(s); nothing was sent\n`);
      return 0;
    }
    const bases = basesFor(config, flags);
    const expiresAt = now();
    let failed = 0;
    for (let i = 0; i < ids.length; i += IDS_PER_REQUEST) {
      const batch = ids.slice(i, i + IDS_PER_REQUEST);
      const r = await callApi({ bases, path: "/v4/auth/access-token/expire", body: { userIds: batch, expiresAt }, appKey: config.appKey, secret: config.secret });
      if (r.code !== 0) failed += 1;
      out(`${batch.join(", ")}: answer ${r.code}\n`);
    }
    out(`${ids.length} id(s) in ${requestsNeeded} request(s), expiresAt ${expiresAt}\n`);
    return failed ? 1 : 0;
  } catch (e) {
    if (!(e instanceof ApiError || e instanceof NexconnConfigError)) throw e;
    err(`${e.message}\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
