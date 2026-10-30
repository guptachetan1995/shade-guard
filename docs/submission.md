# Devpost submission copy — Shade Guard

**Hackathon:** [YouCam API Skin AI & eCommerce VTO Hackathon](https://youcam-api-skin-ai-ecommerce.devpost.com/) ·
**Deadline:** Nov 2, 2026, 11:45 am EST (22:15 IST). **Target:** submitted by 2 Nov, 18:00 IST.

- This file is the copy for each field of the Devpost "Enter a Submission" form. It also
  holds the checklist those fields answer.
- Every sentence outside the two comment blocks below is true of the code today. Where a
  value can only exist later (the video link, its timestamps), the field says **pending** and
  names what fills it.
- Two HTML comment blocks hold copy that is not true yet. `after-sunday` is filled once the
  first keyed run against the live API has happened and a sample shopper is recorded.
  `if-sunday-fails` holds the replacement sentences for the case where that run can't happen.
- Every link in this file is absolute, because Devpost can't follow a relative link.

## Project name

Shade Guard

## Elevator pitch

At most 200 characters. This one is 197:

> Checks the foundation in your cart against your own face with YouCam skin-tone analysis and try-on, and turns a wrong-shade return into the right exchange. Only a human click changes cart or money.

## About the project

The rules require that the text description "explain the features, functionality and
demonstrate clear consumer or retail value".

### Inspiration

Foundation is bought by colour, and colour is the one thing a product photo can't show on
your skin. Online, a wrong guess ends one of two ways. The shopper keeps a shade that doesn't
match, or returns it opened. Opened cosmetics generally can't be resold, so the store writes
the unit off and refunds it.

Shoppers at the ends of a shade range, or with olive or deep undertones, are hit hardest. For
some of them the range has no match at all. A shade finder that always names a "best match"
hides that gap. The merchandiser who could fix the range hears about it months later, if at
all.

### What it does

**It checks the foundation in your cart against your own face, and turns a wrong-shade return
into the right exchange.** One reading of the shopper's face serves three retail moments.

**Not another shade finder.** Perfect Corp's own AI Shade Finder answers "which shade?" on a
brand's site. Shade Guard starts where that ends. It checks the cart the shopper actually
built. It may answer "no shade in this range is close". It turns a near-tie into a two-shade
sample with a measured ± band. On the returns desk, it drafts the exchange from the reading
stored on the order, instead of writing off an opened unit. And it sends every no-match
reading to the merchandiser as a range gap. Last round's winners ShadeSpan and CASTING check
apparel or a catalogue against a fixed panel of skin tones before a product goes live; Shade
Guard works from one real shopper's face, against their own cart and order.

**Before checkout.** Under the foundations in the cart, a line reads *"Not sure about these
shades? Check them on your face."* The shopper uploads a photo on bare skin (on a phone, the
picker also offers the camera). An agent does the rest:

- **Measures once, for the whole cart:**
  - The YouCam **AI Facial Color Tones Analyzer** returns the skin colour and its own verdict
    on the photo's lighting.
  - **AI Skin Analysis** returns skin type, oiliness, moisture and redness.
- **Ranks** every shade of every foundation in the cart by CIEDE2000 colour difference against
  that reading. An uncertainty band, from readings of one face under shifted light, says when
  two shades are too close to call.
- **Shows** the cart shade and the best match on the shopper's own face as one split face,
  using **AI Makeup Virtual Try-On** with skin smoothing turned off, so it's the shade and not
  a filter. A jawline strip puts the measured skin next to both swatches.
- **Drafts one recommendation per product** with its evidence:
  - keep;
  - swap (to a named shade, with a finish chosen from skin type);
  - order the two-shade sample (when two shades sit inside the band);
  - "no shade in this range is close";
  - retake (with exact pose guidance);
  - unavailable (when the store's per-check unit cap can't cover the check).

The cart changes only when the shopper clicks **Swap**, **Get the sample duo**, **Remove it**
or **Keep mine**. When the check closes, every YouCam task is deleted through the API, and a
privacy receipt confirms it. The order keeps the reading's numbers, never the photo.

**At the returns desk.** When a product comes back as "wrong shade, opened":
- **If the order carries a reading,** the agent drafts an exchange for the shade the reading
  supported, instead of a refund, and cites the numbers.
- **If the order has no reading,** the shopper's return page offers a check first.
- **If no shade in the range fits,** the draft is a refund.
- **Only a staff member approves an exchange or a refund.**

**The shade this range is missing, and who it is missing for.** Every "no close match" is kept
as numbers (the reading's lightness, chroma and hue, the nearest shade and the direction to
the reading) and listed for the merchandiser, for example "Cushion Compact: 1 reading with no
shade within ΔE00 6, deeper and warmer than C5". "Who" is a measured colour, never a person:
the panel holds no photo and infers nothing about the shopper.

**The retail value:**
- fewer wrong-shade purchases;
- exchanges instead of write-offs;
- a range gap surfaced to the merchant instead of hidden behind an upsell;
- the cost of every check visible in units, next to its outcome.

**Where it stands today.** The whole store, the agent and the static demo run on synthetic
sample data, and every screen says so. The live YouCam provider is written to the documented
API and tested against a local stand-in; it has not yet called YouCam.

<!-- after-sunday
Replace "Where it stands today" with:

**Where it stands.** The demo replays real YouCam responses recorded on {date} from a sample
shopper: {n} tone readings, one Skin Analysis reading and {k} Makeup Virtual Try-On renders,
{units} units in all. The band on every card is {spread} ΔE00, measured from three readings of
one face under shifted light. Task delete {did / did not} remove the uploaded photo: {finding}.
Every screen says REPLAY and names the recording date.

Also, after the run:
- Testing instructions, item 1: the button is "Use the recorded sample shopper" and the badge
  reads REPLAY · Recorded YouCam responses.
- Testing instructions, item 2: drop "it has not yet run against YouCam"; say what ran.
- How we built it, "Three providers": replay serves the recording of {date}.
- What this entry does not claim, last line: "The demo is a replay of recorded real
  responses, and it says so on every screen."
- Judging criteria: add the video timestamps.
-->

<!-- if-sunday-fails
If the keyed run can't happen (signup asks for a card, or the redeem code is refused), the
default copy above stays as it is, with these sentences in place of "Where it stands today":

**Where it stands.** The live YouCam provider is written to the documented API, tested against
a local stand-in that answers in the documented shapes, and has not run against YouCam. The
demo and the video run on synthetic sample data, and every screen says so.

And in Testing instructions, item 2, in place of its status sentence:

The live provider is written to the documented API and has not run against it.
-->

### How we built it

- **Platform.** A web app for mobile and desktop browsers. The shop is phone-first; the
  returns desk and the merchant panel are desktop views.
- **Zero dependencies.** Node.js built-ins on the server and plain ES modules in the browser.
  There is no `npm install` and no lockfile; `package.json` declares no dependencies, and the
  verification script fails if one appears.
- **One chokepoint.** Every action, from a store button or from the agent, goes through one
  `invoke(tool, args, actor)` function: the same mutation, then a re-render. The seven
  human-only verbs (start a check, apply or keep a draft, stop waiting, approve an exchange or
  a refund, set the unit cap) are never registered as tools, and the chokepoint refuses them
  for the agent actor if called directly. Each verb accepts only its own actor. Tests prove
  each of these.
- **Agent.** A deterministic planner with no language model. It branches on what the provider
  returns:
  - a face-angle error becomes a retake at 0 units;
  - two shades inside the band become a sample duo;
  - a large distance becomes "no match", and a range-gap entry for the merchant.
- **The YouCam integration, written to the documented API:**
  - One photo every endpoint accepts. The browser turns each photo into a JPEG with a long
    side of 1024 px, and the server checks type and dimensions again at `start_check`.
  - The File API: create the file, PUT it to the pre-signed URL, reuse one file id across
    tasks.
  - Create each task, then poll it with backoff. Requests are paced at 200 per 300 s and 5 per
    second, and the provider holds back after a 429.
  - Download each result as soon as it arrives, because result URLs expire after 2 hours.
  - Map engine errors to one sentence of retake guidance each.
  - Price the whole check before uploading, and check every paid call against the per-check
    unit cap inside the chokepoint, before the request is sent, using the free balance and
    feature-cost endpoints.
  - Delete every task when the check closes. A task still running is polled in the
    background until it ends, then deleted.
  - Parse strictly: a response in a shape the code doesn't know fails with the field it
    expected and the response's field names, never a guess.
- **The API's own outputs, read carefully.** Decisions use Skin Analysis `raw_score`, not
  `ui_score`, which the docs say is adjusted "to produce more favorable results". Try-on
  renders set `skin_smooth` to 0, because the docs apply 50 otherwise.
- **Colour science is our own code:** sRGB → CIELAB → CIEDE2000, tested against all 34
  published Sharma, Wu & Dalal (2005) test pairs to four decimal places.
- **Three providers behind one interface:** fake (synthetic sample data, used by the tests
  and the demo today), replay (serves a recorded sample shopper once one exists, with no
  network) and live (real calls with your own key, from the local server only).
- **The public demo page** runs the same modules, unbundled, in the browser tab: the real
  `invoke()`, tools, human verbs, planner and store, with every request and response passed
  through JSON as the local server's socket would. The build never copies the one file that
  reads the environment, or the server.
- **126 offline tests**, including a loopback stand-in for the live API that answers in the
  documented shapes.

### Challenges we ran into

- **Building the live side without a key.** Most of the build ran with no API key. The live
  provider is written to the documented shapes and tested against a local stand-in, and every
  shape the docs don't give (the balance response, the feature-cost list, the engine-error
  envelope) is marked unverified in the code and parsed strictly. A set of probes settles each
  open question at a known unit cost, cheapest first.
- **One photo for three endpoints.** The documented limits differ: the tone analyser takes
  JPEG only, Skin Analysis needs a short side of at least 480 px, and Makeup Virtual Try-On
  needs the width under 1920 px and the height under 1080 px. A phone photo breaks the last
  one. So the browser normalises every photo once, to a JPEG with a 1024 px long side, before
  anything is uploaded.
- **Deleting everything is harder than it sounds.** A running task can't be deleted, and an
  uploaded photo that no task used can't be deleted at all. So the store prices the whole
  check before uploading, a task still running at close is polled in the background and then
  deleted, and the privacy receipt shows "Cleanup pending" until each deletion is confirmed.
- **Letting the shopper leave.** After 90 seconds a running analysis offers **Stop waiting**.
  Stopping closes the check with nothing drafted and the bag unchanged, but the task still
  runs and still costs its units, so cleanup continues behind the receipt. Stopping is a
  human verb: the agent can't stop a check, and nobody can before 90 seconds.
- **Uncertainty that means something.** An identical photo sent twice may read the same,
  which says nothing about the shopper's next photo. So the band comes from three readings of
  one face as taken, 15% brighter and 15% darker, not from re-sends. Until it is measured, the
  band is a provisional 1.0 and the card says so.

### Accomplishments that we're proud of

- **Nothing to install.** Clone it and run `npm start` or `npm test`: no dependencies, 126
  offline tests.
- **A human gate the code enforces, not a convention.** The agent can't discover a human verb,
  can't call one through the chokepoint, and the route that runs it takes no actor at all.
- **An answer of "no close match"** that tells the shopper the truth and gives the
  merchandiser a range gap in numbers, instead of upselling the least-bad shade.
- **Colour maths that matches the reference** on all 34 published CIEDE2000 pairs.
- **A privacy receipt** built on the API's task delete, including the cases where a deletion
  has to wait.
- **Every branch has a designed screen** (retake, sample duo, no match, unavailable, stop
  waiting, a return waiting for the shopper's check), and every step works from the keyboard.

### What we learned

- Read an API for what it softens on purpose: `ui_score` is made to look better, so decisions
  use `raw_score`.
- Endpoint limits differ inside one API; normalise once, at the edge, before anything is sent
  or spent.
- Measure uncertainty from what actually changes between photos, the light, not from
  re-sending the same bytes.
- A refusal is data. Every "no close match" is a shopper the range doesn't serve, and the
  merchandiser should see it.
- Deletion has edges. Design the receipt around the cases the API can't delete at once.

### What's next

- **Live with your own key in the demo page:** real calls from the static page with a key
  kept in that tab's memory, if the API's upload and result hosts accept browser requests.
  It is designed but not built.
- Guided capture with the YouCam Camera Kit, which checks lighting and pose before the photo
  is taken.
- Merchant-measured swatch colours (spectrophotometer readings) for a real range, instead of
  authored ones.
- A second capture under different light for each shopper, so the band is per shopper rather
  than per range.
- Concealer matched relative to the chosen foundation.
- Exposing the nine agent tools over MCP, so any tool-calling agent can drive the store while
  cart changes, refunds and spending stay human clicks.

## Built with

`javascript` · `node.js` · `html5` · `css3` · `youcam-api` · `perfect-corp` ·
`ai-facial-color-tones-analyzer` · `ai-skin-analysis` · `ai-makeup-virtual-try-on` ·
`ciede2000` · `github-pages`

## Try it out links

- **Code repository:** https://github.com/guptachetan1995/shade-guard
- **Live demo:** https://guptachetan1995.github.io/shade-guard/ (the real application code in
  the browser; no key, nothing to install)

## Video demo link

Pending: the link is added once the video (at most 3 minutes) is on YouTube as **Public**.

## Image gallery (planned captions)

1. One face, two shades: the split-face try-on with the jawline strip.
2. Three foundations in the cart, with the "Check them on your face" prompt, at phone width.
3. The evidence card: ΔE numbers, the ± band, the undertone, the lighting verdict and the
   finish.
4. `sample_duo` and `no_match`: honest uncertainty instead of a forced answer.
5. The privacy receipt after the check closes.
6. The returns desk: a drafted exchange citing the order's reading, awaiting a staff click.
7. The merchant panel: the shade the range is missing, and the units per check.

**Thumbnail:** the split-face composite: one face, the cart shade on the left, the
recommended shade on the right, and the jawline strip.

## Hackathon-specific fields (confirm on the live form)

| Field (expected) | Draft answer |
|---|---|
| Code repository URL | https://github.com/guptachetan1995/shade-guard (public, with the MIT licence at the root) |
| Platform | Web app for mobile and desktop browsers (Chrome, Safari) |
| Testing instructions | See [Testing instructions](#testing-instructions) below |
| YouCam API(s) used | AI Facial Color Tones Analyzer (Skin), AI Skin Analysis SD (Skin), AI Makeup Virtual Try-On (Beauty). Also the File API, the unit balance and feature-cost endpoints, and task delete |
| New or existing project | New. Planning notes were drafted on 28 Sep. All application code was written inside the Submission Period; the first code commit is dated 30 Oct 2026 |
| Special awards (Women in Tech / Rising Star) | The entrant's own answer only. Not assumed |

## Testing instructions

The rules require access "free of charge and without any restriction". Shade Guard is a web
app for mobile and desktop browsers.

1. **No setup, no key.** Open https://guptachetan1995.github.io/shade-guard/ and click
   **Check them on my face**, then **Use the synthetic sample shopper**, then **Start the
   check**. The page runs the real application code in your browser on synthetic sample
   data, and its badge says so: **FAKE · Sample data, not YouCam**. Follow the demo
   walkthrough at https://github.com/guptachetan1995/shade-guard#demo-walkthrough. The path
   is cart → check → evidence → Swap → privacy receipt → returns desk → Approve exchange →
   merchant panel. A new photo can't be analysed on sample data, and the page says so.
2. **Live, locally, with your own key.** Clone the repository (there is nothing to install),
   run `cp .env.example .env`, set `YOUCAM_MODE=live` and your `YOUCAM_API_KEY`, run
   `npm start`, and open `http://127.0.0.1:5178`. A three-product check costs about 36 units.
   The live provider is written to the documented API and tested against a local stand-in;
   it has not yet run against YouCam. The step-by-step guide, with probes, unit budgets and
   stop conditions, is
   https://github.com/guptachetan1995/shade-guard/blob/main/docs/sunday-sitting.md.
3. **Tests:** run `npm test`. All 126 tests run offline.

There are no logins and no accounts to create for the demo.

## YouTube upload details (draft; sent with the video file)

| Field | Value |
|---|---|
| Title | Shade Guard — foundation shade check, exchange and range gaps (YouCam API hackathon) |
| Description | The elevator pitch above; then "YouCam APIs used: AI Facial Color Tones Analyzer, AI Skin Analysis, AI Makeup Virtual Try-On."; then https://github.com/guptachetan1995/shade-guard and https://guptachetan1995.github.io/shade-guard/; then "Built for the YouCam API Skin AI & eCommerce VTO Hackathon. Independent entry, not affiliated with Perfect Corp." |
| Tags | youcam api, skin analysis, virtual try-on, foundation shade, ecommerce, beauty tech, returns, hackathon |
| Category | Science & Technology |
| Visibility | **Public**. Devpost requires it; Unlisted or Private fails the rule |

## Judging criteria — where to look

Video timestamps: after the final render.

| Criterion (Official Rules §6) | Where the evidence is |
|---|---|
| Technological Implementation | README: [YouCam APIs used](https://github.com/guptachetan1995/shade-guard#youcam-apis-used), [How a check works](https://github.com/guptachetan1995/shade-guard#how-a-check-works), [Setup, run, test, lint](https://github.com/guptachetan1995/shade-guard#setup-run-test-lint) and [Status in detail](https://github.com/guptachetan1995/shade-guard#status-in-detail). The live provider and its tests against a loopback stand-in; the one normalised upload; pricing before upload and the unit-cap check in the chokepoint. Demo: https://guptachetan1995.github.io/shade-guard/, where Behind the scenes lists every tool call with its actor and units. Video: the progress card names each YouCam call and its units |
| Design | README: [What it looks like](https://github.com/guptachetan1995/shade-guard#what-it-looks-like) and [Demo walkthrough](https://github.com/guptachetan1995/shade-guard#demo-walkthrough). Demo: https://guptachetan1995.github.io/shade-guard/ (add `?frame=phone` for the shop at phone width): the split face and jawline strip, every branch screen, the privacy receipt, the returns desk and the merchant panel |
| Potential Impact | README: [The problem](https://github.com/guptachetan1995/shade-guard#the-problem), [The returns desk](https://github.com/guptachetan1995/shade-guard#the-returns-desk) and [The shade this range is missing](https://github.com/guptachetan1995/shade-guard#the-shade-this-range-is-missing-and-who-it-is-missing-for). Demo: R-104's exchange, R-107's check from the return page, and the merchant panel |
| Quality of the Idea | README: [Not another shade finder](https://github.com/guptachetan1995/shade-guard#not-another-shade-finder), [What the agent does, what only a human does](https://github.com/guptachetan1995/shade-guard#what-the-agent-does-what-only-a-human-does), [Tools](https://github.com/guptachetan1995/shade-guard#tools) and [Privacy](https://github.com/guptachetan1995/shade-guard#privacy). The check on the cart and on the order, the measured band, `no_match` turned into a range gap, skin smoothing off, `raw_score` over `ui_score` |

## What this entry does not claim

- **No medical claims.** Skin readings are cosmetic and used only to pick a finish.
- **No lab-grade colour.** One photo under unknown light is an estimate. That is why every
  card shows a band, the app offers a sample duo and says "no match", and the render is shown.
- **No real store, money or stock.** The store, the ranges, the orders and the refunds are
  fictional and simulated.
- **The ranges are authored around one reading.** The three foundation ranges are authored
  around the sample shopper's reading, so one face shows every outcome. The band and the
  thresholds are not tuned to the demo.
- **No language model.** The agent is a deterministic planner.
- **No live call yet.** The demo runs on synthetic sample data today, and it says so on every
  screen.

## Submission checklist — where each rule is answered

| Rule (Official Rules §4) | Answered by |
|---|---|
| Working application integrating at least one YouCam API from the named categories, with consumer or retail value | Three Skin/Beauty APIs. [What it does](#what-it-does) |
| Repository URL with all source, assets and instructions; public with licence | [Try it out links](#try-it-out-links), with the MIT licence at the root and fixture-image licences in `ASSETS.md` |
| Text description: features, functionality, consumer or retail value | [About the project](#about-the-project) |
| 1–3-minute demo video: end-to-end, explains the YouCam API used, footage on the target device, public on YouTube, no third-party trademarks or copyrighted music | [Video demo link](#video-demo-link). Narration only and a fictional store. The platform is stated as a web app for mobile and desktop browsers, and the footage is that app in a browser, at phone width and on desktop |
| Testing access free of charge and without restriction until judging ends | [Testing instructions](#testing-instructions). The demo page and repository stay up and unchanged through Nov 20, 2026 |
| English | Everything is in English |
| New project, or significantly updated during the Submission Period | [Hackathon-specific fields](#hackathon-specific-fields-confirm-on-the-live-form) |

## Before submitting

- Walk the demo on the live URL, logged out.
- Render the final video against the live URL, upload it to YouTube as **Public**, and add
  the link and its timestamps here.
- Fill every Devpost field from this file: links, gallery, thumbnail and built-with tags.
- Run the judge-panel review and fix what it finds.
- Check every checklist line against the live draft, the live demo and the public
  repository, then submit by 2 Nov, 18:00 IST.
