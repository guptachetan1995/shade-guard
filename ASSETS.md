# Assets

The code in this repository is under the MIT licence in [LICENSE](./LICENSE). Images are not
covered by it automatically: every directory that holds a fixture image has its own line
below, and `./verify.sh` fails if an image directory has none.

| Directory | What it holds | Licence |
|---|---|---|
| `fixtures/` | The fictional catalogue, cart and return cases (JSON), authored for this demo, and the text-to-image prompt for the sample shopper's face (`persona-prompt.txt`). No images | MIT, with the code |
| `fixtures/recorded/sample-shopper/` | `photo.jpg`: an AI-generated portrait of no real person, made `<date>` with the YouCam AI Image Generator V2.0 (`youcam-image-v2`; prompt and sha256 in `docs/api-notes.md`) and scaled to 768×1024; the ±15% brightness copies, the Makeup VTO renders `render-*.jpg` made from it, and the YouCam response bodies for that image | MIT, with the code, to the extent any rights exist. "AI-generated Content" under the YouCam (YCO) API Terms of Service (Sep 2026) §3.5.3 ("We do not claim any ownership of the content generated when you use our Service") and §11.3 ("Your use of the AI-generated content for commercial purposes is not restricted"). No real person, so no personal or biometric data. Not affiliated with or endorsed by Perfect Corp |
| `docs/img/` | Three screenshots of this app for the README, taken from its static demo on the synthetic sample provider (badge FAKE). The face in them is the canvas placeholder, not a person and not a YouCam render | MIT, with the code |
| `public/` | No image files. The synthetic placeholder face is drawn on a canvas by `public/face.js` and stamped "SYNTHETIC · not a person · not YouCam" | MIT, with the code |

## Decided: the persona photo

The sample shopper's face is generated with YouCam's own AI Image Generator V2.0
(`youcam-image-v2`, from the prompt in `fixtures/persona-prompt.txt`) on the same account, so
it is of no real person, and the `fixtures/recorded/sample-shopper/` line above applies once
the recording exists, with `<date>` set to the day the face was generated.
