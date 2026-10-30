// The canvas normaliser: every photo becomes one JPEG that every YouCam endpoint accepts.
// JPEG at quality 0.92, EXIF orientation applied, scaled so the long side is at most 1024 px,
// never cropped. A photo whose short side would fall under 480 px, or one this browser can't
// decode (HEIC in Chrome), gets a retake message before anything is sent.

export const NORMALISED = Object.freeze({ longSide: 1024, minShortSide: 480, quality: 0.92, type: "image/jpeg" });

export class PhotoProblem extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function readAsBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).slice(String(r.result).indexOf(",") + 1));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export async function normalisePhoto(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    const heic = /heic|heif/i.test(file.type) || /\.(heic|heif)$/i.test(file.name ?? "");
    throw new PhotoProblem(
      heic ? "photo_heic" : "photo_unreadable",
      heic
        ? "This browser can't read HEIC photos. Choose a JPEG, or set the camera to its most compatible format."
        : "This file couldn't be read as a photo. Choose a JPEG or PNG.",
    );
  }
  const long = Math.max(bitmap.width, bitmap.height);
  const scale = Math.min(1, NORMALISED.longSide / long);
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  if (Math.min(width, height) < NORMALISED.minShortSide) {
    bitmap.close();
    throw new PhotoProblem(
      "photo_too_small",
      `This photo is ${width}×${height} once sized for the check; its short side must be at least ${NORMALISED.minShortSide} px. Move closer or use a larger photo.`,
    );
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, NORMALISED.type, NORMALISED.quality));
  return {
    base64: await readAsBase64(blob),
    width,
    height,
    bytes: blob.size,
    original: { width: Math.round(width / scale), height: Math.round(height / scale), type: file.type || "unknown" },
    url: URL.createObjectURL(blob),
  };
}
