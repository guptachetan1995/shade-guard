// The support thread as the store holds it: a mirror of what the chat service delivered, kept per
// return case. Pure functions over plain data, browser-safe, and free of anything under
// src/chat/, so the agent's tools may import it. Everything here orders and compares by the
// SERVER's message ids and server times; the local clock is recorded for display and used for
// nothing.
import { TYPES } from "./message-types.js";

// The one order every comparison here uses: server time, and where two messages share a server
// millisecond (UNVERIFIED whether the service can repeat one), the message id. A "place" in a thread
// is any { sentTime, messageId }, so a message and a bare place compare the same way.
export const byServerTime = (a, b) => a.sentTime - b.sentTime || (a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0);

export const placeOf = (m) => ({ sentTime: m.sentTime, messageId: m.messageId });

// readThrough: the newest message the channel held at the last complete read of it (the whole
// channel from that message back to the point the mirror already covered), as { sentTime,
// messageId }; null when the channel was never read. A later read is complete only once it
// reaches back to it. historyTruncated: a restore stopped at its page budget with older messages
// still on the channel, so the thread shows only the newest part of its history. readGap: a catch-up
// read after a reconnect stopped at its page budget before reaching readThrough, so messages may be
// missing in the middle; readThrough stays put, so every staff send still has to read back past the
// gap (thread_unverified until one can), and the next complete read closes it.
export function emptyThread(caseId, peerUserId) {
  return { caseId, peerUserId, messages: [], crossed: [], readThrough: null, historyTruncated: false, readGap: false };
}

// "The channel was read and held nothing": older than every real server time.
export const EMPTY_CHANNEL = Object.freeze({ sentTime: 0, messageId: "" });

// Records a complete read. chain: the channel's messages newest first, as read (all visits).
// readThrough only moves forward. historyTruncated only goes from false to true: a later read
// stops at readThrough and never reaches the older messages the truncated restore left out.
export function markRead(thread, chain, { truncated = false } = {}) {
  const top = chain.length ? placeOf(chain[0]) : { ...EMPTY_CHANNEL };
  if (!thread.readThrough || byServerTime(top, thread.readThrough) > 0) thread.readThrough = top;
  if (truncated) thread.historyTruncated = true;
  else thread.readGap = false;
}

// Records a catch-up read that stopped at its page budget short of readThrough: the messages it held
// are recorded, readThrough does not move, and the thread says messages may be missing in its middle.
export function markGap(thread) {
  thread.readGap = true;
}

// Adds a message in server-time order. A message id already held keeps its first copy.
export function insertMessage(thread, message) {
  if (thread.messages.some((m) => m.messageId === message.messageId)) return false;
  thread.messages.push(message);
  thread.messages.sort(byServerTime);
  return true;
}

export const newestMessage = (thread) => thread.messages.at(-1) ?? null;

export const messageById = (thread, messageId) => thread.messages.find((m) => m.messageId === messageId) ?? null;

export const isClosed = (thread) => Boolean(thread?.messages.some((m) => m.type === TYPES.CASE_CLOSED));

export function newestOffer(thread) {
  return [...thread.messages].reverse().find((m) => m.type === TYPES.OFFER) ?? null;
}

// The shopper's acceptance of this offer: her SG:OfferAccepted for its draftId, placed after it.
export function acceptanceOf(thread, offer) {
  return thread.messages.find((m) => m.type === TYPES.OFFER_ACCEPTED && m.content.draftId === offer.content.draftId && byServerTime(m, offer) > 0) ?? null;
}


// Staff messages the desk sent carry seenThrough: the place of the newest message the desk had when
// it sent (EMPTY_CHANNEL for an empty thread). A shopper message placed after that and before the
// staff message's own was sent over: the desk answered without having seen it. Derived from the
// data, so it comes out the same whichever order the messages reached the mirror in.
export function recomputeCrossed(thread) {
  const crossed = [];
  for (const s of thread.messages) {
    if (s.sender !== "staff" || typeof s.seenThrough?.sentTime !== "number") continue;
    for (const m of thread.messages) {
      if (m.sender === "shopper" && byServerTime(m, s.seenThrough) > 0 && byServerTime(m, s) < 0) {
        crossed.push({ shopperMessageId: m.messageId, staffMessageId: s.messageId });
      }
    }
  }
  thread.crossed = crossed;
  return crossed;
}

// A short, stable fingerprint of what a reply draft says and what it was written against. It
// detects a stale or altered view; it is not a secret. SHA-256 from the platform's own crypto,
// which Node and every browser carry, cut to 16 hex characters.
export async function fingerprintOf({ text, evidence, basedOn }) {
  const body = JSON.stringify([text, evidence, basedOn?.messageId ?? null, basedOn?.sentTime ?? null]);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return [...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const messageView = ({ messageId, sender, type, sentTime, content }) => ({ messageId, sender, type, sentTime, content: structuredClone(content) });
