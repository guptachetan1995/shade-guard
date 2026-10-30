# Shade Guard

**Checks the foundation in your cart against your own face, and turns a wrong-shade return
into the right exchange.**

[![The Skin Tint card on sample data: a synthetic placeholder face split down the middle, 220N on the left and 245W on the right, a divider slider and Cart shade, Split, Recommended buttons under it. Beside it, three shade chips: the measured skin #B9947C, 220N in your bag at ΔE00 4.6, and 245W recommended at ΔE00 1.9, ringed. Below them the agent's draft and the Swap to 245W and Keep mine buttons. The FAKE badge is in the header.](docs/img/evidence-card.png)](https://guptachetan1995.github.io/shade-guard/)

**[Open the demo](https://guptachetan1995.github.io/shade-guard/)**: the real app in your
browser, with no key and nothing to install. [The one-minute path](#demo-walkthrough).

**Mode today: sample data.** Every screen runs on a synthetic sample shopper and says so.\
**Run live so far: nothing.** The YouCam provider is written but has not yet called YouCam.
[Status in detail](#status-in-detail).

Shade Guard is an independent entry to the
[YouCam API Skin AI & eCommerce VTO Hackathon](https://youcam-api-skin-ai-ecommerce.devpost.com/).
It is not affiliated with or endorsed by Perfect Corp.

**Platform:** a web app for mobile and desktop browsers (Chrome, Safari). The shop is
phone-first. The returns desk and the merchant panel are desktop views.

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

## The problem

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

## Not another shade finder

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

## How a check works

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
of the sample shopper's photo, as taken and made 15% brighter and 15% darker (a brightness
shift standing in for a change of light). It is measured, not re-sent: an identical photo
sent twice may well read the same, which would say nothing about the shopper's next photo.
Until the sample shopper is recorded the band is a provisional 1.0, and the card says so. It
widens by a fixed 1.5× when the analyser says the shopper's own lighting isn't good. When two
shades sit inside the band, the draft is the two-shade sample, not a guess.

## The returns desk

A "wrong shade, opened" return reaches the store's returns desk.

- **The order carries a reading.** Say the check recommended 245W over the 220N in the cart,
  and the shopper kept 220N. The agent drafts "exchange for 245W" and cites those numbers.
- **The order carries no reading.** The shopper's return page offers "Check your shade for a
  free exchange". Only the shopper's own photo starts that check. The agent drafts the
  exchange after it. If no shade in the range fits, it drafts a refund instead.
- **A person decides.** Staff approve the exchange or the refund. The agent can't.

## The shade this range is missing, and who it is missing for

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

## YouCam APIs used

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
| Keep or re-use the shopper's photo | **Never.** No tool exists | — (deleted when the check closes) |

The seven human verbs are **never registered as a tool** the agent can discover or call. The
chokepoint also refuses them for the agent actor when they are called directly. Tests prove
both.

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

## Modes, stated plainly

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
  the real Makeup Virtual Try-On renders that were downloaded during the recording. Anything
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

## What it looks like

These are screenshots of the static demo on sample data, so the badge reads **FAKE · Sample
data, not YouCam** and the face is the synthetic canvas placeholder, stamped as such. Once the
sample shopper is recorded, the same screens show REPLAY and the real try-on renders. The
shopper's evidence card is the image at the top of this page.

![The returns desk on sample data: return R-104, Skin Tint 220N, "wrong shade, opened". The order's shade reading lists 245W at ΔE00 2.10 (recommended), 250W at 3.51 and 220N at 5.00 (returned). The agent's draft, marked not approved, is an exchange for 245W, and Approve exchange and Approve refund are the staff's buttons. The FAKE badge and the sample-data banner are at the top.](docs/img/returns-desk.png)

![The merchant panel on sample data after one check: the range gap "Cushion Compact: 1 reading with no shade within ΔE00 6, deeper and warmer than C5" with its numbers, drafts by outcome (one swap, one sample duo, one no match), units per check (36 against a 40-unit cap) and the spending cap control. The FAKE badge and the sample-data banner are at the top.](docs/img/merchant-panel.png)

## Demo walkthrough

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
   the units it spent, next to the nine tools the agent can discover. **Try it as the agent**
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
npm test                    # 126 tests, all offline (the fake provider, and a loopback stand-in for the live API)
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

The whole store runs today on synthetic sample data. The colour science, the fictional store,
the one `invoke` chokepoint, the nine agent tools, the seven human-only verbs, the
deterministic planner, the local server, the shop, the shopper's return page, the returns
desk, the merchant panel and the static demo all run now, with 126 offline tests.

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
| Next | The first run against the live YouCam API: upload, the three analyses, delete, browser access | Planned |
| Next | Recording the sample shopper. The replay loader is built; the recording is not made | Planned |
| Next | The demo video | Planned |

## License

[MIT](./LICENSE). Fixture images carry their own licence lines in [ASSETS.md](./ASSETS.md);
the sample shopper's photo, and so its line, is decided before the recording lands.
