// Synthetic JPEG headers for the fake provider and the tests: a start-of-image, a comment
// naming the fake scenario, a baseline frame header with the dimensions, and end-of-image.
// No pixels; nothing here is a real photo.

export const FAKE_TAG = "shade-guard-fake:";

export function fakePhoto(name, { width = 768, height = 1024 } = {}) {
  const text = new TextEncoder().encode(FAKE_TAG + name);
  const com = [0xff, 0xfe, ((text.length + 2) >> 8) & 255, (text.length + 2) & 255, ...text];
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03];
  for (let c = 1; c <= 3; c++) sof.push(c, c === 1 ? 0x22 : 0x11, c === 1 ? 0 : 1);
  return new Uint8Array([0xff, 0xd8, ...com, ...sof, 0xff, 0xd9]);
}

export function toBase64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromBase64(text) {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
