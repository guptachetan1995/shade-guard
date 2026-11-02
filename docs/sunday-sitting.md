# Running against the live API with your own key

How to take Shade Guard from sample data to real YouCam readings with your own YouCam API
key: check the key, generate the sample shopper's face, run the probes, record the sample
shopper, and set the measured values.
Until this has been done, the live provider has only run against a local stand-in for the
API that answers in the documented shapes.

Every script below prints units, codes, field outlines and colour values. None prints the
key, a request header, a signed URL or a response body, so you can share the output.

Budget for the whole run: **at most 152 units** (the face ≤ 6, probes ≤ 65, readings 69,
renders ≤ 12). The face's units come from the reserve the other caps leave. A hackathon
redeem code gives 1,000. Errors cost nothing: units are charged only for a task that
succeeds.

## 1. An account, units and a key

1. **Sign up** for the YouCam API console. If you are redeeming a hackathon code, use the
   same email address you registered for the hackathon with (a different email is one known
   cause of "Invalid redeem code"). The India console is
   `https://yce.makeupar.com/api-console/en/`. **If signup asks for a payment card and you
   don't want to add one, stop here** (see the stop conditions).
2. If you have a redeem code, open Account > Redeem Code, paste it and click Redeem.
3. Keep the key outside the checkout, in a file only you can read, so no commit or publish
   can pick it up:

   ```sh
   mkdir -p ~/.config/shade-guard
   install -m 600 /dev/null ~/.config/shade-guard/youcam.env
   printf 'YOUCAM_MODE=live\nYOUCAM_API_KEY=\n' > ~/.config/shade-guard/youcam.env
   ```

   Open the console's API Key tab, generate a key, and paste it after `YOUCAM_API_KEY=` in
   that file with a text editor.

Every command below runs from the repository root with the key file named per command:

```sh
export YOUCAM_ENV_FILE="$HOME/.config/shade-guard/youcam.env"
```

## 2. The key works (0 units)

```sh
npm run balance        # expect: YouCam balance: 1000 units (or whatever you hold)
```

- `The API key was not accepted` (either `InvalidApiKey` or `InvalidAccessToken`): paste the
  key again; a second refusal is a stop condition.
- `unexpected_shape` with `expected: results[]`: the credit response has a different shape.
  The script prints its field outline (names and types, no values); fix `getBalance` in
  `src/providers/youcam-live.js` to that shape and run it again. The balance shape is this
  app's assumption; the docs don't give it.

## 3. The sample shopper's face (≤ 6 units, from the reserve)

The face in the recording, the static demo and the video is generated with YouCam's own AI
Image Generator V2.0 on the same key: a face of no real person, so there is nobody whose
consent or biometric data is involved. The YouCam (YCO) API Terms of Service treat the output
as "AI-generated Content": "We do not claim any ownership of the content generated when you
use our Service" (§3.5.3), and "Your use of the AI-generated content for commercial purposes
is not restricted" (§11.3). The page stamps the face "AI-generated · not a real person".

Budget: at most 6 units here (four candidates, the bad-angle photo, one spare).

1. **The cost (0 units).** `npm run probe -- costs` lists the feature-cost table. Expect the
   image generator at 1 unit per image. If it is missing, or the first generation is
   refused, stop and decide the face's source again before spending anything else.
2. **Generate four candidates (≤ 4 units).**

   ```sh
   npm run probe -- gen --count 4 --max-units 4 --save /tmp/shade-guard-faces
   ```

   It sends the request in `fixtures/persona-prompt.txt` (model `youcam-image-v2`, size
   `1104*1472`, which scales exactly to 768×1024, `prompt_extend` false), one candidate at a
   time: create, poll, download into the folder, delete, and a status read to confirm the
   delete. It prints the prompt file's sha256, each file's name, type, size and sha256, and
   the balance before and after; never the key or a URL. It refuses before any paid call if
   the plan is over `--max-units` (the cap is 6 candidates) or the balance. The first call
   settles where the result puts the image; if it isn't where the probe looks, the run stops
   after that one unit and prints the result's field outline.
3. **Pick one by eye against the photo requirements.** Keep the one candidate that meets all
   of these:
   - one person, facing the camera within 10°;
   - jawline and neck visible, bare skin, even light;
   - the face wider than 60% of the frame (crop to 3:4 if needed);
   - no likeness to anyone known.
4. **The bad-angle photo (1 unit).** Probe 6 needs a head turned away:

   ```sh
   npm run probe -- gen --variant bad-angle --count 1 --max-units 1 --save /tmp/shade-guard-faces
   ```

   Rename `bad-angle-1.jpg` to `bad-angle.jpg`. It is used once and never committed.
5. **The probe photos (0 units).** Node has no image codec, so these are made in a browser
   canvas, as in section 5, or with `sips`, which ships with macOS. Each comes from the same
   pixels:
   - `persona.jpg`: the chosen candidate drawn onto a 768×1024 canvas, saved with
     `canvas.toBlob(..., "image/jpeg", 0.92)`;
   - `persona.png`: the same canvas saved with `canvas.toBlob(..., "image/png")`;
   - `phone-full-size.jpg`: `persona.jpg` drawn onto a 3024×4032 canvas, saved as a JPEG at
     0.92.

   With `sips` (if the candidate is a PNG, the first line converts it too):

   ```sh
   sips -s format jpeg -s formatOptions 92 -z 1024 768 candidate-2.jpg --out persona.jpg
   sips -s format png persona.jpg --out persona.png
   sips -s format jpeg -s formatOptions 92 -z 4032 3024 persona.jpg --out phone-full-size.jpg
   ```

6. **Write the provenance** in `docs/api-notes.md`: the date, the model, the size, the prompt
   and negative prompt (with the prompt file's sha256), the units charged, and the sha256 of
   the raw candidate and of `persona.jpg`.

If the tone analyser refuses the chosen face in probe 2 (an `error_face_*` code, 0 units),
try the next-best candidate. If all four are refused, stop and ask the owner before
generating more.

## 4. The probes (≤ 65 units)

The cap covers every probe below, the v2.1 comparison and the PNG probe included: at most
20 + 9 + 9 + 1 + 1 + 0 + 1 + 20 = 61 units.

Run them in this order. `persona.jpg` is the generated face from step 3, pre-sized to a
768×1024 JPEG; `bad-angle.jpg`, `persona.png` and `phone-full-size.jpg` come from the same
step. Each probe deletes what it creates and reads the task's status afterwards.

| # | Command | Units | Settles |
|---|---|---|---|
| 1 | `npm run probe -- costs` | 0 | The feature-cost response's shape and its feature names; whether the three features cost 20 / 9 / 1 |
| 2 | `npm run probe -- tone --photo persona.jpg` | 20 | File init and the PUT with the returned headers; the task-create shape (`data.task_id`); the poll statuses actually seen; the success shape including `face_quality`; whether the poll reports units (the balance delta against the cost table); what a status read returns after delete; the first latency number |
| 3 | `npm run probe -- skin --photo persona.jpg` | 9 | That `skin_type` is a valid SD action next to the three concerns; the `output[]` shape, labels and regions; the cost for four actions. v2.0 is the default; to compare v2.1, change `TASK_VERSION` in `src/providers/youcam-live.js` and run it again (another 9) only if v2.0's shape differs from the docs |
| 4 | `npm run probe -- vto --photo persona.jpg --shade 245W --save /tmp/245W.jpg --cors` | 1 | That Makeup VTO takes `src_file_id`; which success shape is real (`results.url` or `results[].download_url`); whether the uploaded file outlives its task's delete (a new task on the old `file_id`); CORS on the API server, the pre-signed upload host and the result host, as a GitHub Pages origin would send it |
| 5 | `npm run probe -- vto --photo persona.jpg --shade 250W --save /tmp/250W.jpg` | 1 | With #4, the visibility check: 245W and 250W are ΔE00 2.4 apart. Compare the two renders as a split face; record whether the difference shows and whether `skin_smooth` at 0 left the skin unsmoothed. The demo's swap case (220N → 245W) is 5.4 apart |
| 6 | `npm run probe -- tone --photo bad-angle.jpg` | 0 | An engine error's envelope (`data.error`) and the face-angle code it returns |
| 7 | `npm run probe -- vto --photo phone-full-size.jpg` | 0–1 | Whether Makeup VTO refuses an unscaled phone photo, and with which code |
| 8 | `npm run probe -- tone --photo persona.png --type image/png` | 0–20 | Whether the tone analyser refuses a PNG. **Run it last**: if it is accepted it costs 20, which the 65-unit cap already counts |

Along the way the probes also settle:
- **Determinism.** Probe 2's photo and the readings phase's photo are the same bytes. Write
  both hex values in `docs/api-notes.md`: equal means an identical photo re-sent reads the
  same, so the band has to come from shifted light (step 5), not from re-sends.
- **The query-error envelope.** The status read after each delete is a query error; if its
  code doesn't parse, the probe prints `unexpected_shape` with `expected: error_code` and the
  outline.
- **The latency baseline.** Each probe prints creation-to-finish milliseconds; it sets the
  first poll interval (`POLL.firstMs` in `src/tasks.js`, 2 s until then) and the
  "still working" point.

Not settled by a probe, and left as the docs say: the polling retention period, whether a
429 carries `Retry-After` (the provider holds 2 s without one), and the 24-hour versus 2-hour
result retention.

Worth reading in a browser before spending units: the pricing page and the API Terms of
Service.

## 5. Two light-shifted copies of the photo (0 units)

The readings phase measures how far one face's reading moves with the light. Make two
copies of the persona photo at the same size, one brighter and one dimmer, in any browser
tab on the local server: draw the photo onto a canvas of the same size with
`ctx.filter = "brightness(1.15)"` (then `"brightness(0.85)"`), and save each with
`canvas.toBlob(..., "image/jpeg", 0.92)`. A brightness shift stands in for a change of
light; say so wherever the spread is quoted.

The band covers only light the analyser rates good (a photo it rates otherwise gets the fixed
1.5× lighting factor on top). The readings phase prints each reading's lighting verdict: if a
copy reads anything but good, re-make that copy at 1.10 (or 0.90) and run the readings phase
again (69 units, from the reserve).

## 6. Record the sample shopper (≤ 81 units)

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
npm run record -- --phase renders --max-units 12 --photo persona.jpg --generated-persona
```

The demo cart's check and the R-107 return check run through the real planner, with the
readings replayed from the first phase and only new renders paid (at most 12, usually 7).
`--generated-persona` writes `persona` into `recording.json`: the generator as the source,
the model and the prompt file's sha256. That is what makes the page stamp the face
"AI-generated · not a real person"; leave it off only for a photo of a consenting person.
Each run refuses to start when its plan costs more than `--max-units` or the balance, and
prints the units it spent against the cost table and the latency per feature. The output in
`fixtures/recorded/sample-shopper/` holds response bodies only: signed URLs become local
image names or are scrubbed, request ids are dropped, and the run fails, removing what it
wrote, if the key's value appears in any file.

## 7. Set the measured values

- `ASSETS.md`: the line for `fixtures/recorded/sample-shopper/` gets the date the face was
  generated before the recording is committed.
- Every parser marked UNVERIFIED in `src/providers/youcam-live.js` matches what the probes
  showed: the error envelope, `data.error`, `data.results`, the credit and feature-cost
  shapes, `TASK_VERSION`.
- `POLL.firstMs` in `src/tasks.js` from the latency baseline.
- `PREVIEW_INTENSITY` in `src/rules/preview.js` from the visibility check, and
  `PREVIEW_PROVISIONAL` cleared.
- `REPEAT_SPREAD_DE` from the readings, as above.
- Everything recorded in `docs/api-notes.md`, then `./verify.sh`.

## Stop conditions

Stop and write down what happened when:
- **signup asks for a payment card** you don't want to add;
- **the redeem code is refused** ("Invalid redeem code"; the hackathon's organisers can
  issue a new one);
- **the key is not accepted twice** after pasting it again;
- **units run low**: the balance is under 200, the face's tally passes 6, the probes' tally
  passes 65, or a recording
  phase refuses for its `--max-units` (never raise the cap to get past it);
- **a paid call's success doesn't parse**: the units are already spent, so fix the parser
  from the printed outline before running anything else that costs units.
