# Shade Guard

**A buyer–store support chat for online beauty stores, on the Nexconn Chat SDK. A wrong-shade
return becomes a thread: an agent drafts each reply from the shade numbers, and only people send,
accept, approve or close.**

**Status (22 Nov 2026), stated plainly:**

- **Chat on Nexconn: live since 22 Nov 2026.** The returns desk and the shopper's phone connect to
  the Nexconn Chat SDK (App Key `y745wfm8ynetv`, Singapore data centre) as fictional demo users.
  Messages cross the service both ways, every one shows Nexconn's server time and message id, and
  a reload rebuilds the thread from Nexconn's history. [The support chat](#the-support-chat-on-nexconn)
  says what runs and how; the [Nexconn notes](docs/nexconn-notes.md) hold what the live run measured.
- **The live chat on the public demo:** the chat page connects as 12 fictional demo users whose
  tokens sit in the page, so anyone who opens it can write as them. Every demo token expires on
  Wed 2 Dec 2026, after which the public demo's chat stops working.
- **Chat offline too.** `npm start -- --fake-chat` runs the same chat on a fake, in-memory service
  on your machine, behind a "FAKE CHAT (offline)" banner on every pane.
- **The shade check: sample data.** The store and its shade check were built first, for a YouCam
  API hackathon where nothing was submitted. Its YouCam provider is written but has never called
  YouCam; every reading comes from a synthetic sample shopper, and every screen says so.
  [Status in detail](#status-in-detail).

**[Open the support chat](https://guptachetan1995.github.io/shade-guard/chat.html)**: the desk and
the shopper's phone side by side, live on Nexconn until Wed 2 Dec 2026, with no sign-in and nothing
to install. **[Open the store](https://guptachetan1995.github.io/shade-guard/)**: the shop on sample
data. [The one-minute path](#demo-walkthrough).

Shade Guard is built for the [Nexconn Build Challenge 2026](https://reskilll.com/hack/nexconn)
(track: Marketplace & Support). It extends a project made for the
[YouCam API Skin AI & eCommerce VTO Hackathon](https://youcam-api-skin-ai-ecommerce.devpost.com/);
[What existed before, and what was built for Nexconn](#what-existed-before-and-what-was-built-for-nexconn)
draws the line. It is not affiliated with or endorsed by Nexconn or Perfect Corp.

**Platform:** a web app for mobile and desktop browsers (Chrome, Safari). The shop and the
shopper's side of the chat are phone-first. The returns desk and the merchant panel are desktop
views.

## The support chat on Nexconn

An opened foundation in the wrong shade generally can't be resold, so refunding it means writing
the unit off. Here the shopper starts the return from her order page, and the request reaches the
store's returns desk as a message on a direct channel between her and the desk. The agent reads
the thread and the shade reading on her order and drafts the reply: an exchange to the shade the
colour numbers support, with the CIEDE2000 distances in the message, or, when the order has no
reading, an invitation to check her shade first, which she shares in the chat as numbers only,
never a photo. A draft never sends itself. Only a staff click sends a reply, approves the
exchange or closes the case, and each of those first reads the thread back from the chat service:
if she has written since the draft, the send is refused and the agent drafts again. The exchange
waits for her own **Accept** in the chat.

The shopper's phone and the staff desk are **two pages, each its own app with its own store**;
they share nothing but the chat service between them. The agent reads the thread and drafts the
reply; the chat's human-only verbs do everything that sends, accepts, approves or closes. Six
custom message types carry the thread (a note, the return request, the numbers-only reading, the
offer card, its acceptance and the case closed), and every message shows the chat service's own
server time and its message id.

**Status: on Nexconn since 22 Nov 2026.** Both panes connect to Nexconn as fictional demo users
and every message crosses the service; the page says "On Nexconn" above them, and each pane's badge
reads **Connected**. A page that can't load the SDK says so in words ("The Nexconn SDK is not
loaded, so chat is off. Nothing is faked.") and fakes no message.

**The end of the live chat.** The public demo's chat page connects as fictional demo users whose
tokens are in the page, so anyone who opens it can write as them. Every demo token expires on
Wed 2 Dec 2026; from then on the public demo's chat can't connect, and this section will say so.

The same walk runs offline, on a fake service:

```bash
npm start -- --fake-chat    # then open http://127.0.0.1:5178/chat.html
```

The page shows the desk and the shopper's phone side by side. The walk, about a minute and a half:
as the shopper (Maya, order O-5521), tap **Start a return: wrong shade, opened**; the request
reaches the desk, stamped with its server time and id, and the agent drafts an exchange offer for
245W listing the three closest shades. Type "is 250W any closer?" before staff send: **Send** is
refused (`thread_moved`), the message appears on the desk, and the agent drafts again. Staff answer
in their own words (**Send note**), send the offer, and a staff **Approve exchange** clicked before
her tap is refused (`not_accepted`). She taps **Accept**, staff approve and close. The second
shopper (Asha, R-107) has no reading: the agent drafts a check invite, her own check and **Share my
reading** send numbers only, and then the exchange offer follows. Reload either side and the thread
comes back from the service's history.

The desk also shows a one-line link to the shopper's side of its seat and visit, which unfolds to the
address and a copy button. The address carries the seat number and the visit id and nothing else,
never a token: the page it opens reads the seat's demo token from the seats file beside it, as the
frame's own phone pane does. From a public address on Nexconn any phone can open it; a page served by
the local server (offline or on Nexconn) says it opens on this machine only, since that server
answers on 127.0.0.1 alone.

Each customer in the desk inbox carries an unread count. When the chat service reports its own count
for that channel (the offline service does; the Nexconn adapter reads the SDK's channel list), the
badge shows the service's number, and its label and the line under the inbox say so; otherwise the
desk counts what it has not shown. A service count lower than what the desk knows it has not shown
(another tab or visit on the seat marked the channel read, or the service does not count these
messages) is not shown: the badge never says fewer than the desk knows, and its label gives both. The service's count is the channel's, so another visit on the same
seat adds to it; the desk marks a channel read on the service when it shows that thread, or when
nothing of its own visit is unread there, and only once it has read that thread completely (an empty
thread whose history read failed proves nothing). It clears a channel at most once per count it sees,
and reads the counts in the background, one read at a time, giving up after 5 seconds. On Nexconn
on 22 Nov the channel list sometimes answered 35011, and the badge then showed the desk's own
count, as designed; the service's own count was not checked live.

What is checked at the moment of use, on the service's own message ids and server times and never
the local clock:

- A staff send, note, close or approval first reads the channel from the service. The channel is
  shared by every visit that uses the seat, so the newest page of 20 can hold none of this visit's
  messages; the read therefore goes back page by page, by a cursor, until it reaches the point the
  desk already covered or the start of the channel. A shopper message the desk had not shown
  refuses it as `thread_moved` and is recorded; a read that fails, or cannot reach back within 25
  pages (500 messages), refuses it as `thread_unverified`; a dropped connection refuses it as
  `chat_offline`. A reload reads the history back the same way, and a channel with more than 500
  messages shows only its newest part, with a banner saying so that stays up for the rest of the
  visit (a later read reaches back only to what the desk already covered, never to the older part).
- A shopper message that crosses a send in the one round trip after the read is flagged on the desk
  (`crossed`, "sent over a message you had not seen") and the agent can draft again.
- An approval needs the shopper's own `SG:OfferAccepted` for the newest offer (`not_accepted`,
  `offer_mismatch`), and she can only accept the newest offer (`offer_superseded`). She accepts an offer by its draft
  id, so each desk tab tags its draft ids with its own random tag: two tabs, a reload, or a restore
  cut short before an older offer do not hand out the same id. A send whose offer the service
  already holds (an earlier click went through but its answer was lost) is `already_sent`, and the
  draft shows as sent instead of going out twice; an offer with other terms under the same id
  (anyone holding the public desk token could send one) refuses the send as `draft_id_taken`. The desk reads
  the service before it decides, so an empty mirror proves nothing: a chat case whose thread holds
  no offer, an empty thread included, cannot be approved (`not_accepted`). Only a case with no chat
  thread at all (the existing returns desk) keeps its old checks. Last, the approvals take `seen`,
  the newest message the desk's screen showed (as `close_case` does): a shopper message after her
  acceptance that the screen had not shown refuses the approval as `thread_moved`, and one staff
  have read is theirs to weigh. Without that, one "thanks!" typed after Accept would block every
  approval for good, since she cannot accept twice.
- Another visit's messages on the seat's channel cost the desk almost nothing: they are dropped on
  arrival and only counted (`otherVisitDropped`), never logged or held, and the redraw after a
  burst of messages runs once. The activity log is a ring of 2,000 lines, and a received message's
  line carries its id, type, sender, time and size, never its words. A flood of messages carrying
  this visit's own id (the id is in every message, so it is not a secret) is only bounded by memory.
  Staff verbs also re-check, after reading the service, that no other tab of the desk has closed the
  case (`case_closed`).
- The visit id is not a boundary. It keeps two honest visits on one seat apart. The seat tokens of
  the public demo are public, so anyone holding one can read every visit's traffic on that seat's
  channel and send a message carrying a visit they have seen, an `SG:OfferAccepted` included: on
  the public demo "her own Accept" means a message from the seat's shopper user in the visit, not
  an authenticated person. The staff approval still needs it and still re-reads the thread.
- Not done in this slice: an approval and a reply draft live in the tab, so after a reload a case
  staff already approved shows as open again (the approval is simulated). The activity log lists
  verb calls, not each message a thread read recorded inside one.
- A shared reading is the shopper's own, unauthenticated numbers: nothing here makes it true, and
  the desk says "shared by the shopper in the chat" beside it. Every number has a range (L\* 0 to
  100, a\* and b\* within ±200, hue 0 to 360, band 0.1 to 10), every id and label a length and the
  text 500 characters, so a hostile or mistaken reading is refused as `bad_content` instead of
  being ranked, and what the desk draws from one is always finite. A message the table would refuse
  is refused before it is sent, not after, so a retry can't pile copies onto the channel. The ΔE00
  figures an offer carries are the reading's own, never the agent's rounding of them. A visit id
  (`?visit=`) is 1 to 64 letters, digits, dashes or underscores, checked when the page starts.
- The agent's tools have no chat transport in their context at all, and a lint rule and a test keep
  every module they import away from it. The **Try it as the agent** panel sends the agent's
  `send_reply`, `staff_note`, `close_case` and `accept_offer` (each `wrong_actor`) and a
  `draft_reply` with a `text` field (`smuggled_field`), then shows that the thread did not change.

Every connection state has words on screen: connecting, seat busy, offline, SDK not loaded, and
"thread not verified". The fake service has a small control panel to bring each on, including a
pause: a connection that pauses and comes back by itself (as the SDK's suspended one does) reads as
connecting meanwhile, and once it is connected again each side reads its threads back from the
service with the same page budget as a reload, so messages sent while it was away appear in order,
each once, without waiting for the next staff send. If more messages reached the channel meanwhile
than that budget reads, the desk keeps its old read point and says messages may be missing in the
middle of the thread: every staff send then still refuses as `thread_unverified`, as it would have
without the catch-up, so nothing goes out over a message no read reached.

`npm run nexconn:tokens` and `npm run nexconn:expire` mint and expire a pool of demo users on the
Nexconn server API. Both ran against Nexconn on 22 Nov 2026: the issue, user lookup and expire calls
answer HTTP 200 with a `code` of 0 (a lookup of an unknown user answers 400), and the token is
`result.accessToken`. The tests' fake signer answers in the same shapes.

**The path to Nexconn.** The Nexconn Chat SDK (`@nexconn/chat` and
`@nexconn/engine` 26.2.1) loads in the browser from jsDelivr through an import map in `chat.html`
that pins both files by version and by an integrity hash, so the browser refuses any other bytes.
Nothing of the SDK is copied into this repository or its static build: it loads at run time, under
Nexconn's own licence. One module, `public/chat-sdk.js`, imports it; the adapter,
`src/chat/nexconn-transport.js`, implements the same transport interface as the fake on top of the
SDK's engine, direct channels, custom messages and history query. Once `npm run nexconn:tokens` has
written the seats file (outside every git work tree), `npm start` serves it to its own chat page and
the page connects both sides to Nexconn. A static build carries it only when `NEXCONN_SEATS_FILE`
names it and `NEXCONN_PUBLISH_TOKENS=1` is also set; it then refuses to be written inside a git work
tree, and scans every file it wrote for the App Secret's value, removing itself on a hit. The names the adapter relies on, what
the first live run measured and what it has still not checked are in
[Nexconn notes](docs/nexconn-notes.md).

```bash
# They need a Nexconn app's env file at ~/.config/shade-guard/nexconn.env (App Key, area, API host, App Secret)
npm run nexconn:tokens -- --seats 4    # mints 12 fictional demo users and writes ~/.config/shade-guard/nexconn-seats.json
npm run nexconn:tokens -- --check      # asks the server API whether each demo user exists
npm start                              # serves the seats file to http://127.0.0.1:5178/chat.html
NEXCONN_SEATS_FILE=~/.config/shade-guard/nexconn-seats.json NEXCONN_PUBLISH_TOKENS=1 npm run build:pages -- "$(mktemp -d)/site"
npm run nexconn:tokens -- --scan <dir>  # names any file under <dir> that holds the App Secret's value, never the value
```

## What existed before, and what was built for Nexconn

Shade Guard was first built for the YouCam API hackathon, which closed on 2 Nov 2026 with nothing
submitted. Its application code was written between 30 Oct and 2 Nov 2026 (the plan and the
licence on 28 Sep). In this repository the line is commit
[5f35675](https://github.com/guptachetan1995/shade-guard/commit/5f35675) (2 Nov 2026, 21:49
IST), whose static demo is the `gh-pages` build 9528984: everything up to it existed before the
Nexconn work, and every later commit is the Nexconn work. The Nexconn layer was planned from
6 Nov 2026 and its code written from 10 Nov 2026.

| Existed before (built 28 Sep – 2 Nov 2026 for YouCam, never submitted) | Built for Nexconn (planned from 6 Nov 2026, code from 10 Nov) |
|---|---|
| The fictional store, catalogue, cart, orders and return cases R-104 and R-107 | The Nexconn Chat SDK in the chat page: the import map with pinned versions and integrity hashes, and the one module that loads it |
| CIEDE2000 colour science and the shade ranking | The chat transport interface, the Nexconn adapter, and a fake service for the offline tests and walk |
| `invoke(tool, args, actor)`, nine agent tools, seven human-only verbs, the deterministic planner | Two agent tools (`read_thread`, `draft_reply`), six human verbs (`shopper_send`, `share_reading`, `accept_offer`, `send_reply`, `staff_note`, `close_case`), the re-checks that read the chat service at the moment of use, and the chat adapter's own actor with its one verb, `record_inbound` |
| The shop check on the fake provider, the privacy receipt, the returns desk, the merchant panel | The desk inbox (with unread counts and the phone link) and thread view, the shopper's order page with the chat, the reading card and the offer card with its **Accept** button |
| The YouCam live provider, recorder and probes (tested only against a stand-in; never called YouCam) | `npm run nexconn:tokens` and `npm run nexconn:expire`, the seats file, and the static build's seats copy |
| The static demo build, 133 offline tests, `verify.sh`, the README | A test for every chat refusal, the README's chat sections, the [Nexconn notes](docs/nexconn-notes.md) |

The face reading is still sample data: nothing here makes it a YouCam reading.

## What the agent does, what only a human does

The agent is a **deterministic planner**, with no language model. It calls the same tools the
store's buttons call, through one `invoke(tool, args, actor)` chokepoint, and branches on what
the API actually returns.

| | Agent | Human |
|---|---|---|
| Start a face analysis (consent + photo) | **Never** | Shopper: `start_check`, from the cart or a return page |
| Measure, rank, render try-on previews | Yes, within the per-check unit cap | — |
| Draft a recommendation with evidence | Yes | — |
| Change the cart | **Never** | Shopper: `apply_draft` / `keep_my_shade` |
| Draft a returns resolution | Yes, citing the reading. No exchange without one | — |
| Approve an exchange or a refund | **Never** | Staff: `approve_exchange` / `approve_refund` |
| Change how many units a check may spend | **Never** | Merchant: `set_unit_cap` |
| Stop waiting for an analysis still running after 90 s | **Never** | Shopper: `stop_waiting` |
| Read a support thread and draft a reply for staff | Yes: `read_thread`, `draft_reply`. The reply's text is composed in code from the reading's own numbers | — |
| Send a message, accept an offer, close a case | **Never.** `draft_reply` takes no free text, and a draft never reaches the chat service | Shopper: `shopper_send`, `share_reading`, `accept_offer`. Staff: `send_reply`, `staff_note`, `close_case` |
| Keep or re-use the shopper's photo | **Never.** No tool exists | — (deleted when the check closes) |

The human verbs (the shop's seven, the support chat's six, and `record_inbound`, which only the
chat adapter's own actor may call) are **never registered as a tool** the agent can discover or
call. The chokepoint also refuses them for the agent actor when they are called directly. Tests
prove both.

Each human verb also accepts only its own actor: a shopper can't approve a refund, and an
unknown or missing actor is refused. The actor field is not authentication, though. The local
server listens only on 127.0.0.1 and answers only to that host name, and any client there could
claim to be a shopper. The gate is structural: it stops the agent's code paths from reaching a
human verb. The route that runs the agent, `POST /api/agent`, takes no actor at all; the
planner pins `actor: "agent"` in code.

## Tools

| Tool | What it does | What it does NOT do |
|---|---|---|
| `get_cart` | Lists cart lines: product, shade, finish, quantity | Change the cart |
| `list_shades` | Lists a product's shades with swatch colour, undertone label, finishes, stock and its two-shade sample | Call YouCam or recommend |
| `measure_complexion` | Uploads the check's photo once, then runs the Facial Color Tones Analyzer and SD Skin Analysis. Returns the readings, the lighting verdict, the uncertainty band and the units spent, or retake guidance at 0 units | Run on a closed check. Run past the unit cap: it refuses before sending anything |
| `rank_shades` | Ranks one product's shades by CIEDE2000 distance to the reading. Flags too-close-to-call and no-good-match, with the direction of the gap | Call YouCam (0 units) |
| `preview_shade` | Renders one catalogue shade on the shopper's photo with Makeup Virtual Try-On and saves the image at once | Change the cart. Render a colour outside the catalogue |
| `draft_recommendation` | Writes keep / swap / sample_duo / no_match / retake / unavailable for one cart line, with evidence citing the check's own numbers | Change the cart: a smuggled cart field is refused and logged |
| `list_return_cases` | Lists return requests and the reading attached to each order (numbers only) | Show any photo. Approve anything. Ask a shopper for a check |
| `draft_return_resolution` | Drafts an exchange (to a named shade or the two-shade sample) or a refund for staff | Approve, refund or change stock. Draft an exchange with no reading |
| `get_unit_budget` | Shows a check's units spent, the cap, the price of the whole check, how many lines the cap can cover, and the live balance (a free call) | Spend units or change the cap |
| `read_thread` | Reads one return case's support thread as recorded from the chat service: each message's id, sender, type, server time and content | Send, mark read, or call the chat service. Show a photo: none is ever in a thread |
| `draft_reply` | Writes one reply draft for staff (exchange offer, sample offer, refund offer or check invite), its text composed in code from the reading's numbers, which the evidence must cite within 0.05 | Send: a draft never reaches the thread. Take free text: a `text` field is a smuggled field, refused and logged |

## The shade check underneath (built for YouCam, on sample data)

Everything in this part existed before the Nexconn work, and runs today on a synthetic sample
shopper: the YouCam provider has never called YouCam. The chat's offers and readings come from it.

[![The Skin Tint card on sample data: a synthetic placeholder face split down the middle, 220N on the left and 245W on the right, a divider slider and Cart shade, Split, Recommended buttons under it. Beside it, three shade chips: the measured skin #B9947C, 220N in your bag at ΔE00 4.6, and 245W recommended at ΔE00 1.9, ringed. Below them the agent's draft and the Swap to 245W and Keep mine buttons. The FAKE badge is in the header.](docs/img/evidence-card.png)](https://guptachetan1995.github.io/shade-guard/)

One reading of a shopper's face is used at three retail moments.

- **Before checkout.** The shopper checks every foundation in the cart against their own face:
  - the **YouCam AI Facial Color Tones Analyzer** reads their skin colour and the photo's
    lighting;
  - **YouCam AI Skin Analysis** reads their skin type;
  - **YouCam AI Makeup Virtual Try-On** renders the cart shade and the best match on their
    photo, shown as one split face.

  An agent drafts one recommendation per product, with the evidence attached: keep, swap,
  order a two-shade sample, or "this range has no close match". **Only the shopper's click
  changes the cart.**
- **At the returns desk.** When a wrong-shade product comes back opened, the agent drafts an
  exchange for the shade the reading supports, instead of a refund. If the order has no
  reading, the shopper is offered a check first. **Only a staff member approves an exchange or
  a refund.**
- **In the range plan.** Every "no close match" is kept as numbers and listed for the
  merchandiser: the shade the range is missing, and the readings it is missing for.

### The problem

Foundation is bought by colour, and colour is the one thing a product photo can't show on
your skin. A wrong guess ends in one of two ways:

- **The shopper keeps a shade that doesn't match**, and stops buying.
- **The shopper returns it opened.** Opened cosmetics generally can't be resold for hygiene
  reasons, so the store writes the unit off and refunds it.

Shoppers at the ends of a shade range, or with olive or deep undertones, are hit hardest. For
some of them the range has no match at all. A shade finder that always names a "best match"
hides that gap and sells a return. The merchandiser who could fix the range hears about the
gap months later, from return reasons, if at all.

Shade Guard does the tedious, measurable part: read, rank, render, and draft with evidence.
The decisions that change the shopper's cart, move the store's money, or spend its API budget
stay human clicks.

### Not another shade finder

Perfect Corp's own [AI Shade Finder](https://www.perfectcorp.com/business/blog/makeup/foundation-shade-finder-comparison)
answers "which shade?" on a brand's site: it reads skin tone and undertone from the camera and
recommends a foundation, with a virtual try-on. Shade Guard starts where that ends:

- it checks the cart the shopper actually built, every foundation in it, against one reading;
- it may answer "no shade in this range is close" instead of naming the nearest one;
- it turns a near-tie into the two-shade sample, with a measured ± band on the card;
- on the returns desk, it drafts the exchange from the reading stored on the order, instead
  of writing off an opened unit for a refund;
- it sends every no-match reading to the merchandiser as a range gap, in numbers.

It also differs from two winners of the previous YouCam API hackathon.
[ShadeSpan](https://devpost.com/software/shadespan) renders each garment in a collection on a
panel of six skin tones and grades the colours that vanish. [CASTING](https://devpost.com/software/casting)
puts one product photo on a panel of eight measured skin tones and scores a catalogue's
coverage. Both check apparel or a catalogue against a fixed panel before a product goes live.
Shade Guard works from the other side: one real shopper's face, against the shades in their
own cart and on their own order.

### How a check works

1. **The shopper starts it.** They upload a photo (on a phone, the picker also offers the
   camera). The page asks for bare skin. It then shrinks the photo to one JPEG, long side
   1024 px, that every YouCam endpoint accepts. Nothing else can start a face analysis.
2. **Measure, once.** The Facial Color Tones Analyzer returns the skin colour as a hex value,
   and its own verdict on the photo's lighting. Skin Analysis (SD) returns skin type,
   oiliness, moisture and redness. One reading serves every product in the cart.
3. **Rank.** For each foundation in the cart, every shade in the store's range is ranked by
   CIEDE2000 colour difference against the reading. This is colour-science code in this
   repository, with no API call.
4. **Show.** Makeup Virtual Try-On renders the cart shade and the best match on the shopper's
   own photo, with skin smoothing off, so the preview shows the shade and not a beauty filter.
   The two renders appear as one split face with a divider. Beside it, a jawline strip shows
   the measured skin next to both swatches.
5. **Draft.** The agent writes one recommendation per product, with the ΔE numbers, the
   undertone reading, the lighting verdict, the finish suggested by skin type, and the
   previews. The recommendation is one of:
   - `keep`;
   - `swap`;
   - `sample_duo`: two shades too close to call;
   - `no_match`: nothing in the range is close;
   - `retake`, with exact pose guidance;
   - `unavailable`: the store's per-check unit cap can't cover it.
6. **Decide.** Per product, the shopper clicks **Swap**, **Get the sample duo**, **Remove it**
   or **Keep mine**.
7. **Forget.** When the check closes, the server deletes every YouCam task it created and
   shows a privacy receipt (see [Privacy](#privacy)). The order keeps the reading's numbers,
   never the photo.

**How sure is one photo?** Every card shows a ± band next to the ΔE numbers. The band is how
far one face's reading moves when the light shifts: the largest ΔE00 between three readings
of the sample shopper's photo, as generated and made 15% brighter and 15% darker (a brightness
shift standing in for a change of light). It is measured, not re-sent: an identical photo
sent twice may well read the same, which would say nothing about the shopper's next photo.
Until the sample shopper is recorded the band is a provisional 1.0, and the card says so. It
widens by a fixed 1.5× when the analyser says the shopper's own lighting isn't good. When two
shades sit inside the band, the draft is the two-shade sample, not a guess.

### The returns desk

A "wrong shade, opened" return reaches the store's returns desk.

- **The order carries a reading.** Say the check recommended 245W over the 220N in the cart,
  and the shopper kept 220N. The agent drafts "exchange for 245W" and cites those numbers.
- **The order carries no reading.** The shopper's return page offers "Check your shade for a
  free exchange". Only the shopper's own photo starts that check. The agent drafts the
  exchange after it. If no shade in the range fits, it drafts a refund instead.
- **A person decides.** Staff approve the exchange or the refund. The agent can't.

### The shade this range is missing, and who it is missing for

Shoppers at the ends of a shade range, or with olive or deep undertones, are the ones a range
most often fails. Shade Guard records each of those failures as numbers. Every "no close
match" keeps the reading's lightness (L\*), chroma (C\*) and hue angle, the nearest shade, its
ΔE00, and the direction from that shade to the reading. The merchant panel lists them per
product. On the sample data it reads "Cushion Compact: 1 reading with no shade within ΔE00 6,
deeper and warmer than C5": the range needs a shade past C5, deeper and warmer, and the table
under the sentence says exactly where.

"Who" here means a measured colour, never a person: the panel holds no photo, name, age or any
other inference about the shopper. It also shows checks by outcome and the units each check
cost.

### YouCam APIs used

| API | Category | What Shade Guard uses it for | Units per call (per the docs) |
|---|---|---|---|
| AI Facial Color Tones Analyzer | Skin | The skin colour (`skin_color` hex) that every ranking is computed from, and the photo's lighting verdict, which widens the uncertainty band | 20 |
| AI Skin Analysis (SD) | Skin | `skin_type`, `oiliness`, `moisture` and `redness`, which set the finish and flag readings that may run pink | 9 (1–4 concerns) |
| AI Makeup Virtual Try-On | Beauty | A `foundation` render of a catalogue shade on the shopper's own photo, with `skin_smooth` at 0 | 1 |

It also uses:
- the File API: upload once, then reuse the file id across tasks;
- the unit balance and feature-cost endpoints, which are free. Every paid call is checked
  against a per-check unit cap before it is sent, and the whole check is priced before the
  photo is uploaded;
- task delete, which cleans up when a check closes.

A check of a three-product cart costs about 36 units.

### Modes, stated plainly

A badge in the page always shows the active mode, and a banner under it says what that means.
`npm start` picks the mode by itself: LIVE when `YOUCAM_MODE=live` and a key is configured,
otherwise REPLAY when a recording of the sample shopper exists, otherwise FAKE. It prints the
mode it chose and why.

- **FAKE** ("Sample data, not YouCam"): deterministic synthetic responses from this app's own
  provider, with no network. The automated tests use it, and so do `npm start` and the static
  demo while no recording exists. The face on screen is then a synthetic placeholder drawn on
  a canvas in the browser and stamped "SYNTHETIC · not a person · not YouCam". An uploaded
  photo is resized in the tab and stopped there with "New photos need live mode": nothing is
  sent, because sample data can't read a real face.
- **REPLAY** ("Recorded YouCam responses"): real responses recorded from live YouCam calls on
  the date the banner names, served back with no network. It is the default once a recording
  is in `fixtures/recorded/sample-shopper/`, for `npm start` without a key and for the static
  demo. The check starts from the recorded sample shopper's photo, and the split face shows
  the real Makeup Virtual Try-On renders that were downloaded during the recording. The
  sample shopper's face is generated with YouCam's own AI Image Generator V2.0: it is of no
  real person, and the page stamps it and its renders "AI-generated · not a real person". Anything
  that was not recorded says so instead of making something up: a new photo gets "new photos
  need live mode", and an unrecorded request fails as `not_recorded`.
- **LIVE** ("Real YouCam API calls"): real calls from the local server, using the key in your
  own env file. The key stays on the local server. It is never sent to the browser and never
  logged. The split face shows the renders of your own photo.

A fourth mode, **LIVE · YOUR KEY** (real calls from the static demo page with a key pasted
into the tab), is designed but not built: it depends on the API's upload and result hosts
accepting browser requests, which the first keyed run checks.

The store, its three foundation ranges, its orders and its return requests are fictional.
Shade names and swatch colours are authored for this demo. The three ranges are authored
around the one recorded sample shopper, so that a single face shows a swap, a sample duo and
a range with no match. The uncertainty band is measured and the thresholds are fixed in
advance; neither is tuned to the demo. A real merchant would supply measured swatch colours
for its own range.

### What it looks like

These are screenshots of the static demo on sample data, so the badge reads **FAKE · Sample
data, not YouCam** and the face is the synthetic canvas placeholder, stamped as such. Once the
sample shopper is recorded, the same screens show REPLAY and the real try-on renders. The
shopper's evidence card is the image at the top of this page.

![The returns desk on sample data: return R-104, Skin Tint 220N, "wrong shade, opened". The order's shade reading lists 245W at ΔE00 2.10 (recommended), 250W at 3.51 and 220N at 5.00 (returned). The agent's draft, marked not approved, is an exchange for 245W, and Approve exchange and Approve refund are the staff's buttons. The FAKE badge and the sample-data banner are at the top.](docs/img/returns-desk.png)

![The merchant panel on sample data after one check: the range gap "Cushion Compact: 1 reading with no shade within ΔE00 6, deeper and warmer than C5" with its numbers, drafts by outcome (one swap, one sample duo, one no match), units per check (36 against a 40-unit cap) and the spending cap control. The FAKE badge and the sample-data banner are at the top.](docs/img/merchant-panel.png)

### Demo walkthrough

The path a first-time visitor clicks on the demo page takes about a minute. Today it runs on
the synthetic sample shopper; once the real one is recorded, the same path replays real YouCam
responses.

1. **Open the demo.** The cart holds three foundations and a setting spray.
2. **Click Check them on my face, then Use the synthetic sample shopper and Start the check.**
   A progress list names each YouCam API and its units as the agent calls it. "More synthetic
   samples" has one sample per branch: dim light, a tilted head (retake), and others.
3. **Skin Tint.** A split face shows 220N and the recommended shade on the same face. Beside
   it, the jawline strip puts the measured skin next to both shades, each with its ΔE00, and
   rings the recommended one. Drag the divider (or focus it and use the arrow keys), or use
   **Cart shade · Split · Recommended**. Click **Swap**, and the cart line changes.
4. **Serum Foundation** comes back as the two-shade sample. **Cushion Compact** comes back as
   no close match; click **Remove it**.
5. **Privacy receipt.** Every task and the photo are deleted, with confirmation.
6. **Returns desk.**
   - R-104 carries a reading the shopper overrode. Click **Draft with the agent**: the drafted
     exchange cites that reading. Click **Approve exchange**.
   - R-107 has no reading, so the agent stops and the case waits. Open the **Return page** tab,
     run the shopper's check there, and the exchange is drafted; approve it on the desk.
7. **Merchant panel.** The range-gap list names the shade Cushion Compact lacks.
8. **Optional: Behind the scenes** (desktop width). Every tool call appears with its actor and
   the units it spent, next to the eleven tools the agent can discover. **Try it as the agent**
   sends the two calls the agent is refused through the same chokepoint: changing the cart
   (`wrong_actor`), and smuggling a cart field into a draft (`smuggled_field`).

Every step works from the keyboard. Focus moves to the next step as each one finishes (the
sample, then Start the check, then the first card, then the next card's decision), and the
divider is a labelled slider that announces what each side of the face shows.

The static demo keeps the store in the browser tab, so move between views with the tabs at
the top; reloading the page starts the store afresh. The merchant panel's cap control shows
the `unavailable` screen: set it to 31 and start a check.

## Privacy

- Only the shopper's own photo starts an analysis. The photo goes to the YouCam API server
  for the check and nowhere else.
- When the check closes, every task is deleted through the API's task-delete endpoint. Per the
  YouCam docs, that also removes the uploaded photo. The build checks this against the live
  API, and this section will then state what it found. The privacy receipt appears once each
  deletion is confirmed.
- The API has no way to delete an uploaded photo that no task used. If an upload succeeds but
  the analysis can't start, the receipt says the photo stays with YouCam for up to 30 days.
  The store prices each check before uploading, which makes this rare.
- A task still running when the check closes is deleted as soon as it finishes. Until then,
  the receipt shows it as pending.
- If an analysis is still running after 90 seconds, the page says so and offers **Stop
  waiting**. Stopping closes the check: nothing is drafted and the bag is unchanged. The task
  can't be deleted while it runs, so the server keeps polling it in the background and
  deletes it, with the photo, when it ends; the receipt reads "Cleanup pending", then
  "Cleanup done". The "A slow analysis" sample shows this branch on sample data.
- Skin readings are cosmetic, never medical.

## Setup, run, test, lint

**Nothing to install.** Shade Guard uses Node.js built-ins only and has no dependencies, so
there is no `npm install` step and no `node_modules`. It needs Node.js 22 or later; it is
developed and verified on Node 26.1.0.

Runs today, from a fresh clone:

```bash
npm start                   # the store on sample data: http://127.0.0.1:5178
npm start -- --fake-chat    # also the support chat on a fake in-memory service: http://127.0.0.1:5178/chat.html
npm test                    # 418 tests, all offline (fake providers, a stand-in for the chat SDK, and loopback stand-ins for the live APIs)
npm run lint                # node --check on every file, plus this repo's own static rules
./verify.sh                 # the docs checks, then lint and tests
npm run build:pages -- out  # the static demo in ./out, the same modules served unbundled
```

`npm start` prints the address and the mode. With no key, or before the live provider and the
recording exist, it runs on sample data and says why. Add `?frame=phone` to the address to see
the shop's phone layout in a 390 px column. One test, the key scan of the static build, runs
only when `YOUCAM_API_KEY` is set in the environment; it then checks that the value appears in
no built file.

The static demo needs any static file server, for example `python3 -m http.server` run inside
`out`. It loads `src/pages-entry.js`, which runs the real `api.js`, `invoke()`, tools, verbs,
planner and store in the tab, and passes every request and response through JSON exactly as
the local server's socket does. The build never copies `src/config.js` (the only file that
reads the environment) or `src/server.js`, and it fails if anything it wrote reads the
environment.

The lint rules are the repository's invariants: only Node built-ins and the repository's own
files may be imported, the human-only verbs are imported by one wiring module and never by the
agent's tools, and the environment is read in one server-only file.

With your own YouCam API key (written and tested against a local stand-in; not yet run
against the live API). [Running against the live API with your own key](docs/sunday-sitting.md)
gives the order, the probes, the unit budgets and when to stop:

```bash
cp .env.example .env        # then set YOUCAM_MODE=live and your own YOUCAM_API_KEY
npm start                   # live mode, real YouCam calls; without a key it stays on sample data
YOUCAM_ENV_FILE=/path/to/your.env npm start   # or keep the key file outside the repository
npm run balance             # prints your unit balance, never the key
npm run probe -- tone --photo face.jpg        # one task end to end: shapes, values, units, then delete
npm run record -- --max-units 90 --photo face.jpg --light brighter.jpg --light dimmer.jpg
```

The live provider holds the key in one private field and sends it only as the bearer header
to the API server, never to the upload or result hosts. It paces requests at 200 per 300 s
and 5 per second, holds back after a 429, and keeps polling a task the check stopped waiting
for until it can delete it. A response in a shape it doesn't know fails with the field it
expected and the response's field names, never a guess. `npm run record` refuses to start
when its plan costs more than `--max-units`, and writes response bodies with every signed URL
replaced by a local image name.

Once the sample shopper is recorded, `npm start` serves it in replay mode with no key, and
`npm run build:pages` copies the recording into the static demo, which then replays it too.

## Status in detail

**The Nexconn Build Challenge 2026 (22 Nov 2026).** The returns desk has been extended into a
buyer–store support chat on the Nexconn Chat SDK, and it runs on Nexconn: the tools, the human-only
verbs and their re-checks, the planner's chat path, the desk and the phone, every state's words, and
the adapter. Both cases, R-104 and R-107, ran end to end over Nexconn on 22 Nov, the refusals
included, and the demo video was filmed on it. What the live run measured, and what it has still not
checked (the catch-up after a dropped connection, the service's own unread counts), are in the
[Nexconn notes](docs/nexconn-notes.md). The rest of this section describes the app as it stands.

The whole store runs today on synthetic sample data. The colour science, the fictional store,
the one `invoke` chokepoint, the eleven agent tools, the human-only verbs, the
deterministic planner, the local server, the shop, the shopper's return page, the returns
desk, the merchant panel, the support chat on its fake service and the static demo all run now,
with 419 offline tests (417 pass, 2 skipped).

The live provider, the balance check, the spike probes and the fixture recorder are tested
only against a local stand-in for the API that answers in the documented shapes. None of them
has called YouCam yet; [Running against the live API with your own key](docs/sunday-sitting.md)
is the order for the first keyed run. The replay loader is built and tested, but no recording
of a sample shopper exists yet.

Until one does, every reading comes from a fake provider, and the page says so on every
screen: its badge reads **"Sample data, not YouCam"**, and the face is a synthetic placeholder
drawn in the browser, not a person and not a YouCam render. Sections that describe the live
API describe what the code is written to do against the documented API. The build log below
records each stage as it lands.

## Build log

Each row gets its real date as the work lands, oldest first.

| Date (2026) | Stage | Status |
|---|---|---|
| 28 Sep | The plan, the licence and the verification script. No application code | Done |
| 30 Oct | The key-free core: colour science (tested on all 34 published CIEDE2000 pairs), the fictional store, the `invoke` chokepoint, nine tools, six human-only verbs, the planner, a fake provider and 79 offline tests. No API key needed, nothing installed | Done |
| 30 Oct | The local server (127.0.0.1 only), the shop with the split-face evidence card and the jawline strip, every branch screen, the privacy receipt, the shopper's return page, the returns desk, the merchant panel, Behind the scenes with Try it as the agent, and the static demo build, all on synthetic sample data. 96 offline tests, still nothing installed | Done |
| 30 Oct | The live YouCam provider (the pacer, the background finisher for a task still running at close, strict response parsing), `npm run balance`, `npm run probe` and `npm run record`, all tested against a local stand-in for the API only. 118 offline tests, nothing installed | Done |
| 30 Oct | The replay loader (`npm start` and the static demo serve a recorded sample shopper once one exists, with the real try-on renders on the face; no recording exists yet), the 90-second "still working, stop waiting" branch, and the demo video's script. 126 offline tests, nothing installed | Done |
| 30 Oct | A visual design pass over every screen: the store's own palette and type, the shade-card jawline strip, the phone header, the evidence card in two columns on wider screens, contrast fixes, and keyboard focus that follows each step. 126 offline tests, nothing installed | Done |
| 30 Oct | This repository made public | Done |
| 30 Oct | The live demo on GitHub Pages, on sample data | Done |
| 10 Nov | The support chat's key-free layer on a fake in-memory service: a chat transport interface and a fake with its own message ids and times, delayed delivery and a connection limit; two agent tools; the shopper's, staff's and the adapter's human-only verbs, each refusal tested first; the planner's chat path; the desk and the phone as two pages with words for every connection state; token and expire scripts against a local fake signer. 236 offline tests, nothing installed, nothing connected to Nexconn | Done |
| 10 Nov | Fixes from two independent reviews of that layer, each test first and each shown failing on the commit before it: an approval reads the service and refuses a thread with no offer, an empty one included; every thread read pages back by a cursor so another visit's traffic on the shared channel can't hide a message; approvals take the screen's `seen`; every gate compares in the (server time, message id) order; draft ids can't repeat after a reload; the message table bounds every number and string; another visit's messages are dropped and counted, and the log is a ring; every pane says it runs on the offline service; the seats file may not sit in any git work tree; the local server refuses POSTs from other origins. 308 offline tests (306 pass, 2 skipped as before), nothing installed, still nothing connected to Nexconn | Done |
| 16 Nov | Fixes before the live adapter, each test first and checked by an independent review: draft ids carry a random tag per desk tab, so two tabs sending at once, a reload, or a restore cut short before an older offer can't put two offers under one id (her Accept names an offer by its id); a retried send whose first answer was lost is `already_sent` instead of a second copy, still flags a shopper message that crossed it, and the failed send's words say to send the same draft again rather than redraft; an offer with other terms under the same id refuses the send (`draft_id_taken`); and the "older messages are not loaded" banner stays up once a restore was cut short, instead of clearing on the next send. 314 offline tests (312 pass, 2 skipped as before), nothing installed, still nothing connected to Nexconn | Done |
| 17 Nov | The Nexconn adapter, written before the App Key arrives: the transport interface on the SDK's published 26.2.1 names, tested against a hand-written stand-in for the SDK (the order of initialize, custom-message registration and connect; the connection states and kick codes; sends and their failure codes; history read back by a cursor, sorted and topped up so a short page means the start); the one SDK loader and the pinned import map; the seats file read field by field, served by the local server to its own chat page and copied into a static build only when named; the chat flows run unchanged on the adapter. Then fixes from two independent reviews, each test first: no history query is ever continued (the SDK continues one by time, which can drop a message sharing a millisecond), a page waits until its oldest millisecond is complete, a millisecond holding more than a page fails closed; a connect that times out lets go of the SDK; every static build that carries the demo tokens needs a second explicit setting and scans itself for the App Secret; the page's policy loads scripts only from the SDK's own CDN path; the token and expire scripts refuse a flag whose value is missing and any flag they don't take (expire has a `--dry-run`, not a `--check`). The behaviours behind the SDK's names are recorded as unverified until the first live run. 370 offline tests (368 pass, 2 skipped), nothing installed, still nothing connected to Nexconn | Done |
| 17 Nov | Key-free work for the next slice: the desk's link to the shopper's side on a phone, carrying only the seat number and the visit id (no token), with words for where it works; the desk inbox's unread counts from the chat service's channel list where the transport gives them (the offline service, and the Nexconn adapter against a stand-in for the SDK), the desk's own count otherwise, each badge saying whose it is; and a catch-up after a connection comes back by itself, which reads each thread back with the reload's page budget so messages sent while it was away appear in order, each once (with a pause in the offline walk's controls); then fixes from an independent review. 418 offline tests (416 pass, 2 skipped), nothing installed, still nothing connected to Nexconn | Done |
| 22 Nov | The first live run on Nexconn (Singapore): 12 demo users minted through the Server API, the two sides in two frames of one page, messages both ways, a reload that restores the custom messages from Nexconn's history, the paging cursor checked over 45 messages, both cases end to end with the `thread_moved` and `not_accepted` refusals, and the demo video filmed on it. Two fixes the live service showed: the Server API answers `code: 0` with the token in `result.accessToken`, and every message now shows its full id (the last six characters repeat across one sender's messages). 419 offline tests (417 pass, 2 skipped) | Done |
| Next | The first run against the live YouCam API: upload, the three analyses, delete, browser access | Planned |
| Next | Recording the sample shopper. The replay loader is built; the recording is not made | Planned |
| 22 Nov | The Nexconn demo video | Done |

## License

[MIT](./LICENSE). Fixture images carry their own licence lines in [ASSETS.md](./ASSETS.md).
The sample shopper's photo is an AI-generated portrait of no real person, made with the
YouCam AI Image Generator V2.0; its line there applies once the recording lands.
