// The start_check boundary: the photo must be one normalised JPEG that every YouCam endpoint
// accepts. Type and dimensions are read from the JPEG header, with no image library.

export const PHOTO_LIMITS = Object.freeze({
  maxLongSide: 1024, // the browser scales the long side to 1024 px; Makeup VTO needs < 1920 × 1080
  minShortSide: 480, // SD Skin Analysis needs a short side of at least 480 px
  maxBytes: 10 * 1024 * 1024 - 1, // every endpoint takes files under 10 MB
});

const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

export class PhotoError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function sniffNonJpeg(b) {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b.length >= 12) {
    const box = String.fromCharCode(b[4], b[5], b[6], b[7]);
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    if (box === "ftyp" && /^(heic|heix|hevc|heim|heis|mif1|msf1)$/.test(brand)) return "heic";
  }
  return null;
}

// Returns { width, height, comment }, where comment is the first COM segment's text, if any.
export function readJpegInfo(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) {
    const kind = sniffNonJpeg(b);
    if (kind === "png") throw new PhotoError("photo_not_jpeg", "The photo is a PNG; the check needs a JPEG.");
    if (kind === "heic") {
      throw new PhotoError("photo_heic", "The photo is HEIC, which this browser can't convert; take or choose a JPEG.");
    }
    throw new PhotoError("photo_not_jpeg", "The photo is not a JPEG.");
  }
  let comment = null;
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) throw new PhotoError("photo_unreadable", "The JPEG header is damaged.");
    let marker = b[i + 1];
    while (marker === 0xff && i + 2 < b.length) {
      i += 1;
      marker = b[i + 1];
    }
    i += 2;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (i + 2 > b.length) break;
    const len = (b[i] << 8) | b[i + 1];
    if (len < 2 || i + len > b.length) throw new PhotoError("photo_unreadable", "The JPEG header is damaged.");
    if (marker === 0xfe && comment === null) {
      comment = new TextDecoder().decode(b.subarray(i + 2, i + len));
    }
    if (SOF_MARKERS.has(marker)) {
      if (len < 7) throw new PhotoError("photo_unreadable", "The JPEG header is damaged.");
      const height = (b[i + 3] << 8) | b[i + 4];
      const width = (b[i + 5] << 8) | b[i + 6];
      return { width, height, comment };
    }
    i += len;
  }
  throw new PhotoError("photo_unreadable", "The JPEG has no frame header, so its size can't be read.");
}

export function checkPhoto(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length > PHOTO_LIMITS.maxBytes) {
    throw new PhotoError("photo_too_large", "The photo is 10 MB or more.");
  }
  const { width, height, comment } = readJpegInfo(b);
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  if (long > PHOTO_LIMITS.maxLongSide) {
    throw new PhotoError(
      "photo_not_normalised",
      `The photo is ${width}×${height}; the page scales it so the long side is ${PHOTO_LIMITS.maxLongSide} px before sending.`,
    );
  }
  if (short < PHOTO_LIMITS.minShortSide) {
    throw new PhotoError(
      "photo_too_small",
      `The photo is ${width}×${height}; the short side must be at least ${PHOTO_LIMITS.minShortSide} px. Move closer or use a larger photo.`,
    );
  }
  return { contentType: "image/jpeg", width, height, bytes: b.length, comment };
}
