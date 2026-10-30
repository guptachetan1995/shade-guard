import { createApp } from "../src/app.js";
import { FakeYouCamProvider } from "../src/providers/youcam-fake.js";
import { fakePhoto, toBase64 } from "../src/providers/fake-photos.js";

export function fixedClock(start = "2026-10-30T06:00:00.000Z") {
  let t = Date.parse(start);
  return () => new Date((t += 1000)).toISOString();
}

export const noWait = async () => {};

export async function makeApp({ provider = new FakeYouCamProvider(), unitCapPerCheck, now = fixedClock() } = {}) {
  const app = await createApp({ provider, unitCapPerCheck, now, wait: noWait });
  return app;
}

export function photo(name = "sample-shopper", dims) {
  return toBase64(fakePhoto(name, dims));
}

export async function startCartCheck(app, name = "sample-shopper") {
  const r = await app.invoke("start_check", { photo: photo(name), capture: "upload" }, "shopper");
  if (!r.ok) throw new Error(`start_check refused: ${r.error.code}`);
  return r.result.checkId;
}
