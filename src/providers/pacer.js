// The live provider's pacer: a sliding window over the requests this process sends to the
// API server. The documented limit is 250 requests per 300 s per IP and per access token;
// the pacer stays under it at 200 per 300 s, with at most 5 in any one second, and holds
// every request back for a while after a 429. Browser-safe: no Node APIs.

export const PACE = Object.freeze({ windowMs: 300_000, maxInWindow: 200, burstMs: 1000, maxInBurst: 5 });

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createPacer({ now = () => Date.now(), sleep = realSleep, pace = PACE } = {}) {
  const sent = []; // send times inside the window, oldest first
  let notBefore = 0;
  let chain = Promise.resolve();

  function waitNeeded(t) {
    while (sent.length && sent[0] <= t - pace.windowMs) sent.shift();
    let until = notBefore;
    if (sent.length >= pace.maxInWindow) until = Math.max(until, sent[sent.length - pace.maxInWindow] + pace.windowMs);
    const inBurst = sent.filter((s) => s > t - pace.burstMs);
    if (inBurst.length >= pace.maxInBurst) until = Math.max(until, inBurst[inBurst.length - pace.maxInBurst] + pace.burstMs);
    return Math.max(0, until - t);
  }

  async function takeOne() {
    for (let ms = waitNeeded(now()); ms > 0; ms = waitNeeded(now())) await sleep(ms);
    sent.push(now());
  }

  return {
    // Resolves when one more request may go. Calls are served in order, so concurrent callers
    // can't both see the same free slot.
    take() {
      const turn = chain.then(takeOne);
      chain = turn.catch(() => {});
      return turn;
    },
    // After a 429: nothing goes for ms.
    backoff(ms) {
      notBefore = Math.max(notBefore, now() + ms);
    },
    inWindow() {
      waitNeeded(now());
      return sent.length;
    },
  };
}
