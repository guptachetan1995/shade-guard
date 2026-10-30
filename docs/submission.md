# Devpost submission copy — Shade Guard

**Hackathon:** [YouCam API Skin AI & eCommerce VTO Hackathon](https://youcam-api-skin-ai-ecommerce.devpost.com/) ·
**Deadline:** Nov 2, 2026, 11:45 am EST (22:15 IST). **Target:** submitted by 2 Nov, 18:00 IST.

**State: first draft, written 28 Sep 2026 before any code, and revised the same day after two
independent plan reviews.**

- This file is the copy for each field of the Devpost "Enter a Submission" form. It also
  holds the checklist those fields answer and the split of who does what.
- Where a value can only exist later (a URL, a measured number), the field says **pending**
  and names what fills it.
- The form opens with the Submission Period (Sep 29, 2026, 12:00 pm ET). Its exact field list
  is read on the live form, and this file is updated to match. The fields below are Devpost's
  standard ones plus what the Official Rules require.
- Every link in this file is absolute, because Devpost can't follow a relative link. A URL
  that doesn't exist yet is written as plain text until it does.

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

*Pending (researched 9–11 Oct): at most one cited public figure on beauty returns or on
opened-cosmetics disposal, from a primary source where one exists. If no source is found, no
number is used.*

### What it does

**It checks the foundation in your cart against your own face, and turns a wrong-shade return
into the right exchange.** One reading of the shopper's face serves three retail moments.

**Before checkout.** Under the foundations in the cart, a line reads *"Not sure about these
shades? Check them on your face."* The shopper takes a photo with the YouCam Camera Kit or
uploads one, on bare skin. An agent does the rest:

- **Measures once, for the whole cart:**
  - The YouCam **AI Facial Color Tones Analyzer** returns the skin colour and its own verdict
    on the photo's lighting.
  - **AI Skin Analysis** returns skin type, oiliness, moisture and redness.
- **Ranks** every shade of every foundation in the cart by CIEDE2000 colour difference against
  that reading. An uncertainty band, measured on readings of one face under shifted light, says when two
  shades are too close to call.
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

**In the range plan.** Every "no close match" is kept as numbers and listed for the
merchandiser, for example "no shade within ΔE 6, deeper and warmer than C5". That is the
shade the range lacks.

**The retail value:**
- fewer wrong-shade purchases;
- exchanges instead of write-offs;
- a range gap surfaced to the merchant instead of hidden behind an upsell;
- the cost of every check visible in units, next to its outcome.

### How we built it

*Pending: rewritten from the actual build. The plan is below.*

- **Platform.** A web app for mobile and desktop browsers. The shop is phone-first.
- **Server.** Node.js built-ins only, with nothing to install, on one
  `invoke(tool, args, actor)` chokepoint. The store's buttons and the agent's tool calls take
  the same path.
- **Agent.** A deterministic planner with no language model. It branches on what the API
  actually returns:
  - a face-angle error becomes a retake at 0 units;
  - two shades inside the band become a sample duo;
  - a large distance becomes "no match", and a range-gap entry for the merchant.
- **YouCam integration** covers the full async lifecycle:
  - One normalised upload that every endpoint accepts. The browser turns each photo into a
    JPEG with a long side of 1024 px, because Makeup Virtual Try-On rejects a raw phone
    photo.
  - The File API: create the file, PUT it to the pre-signed URL, reuse one file id across
    tasks.
  - Create each task, then poll it with backoff. Calls are paced with a sliding window under
    the documented rate limit, with 429 retry.
  - A slow task is polled to completion in the background, then deleted.
  - Download each result as soon as it arrives, because result URLs expire after 2 hours.
  - Map engine errors to plain retake guidance.
  - Delete each task when the check closes.
  - Price the whole check before uploading, and check every paid call against a per-check
    unit cap, using the free feature-cost and balance endpoints.
- **Colour science is our own code:**
  - sRGB → CIELAB → CIEDE2000, tested against the published Sharma, Wu & Dalal (2005) test
    pairs;
  - decisions use Skin Analysis `raw_score`, not the deliberately favourable `ui_score`.
- **Three interchangeable providers:** live (real calls), replay (real recorded responses, no
  network) and fake (for tests).
- **The public demo page** runs the same bundled code. It replays a recorded sample shopper,
  or, with your own key, makes live calls from the page.

### Challenges we ran into

*Pending: written from what actually happened during the build.*

### Accomplishments that we're proud of

*Pending: written from the finished build.*

### What we learned

*Pending: written from the finished build.*

### What's next

- Merchant-measured swatch colours (spectrophotometer readings) for a real range, instead of
  authored ones.
- A second capture under different light for each shopper, so the band is per shopper rather
  than per range.
- Concealer matched relative to the chosen foundation.
- Exposing the nine agent tools over MCP, so any tool-calling agent can drive the store while
  cart changes, refunds and spending stay human clicks.

## Built with

The final list comes from what the build actually used:

`javascript` · `node.js` · `html5` · `css3` · `youcam-api` · `perfect-corp` ·
`ai-facial-color-tones-analyzer` · `ai-skin-analysis` · `ai-makeup-virtual-try-on` ·
`youcam-camera-kit` · `ciede2000` · `github-pages`

## Try it out links

- **Code repository:** `github.com/guptachetan1995/shade-guard` (pending: created when the
  entry is published on 29 Oct, and written as a full link from then on).
- **Live demo:** pending. The static page is deployed from the same repository on 29 Oct.

## Video demo link

Pending: the owner uploads the agent-rendered video (at most 3 minutes) to YouTube as
**Public** and pastes the link.

## Image gallery (planned captions)

1. One face, two shades: the split-face try-on with the jawline strip.
2. Three foundations in the cart, with the "Check them on your face" prompt, at phone width.
3. The evidence card: ΔE numbers, the ± band, the undertone, the lighting verdict and the
   finish.
4. `sample_duo` and `no_match`: honest uncertainty instead of a forced answer.
5. The privacy receipt after the check closes.
6. The returns desk: a drafted exchange citing the order's reading, awaiting a staff click.
7. The merchant panel: the range-gap list and the units per check.

**Thumbnail:** the split-face composite: one face, the cart shade on the left, the
recommended shade on the right, and the jawline strip.

## Hackathon-specific fields (confirm on the live form)

| Field (expected) | Draft answer |
|---|---|
| Code repository URL | `github.com/guptachetan1995/shade-guard` (pending until published on 29 Oct). Public, with the MIT licence visible at the root |
| Platform | Web app for mobile and desktop browsers (Chrome, Safari) |
| Testing instructions | See [Testing instructions](#testing-instructions) below |
| YouCam API(s) used | AI Facial Color Tones Analyzer (Skin), AI Skin Analysis SD (Skin), AI Makeup Virtual Try-On (Beauty). Also the File API, the unit balance and feature-cost endpoints, task delete, and the YouCam Camera Kit for capture |
| New or existing project | New. Planning notes were drafted on 28 Sep. All application code was written from 1 Oct 2026, inside the Submission Period |
| Special awards (Women in Tech / Rising Star) | The owner's answer only. Not assumed |

## Testing instructions

The rules require access "free of charge and without any restriction". Shade Guard is a web
app for mobile and desktop browsers.

1. **No setup, no key.** Open the live demo link and click **Try with a sample shopper**. It
   runs the real application code in **replay mode**: real YouCam API responses recorded from
   live calls, served back with no network and no key. Follow the "Demo walkthrough" section
   of the repository's README (linked here once the repository is public). The path is cart →
   check → evidence → Swap → privacy receipt → returns desk → Approve exchange → merchant
   panel. A new photo can't be analysed in replay mode, and the page says so.
2. **Live, with your own key, no install.** On the same page, choose **Live with your own
   key** and paste a YouCam API key. The key stays in that tab's memory, is never stored, and
   is sent only to the YouCam API. A three-product check costs about 36 units. (This mode
   ships only if the API's upload and result hosts accept browser requests. The build checks
   that from 1 Oct, and this item is removed if they don't.)
3. **Live, locally:** clone the repository (there is nothing to install), then run
   `cp .env.example .env`. Set `YOUCAM_MODE=live` and your `YOUCAM_API_KEY`, run `npm start`,
   and open `http://127.0.0.1:5178`.
4. **Tests:** run `npm test`. All tests run offline.

There are no logins and no accounts to create for the demo.

## YouTube upload details (draft; sent with the video file)

| Field | Value |
|---|---|
| Title | Shade Guard — foundation shade check, exchange and range gaps (YouCam API hackathon) |
| Description | The elevator pitch above; then "YouCam APIs used: AI Facial Color Tones Analyzer, AI Skin Analysis, AI Makeup Virtual Try-On."; then the repository and demo links; then "Built for the YouCam API Skin AI & eCommerce VTO Hackathon. Independent entry, not affiliated with Perfect Corp." |
| Tags | youcam api, skin analysis, virtual try-on, foundation shade, ecommerce, beauty tech, returns, hackathon |
| Category | Science & Technology |
| Visibility | **Public**. Devpost requires it; Unlisted or Private fails the rule |

## Judging criteria — where to look

| Criterion (Official Rules §6) | Where the evidence will be |
|---|---|
| Technological Implementation | The README's "YouCam APIs used" section. The live-provider code and its request-shape tests. The one normalised upload. Pricing before upload, and the unit-cap check in the chokepoint. "Live with your own key" on the demo page. The video's API overlay, which names each call and its units |
| Design | The split-face evidence card and jawline strip. The shop flow at phone width, and every branch screen (retake, sample duo, no match, unavailable). The privacy receipt. The returns desk and the merchant panel |
| Potential Impact | [What it does](#what-it-does): prevention, then an exchange instead of a write-off (even for an order that had no check), then the range gap shown to the merchandiser. The measured band on every card |
| Quality of the Idea | The check on the cart and on the order. One reading across the cart. The band measured on readings of one face under shifted light. `no_match` turned into a range gap. Skin smoothing off. `raw_score` over `ui_score`. The human gate on cart, refund and spend |

## What this entry does not claim

- **No medical claims.** Skin readings are cosmetic and used only to pick a finish.
- **No lab-grade colour.** One photo under unknown light is an estimate. That is why every
  card shows a measured band, the app offers a sample duo and says "no match", and the render
  is shown.
- **No real store, money or stock.** The store, the ranges, the orders and the refunds are
  fictional and simulated.
- **The ranges are authored around one reading.** The three foundation ranges are authored
  around the one recorded sample shopper, so one face shows every outcome. The band and the
  thresholds are not tuned to the demo.
- **No language model.** The agent is a deterministic planner.
- **The default demo is a replay** of recorded real responses, and it says so on every screen.

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

## Who does what before submitting

**Agent,** in a live session in the owner's Chrome:
- publishes the repository and deploys the demo on 29 Oct, then walks the demo on the live
  URL;
- renders the final video against the live URLs and hands it over with the YouTube details
  above;
- fills every Devpost field from this file, including links, gallery, thumbnail and built-with
  tags;
- turns the repository name above into a full link, and replaces the testing instructions'
  README reference with the absolute link to `github.com/guptachetan1995/shade-guard#demo-walkthrough`,
  once the repository is public;
- adds the video link once the owner pastes it;
- runs the judge-panel review and fixes what it finds;
- verifies every checklist line against the live draft, the live demo and the public
  repository.

**Owner:**
1. Uploads the video to YouTube as **Public** and pastes the link (2 Nov, by 14:00 IST).
2. Clicks **Submit** (and solves any captcha), by 2 Nov 18:00 IST.
