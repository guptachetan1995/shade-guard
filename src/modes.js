// Which provider answers, and how the page says so. The badge is always visible, so a visitor
// can never mistake sample data for a YouCam reading. Browser-safe: no environment access.
import { faceStampFor } from "./persona.js";

export const MODE_INFO = Object.freeze({
  fake: {
    badge: "FAKE",
    label: "Sample data, not YouCam",
    banner:
      "Sample data, not YouCam. Every reading, ranking input and try-on on this page comes from this app's own synthetic provider. No YouCam API is called and no face is analysed.",
  },
  replay: {
    badge: "REPLAY",
    label: "Recorded YouCam responses",
    banner: "Replay: recorded responses from real YouCam API calls. This page makes no API calls.",
  },
  live: {
    badge: "LIVE",
    label: "Real YouCam API calls",
    banner: "Live: real YouCam API calls from the local server. The key stays on the server.",
  },
  "live-own-key": {
    badge: "LIVE · YOUR KEY",
    label: "Real YouCam API calls with your key",
    banner: "Live with your own key: real YouCam API calls from this tab. The key is held in this tab's memory only.",
  },
});

// requested: fake | replay | live. hasKey: a key is configured (its value never comes here).
// liveAvailable / recordingAvailable: whether that provider exists in this build.
export function chooseMode({ requested, hasKey, liveAvailable = false, recordingAvailable = false }) {
  if (requested === "live") {
    if (!hasKey) return { mode: "fake", notice: "YOUCAM_MODE is live but no YOUCAM_API_KEY is set, so the server runs on sample data." };
    if (!liveAvailable) return { mode: "fake", notice: "The live YouCam provider is not in this build yet, so the server runs on sample data." };
    return { mode: "live", notice: null };
  }
  if (requested === "replay") {
    if (!recordingAvailable) return { mode: "fake", notice: "No recording of the sample shopper exists yet, so the server runs on sample data." };
    return { mode: "replay", notice: null };
  }
  return { mode: "fake", notice: null };
}

// recordedAt: the replay's recording date, which the banner names. persona: the recording's
// persona block (src/persona.js), which decides the stamp on the replayed face.
export function describeMode(mode, notice = null, { recordedAt = null, persona = null } = {}) {
  const info = { id: mode, ...MODE_INFO[mode], notice, faceStamp: faceStampFor(mode, persona) };
  if (mode === "replay" && persona) info.persona = persona;
  if (mode === "replay" && recordedAt) {
    info.recordedAt = recordedAt;
    info.banner = `Replay: recorded responses from real YouCam API calls made on ${recordedAt.slice(0, 10)}. This page makes no API calls.`;
  }
  return info;
}
