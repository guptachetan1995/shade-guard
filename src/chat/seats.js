// A seat is one desk user and two shopper users: the demo's fixed pool is four seats, twelve
// user ids (a visit picks one seat). Each seat's desk inbox holds two channels, one per shopper,
// so each return case keeps its own thread and unread count. The shape is the one the token
// script writes to the seats file, so the fake pool and the real one are read the same way.
// Browser-safe.

export const SEAT_COUNT = 4;

// The two fictional shoppers match the fictional orders and return cases in fixtures/returns.json.
export const SHOPPER_PROFILES = Object.freeze([
  Object.freeze({ name: "Maya (fictional shopper, O-5521)", caseId: "R-104", orderId: "O-5521" }),
  Object.freeze({ name: "Asha (fictional shopper, O-5530)", caseId: "R-107", orderId: "O-5530" }),
]);

export const DESK_NAME = "Shade Guard desk (demo)";

// Ids the offline fake hands out. They are plainly fake: the real ones are minted by the token
// script, one random id each.
export function fakeSeats(count = SEAT_COUNT) {
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    return {
      n,
      deskUserId: `fakedesk${n}`,
      shoppers: SHOPPER_PROFILES.map((p, k) => ({ userId: `fakeshop${n}${"ab"[k]}`, ...p })),
    };
  });
}

export function seatOf(seats, n) {
  return seats.find((s) => s.n === n) ?? null;
}

// Who is who for one side of one seat. The desk sees both shoppers; a shopper sees only the
// desk, and only herself.
export function sessionFor({ seat, side, as = 0 }) {
  if (side === "desk") {
    return {
      side,
      seat: seat.n,
      selfUserId: seat.deskUserId,
      deskUserId: seat.deskUserId,
      peers: Object.fromEntries(seat.shoppers.map((s) => [s.userId, { role: "shopper", caseId: s.caseId, orderId: s.orderId, name: s.name }])),
    };
  }
  if (side === "shopper") {
    const me = seat.shoppers[as];
    if (!me) throw new RangeError(`seat ${seat.n} has no shopper ${as}`);
    return {
      side,
      seat: seat.n,
      selfUserId: me.userId,
      deskUserId: seat.deskUserId,
      peers: { [seat.deskUserId]: { role: "staff", caseId: me.caseId, orderId: me.orderId, name: "Shade Guard desk (demo)" } },
      me: { userId: me.userId, caseId: me.caseId, orderId: me.orderId, name: me.name },
    };
  }
  throw new RangeError(`side must be desk or shopper, not ${side}`);
}

// ---------------------------------------------------------------------------------------
// The Nexconn seats file (written by scripts/nexconn-tokens.js), as the page reads it: served by the
// local server, or copied into a Pages build. It holds the App Key (not secret), the area and each
// seat's user ids and demo tokens; never the App Secret. Read strictly: a field this table does not
// name is refused, so nothing unexamined is ever served or copied.

export const NEXCONN_AREAS = Object.freeze(["SG", "NA", "SAU"]);
const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const APP_KEY = /^[\x21-\x7e]{1,128}$/;
const MAX_TOKEN = 1024;
const MAX_SEATS = 10;

const only = (obj, keys, what) => {
  const extra = Object.keys(obj).filter((k) => !keys.includes(k));
  if (extra.length) throw new RangeError(`the seats file's ${what} carries ${extra.join(", ")}, which it may not`);
};
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// json: the parsed seats file. Returns { kind: "nexconn", appKey, area, seats, tokens } with seats in
// the shape fakeSeats() returns and tokens as one { userId: token } map; throws a RangeError naming
// what is wrong (never a token).
export function parseNexconnSeats(json) {
  if (!isObject(json)) throw new RangeError("the seats file is not an object");
  only(json, ["appKey", "area", "seats"], "top level");
  if (typeof json.appKey !== "string" || !APP_KEY.test(json.appKey)) throw new RangeError("the seats file's appKey is not a plain App Key");
  if (!NEXCONN_AREAS.includes(json.area)) throw new RangeError(`the seats file's area must be one of ${NEXCONN_AREAS.join(", ")}`);
  if (!Array.isArray(json.seats) || json.seats.length < 1 || json.seats.length > MAX_SEATS) throw new RangeError(`the seats file needs 1 to ${MAX_SEATS} seats`);
  const ids = new Set();
  const numbers = new Set();
  const tokens = {};
  const seats = json.seats.map((s, i) => {
    if (!isObject(s)) throw new RangeError(`seat ${i + 1} is not an object`);
    only(s, ["n", "deskUserId", "shoppers", "tokens"], `seat ${i + 1}`);
    if (!Number.isInteger(s.n) || s.n < 1 || s.n > MAX_SEATS || numbers.has(s.n)) throw new RangeError(`seat ${i + 1} has no unique number from 1 to ${MAX_SEATS}`);
    numbers.add(s.n);
    if (!Array.isArray(s.shoppers) || s.shoppers.length !== SHOPPER_PROFILES.length) throw new RangeError(`seat ${s.n} needs exactly ${SHOPPER_PROFILES.length} shoppers`);
    const shoppers = s.shoppers.map((p, k) => {
      if (!isObject(p)) throw new RangeError(`seat ${s.n} shopper ${k + 1} is not an object`);
      only(p, ["userId", "name", "caseId", "orderId"], `seat ${s.n} shopper ${k + 1}`);
      const profile = SHOPPER_PROFILES[k];
      if (p.caseId !== profile.caseId || p.orderId !== profile.orderId || p.name !== profile.name) {
        throw new RangeError(`seat ${s.n} shopper ${k + 1} must be ${profile.name}, case ${profile.caseId}, order ${profile.orderId}`);
      }
      return { userId: p.userId, ...profile };
    });
    const users = [s.deskUserId, ...shoppers.map((p) => p.userId)];
    if (!isObject(s.tokens)) throw new RangeError(`seat ${s.n} has no tokens`);
    only(s.tokens, users.filter((u) => typeof u === "string"), `seat ${s.n} tokens`);
    for (const u of users) {
      if (typeof u !== "string" || !USER_ID.test(u)) throw new RangeError(`seat ${s.n} has a user id that is not 1-64 letters, digits, dashes or underscores`);
      if (ids.has(u)) throw new RangeError(`user id ${u} appears twice in the seats file`);
      ids.add(u);
      const t = s.tokens[u];
      if (typeof t !== "string" || t.length === 0 || t.length > MAX_TOKEN) throw new RangeError(`seat ${s.n} has no usable token for ${u}`);
      tokens[u] = t;
    }
    return { n: s.n, deskUserId: s.deskUserId, shoppers };
  });
  return { kind: "nexconn", appKey: json.appKey, area: json.area, seats, tokens };
}

// The seats file again, from a parsed config: what the Pages build writes (only the fields above).
export function seatsFileOf(config) {
  return {
    appKey: config.appKey,
    area: config.area,
    seats: config.seats.map((s) => ({ n: s.n, deskUserId: s.deskUserId, shoppers: s.shoppers.map((p) => ({ ...p })), tokens: Object.fromEntries([s.deskUserId, ...s.shoppers.map((p) => p.userId)].map((u) => [u, config.tokens[u]])) })),
  };
}
