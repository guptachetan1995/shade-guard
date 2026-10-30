# Assets

The code in this repository is under the MIT licence in [LICENSE](./LICENSE). Images are not
covered by it automatically: every directory that holds a fixture image has its own line
below, and `./verify.sh` fails if an image directory has none.

| Directory | What it holds | Licence |
|---|---|---|
| `fixtures/` | JSON only: the fictional catalogue, cart and return cases, authored for this demo. No images | MIT, with the code |
| `fixtures/recorded/sample-shopper/` | Not recorded yet. It will hold the sample shopper's photo (`photo.jpg`), the YouCam Makeup Virtual Try-On renders made from it (`render-*.jpg`) and the recorded response bodies | **Open: decided before the recording is committed** (below). The renders are derived from the photo and carry its line; the response bodies are numbers and labels returned by the YouCam API for that photo |
| `docs/img/` | Three screenshots of this app for the README, taken from its static demo on the synthetic sample provider (badge FAKE). The face in them is the canvas placeholder, not a person and not a YouCam render | MIT, with the code |
| `public/` | No image files. The synthetic placeholder face is drawn on a canvas by `public/face.js` and stamped "SYNTHETIC · not a person · not YouCam" | MIT, with the code |

## Open: the persona photo

Whose face is in the recording, and so in this repository, its static demo and its video, is
decided at the first keyed sitting, in this order:

1. **A synthetic portrait whose licence allows redistribution.** YouCam's own AI Image
   Generator is evaluated first, on the same account: its unit cost and its output terms
   (whether a generated image may be stored and redistributed).
2. **The owner's own photo**, only on the owner's explicit yes.
3. **The sponsor's sample images**, only if the YouCam API Terms of Service grant
   redistribution.

Never a photo of anyone else, and never a scraped face. When the source is decided, the
`fixtures/recorded/sample-shopper/` line above names it and its licence, and the same line
covers the renders.
