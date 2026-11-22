// The agent's two tools for the support thread. They read the thread as the store recorded it and
// write a reply draft for staff; they hold no chat transport (a tool's context has none), so
// nothing here can send, accept, approve or close. The reply text is composed in code from the
// reading's own numbers: the agent never writes a sentence, and a figure in a draft is a figure
// the reading carries.
import { NO_GOOD_MATCH } from "./rules/recommend.js";
import { fingerprintOf, isClosed, messageView, newestMessage } from "./threads.js";
import { TYPES } from "./message-types.js";
import { refuse } from "./refusal.js";

const CITE_TOLERANCE = 0.05 + 1e-9;
const REPLY_KINDS = ["exchange_offer", "sample_offer", "refund_offer", "check_invite"];
const cites = (cited, actual) => typeof cited === "number" && Math.abs(cited - actual) <= CITE_TOLERANCE;
const f2 = (n) => Number(n).toFixed(2);
const f1 = (n) => Number(n).toFixed(1);

function mustCase(store, caseId) {
  const rcase = store.getCase(caseId);
  if (!rcase) refuse("unknown_case", `No return case ${caseId} exists.`);
  return rcase;
}

const read_thread = {
  name: "read_thread",
  description:
    "Read one return case's support thread as it was recorded from the chat service: for each message its id, sender (shopper or staff), type, the service's own send time in milliseconds, and its content. The types are SG:Note (words), SG:ReturnRequest, SG:Reading (the shopper's shade reading as numbers), SG:Offer (staff's offer, with the draft it sent), SG:OfferAccepted and SG:CaseClosed. Also says whether the case was closed, and any message the desk answered without having seen (crossed). " +
    "Does NOT send anything, mark anything read, or call the chat service: it reads the store's record. Does NOT show a photo: none is ever in a thread, and a reading is numbers only. Does NOT interpret the shopper's words: free text comes back as written and decides nothing by itself.",
  args: { caseId: { type: "string", required: true, description: "The return case, e.g. R-104." } },
  run({ caseId }, { store }) {
    mustCase(store, caseId);
    const thread = store.state.threads[caseId];
    return {
      caseId,
      closed: isClosed(thread),
      crossed: structuredClone(thread?.crossed ?? []),
      messages: (thread?.messages ?? []).map(messageView),
    };
  },
};

function mustOpen(store, rcase) {
  if (rcase.status === "exchange_approved" || rcase.status === "refund_approved" || isClosed(store.state.threads[rcase.caseId])) {
    refuse("case_closed", `${rcase.caseId} is closed; there is nothing left to reply to.`);
  }
}

// Every shade the reading ranked must be cited, nothing else, each within 0.05; so must the band.
function citeRanking(reading, evidence) {
  const cited = evidence.deltaE;
  const codes = reading.ranking.map((r) => r.code);
  if (cited === null || typeof cited !== "object" || Array.isArray(cited) || Object.keys(cited).sort().join() !== [...codes].sort().join()) {
    refuse("evidence_mismatch", `The evidence must cite ΔE00 for exactly the shades the reading ranked: ${codes.join(", ")}.`);
  }
  for (const r of reading.ranking) {
    if (!cites(cited[r.code], r.de00)) refuse("evidence_mismatch", `${r.code} is ΔE00 ${f2(r.de00)} on this reading, and the evidence must cite it.`);
  }
  if (!cites(evidence.band, reading.band)) refuse("evidence_mismatch", `The band on this reading is ${f1(reading.band)}.`);
}

// What an offer carries is the reading's own figures: the agent's citation only has to agree with them
// to 0.05, and the text quotes them, so the card must not carry the agent's rounding instead.
const readingDeltaE = (reading) => Object.fromEntries(reading.ranking.map((r) => [r.code, r.de00]));

function onlyKeys(evidence, allowed, kind) {
  const extra = Object.keys(evidence).filter((k) => !allowed.includes(k));
  if (extra.length) refuse("evidence_mismatch", `A ${kind} cites ${allowed.join(", ") || "no numbers"}, not ${extra.join(", ")}.`);
}

function rankingLine(reading, rcase) {
  return reading.ranking.map((r) => `${r.code} ${f2(r.de00)}${r.code === rcase.shadeCode ? " (returned)" : ""}`).join(", ");
}

const ACCEPT = "Tap Accept if you'd like that, and a member of staff will approve it.";

const read = (reading, rcase) => `Your shade reading, in ΔE00 (smaller is closer; one reading can move about ± ${f1(reading.band)}), puts ${rankingLine(reading, rcase)}.`;

const draft_reply = {
  name: "draft_reply",
  description:
    "Write one reply draft for staff on a return case's thread. kind is exchange_offer (an exchange for the shade the reading supports), sample_offer (the two-shade sample, when two shades are too close to call), refund_offer (when no shade fits, the returned shade already is the closest, or the order has no reading) or check_invite (when the case has no reading: invites the shopper to check her own shade). " +
    "The text is composed in code from the case's own numbers: the offered shade, every shade the reading ranked with its ΔE00, and the band. evidence must cite those numbers (exchange_offer and sample_offer: shadeCode, deltaE for every ranked shade, band; refund_offer: reason, deltaE, band, or only reason 'no_reading' when the order has no reading; check_invite: an empty object) and each figure must be within 0.05 of the reading's, or the call is refused as evidence_mismatch. An exchange or refund offer needs draft_return_resolution to have drafted that resolution first. " +
    "The draft carries a fingerprint of its text, its evidence and the thread's newest message, so staff can tell when the customer has written since. " +
    "Does NOT send: a draft never reaches the chat service or the thread, and only a staff member's send does that. Does NOT take free text: a text field is a smuggled field, refused and logged. Does NOT approve, refund, close, or change stock, and does NOT write a reply for a closed case.",
  args: {
    caseId: { type: "string", required: true, description: "The return case, e.g. R-104." },
    kind: { type: "string", required: true, enum: REPLY_KINDS, description: "exchange_offer, sample_offer, refund_offer or check_invite." },
    evidence: { type: "object", required: true, description: "The reading's own numbers, as described above." },
  },
  async run({ caseId, kind, evidence }, { store }) {
    const rcase = mustCase(store, caseId);
    mustOpen(store, rcase);
    const reading = rcase.reading;
    const product = store.getProduct(rcase.productId);
    let text;
    let resolution = null;
    let shadeCode;
    let deltaE = null;

    if (kind === "check_invite") {
      if (reading) refuse("reading_exists", `${caseId} already carries a shade reading, so there is nothing to invite her to check.`);
      onlyKeys(evidence, [], kind);
      text = `Before we choose a replacement, you can check your shade for a free exchange: tap "Check my shade" on your order. Only your own photo starts the check, it is deleted afterwards, and we only ever receive numbers.`;
    } else if (!reading && kind === "refund_offer") {
      if (rcase.draft?.resolution !== "refund" || rcase.draft.evidence?.reason !== "no_reading") refuse("no_resolution_draft", "A refund offer for an order with no reading needs a refund drafted with the reason no_reading.");
      onlyKeys(evidence, ["reason"], kind);
      if (evidence.reason !== "no_reading") refuse("evidence_mismatch", "The drafted refund's reason is no_reading.");
      resolution = "refund";
      text = `We don't have a shade reading for this order, so we can't choose a replacement shade. We can refund the ${rcase.shadeCode} you're returning. ${ACCEPT}`;
    } else {
      if (!reading) refuse("no_reading", `${caseId} has no shade reading, so an offer can't cite one. Invite the shopper to check her shade first.`);
      const supportsExchange = reading.draftDecision === "swap" || reading.draftDecision === "sample_duo";
      if (kind === "refund_offer") {
        if (supportsExchange) refuse("reading_supports_exchange", `The reading supports an exchange (${reading.draftDecision}); offer that instead.`);
        if (rcase.draft?.resolution !== "refund") refuse("no_resolution_draft", "A refund offer needs a refund drafted first (draft_return_resolution).");
        onlyKeys(evidence, ["reason", "deltaE", "band"], kind);
        if (evidence.reason !== rcase.draft.evidence.reason) refuse("evidence_mismatch", `The drafted refund's reason is ${rcase.draft.evidence.reason}.`);
        citeRanking(reading, evidence);
        resolution = "refund";
        deltaE = readingDeltaE(reading);
        text =
          evidence.reason === "no_match"
            ? `No shade of ${product.name} is within ΔE00 ${f1(NO_GOOD_MATCH)} of your reading (the closest, ${reading.ranking[0].code}, is ${f2(reading.ranking[0].de00)}). ${read(reading, rcase)} We can refund the ${rcase.shadeCode} instead. ${ACCEPT}`
            : `${read(reading, rcase)} The ${rcase.shadeCode} you're returning already is the closest shade in the range, so a different shade would not fit better. We can refund it instead. ${ACCEPT}`;
      } else {
        const want = kind === "exchange_offer" ? "swap" : "sample_duo";
        if (reading.draftDecision !== want) {
          refuse("reading_does_not_support_exchange", `The reading's decision is ${reading.draftDecision}, which a ${kind} does not follow${reading.draftDecision === "sample_duo" ? "; offer the two-shade sample" : reading.draftDecision === "swap" ? "; offer the exchange" : "; offer a refund"}.`);
        }
        if (rcase.draft?.resolution !== "exchange") refuse("no_resolution_draft", "An offer needs an exchange drafted first (draft_return_resolution).");
        onlyKeys(evidence, ["shadeCode", "deltaE", "band"], kind);
        if (evidence.shadeCode !== rcase.draft.shadeCode) refuse("evidence_mismatch", `The drafted exchange is for ${rcase.draft.shadeCode}.`);
        citeRanking(reading, evidence);
        resolution = "exchange";
        shadeCode = rcase.draft.shadeCode;
        deltaE = readingDeltaE(reading);
        if (kind === "exchange_offer") {
          text = `${read(reading, rcase)} We can exchange it for ${shadeCode}. ${ACCEPT}`;
        } else {
          const [a, b] = reading.recommended;
          const de = (code) => f2(reading.ranking.find((r) => r.code === code).de00);
          text = `${read(reading, rcase)} The two closest, ${a} (ΔE00 ${de(a)}) and ${b} (${de(b)}), are too close to call, so we can send the two-shade sample (${shadeCode}) instead. ${ACCEPT}`;
        }
      }
    }

    const newest = newestMessage(store.state.threads[caseId] ?? { messages: [] });
    const basedOn = newest ? { messageId: newest.messageId, sentTime: newest.sentTime } : null;
    const draft = {
      draftId: store.nextDraftId(),
      caseId,
      kind,
      type: kind === "check_invite" ? TYPES.NOTE : TYPES.OFFER,
      resolution,
      ...(shadeCode ? { shadeCode } : {}),
      deltaE,
      text,
      evidence: structuredClone(evidence),
      basedOn,
      seenIds: (store.state.threads[caseId]?.messages ?? []).map((m) => m.messageId),
      fingerprint: await fingerprintOf({ text, evidence, basedOn }),
      at: store.now(),
      sent: null,
    };
    store.state.replyDrafts.push(draft);
    return { draft: structuredClone(draft) };
  },
};

export const THREAD_TOOLS = Object.freeze([read_thread, draft_reply]);
