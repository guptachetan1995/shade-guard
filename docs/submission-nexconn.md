# Reskilll submission copy — Shade Guard (Nexconn Build Challenge 2026)

**Challenge:** [Nexconn Build Challenge 2026](https://reskilll.com/hack/nexconn), run by Reskilll
for Nexconn. **Track:** Marketplace & Support. **Deadline:** Nov 22, 23:59 Anywhere on Earth, which
is Mon 23 Nov 2026, 17:29 IST.

- This file is the copy for each field of Reskilll's "Submit your project" form, in the order the
  form's own text lists them, with each limit as that text states it (read on 6 Nov 2026). Where that text
  names no limit, the section says so and gives this copy's own length; the rehearsal fill shows
  whether a field cuts it shorter.
- The form keeps no draft: its first save is the submission, and unsaved input survives only in
  the tab it was typed in. So the form is filled from this file in one sitting, just before the
  review and the Submit click.
- A slot written `{{FILL:…}}` with a name after the colon marks a value that exists only once
  the live app has run on Nexconn, or on the day of submission. Each one is listed under
  [Values filled after the live run](#values-filled-after-the-live-run) with where it comes from.
  Nothing from this file goes into the form while
  `grep -n '{{FILL:[a-z]' docs/submission-nexconn.md docs/writeup-nexconn.html docs/video-script-nexconn.md`
  prints a line.
- HTML comment blocks hold sentences that apply only in the case they name: `if-isolate` (the
  phone's frame needs to be credentialless, which the page does when opened with `?isolate=1`),
  `if-two-pages` (the phone can't share the page with the desk), `if-sdk-unread` (the desk's unread
  counts come from the SDK) and `if-typing` (typing indicators or read receipts are built).
- Every link is absolute. The write-up is `docs/writeup-nexconn.html`, printed to PDF.

## Values filled after the live run

| Slot | What goes in | Where it comes from | Rule |
|---|---|---|---|
| `app-key` | The app's Nexconn App Key | The env file, by its line name only: `grep '^NEXCONN_APP_KEY=' ~/.config/shade-guard/nexconn.env` | The same key the live demo's seats file carries ("Use the same key that your demo uses."). The App Key is public by design; the App Secret never comes near this file |
| `data-centre` | Singapore, North America or Saudi Arabia | The env file's `NEXCONN_AREA=` line, by name (`SG`, `NA`, `SAU`) | As the console created the app |
| `first-live-date` | The date a message first crossed Nexconn between the two panes | `docs/nexconn-notes.md` | A date the notes record |
| `send-to-arrival` | The measured send-to-arrival time, with how it was measured and over how many messages | `docs/nexconn-notes.md` | As the notes state it, for example a median and a range over n messages from the service's own times; never rounded to a better figure |
| `ws-host` | The WebSocket host the SDK connected to | `docs/nexconn-notes.md` | As recorded |
| `kick-code` | The connection-status code a busy seat reports | `docs/nexconn-notes.md` | As recorded |
| `history-date` | The date a reload restored a custom message from Nexconn's remote history | `docs/nexconn-notes.md` | Only a date the notes record |
| `layout` | How the two sides share the page: "two frames of one page", "two frames of one page, the phone's frame credentialless", or "the desk in the page and the phone in a private window" | `docs/nexconn-notes.md`, the two-frame check | Pick the one the notes record. The second also applies the `if-isolate` block (every live link gains `?isolate=1`); the third applies the `if-two-pages` blocks here, in the write-up and in the video script |
| `video-url` | The film's YouTube link | The upload, pasted in chat | Visibility Public, checked logged out |
| `video-length` | The film's length, m:ss | `ffprobe` on the final render | At most 3:00 |
| `mau`, `mau-date` | The active users the Nexconn console shows for the app, and the date it was read | The console's usage figure, read on Sun 22 Nov from a console page that cannot show the App Secret | The number as shown; the sentence after it says what it counts |
| `test-ids` | How many user ids besides the 12 seat ids were registered, for tests | `docs/nexconn-notes.md` (the token script prints every id it registers) | — |
| `tests` | The offline test total of the submitted commit | `npm test` on that commit | The runner's own total |
| `pdf-size` | The write-up PDF's size | `ls -l` on the printed PDF | At most 25 MB |

## Project name

Shade Guard

## One-paragraph summary

Limit: 10 to 2,000 characters. Prompt: "Tell us what the app does and who it is for." This one is
1,241 characters.

> Shade Guard is a buyer–store support chat for online beauty stores, built on the Nexconn Chat SDK. It handles one kind of message: "this foundation is the wrong shade, and I've opened it." An opened foundation generally can't be resold for hygiene reasons, so refunding it means writing the unit off. Here the shopper starts the return from her order page, and the request reaches the store's returns desk over a Nexconn direct channel. An agent reads the thread and the shade reading stored on her order, and drafts a reply for staff: an exchange to the shade the colour numbers support, with the CIEDE2000 distances in the message, or, when the order has no reading, an invitation to check her shade first, which she shares in the chat as numbers only, never a photo. A draft never sends itself. Only a staff click sends a reply, approves the exchange or closes the case, and each of those first reads the thread back from Nexconn: if the shopper has written since the draft, the send is refused and the agent drafts again. The exchange waits for her own Accept in the chat. It is for the support staff of online beauty stores and the shoppers they serve. The store, the shoppers and the face reading in the demo are fictional sample data.

## Nexconn App Key

Prompt: "Use the same key that your demo uses."

`y745wfm8ynetv`

## Nexconn packages used

Options: Chat SDK, Chat UI, Call SDK. Tick **Chat SDK** only. The chat screens are the app's own,
built on the SDK's message API, not on the Chat UI kit; the Call SDK is not used.

## SDK features you used

Limit: at least 30 characters; the form's text, read on 6 Nov, names no maximum. Prompt: "Tell us where the app uses them."
This one is 1,297 characters with both slots empty; the longest `layout` value adds 56, so
recount it once the slots are filled.

> Web Chat SDK, @nexconn/chat and @nexconn/engine 26.2.1, loaded in the page from jsDelivr with pinned integrity hashes. The returns desk and the shopper's phone are two separate apps (two frames of one page); each initialises its own NCEngine and connects as its own demo user with an access token issued through the Server API. Direct channels: one per shopper–desk pair; the desk inbox holds both channels of a seat, and the desk counts each case's unread messages from what it has shown. Custom messages: six types registered before connect and stored on Nexconn: the return request, a note, the numbers-only shade reading, the offer card with its Accept button, the acceptance and the case closed. Real-time receipt through the message handler: every message shows its Nexconn server time and its message id. Remote message history (createMessagesQuery): a reload rebuilds the thread from Nexconn, and every staff send, note, approval and close first reads the thread back from Nexconn and is refused when the shopper has written something the screen had not shown. Connection status handler: the connection badge and every state's words on screen. Server API: access-token issue for the demo users, a user lookup that checks they exist, and token expiry for the end of the demo.

<!-- if-sdk-unread
Only if the desk's unread counts come from the SDK's channel list on the live demo (they are counted
by the desk itself from what it has shown when this was written): replace "and the desk counts each
case's unread messages from what it has shown" with "each case with the unread count Nexconn's
channel list reports", and make the same change in the write-up's Direct channels row and step 7.
-->

<!-- if-typing
Only if typing indicators or read receipts are built and running on the live demo before the
form is filled: add one sentence naming each, and where the screen shows it.
-->

## Live app or download link

https://guptachetan1995.github.io/shade-guard/chat.html

No sign-in and nothing to install: the page connects the desk and the phone as fictional demo
users. The store itself, with the shop's own shade check, is at
https://guptachetan1995.github.io/shade-guard/.

<!-- if-isolate
Only if the live check needed the phone's frame made credentialless: the live link is
https://guptachetan1995.github.io/shade-guard/chat.html?isolate=1, and the same address replaces the
plain chat.html link in the YouTube description below, in the write-up (the box at the top and
"Try it in 90 seconds", step 1) and in the video script's "What the final cut requires". The film
is made with the builder's isolate switch, so it opens that address too.
-->

<!-- if-two-pages
Only if the phone can't share the page with the desk. This layout is not built when this is
written, so how the phone is opened comes from docs/nexconn-notes.md, not from this file. Replace
the first sentence above with: "No sign-in and nothing to install: the page connects the desk as a
fictional demo user, and the shopper's phone, opened in a private window as the page explains,
connects as a fictional shopper."
-->

## Public GitHub repository

https://github.com/guptachetan1995/shade-guard (public, with the MIT licence at the root)

## Demo video

PENDING(video-url) (YouTube, Public, PENDING(video-length))

## Write-up (PDF)

"Upload one PDF." "The PDF must be 25 MB or smaller." The PDF is `docs/writeup-nexconn.html`
printed to Letter pages once every slot in it is filled. It carries the App Key, as the rules ask:
"Put the App Key in your write-up and in the submission form." Size: PENDING(pdf-size).

## Traction (optional)

- **Proof link:** left empty.
- **Active users:** left empty.

No users are claimed and none were sought. The write-up states the console's count and what it
counts: Nexconn counts the unique user ids that connect, and the public demo shares 12 fictional
seat ids among every visitor, so the count shows at most those ids and the test ids, however many
people open the demo.

## Prior work

"Did any part of this project exist before the challenge?": **Yes, it extends earlier work.**

"What existed before, and what did you build during the challenge?" The form's text, read on
6 Nov, names no limit. This one is
934 characters; a 454-character version follows it in case the form caps lower.

> Shade Guard was built from 30 Oct to 2 Nov 2026 for another hackathon (YouCam API) and was never submitted there. That version had the fictional store, the colour science (CIEDE2000), the agent's tools behind one chokepoint, and staff-only approvals on a returns desk, all on sample data. In the public repository it ends at commit 5f35675 (2 Nov 2026); every later commit is work for this challenge. For this challenge the whole Nexconn layer was added: the buyer–store support thread on the Chat SDK (the desk inbox, the shopper's order chat and every connection state), the reading, the offer and the acceptance as custom messages, the agent's thread reader and draft-only reply tool, the shopper's own Accept, the staff-only send, note, approve and close that read the thread back from Nexconn before anything reaches the shopper, the token scripts, and their tests. The face reading is still sample data: YouCam was never called.

Shorter, if needed:

> Built 30 Oct – 2 Nov 2026 for the YouCam API hackathon and never submitted: the fictional store, the colour science, the agent's tools and staff-only approvals, on sample data (public repo up to commit 5f35675). Built for this challenge: the whole Nexconn layer, from the support thread on the Chat SDK and its custom message cards to the agent's draft-only reply tool, the shopper's Accept, and staff-only verbs that re-read the thread on Nexconn first.

## Track

**Marketplace & Support** ("Buyer-seller chat and customer service"). The form asks: "Select a
track before you submit."

## Confirmation

The box "I confirm that this submission follows the challenge rules and that my team owns, or has
the right to use, all of its content. I grant Nexconn a license to exhibit and promote it, as the
Terms say." is the entrant's own tick, with the Submit click.

## YouTube upload details (sent with the video file)

| Field | Value |
|---|---|
| Title | Shade Guard: wrong-shade returns in a Nexconn support chat where only staff send |
| Description | The summary's first two sentences; then "Built on the Nexconn Chat SDK: direct channels, six custom message types, real-time receipt and remote message history. The agent drafts; only people send, accept, approve or close."; then "Live demo: https://guptachetan1995.github.io/shade-guard/chat.html" and "Code (MIT): https://github.com/guptachetan1995/shade-guard"; then "Built for the Nexconn Build Challenge 2026, track Marketplace & Support. Independent entry, not affiliated with Nexconn or Reskilll. The store, the shoppers and the face reading are fictional sample data." |
| Tags | nexconn, chat sdk, customer support, support chat, ecommerce, beauty, returns, human in the loop, hackathon |
| Category | Science & Technology |
| Audience | Not made for kids |
| Visibility | **Public**. The rules: "Make sure that anyone with the link can watch it." |

The title is 80 characters; YouTube allows 100.

## Judging criteria — where the evidence is

| Criterion (the rules' words) | Weight | Where the evidence is |
|---|---|---|
| "The demo works fully and runs smoothly. The interface is clean, and the interaction is clear and easy to understand." | 50% | The live demo, with no sign-in and nothing to install; the write-up's "Try it in 90 seconds"; the video, beats 1 to 15. Every message shows its Nexconn server time and message id; every connection state has words on screen; a reload brings the thread back from Nexconn's history. Measured send-to-arrival: a median of 223 ms from Nexconn's server send time to arrival on the other pane (218 to 356 ms over 45 notes sent 300 ms apart, desk to phone, Bengaluru to the Singapore data centre, read on the receiving machine's clock); the receiving pane had each note a median 143 ms after the sending pane's send call returned, both on one clock |
| "Judges look at how new the idea is. They also look at whether it solves a real communication problem or adds a new, interesting interaction." | 30% | The write-up's "Why we built it" and "The rule the chat enforces". The shade reading travels as a numbers-only card; the reply quotes the reading's own ΔE00; a draft never sends; a send re-reads the thread on Nexconn and is refused when the customer has written since; the exchange waits for her own Accept (video beats 4, 6, 9 and 12) |
| "Judges look at traction and viability. They count early users as active users on Nexconn. They also look at whether the app can become a real product." | 20% | No users are claimed. The console showed PENDING(mau) active users on PENDING(mau-date): the demo's own seat ids and test ids, not people (write-up, "Traction, stated plainly"). Viability: the write-up's "Can it become a product?" |

## What this entry does not claim

- **No users.** The active-user count is the demo's own fictional seat ids and test ids.
- **No real face reading.** The shade check runs on the app's synthetic sample face, labelled on
  screen. The YouCam provider is written but has never called YouCam.
- **No real store, money or stock.** The store, the orders, the shoppers and the approvals are
  fictional; an approval is simulated, and after a reload an approved case shows as open again.
- **No language model.** The agent is a deterministic planner; every number in a draft is the
  reading's own, composed in code.
- **No authenticated shopper.** The public demo's seat tokens are public, so "her own Accept" means
  a message from the seat's shopper user in that visit. The visit id keeps two honest visitors on
  one seat apart; it does not stop a hostile one.
- **The live chat has an end date.** The demo's tokens are public in the demo's build and stay
  valid until Wed 2 Dec 2026, after judging, when they are expired; from then the chat panes read
  Offline.

## Submission checklist — where each rule is answered

| Rule (Reskilll's words) | Answered by |
|---|---|
| "Your submission must be a functional app or website that uses the Nexconn Chat SDK. … The app must show real, measurable SDK usage." | [SDK features you used](#sdk-features-you-used); the App Key; every message's Nexconn server time and id on screen |
| "Teams of 1 to 4": "You can also take part alone." | A team of one |
| "Web, iOS, Android and Flutter." | Web, in mobile and desktop browsers |
| "Be respectful, inclusive and professional. Harassment or plagiarism causes immediate disqualification." | Original work; the prior work is disclosed under [Prior work](#prior-work) |
| Project write-up (PDF): "Tell us why you built the app and which problem it solves. Name the features that use the Nexconn SDK. Include your Nexconn App Key." | [Write-up (PDF)](#write-up-pdf) |
| Demo video: "A video that shows your main features working. Use a YouTube, Vimeo, Loom or Google Drive link. Make sure that anyone with the link can watch it." | [Demo video](#demo-video) |
| Runnable app: "A live URL for a website, or a direct download link for an app." | [Live app or download link](#live-app-or-download-link) |
| Source code: "A public GitHub repository." | [Public GitHub repository](#public-github-repository) |
| User traction proof (bonus): "Proof that real people use your app." | Left empty; the write-up states the console's count and what it is |
| "Put the App Key in your write-up and in the submission form." | [Nexconn App Key](#nexconn-app-key) and the write-up's first box |
| "Yes, but you must add a real Nexconn integration during the challenge. Tell us which parts existed before and which parts you built for this challenge." | [Prior work](#prior-work) |
| "Only the team leader can select the track and submit." and "One submission per team." | One entry, from the team's leader |

## Publishing order

The repository's pre-publish check fails while the README or `docs/` holds a `{{FILL:…}}` slot or a
`PENDING(…)` marker with a name, so the final republish can't carry either.

1. After the live run, fill every slot the notes and the render give: `app-key`, `data-centre`,
   `first-live-date`, `send-to-arrival`, `ws-host`, `kick-code`, `history-date`, `layout`,
   `test-ids`, `tests` and `video-length`.
2. Four slots can only be filled on Sun 22 Nov: `video-url`, `mau`, `mau-date` and `pdf-size`. A
   republish before then (the live demo needs one) writes each of them as the fixed marker
   `PENDING(…)`, with the slot's name in place of the ellipsis and no space. The check then fails
   on those four markers alone, and that is the one failure an interim republish
   may carry: every other check passes, and `grep -n '{{FILL:[a-z]' docs/*.md docs/*.html` prints
   nothing.
3. Sun 22 Nov, with the entrant present: the video link and the console's count and date go in;
   the write-up is printed to PDF and its size goes in; then
   `grep -n 'PENDING([a-z]' README.md docs/*.md docs/*.html` prints nothing; the pre-publish check
   runs with the Nexconn film's own path and a 180-second cap (its default path is the shop film's);
   and only when it reads READY is the repository republished, then the live demo.

## Filling the form

1. Every slot filled: the `grep` at the top of this file prints nothing, and neither does
   `grep -n 'PENDING([a-z]' README.md docs/*.md docs/*.html`.
2. The write-up printed to PDF, at most 25 MB, and opened once to check that the App Key reads
   correctly.
3. A rehearsal fill in a tab, to check that every field takes its copy (lengths, the PDF, the
   links), then **Leave without saving**: the first save is the submission.
4. On the day: the form filled again from this file, the video link pasted last, the PDF uploaded;
   the entrant reviews every section, ticks the box and clicks **Submit your project**.
