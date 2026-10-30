# Shade Guard: demo video script

**Length:** at most 3:00 (the hackathon's limit); this script runs about 2:45. English
narration from macOS `say`, no music, no third-party brands.

**How it is made.** Every picture is a screenshot of the real static demo page (the same
modules as `npm run build:pages`), driven through its own buttons in a headless browser, and
held for exactly as long as its sentence takes. Nothing is drawn over the app; the framing
only zooms, scrolls and keeps the page's own header, with its mode badge, at the top of the
frame. Moving parts are frame-stepped: the divider sweep is four short stills, each a real
state of the slider. The shop is filmed at phone width (`?frame=phone`); the returns desk and
the merchant panel at desktop width.

**Which mode is on screen.** The final cut is filmed in **REPLAY**: real YouCam responses and
the real Makeup Virtual Try-On renders, recorded from the sample shopper, with the badge
reading REPLAY in every frame. The build refuses a final cut when the badge reads anything
other than REPLAY or LIVE, and fails if "FAKE", "Sample data, not YouCam" or "SYNTHETIC" is
on screen. Before the recording exists, only a draft can be made: the badge reads FAKE · Sample
data, not YouCam, the face is the synthetic placeholder stamped "SYNTHETIC · not a person ·
not YouCam", and the opening line says so.

**The numbers.** The ΔE values, the band, the undertone, the lighting verdict, the finish and
the shade codes the narration speaks are read from the same app on the same provider just
before filming, so the voice and the screen always agree. The values in braces below are
those; the draft on sample data reads 220N → 245W, ΔE00 4.6 against 1.9, band ± 1.0, warm,
good, combination → satin, S14 + S15, nearest C5.

| # | On screen | Narration |
|---|---|---|
| 1 | The Skin Tint evidence card: one face, left half in the cart shade, right half in the recommended shade, divider in the middle | A wrong-shade foundation is the return a store can't resell. Here is one face in two shades: {cart} from the bag on the left, {best} on the right. *(Draft only: "In this draft, a synthetic face.")* |
| 2 | The bag at phone width: three foundations and a setting spray, and the line "Not sure about these shades? Check them on your face" | Shade Guard checks every foundation in a shopper's bag against her own face, with one reading, before she pays. |
| 3a | The capture card: bare skin, face the light, fill the oval; the sample shopper chosen; the consent line and **Start the check** | Only the shopper's own click starts a check: bare skin, face the light, and the photo is deleted afterwards. The agent has no tool that can start one. |
| 3b | The same card, with the mode badge in the header | The badge at the top always says what is answering. Here it is a recording of real YouCam API calls. |
| 4 | The progress card while the agent works: Facial Color Tones Analyzer · 20 units, Skin Analysis (SD) · 9, ranking · 0, Makeup Virtual Try-On · 1 per render | The agent calls three YouCam APIs. The Facial Color Tones Analyzer reads skin colour and light, for 20 units. Skin Analysis reads skin type, for 9. Makeup Virtual Try-On renders each shade, 1 unit a render. |
| 5a | Skin Tint evidence, divider at **Cart shade** | Skin Tint. {cart} is Delta E {ΔE cart} from her reading; {best} is {ΔE best}, well outside the plus or minus {band} band. |
| 5b | The divider sweeps from the cart shade to the recommended shade (four 280 ms stills) | *(no narration)* |
| 5c | The jawline strip: measured skin, cart shade, recommended shade; the agent's draft and **Swap to {best}** | The jawline strip puts her measured skin beside both swatches. Her undertone reads {undertone}, the light is {lighting}, and {skin type} skin points to a {finish} finish. |
| 5d | **Swap** clicked: the bag's Skin Tint line now reads {best}, "Changed by you" | The agent only drafted the swap. Her click changed the bag to {best}. |
| 6a | Serum Foundation: two shades too close to call, the two-shade sample | Serum Foundation: {duo 1} and {duo 2} sit inside the band of each other, so the draft is the two-shade sample, not a guess. |
| 6b | Cushion Compact: no close match; the nearest shade on the face, still off; "we won't guess"; **Remove it** | Cushion Compact: no shade in this range is within Delta E 6 of her reading. The nearest, {nearest}, is still off, and the draft says so instead of selling it. |
| 7 | The privacy receipt after the last decision: every task deleted and confirmed, the photo deleted with them | Her last decision closes the check. Every analysis task is deleted, and the photo with it. The order keeps only the numbers. |
| 8a | Returns desk, desktop: R-104 "wrong shade, opened", with the reading on the order (245W recommended, 220N kept) | At the returns desk, R-104 came back opened. Its order carries the reading: 245W was recommended, and the shopper kept 220N. |
| 8b | **Draft with the agent**: the drafted exchange, not approved | The agent drafts an exchange for 245W and cites those numbers. |
| 8c | **Approve exchange** clicked by staff | Only a member of staff approves it. Stock and money move on a person's click, never the agent's. |
| 8d | R-107: no reading; the agent stopped | R-107 has no reading, so the agent stops. It cannot ask anyone for a photo. |
| 8e | The shopper's return page for R-107 after her own check: the exchange drafted, waiting for staff, and her privacy receipt | The shopper's return page offers a free shade check. She runs it herself, and the agent drafts the exchange for staff to approve. |
| 9 | Merchant panel: the range gap for Cushion Compact, drafts by outcome, units per check against the cap | The merchant panel turns every no-match into a range gap: the shade this range lacks, from real shoppers' readings, and what each check cost against the cap. |
| 10 | Closing card: the three YouCam APIs, the code repository and the demo page | Shade Guard, on three YouCam APIs. Try the sample shopper on the demo page, or run it with your own key. |

**Not in the video, on purpose:** the approval-gate internals (the agent's refused calls),
which the README and the tests carry; the "still working" branch after 90 seconds; and the
own-key mode, which is not built.

**Checklist against the rules:** under three minutes; the YouCam APIs used are named and
explained (beats 4 and 10); the footage is the project running in a browser, the platform it
is built for; no third-party trademarks and no music; uploaded to YouTube as Public.
