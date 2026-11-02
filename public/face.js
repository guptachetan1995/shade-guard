// A synthetic placeholder face, drawn on canvas from shapes. It stands in for the shopper's
// photo and the try-on renders when the fake provider answers, which has no real image. It
// is deliberately an illustration, never a photo, and every drawing is stamped as synthetic.
//
// The foundation covers the face only; the neck stays the measured bare skin. That is the
// jawline test a shop counter does: a wrong shade shows as a line between face and neck.
import { FACE_STAMP } from "../src/persona.js";

const COVERAGE = 0.88;

function hexToRgb(hex) {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(a, b, t) {
  const [x, y] = [hexToRgb(a), hexToRgb(b)];
  return `rgb(${x.map((v, i) => Math.round(v * (1 - t) + y[i] * t)).join(",")})`;
}

function shade(hex, f) {
  const [r, g, b] = hexToRgb(hex);
  const c = (v) => Math.max(0, Math.min(255, Math.round(v * f)));
  return `rgb(${c(r)},${c(g)},${c(b)})`;
}

function ellipse(ctx, x, y, rx, ry, fill, rot = 0) {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
}

// One full scene at scale s (the canvas is 300 × 400 logical units).
function paint(ctx, { skinHex, faceHex, tilt = 0, noFace = false, dim = false }) {
  const bg = ctx.createLinearGradient(0, 0, 0, 400);
  bg.addColorStop(0, dim ? "#8d8a86" : "#e9e4de");
  bg.addColorStop(1, dim ? "#6f6c69" : "#d8d1c9");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 300, 400);
  if (noFace) return;

  ctx.save();
  ctx.translate(150, 210);
  ctx.rotate(tilt);
  ctx.translate(-150, -210);

  // shoulders and top
  ctx.beginPath();
  ctx.moveTo(30, 400);
  ctx.quadraticCurveTo(40, 318, 150, 312);
  ctx.quadraticCurveTo(260, 318, 270, 400);
  ctx.fillStyle = "#4f6f6a";
  ctx.fill();

  // neck: bare, measured skin
  ctx.beginPath();
  ctx.moveTo(120, 250);
  ctx.lineTo(118, 322);
  ctx.quadraticCurveTo(150, 336, 182, 322);
  ctx.lineTo(180, 250);
  ctx.closePath();
  ctx.fillStyle = shade(skinHex, 0.93);
  ctx.fill();

  // hair behind
  ellipse(ctx, 150, 160, 98, 118, "#3b2a22");
  ctx.fillStyle = "#3b2a22";
  ctx.fillRect(56, 160, 188, 110);

  // ears
  ellipse(ctx, 76, 190, 11, 20, faceHex);
  ellipse(ctx, 224, 190, 11, 20, faceHex);

  // face, with the foundation
  ellipse(ctx, 150, 182, 74, 96, faceHex);
  const cheek = ctx.createRadialGradient(150, 200, 20, 150, 200, 96);
  cheek.addColorStop(0, "rgba(255,255,255,0.06)");
  cheek.addColorStop(1, "rgba(0,0,0,0.10)");
  ellipse(ctx, 150, 182, 74, 96, cheek);

  // fringe
  ctx.beginPath();
  ctx.moveTo(74, 160);
  ctx.quadraticCurveTo(92, 78, 150, 76);
  ctx.quadraticCurveTo(214, 78, 228, 156);
  ctx.quadraticCurveTo(196, 112, 140, 116);
  ctx.quadraticCurveTo(100, 120, 74, 160);
  ctx.fillStyle = "#3b2a22";
  ctx.fill();

  // brows, eyes, nose, lips
  ctx.strokeStyle = "#3b2a22";
  ctx.lineWidth = 4;
  ctx.lineCap = "round";
  for (const x of [120, 180]) {
    ctx.beginPath();
    ctx.moveTo(x - 17, 160);
    ctx.quadraticCurveTo(x, 151, x + 17, 159);
    ctx.stroke();
    ellipse(ctx, x, 178, 13, 7, "#f6f2ee");
    ellipse(ctx, x, 178, 6, 6, "#4a3326");
  }
  ctx.strokeStyle = shade(faceHex, 0.8);
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(150, 186);
  ctx.quadraticCurveTo(144, 210, 152, 216);
  ctx.stroke();
  ellipse(ctx, 150, 238, 20, 7.5, "#a8574f");
  ctx.restore();
}

function stamp(ctx, text) {
  ctx.font = "600 11px system-ui, sans-serif";
  const w = ctx.measureText(text).width + 14;
  ctx.fillStyle = "rgba(20,16,14,0.78)";
  ctx.beginPath();
  ctx.roundRect(8, 400 - 28, w, 20, 10);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.fillText(text, 15, 400 - 14);
}

function tag(ctx, text, x, align) {
  ctx.font = "700 12px system-ui, sans-serif";
  const w = ctx.measureText(text).width + 12;
  const left = align === "left" ? x : x - w;
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.beginPath();
  ctx.roundRect(left, 8, w, 20, 6);
  ctx.fill();
  ctx.fillStyle = "#1d1714";
  ctx.fillText(text, left + 6, 22);
}

function prepare(canvas) {
  const ratio = globalThis.devicePixelRatio || 1;
  canvas.width = 300 * ratio;
  canvas.height = 400 * ratio;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return ctx;
}

// opts: { skinHex, left: { code, hex }?, right: { code, hex }?, split (0–1, the divider's x),
// tilt, noFace, dim }. With no left or right shade it draws bare skin.
export function drawFace(canvas, opts) {
  const ctx = prepare(canvas);
  const { skinHex, left, right, split = 0.5 } = opts;
  const scene = (shadeHex) => ({ ...opts, faceHex: shadeHex ? mix(skinHex, shadeHex, COVERAGE) : skinHex });
  if (!left) {
    paint(ctx, scene(null));
  } else if (!right) {
    paint(ctx, scene(left.hex));
    tag(ctx, left.code, 8, "left");
  } else {
    const x = Math.round(300 * split);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, x, 400);
    ctx.clip();
    paint(ctx, scene(left.hex));
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, 0, 300 - x, 400);
    ctx.clip();
    paint(ctx, scene(right.hex));
    ctx.restore();
    if (x > 0 && x < 300) {
      ctx.fillStyle = "#fff";
      ctx.fillRect(x - 1, 0, 2, 400);
      ellipse(ctx, x, 200, 9, 9, "#fff");
    }
    if (x > 40) tag(ctx, left.code, 8, "left");
    if (x < 260) tag(ctx, right.code, 292, "right");
  }
  stamp(ctx, FACE_STAMP.synthetic);
}
