// The desk's link to the shopper's side on a phone (§15.5.3): it carries the seat number and the visit
// id and nothing else, never a token; the phone that opens it finds its user in the seats config the
// same way the frame's iframe does, and its token from that config. Its words say where it works: on
// Nexconn from any phone, on the offline service only on this machine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTransport, params, phoneLinkHtml, phoneLinkUrl, sideOf } from "../public/chat/common.js";
import { parseNexconnSeats, fakeSeats, SHOPPER_PROFILES } from "../src/chat/seats.js";
import { registrationObjects } from "../src/chat/messages.js";
import { STATUS } from "../src/chat/transport.js";
import { MockNexconnServer } from "./nexconn-sdk-mock.js";

const DESK_HREF = "https://example.invalid/shade-guard/chat.html?side=desk&seat=2&visit=ab12cd34&probe=1&isolate=1&token=nope#top";

// tokenOf: the token the seats file holds for a user (the mock SDK knows each user by "mock-token-<id>").
function seatsFile(tokenOf = (u) => `mock-token-${u}`) {
  return {
    appKey: "dummyAppKey123",
    area: "SG",
    seats: [1, 2].map((n) => {
      const desk = `sgdesk0000000${n}`;
      const shoppers = SHOPPER_PROFILES.map((p, k) => ({ userId: `sgshop000000${n}${k}`, ...p }));
      return { n, deskUserId: desk, shoppers, tokens: Object.fromEntries([desk, ...shoppers.map((s) => s.userId)].map((u) => [u, tokenOf(u)])) };
    }),
  };
}

test("the phone link is the same page with side, seat and visit only: no token, no probe, no other parameter, no fragment", () => {
  const url = new URL(phoneLinkUrl(DESK_HREF, { seat: 2, visit: "ab12cd34" }));
  assert.equal(url.origin + url.pathname, "https://example.invalid/shade-guard/chat.html");
  assert.deepEqual([...url.searchParams.keys()].sort(), ["seat", "side", "visit"]);
  assert.deepEqual([url.searchParams.get("side"), url.searchParams.get("seat"), url.searchParams.get("visit")], ["shopper", "2", "ab12cd34"]);
  assert.equal(url.hash, "");
  assert.doesNotMatch(url.href, /token|probe|isolate|dummy/i);
});

test("a phone that opens the link is the seat's first shopper in that visit, the same user the frame's phone iframe is", () => {
  const config = { seats: fakeSeats() };
  const link = new URL(phoneLinkUrl(DESK_HREF, { seat: 2, visit: "ab12cd34" }));
  const fromLink = sideOf(params(link.search), config);
  assert.deepEqual([fromLink.side, fromLink.seat.n, fromLink.visit, fromLink.as, fromLink.userId], ["shopper", 2, "ab12cd34", 0, "fakeshop2a"]);
  const iframe = sideOf(params("?side=shopper&seat=2&visit=ab12cd34&as=0&probe=1"), config);
  assert.equal(iframe.userId, fromLink.userId);
  const desk = sideOf(params("?side=desk&seat=2&visit=ab12cd34"), config);
  assert.equal(desk.userId, "fakedesk2");
});

test("on Nexconn the phone takes its token from the seats config beside the page, never from the address, and connects as that shopper", async () => {
  const config = parseNexconnSeats(seatsFile());
  const server = new MockNexconnServer();
  for (const userId of Object.keys(config.tokens)) server.addUser(userId);
  const link = new URL(phoneLinkUrl(DESK_HREF, { seat: 2, visit: "ab12cd34" }));
  const { userId } = sideOf(params(link.search), config);
  assert.equal(userId, "sgshop00000020");
  assert.ok(!link.href.includes(config.tokens[userId]), "the address does not carry the token");
  const { sdk, control } = server.realm();
  const t = await makeTransport(config, userId, { pages: true, sdk: async () => sdk });
  t.registerCustomMessages(registrationObjects());
  const status = await t.connect();
  assert.deepEqual([status.state, control.userId], [STATUS.CONNECTED, userId]);
});

test("the link's words: on Nexconn it opens on any phone and says what the address carries; on the offline service it says this machine only", () => {
  const url = phoneLinkUrl(DESK_HREF, { seat: 2, visit: "ab12cd34" });
  const nexconn = phoneLinkHtml({ url, kind: "nexconn" });
  assert.match(nexconn, /data-phone-link="nexconn"/);
  assert.match(nexconn, /on a phone/i);
  assert.match(nexconn, /only this seat's number and this visit's id/);
  assert.match(nexconn, /no token/i);
  assert.ok(nexconn.includes(`href="${url.replaceAll("&", "&amp;")}"`), "the link is the address, escaped");
  assert.match(nexconn, /<code class="phone-url">/);
  assert.match(nexconn, /data-action="copy-phone-link"/);
  const local = phoneLinkHtml({ url, kind: "fake" });
  assert.match(local, /data-phone-link="local"/);
  assert.match(local, /this machine/i);
  assert.match(local, /127\.0\.0\.1/);
  assert.match(local, /can't reach/);
  assert.doesNotMatch(local, /on a phone</i, "the offline walk's link does not promise a phone");
  assert.equal(phoneLinkHtml({ url, kind: "unavailable" }), "", "with no chat service there is nothing to open");
});

test("a page served from this computer says this machine only, even with a Nexconn seats file: a phone can't reach 127.0.0.1", () => {
  for (const host of ["127.0.0.1:5178", "localhost:5178", "[::1]:5178", "shade.localhost:5178"]) {
    const url = phoneLinkUrl(`http://${host}/chat.html?side=desk&seat=1&visit=v1`, { seat: 1, visit: "v1" });
    const html = phoneLinkHtml({ url, kind: "nexconn" });
    assert.match(html, /data-phone-link="local"/, host);
    assert.match(html, /this machine/i, host);
  }
  assert.match(phoneLinkHtml({ url: "https://example.invalid/chat.html?side=shopper&seat=1&visit=v1", kind: "nexconn" }), /data-phone-link="nexconn"/);
});

test("the link sits in a folded box whose one visible line is the link itself, so it adds a line, not a panel, to the desk", () => {
  const url = phoneLinkUrl(DESK_HREF, { seat: 2, visit: "ab12cd34" });
  const html = phoneLinkHtml({ url, kind: "nexconn" });
  assert.match(html, /^<details class="phone-link" data-phone-link="nexconn"><summary>/);
  const summary = html.slice(html.indexOf("<summary>"), html.indexOf("</summary>"));
  assert.ok(summary.includes(`href="${url.replaceAll("&", "&amp;")}"`), "the link is in the visible line");
  assert.doesNotMatch(summary, /phone-url|copy-phone-link/, "the address and the copy button are inside the fold");
  assert.match(phoneLinkHtml({ url, kind: "nexconn", copied: "Copied." }), /<details class="phone-link"[^>]* open>/, "kept open while it says what the copy did");
});

test("the link's address is escaped wherever it is written", () => {
  const html = phoneLinkHtml({ url: 'https://example.invalid/chat.html?side=shopper&seat=1&visit=a"><script>', kind: "nexconn" });
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /"><script/);
});

test("an acceptance reads as words, with the offer's id only in small print", async () => {
  const { messageHtml } = await import("../public/chat/common.js");
  const html = messageHtml({ messageId: "m_9", sender: "shopper", type: "SG:OfferAccepted", sentTime: 1, content: { visit: "v", caseId: "R-104", draftId: "d_5d350d23_02" } }, { via: "fake chat (offline)" });
  assert.match(html, /<b>Accepted<\/b> the store's offer\./);
  assert.match(html, /<span class="fine">Offer d_5d350d23_02<\/span>/);
  assert.doesNotMatch(html, /Accepted<\/b> offer d_/);
});
