// The six custom message types of the support thread: their registration objects, who may send
// each, and the content each carries. Browser-safe, no SDK and no network. record_inbound and
// every chat verb validate against this one table, so a received message and a sent one are held
// to the same shape.

import { TYPES } from "../message-types.js";

export { TYPES };

export const MAX_TEXT = 500;
// Ids and labels: case, order, draft and shade ids, a lighting label.
export const MAX_ID = 64;
export const MAX_LABEL = 32;
// A visit id: what the URL's ?visit= may carry. Plain characters only, so it is safe wherever it is shown.
export const VISIT_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const CLOSE_REASONS = Object.freeze(["resolved", "no_reply", "other"]);
// A reading is the shopper's own, unauthenticated numbers: nothing below makes it true, it only keeps
// it a plausible CIELAB colour so the ranking, the decision and every card the desk draws from it stay
// finite. L* is 0-100; a* and b* sit well inside +-200 for any real colour; h_ab is 0-360; the
// uncertainty band is 1.0 or 1.5 today and may be re-measured, so it may run from 0.1 to 10.
export const LAB_RANGE = Object.freeze({ L: [0, 100], ab: [-200, 200], hue: [0, 360], band: [0.1, 10] });
export const MAX_SHADES_IN_OFFER = 16;
export const MAX_DELTA_E = 200;

const isStr = (v) => typeof v === "string" && v.length > 0;
const isId = (v) => isStr(v) && v.length <= MAX_ID;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const within = (v, [lo, hi]) => isNum(v) && v >= lo && v <= hi;
const isText = (v) => typeof v === "string" && v.trim().length > 0 && v.length <= MAX_TEXT;
const isLab = (v) => Array.isArray(v) && v.length === 3 && within(v[0], LAB_RANGE.L) && within(v[1], LAB_RANGE.ab) && within(v[2], LAB_RANGE.ab);
const isDeltaE = (v) =>
  v === null ||
  (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length <= MAX_SHADES_IN_OFFER && Object.entries(v).every(([code, de]) => isId(code) && within(de, [0, MAX_DELTA_E])));

// fields: name → [required, test]. senders: who may send the type. counted: whether Nexconn
// counts it as unread (the registration's isCounted).
const SPECS = Object.freeze({
  [TYPES.NOTE]: {
    counted: true,
    senders: ["shopper", "staff"],
    fields: { visit: [true, isId], caseId: [false, isId], text: [true, isText], by: [false, (v) => v === "draft" || v === "staff"] },
  },
  [TYPES.RETURN_REQUEST]: {
    counted: true,
    senders: ["shopper"],
    fields: { visit: [true, isId], caseId: [true, isId], orderId: [true, isId], reason: [true, isText] },
  },
  [TYPES.READING]: {
    counted: true,
    senders: ["shopper"],
    fields: {
      visit: [true, isId],
      caseId: [true, isId],
      lab: [true, isLab],
      hueAngle: [true, (v) => within(v, LAB_RANGE.hue)],
      band: [true, (v) => within(v, LAB_RANGE.band)],
      lighting: [true, (v) => v === null || (isStr(v) && v.length <= MAX_LABEL)],
    },
  },
  [TYPES.OFFER]: {
    counted: true,
    senders: ["staff"],
    fields: {
      visit: [true, isId],
      caseId: [true, isId],
      draftId: [true, isId],
      text: [true, isText],
      resolution: [true, (v) => v === "exchange" || v === "refund"],
      shadeCode: [false, isId],
      deltaE: [true, isDeltaE],
    },
  },
  [TYPES.OFFER_ACCEPTED]: {
    counted: true,
    senders: ["shopper"],
    fields: { visit: [true, isId], caseId: [true, isId], draftId: [true, isId] },
  },
  [TYPES.CASE_CLOSED]: {
    counted: false,
    senders: ["staff"],
    fields: { visit: [true, isId], caseId: [true, isId], reason: [true, (v) => CLOSE_REASONS.includes(v)] },
  },
});

export const MESSAGE_TYPES = Object.freeze(Object.keys(SPECS));

export function isKnownType(type) {
  return typeof type === "string" && Object.hasOwn(SPECS, type);
}

export function sendersOf(type) {
  return [...SPECS[type].senders];
}

// What registerCustomMessages gets, before connect. The key names are the 26.2.1 typings'
// `CustomMessageRegistration` (isPersisted), not the docs' misspelling, which the SDK ignores
// without an error.
export function registrationObjects() {
  return MESSAGE_TYPES.map((messageType) => ({ messageType, isPersisted: true, isCounted: SPECS[messageType].counted }));
}

// { ok: true } or { ok: false, reason }. Strict: a field the type doesn't declare is refused,
// so a message can't carry anything the desk would show or act on but nobody checked.
export function validateContent(type, content, sender) {
  if (!isKnownType(type)) return { ok: false, reason: `${type} is not one of the support thread's message types` };
  if (content === null || typeof content !== "object" || Array.isArray(content)) return { ok: false, reason: "the content must be an object" };
  const spec = SPECS[type];
  if (sender !== undefined && !spec.senders.includes(sender)) {
    return { ok: false, reason: `a ${sender} may not send ${type}`, wrongSender: true };
  }
  const extra = Object.keys(content).filter((k) => !Object.hasOwn(spec.fields, k));
  if (extra.length) return { ok: false, reason: `${type} does not carry ${extra.join(", ")}` };
  for (const [name, [required, test]] of Object.entries(spec.fields)) {
    const v = content[name];
    if (v === undefined) {
      if (required) return { ok: false, reason: `${type} needs ${name}` };
      continue;
    }
    if (!test(v)) return { ok: false, reason: `${type}.${name} is not valid` };
  }
  if (type === TYPES.NOTE && content.by !== undefined) {
    if (sender === "shopper") return { ok: false, reason: "a shopper's note carries no by" };
    if (sender === "staff" && content.by !== "draft" && content.by !== "staff") return { ok: false, reason: "by must be draft or staff" };
  }
  return { ok: true };
}
