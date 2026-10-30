# Sunday sitting: the first keyed run

The order for the one sitting that turns Shade Guard from sample data into real YouCam
readings. Everything before it ran against a local mock only. The owner does the account,
the redeem code and the key; the agent runs everything else and never sees the key: every
script below prints units, codes, field outlines and colour values, never the key, a
header, a signed URL or a response body.

Budget for the sitting: **at most 146 of the 1,000 redeemed units** (spike ≤ 65, readings
69, renders ≤ 12). Errors cost nothing; units are charged only for a task that succeeds.

## 1. The owner: account, code, key (about 15 minutes)

1. **Sign up** for the YouCam API console with the same email address as the Devpost
   registration (a different email is one known cause of "Invalid redeem code"). The India
   console is `https://yce.makeupar.com/api-console/en/`. **If signup asks for a payment card,
   stop here** (see the stop conditions).
2. The agent opens Account > Redeem Code. **The owner pastes the 1,000-unit code** from the
   Start Kit email and clicks Redeem.
3. The agent creates `~/.config/shade-guard/youcam.env` with mode 600, holding
   `YOUCAM_MODE=live` and an empty `YOUCAM_API_KEY=`. The owner opens the API Key tab,
   generates a key and **pastes it after the `=`**. The agent never opens that file again.
   It sits outside every checkout, so no publish can pick it up.

Every command below runs from the entry's root with the key file named per command:

```sh
export YOUCAM_ENV_FILE="$HOME/.config/shade-guard/youcam.env"
```

## 2. The key works (0 units)

```sh
npm run balance        # expect: YouCam balance: 1000 units
```

- `The API key was not accepted` (either `InvalidApiKey` or `InvalidAccessToken`): the
  owner re-pastes the key; a second refusal is a stop condition.
- `unexpected_shape` with `expected: results[]`: the credit response has a different shape.
  The script prints its field outline (names and types, no values); fix `getBalance` in
  `src/providers/youcam-live.js` to that shape and run it again. The balance shape is this
  app's assumption, not documented.

## 3. The spike probes (≤ 65 units)

The cap covers every probe below, the v2.1 comparison and the PNG probe included: at most
20 + 9 + 9 + 1 + 1 + 0 + 1 + 20 = 61 units. (It was 50, which the full list could exceed.)

Run in this order. The photo is the decided persona photo, pre-sized to 768×1024 JPEG.
Each probe deletes what it creates and reads the task's status afterwards.

| # | Command | Units | Settles |
|---|---|---|---|
| 1 | `npm run probe -- costs` | 0 | The feature-cost response's shape and its feature names; whether the three features cost 20 / 9 / 1 |
| 2 | `npm run probe -- tone --photo persona.jpg` | 20 | File init and the PUT with the returned headers; the task-create shape (`data.task_id`); the poll statuses actually seen; the success shape including `face_quality`; whether the poll reports units (the balance delta against the cost table); what a status read returns after delete; the first latency number |
| 3 | `npm run probe -- skin --photo persona.jpg` | 9 | That `skin_type` is a valid SD action next to the three concerns; the `output[]` shape, labels and regions; the cost for four actions. v2.0 is the default; to compare v2.1, change `TASK_VERSION` in `src/providers/youcam-live.js` and run it again (another 9) only if v2.0's shape differs from the docs |
| 4 | `npm run probe -- vto --photo persona.jpg --shade 245W --save <scratch>/245W.jpg --cors` | 1 | That Makeup VTO takes `src_file_id`; which success shape is real (`results.url` or `results[].download_url`); whether the uploaded file outlives its task's delete (a new task on the old `file_id`); CORS on the API server, the pre-signed upload host and the result host, as the Pages origin would send it |
| 5 | `npm run probe -- vto --photo persona.jpg --shade 250W --save <scratch>/250W.jpg` | 1 | With #4, the visibility check: 245W and 250W are ΔE00 2.4 apart. Compare the two renders as a split face; record whether the difference shows and whether `skin_smooth` at 0 left the skin unsmoothed. The demo's swap case (220N → 245W) is 5.4 apart |
| 6 | `npm run probe -- tone --photo bad-angle.jpg` | 0 | An engine error's envelope (`data.error`) and the face-angle code it returns |
| 7 | `npm run probe -- vto --photo phone-full-size.jpg` | 0–1 | Whether Makeup VTO refuses an unscaled phone photo, and with which code |
| 8 | `npm run probe -- tone --photo persona.png --type image/png` | 0–20 | Whether the tone analyser refuses a PNG. **Run it last**: if it is accepted it costs 20, which the 65-unit cap already counts |

Along the way the probes also settle:
- **Determinism.** Probe 2's photo and the readings phase's photo are the same bytes. Write
  both hex values in `docs/api-notes.md`: equal means an identical photo re-sent reads the
  same, so the band has to come from shifted light (step 4), not from re-sends.
- **The query-error envelope.** The status read after each delete is a query error; if its
  code doesn't parse, the probe prints `unexpected_shape` with `expected: error_code` and the
  outline.
- **The latency baseline.** Each probe prints creation-to-finish milliseconds; it sets the
  first poll interval (`POLL.firstMs` in `src/tasks.js`, 2 s until then) and the
  "still working" point.

Not settled by a probe, and left as the docs say: the polling retention period, whether a
429 carries `Retry-After` (the provider holds 2 s without one), and the 24-hour versus 2-hour
result retention.

Also in the browser, not by script: the pricing page, the API Terms of Service and the AI
Image Generator's output terms; Camera Kit's `shadefinder` mode on `http://localhost` and on
the github.io origin; the live "Enter a Submission" form.

## 4. Two light-shifted copies of the photo (0 units)

The readings phase measures how far one face's reading moves with the light. Make two
copies of the persona photo at the same size, one brighter and one dimmer, in a Chrome tab
on the local server: draw the photo onto a canvas of the same size with
`ctx.filter = "brightness(1.15)"` (then `"brightness(0.85)"`), and save each with
`canvas.toBlob(..., "image/jpeg", 0.92)`. A brightness shift stands in for a change of
light; say so wherever the spread is quoted.

The band covers only light the analyser rates good (a photo it rates otherwise gets the fixed
1.5× lighting factor on top). The readings phase prints each reading's lighting verdict: if a
copy reads anything but good, re-make that copy at 1.10 (or 0.90) and run the readings phase
again (69 units, from the reserve).

## 5. Record the sample shopper (≤ 81 units)

```sh
npm run record -- --phase readings --max-units 69 \
  --photo persona.jpg --light persona-bright.jpg --light persona-dim.jpg
```

Three tone readings and one SD reading (69 units). It prints each reading's hex and lighting
verdict, then the spread: the largest ΔE00 between the three readings. Then, before the renders:
- set `REPEAT_SPREAD_DE` in `src/rules/recommend.js` to the measured spread and clear
  `REPEAT_SPREAD_PROVISIONAL`;
- adjust the three authored ranges in `fixtures/catalogue.json` around the reading, so the
  demo shows keep, swap, sample duo and no match.

```sh
npm run record -- --phase renders --max-units 12 --photo persona.jpg
```

The demo cart's check and the R-107 return check run through the real planner, with the
readings replayed from the first phase and only new renders paid (at most 12, usually 7).
Each run refuses to start when its plan costs more than `--max-units` or the balance, and
prints the units it spent against the cost table and the latency per feature. The output in
`fixtures/recorded/sample-shopper/` holds response bodies only: signed URLs become local
image names or are scrubbed, request ids are dropped, and the run fails, removing what it
wrote, if the key's value appears in any file.

## 6. Set the measured values

- `ASSETS.md`: the line for `fixtures/recorded/sample-shopper/` names the persona photo's
  source and licence (the open item there) before the recording is committed.
- Every parser marked UNVERIFIED in `src/providers/youcam-live.js` matches what the probes
  showed: the error envelope, `data.error`, `data.results`, the credit and feature-cost
  shapes, `TASK_VERSION`.
- `POLL.firstMs` in `src/tasks.js` from the latency baseline.
- `PREVIEW_INTENSITY` in `src/rules/preview.js` from the visibility check, and
  `PREVIEW_PROVISIONAL` cleared.
- `REPEAT_SPREAD_DE` from the readings, as above.
- Everything recorded in `docs/api-notes.md`, then `./verify.sh`.

## Stop conditions

Stop, record what happened, and tell the owner when:
- **signup asks for a payment card** (the entry is dropped: no card);
- **the redeem code is refused** ("Invalid redeem code"; the owner may ask the hackathon
  manager for a new one);
- **the key is not accepted twice** after a re-paste;
- **units run low**: the redeemed balance is under 200, the spike's tally passes 65, or a
  recording phase refuses for its `--max-units` (never raise the cap to get past it);
- **a paid call's success doesn't parse**: the units are already spent, so fix the parser
  from the printed outline before running anything else that costs units.
