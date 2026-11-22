// How a thread is read from the chat service. The service answers one page at a time, newest
// first, and a channel is shared by every visit that uses its seat, so "the newest page" can hold
// nothing of this visit at all: another visit's messages crowd it. A read is therefore a chain of
// pages, each one older than the last, that stops only at ground the caller already covers.
// Browser-safe; it talks to a transport and makes no call of its own.
import { MAX_PAGES, PAGE_SIZE } from "./transport.js";
import { byServerTime } from "../threads.js";

export { MAX_PAGES };

// Reads the channel with withUserId back from its newest message. anchor is a { sentTime,
// messageId }: the newest message the caller's earlier complete read held (thread.readThrough),
// or null. The chain stops when
//   "start":  a page came back short, so nothing older exists;
//   "anchor": a page reached a message at or before the anchor, so every message newer than the
//             anchor is in the chain;
//   null:     maxPages pages were read and neither happened (the chain is a truncated read).
// Returns { messages (newest first, every visit), reached }. A transport error propagates.
export async function readBack(transport, withUserId, { anchor = null, maxPages = MAX_PAGES } = {}) {
  const messages = [];
  let before = null;
  for (let n = 0; n < maxPages; n++) {
    const page = await transport.newest({ withUserId, limit: PAGE_SIZE, ...(before ? { before } : {}) });
    messages.push(...page);
    if (page.length < PAGE_SIZE) return { messages, reached: "start" };
    const oldest = page.at(-1);
    if (anchor && byServerTime(oldest, anchor) <= 0) return { messages, reached: "anchor" };
    before = { messageId: oldest.messageId, sentTime: oldest.sentTime };
  }
  return { messages, reached: null };
}
