// Loads the recorded sample shopper (what `npm run record` writes) into the shape
// RecordedYouCamProvider serves. Browser-safe: the caller passes a reader, which is the file
// system on the local server and fetch on the static demo. A missing recording.json means no
// recording (the page then runs on sample data); a recording that names a file it doesn't
// carry is broken, and fails loudly rather than replaying half of it.

export const RECORDING_DIR = "fixtures/recorded/sample-shopper";

// read(name) → Uint8Array, or null when the file doesn't exist.
export async function loadRecording(read) {
  const index = await read("recording.json");
  if (!index) return null;
  const rec = JSON.parse(new TextDecoder().decode(index));
  const need = async (name) => {
    const bytes = await read(name);
    if (!bytes) throw new Error(`the recording names ${name}, which is missing`);
    return bytes;
  };
  const images = {};
  for (const [name, { file, contentType }] of Object.entries(rec.images ?? {})) images[name] = { bytes: await need(file), contentType };
  return { ...rec, photo: await need(rec.photo), images };
}

// The recorded files the static demo copies: the index, the photo and every render.
export function recordingFiles(rec) {
  return ["recording.json", rec.photo, ...Object.values(rec.images ?? {}).map((i) => i.file)];
}
