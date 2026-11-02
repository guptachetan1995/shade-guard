// The static demo's transport: the real app (store, invoke, the nine tools, the human-only verbs,
// the planner) and the real api.js, running in the visitor's tab. Every request and response is
// JSON round-tripped, exactly as the local server's socket would, so the page never holds a
// live store object. No environment is read here: this build has no key to read.
//
// With a recording copied into the build (read is then given), the tab replays it through
// RecordedYouCamProvider; without one it runs the fake provider and says so.
import { createApp } from "./app.js";
import { createApi, TICK_MS } from "./api.js";
import { describeMode } from "./modes.js";
import { FakeYouCamProvider } from "./providers/youcam-fake.js";
import { RecordedYouCamProvider } from "./providers/youcam-recorded.js";
import { loadRecording } from "./recording.js";
import { personaOf } from "./persona.js";

export const PAGES_NOTICE = "This static demo runs on synthetic sample data; it makes no network calls.";

// read(name) → Uint8Array or null: a file of the recorded sample shopper, from the build.
export async function createPagesTransport({ tick = true, read = null } = {}) {
  const recording = read ? await loadRecording(read) : null;
  const provider = recording ? new RecordedYouCamProvider(recording) : new FakeYouCamProvider();
  const mode = recording ? describeMode("replay", null, { recordedAt: recording.recordedAt, persona: personaOf(recording) }) : describeMode("fake", PAGES_NOTICE);
  const app = await createApp({ provider });
  const api = createApi({ app, mode });
  if (tick) setInterval(() => api.tick().catch(() => {}), TICK_MS);
  return {
    kind: "pages",
    async request(method, path, body = null) {
      const sent = body === null ? null : JSON.parse(JSON.stringify(body));
      const { body: out } = await api.handle(method, path, sent);
      return JSON.parse(JSON.stringify(out));
    },
  };
}
