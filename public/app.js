// The store's page: the shop, the shopper's return page, the returns desk and the merchant
// panel, plus the Behind the scenes drawer. Every button posts to /api/invoke (the agent's run
// posts to /api/agent) through one transport, then re-reads /api/state and re-renders. The
// page keeps no store state of its own, only what is on screen.
import { createTransport } from "./transport.js";
import { normalisePhoto, PhotoProblem } from "./photo.js";
import { drawFace } from "./face.js";
import { fakePhoto, toBase64 } from "../src/providers/fake-photos.js";
import { FAKE_SCENARIOS } from "../src/providers/youcam-fake.js";
import { STILL_WORKING_MS } from "../src/check-lifecycle.js";

const SAMPLES = [
  { scenario: "sample-shopper", label: "Sample shopper", note: "good light, facing the camera" },
  { scenario: "dim-light", label: "Dim light", note: "the analyser says the light isn't good, so the band widens" },
  { scenario: "angle-up", label: "Head tilted up", note: "the analyser asks for a retake" },
  { scenario: "outside-range", label: "Deeper, warmer skin", note: "past the deep end of some ranges" },
  { scenario: "oily-redness", label: "Oily skin with redness", note: "a matte finish, and the may-run-pinker note" },
  { scenario: "slow-analyser", label: "A slow analysis", note: "still working after 90 seconds: you can stop waiting" },
];
// Actions that run while another is still waiting (the agent's run is one long action).
const CONCURRENT_ACTIONS = new Set(["stop-waiting", "bts-toggle"]);
// Actions that move the capture to its next stage: focus follows to that stage's next step.
const ADVANCING_ACTIONS = new Set(["capture-open", "use-sample", "use-recorded", "again"]);
const SAMPLE_LOOK = { "dim-light": { dim: true }, "angle-up": { tilt: -0.24 }, "no-face": { noFace: true } };

const ui = {
  route: "shop",
  caseId: null,
  capture: {},
  dismissed: {},
  progress: null,
  splits: {},
  bts: false,
  busy: false,
  tryOut: null,
  deskOutcome: {},
  lastOutcome: null,
  moreOpen: false,
  advance: false,
};
let api;
let server = null;
let tools = [];
const faces = new Map();
const previewUrls = new Map(); // "checkId|previewId" → data URL of a real render (replay or live)

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const f1 = (n) => Number(n).toFixed(1);
const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = () => server.state;
const mode = () => server.mode;
const sampleMode = () => mode().id === "fake" || mode().id === "replay";
const synthetic = () => mode().id === "fake";
const product = (id) => S().catalogue.products.find((p) => p.productId === id);
const shadeOf = (pid, code) => product(pid)?.shades.find((s) => s.code === code) ?? null;
const shortName = (name) => String(name).replace(/\s*\(.*\)\s*$/, "");
const getCase = (id) => S().returnCases.find((c) => c.caseId === id) ?? null;
const cap = (ctx) => (ui.capture[ctx] ??= { stage: ctx === "cart" ? "intro" : "intro" });
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function latestCheck(ctx) {
  const list = S().checks.filter((c) => (ctx === "cart" ? c.origin.from === "cart" : c.origin.caseId === ctx));
  return list.at(-1) ?? null;
}

// ---------------------------------------------------------------- transport and actions

async function refresh() {
  server = await api.request("GET", "/api/state");
  render();
  watchPendingReceipts();
}

function flash(message, kind = "warn") {
  const el = $("#flash");
  el.textContent = message;
  el.dataset.kind = kind;
  el.hidden = !message;
}

async function invoke(tool, args, actor, { quiet = false } = {}) {
  const r = await api.request("POST", "/api/invoke", { tool, args, actor });
  if (!r.ok && !quiet) flash(r.error.message);
  else if (r.ok) flash("");
  return r;
}

async function runAgent(ctx, body) {
  const start = (await api.request("GET", "/api/activity?since=0")).total;
  ui.progress = { ctx, checkId: body.checkId, entries: [], stillWorking: false };
  render();
  let finished = null;
  const run = api.request("POST", "/api/agent", body).then((r) => (finished = r));
  let shown = 0;
  for (let n = 0; ; n++) {
    const { entries } = await api.request("GET", `/api/activity?since=${start}`);
    const agentCalls = entries.filter((e) => e.actor === "agent");
    if (shown < agentCalls.length) shown += 1;
    ui.progress.entries = agentCalls.slice(0, shown);
    // About once a second: has a task of this check been running for 90 s?
    if (!finished && n % 4 === 0 && ui.progress.checkId) {
      const check = (await api.request("GET", "/api/state")).state.checks.find((c) => c.checkId === ui.progress.checkId);
      const running = check?.tasks.filter((t) => t.status === "running") ?? [];
      ui.progress.stillWorking = check?.status === "open" && running.some((t) => Date.now() - Date.parse(t.startedAt) >= STILL_WORKING_MS);
      ui.progress.runningFeature = running[0]?.feature ?? null;
    }
    render();
    if (finished && shown >= agentCalls.length) break;
    await sleep(finished ? 90 : 250);
  }
  await run;
  ui.progress = null;
  ui.lastOutcome = finished.outcome;
  await refresh();
  return finished;
}

// While a closed check's receipt still has a task finishing, re-read the state so the receipt
// moves from "cleanup pending" to "done" on its own.
let receiptTimer = null;
function watchPendingReceipts() {
  const pending = S().checks.some((c) => c.privacyReceipt?.pending > 0);
  if (!pending || receiptTimer) return;
  receiptTimer = setTimeout(async () => {
    receiptTimer = null;
    await refresh();
  }, 3000);
}

const actions = {
  "stop-waiting": async (el) => {
    const r = await invoke("stop_waiting", { checkId: el.dataset.check }, "shopper");
    if (r.ok && ui.progress) {
      ui.progress.stopping = true;
      render();
    }
  },
  "bts-toggle": () => {
    ui.bts = !ui.bts;
    render();
    // Opening moves focus into the drawer (it sits after the page in the tab order); closing returns it.
    (ui.bts ? $('#bts [data-action="bts-toggle"]') : $("#bts-toggle")).focus({ preventScroll: true });
  },
  "capture-open": (el) => {
    cap(el.dataset.ctx).stage = "choose";
    render();
  },
  "use-sample": (el) => {
    const c = cap(el.dataset.ctx);
    c.source = { kind: "sample", scenario: el.dataset.scenario };
    c.stage = "ready";
    c.problem = null;
    render();
  },
  // Replay answers for one photo only: the recorded sample shopper's, read from the recording.
  "use-recorded": async (el) => {
    const c = cap(el.dataset.ctx);
    const r = await api.request("GET", "/api/sample-photo");
    if (!r.ok) return flash(r.error.message);
    c.source = { kind: "recorded", base64: r.base64, url: `data:${r.contentType};base64,${r.base64}` };
    c.stage = "ready";
    c.problem = null;
    render();
  },
  "start-check": async (el) => {
    const ctx = el.dataset.ctx;
    const c = cap(ctx);
    const photo = { sample: () => toBase64(fakePhoto(c.source.scenario)), recorded: () => c.source.base64 }[c.source.kind]?.() ?? c.source.photo.base64;
    const r = await invoke("start_check", { photo, capture: "upload", ...(ctx === "cart" ? {} : { caseId: ctx }) }, "shopper");
    if (!r.ok) {
      c.stage = "problem";
      c.problem = r.error;
      return render();
    }
    ui.capture[ctx] = { stage: "intro" };
    delete ui.dismissed[ctx];
    await runAgent(ctx, ctx === "cart" ? { checkId: r.result.checkId } : { checkId: r.result.checkId, caseId: ctx });
  },
  again: (el) => {
    const ctx = el.dataset.ctx;
    const check = latestCheck(ctx);
    if (check) ui.dismissed[ctx] = check.checkId;
    cap(ctx).stage = el.dataset.stage ?? "choose";
    cap(ctx).problem = null;
    render();
  },
  apply: async (el) => decideLine("apply_draft", el),
  keep: async (el) => decideLine("keep_my_shade", el),
  "split-set": (el) => setSplit(el.dataset.key, Number(el.dataset.value)),
  "desk-draft": async (el) => {
    const r = await api.request("POST", "/api/agent", { caseId: el.dataset.case });
    ui.deskOutcome[el.dataset.case] = r.ok ? r.outcome : r.error.code;
    await refresh();
  },
  "approve-exchange": async (el) => {
    await invoke("approve_exchange", { caseId: el.dataset.case }, "staff");
    await refresh();
  },
  "approve-refund": async (el) => {
    await invoke("approve_refund", { caseId: el.dataset.case }, "staff");
    await refresh();
  },
  "set-cap": async () => {
    const value = Number.parseInt($("#cap-input").value, 10);
    await invoke("set_unit_cap", { unitsPerCheck: Number.isInteger(value) ? value : -1 }, "merchant");
    await refresh();
  },
  "try-apply": async () => {
    const checkId = latestCheck("cart")?.checkId ?? "chk_01";
    const args = { checkId, lineId: "L1" };
    const response = await invoke("apply_draft", args, "agent", { quiet: true });
    ui.tryOut = { call: { tool: "apply_draft", args, actor: "agent" }, response };
    await refresh();
  },
  "try-smuggle": async () => {
    const checkId = latestCheck("cart")?.checkId ?? "chk_01";
    const args = { checkId, lineId: "L1", decision: "swap", shadeCode: "245W", evidence: {}, cart: { lines: [{ lineId: "L1", shadeCode: "245W" }] } };
    const response = await invoke("draft_recommendation", args, "agent", { quiet: true });
    ui.tryOut = { call: { tool: "draft_recommendation", args, actor: "agent" }, response };
    await refresh();
  },
};

// The shopper's decision on one line; the last one closes the check, so show its receipt.
async function decideLine(verb, el) {
  const r = await invoke(verb, { checkId: el.dataset.check, lineId: el.dataset.line }, "shopper");
  await refresh();
  if (r.ok && r.result.privacyReceipt) $(".receipt")?.scrollIntoView({ block: "start" });
}

async function onUpload(input) {
  const ctx = input.dataset.ctx;
  const file = input.files?.[0];
  if (!file) return;
  const c = cap(ctx);
  ui.advance = true;
  try {
    const photo = await normalisePhoto(file);
    c.source = { kind: "upload", photo };
    c.problem = null;
    c.stage = sampleMode() ? "newphoto" : "ready";
  } catch (e) {
    c.stage = "problem";
    c.problem = e instanceof PhotoProblem ? { code: e.code, message: e.message } : { code: "photo_unreadable", message: "This file couldn't be read as a photo." };
  }
  render();
}

function setSplit(key, value) {
  ui.splits[key] = value;
  const canvas = document.querySelector(`canvas[data-face-key="${CSS.escape(key)}"]`);
  const range = document.querySelector(`input[data-key="${CSS.escape(key)}"]`);
  if (range) {
    range.value = String(value);
    range.setAttribute("aria-valuetext", splitText(value, range.dataset.left, range.dataset.right));
  }
  if (canvas) {
    const opts = faces.get(canvas.dataset.faceId);
    drawFace(canvas, { ...opts, split: value / 100 });
  }
  const photo = document.querySelector(`.split-photo[data-face-key="${CSS.escape(key)}"]`);
  if (photo) photo.style.setProperty("--split", `${value}%`);
  for (const b of document.querySelectorAll(`button[data-action="split-set"][data-key="${CSS.escape(key)}"]`)) {
    b.setAttribute("aria-pressed", String(Number(b.dataset.value) === value));
  }
}

// ---------------------------------------------------------------- rendering helpers

let faceSeq = 0;
function faceCanvas(opts, { key = "", label }) {
  const id = `f${++faceSeq}`;
  faces.set(id, opts);
  return `<canvas class="face" data-face-id="${id}" data-face-key="${esc(key)}" role="img" aria-label="${esc(label)}"></canvas>`;
}

// The split divider: a labelled slider whose spoken value names what each side shows.
function splitText(value, left, right) {
  if (value >= 100) return `All ${left}`;
  if (value <= 0) return `All ${right}`;
  return `${left} on the left ${value}%, ${right} on the right ${100 - value}%`;
}

function dividerHtml(key, split, cmp) {
  return `<input class="divider" type="range" min="0" max="100" step="1" value="${split}" data-action="split" data-key="${esc(key)}" data-left="${esc(cmp.left.code)}" data-right="${esc(cmp.right.code)}" aria-label="Divider: left of it shows ${esc(cmp.left.code)}, right of it shows ${esc(cmp.right.code)}" aria-valuetext="${esc(splitText(split, cmp.left.code, cmp.right.code))}">
    <div class="seg" role="group" aria-label="Show on the face">
      ${[100, 50, 0].map((v, i) => `<button type="button" data-action="split-set" data-key="${esc(key)}" data-value="${v}" aria-pressed="${split === v}">${esc(cmp.buttons[i])}</button>`).join("")}
    </div>`;
}

function swatch(hex, cls = "swatch") {
  return `<span class="${cls}" data-swatch="${esc(hex)}"></span>`;
}

function hydrate(root) {
  for (const el of root.querySelectorAll("[data-swatch]")) el.style.setProperty("--sw", el.dataset.swatch);
  for (const el of root.querySelectorAll("[data-pct]")) el.style.setProperty("--pct", `${el.dataset.pct}%`);
  for (const c of root.querySelectorAll("canvas[data-face-id]")) {
    const opts = faces.get(c.dataset.faceId);
    const split = c.dataset.faceKey && ui.splits[c.dataset.faceKey] !== undefined ? ui.splits[c.dataset.faceKey] / 100 : opts.split;
    drawFace(c, { ...opts, split });
  }
  for (const el of root.querySelectorAll(".split-photo[data-split]")) el.style.setProperty("--split", `${el.dataset.split}%`);
  for (const img of root.querySelectorAll("img[data-preview]")) loadPreview(img);
}

// A real try-on render (replay or live), read once from /api/preview and kept as a data URL.
async function loadPreview(img) {
  const key = img.dataset.preview;
  if (!previewUrls.has(key)) {
    const [checkId, previewId] = key.split("|");
    const r = await api.request("GET", `/api/preview?checkId=${encodeURIComponent(checkId)}&previewId=${encodeURIComponent(previewId)}`);
    if (!r.ok) return;
    previewUrls.set(key, `data:${r.contentType};base64,${r.base64}`);
  }
  img.src = previewUrls.get(key);
}

const HEADLINE = {
  keep: ["Your shade is the right one", "ok"],
  swap: ["A closer shade is in this range", "swap"],
  sample_duo: ["Two shades too close to call", "duo"],
  no_match: ["No close match in this range", "gap"],
  unavailable: ["Not checked", "muted"],
  retake: ["Retake needed", "warn"],
};

function outcomeText(line, cartCode) {
  const o = line.outcome;
  if (!o) return "";
  if (o.verb === "keep_my_shade") return `You kept ${cartCode}.`;
  const d = line.draft;
  if (d.decision === "swap") return `You swapped to ${d.shadeCode}.`;
  if (d.decision === "sample_duo") return `You chose the two-shade sample, ${d.shadeCodes.join(" + ")}.`;
  if (d.decision === "no_match") return "You removed it from your bag.";
  return `You kept ${cartCode}.`;
}

// ---------------------------------------------------------------- shop

function shopView() {
  const check = latestCheck("cart");
  const showCheck = check && (check.status === "open" || ui.dismissed.cart !== check.checkId);
  const out = [`<section class="shop" aria-labelledby="bag-h"><h1 id="bag-h" class="page-title">Your bag</h1>`, cartHtml(showCheck ? check : null)];
  if (ui.progress?.ctx === "cart") out.push(progressHtml(ui.progress));
  else if (showCheck) out.push(checkHtml(check, "cart"));
  else out.push(captureHtml("cart"));
  out.push("</section>");
  return out.join("");
}

function cartHtml(check) {
  const rows = S().cart.lines.map((l) => {
    const p = product(l.productId);
    const outcome = check?.lines[l.lineId]?.outcome;
    let text;
    let sw;
    if (l.sampleDuo) {
      text = `Two-shade sample · ${l.sampleDuo.shadeCodes.join(" + ")}`;
      sw = l.sampleDuo.shadeCodes.map((c) => swatch(shadeOf(l.productId, c).hex)).join("");
    } else if (l.shadeCode) {
      const s = shadeOf(l.productId, l.shadeCode);
      text = `${s.name} · ${s.code}`;
      sw = swatch(s.hex);
    } else {
      text = "One size";
      sw = `<span class="swatch none"></span>`;
    }
    return `<li class="cart-line${outcome ? " changed" : ""}">
      <span class="swatches" aria-hidden="true">${sw}</span>
      <span class="cart-text"><strong>${esc(shortName(p.name))}</strong><span>${esc(text)}${l.finish ? ` · ${esc(l.finish)}` : ""}</span></span>
      <span class="qty"><span aria-hidden="true">×${l.qty}</span><span class="sr-only">quantity ${l.qty}</span></span>
      ${outcome ? `<span class="chip ok">Changed by you</span>` : ""}
    </li>`;
  });
  const removed = check
    ? Object.entries(check.lines)
        .filter(([id, l]) => l.outcome?.verb === "apply_draft" && l.draft.decision === "no_match" && !S().cart.lines.some((c) => c.lineId === id))
        .map(([, l]) => `<li class="cart-line removed"><span class="swatches" aria-hidden="true">${swatch(shadeOf(l.productId, l.shadeCode).hex)}</span><span class="cart-text"><strong>${esc(shortName(product(l.productId).name))}</strong><span>${esc(l.shadeCode)} · removed by you</span></span></li>`)
    : [];
  return `<ul class="cart" aria-label="Bag">${rows.join("")}${removed.join("")}</ul>
    <p class="fine">Products, shades and swatch colours are authored for this demo.</p>`;
}

function captureHtml(ctx) {
  const c = cap(ctx);
  if (c.stage === "intro" && ctx === "cart") {
    return `<div class="card prompt">
      <p class="prompt-lead">Not sure about these shades? Check them on your face: about 30 seconds, bare skin, and your photo is deleted afterwards.</p>
      <button type="button" class="btn primary" data-action="capture-open" data-ctx="cart">Check them on my face</button>
      <p class="fine">One reading checks every foundation in the bag. Only you can start it; the agent can't.</p>
    </div>`;
  }
  const preview = (() => {
    if (c.source?.kind === "sample") {
      const look = SAMPLE_LOOK[c.source.scenario] ?? {};
      return faceCanvas({ skinHex: FAKE_SCENARIOS[c.source.scenario].skinHex, ...look }, { label: "Synthetic placeholder face, bare skin" });
    }
    if (c.source?.kind === "upload") return `<img class="face" src="${esc(c.source.photo.url)}" alt="Your photo, resized in this tab">`;
    if (c.source?.kind === "recorded") return stamped(`<img class="face" src="${esc(c.source.url)}" alt="The recorded sample shopper's photo">`);
    return `<div class="face oval" aria-hidden="true"><span>Fill the oval with your face</span></div>`;
  })();
  // Where keyboard focus lands when this stage replaces the button that was used.
  const next = (where) => ((c.stage === "ready" ? "start" : c.stage === "newphoto" ? "alt" : "first") === where ? " data-focus-next" : "");
  const samples = synthetic()
    ? `<button type="button" class="btn primary" data-action="use-sample" data-ctx="${esc(ctx)}" data-scenario="sample-shopper"${next("first")}>Use the synthetic sample shopper</button>`
    : mode().id === "replay"
      ? `<button type="button" class="btn primary" data-action="use-recorded" data-ctx="${esc(ctx)}"${next("first")}>Use the recorded sample shopper</button>`
      : "";
  const more = synthetic()
    ? `<details class="more"${ui.moreOpen ? " open" : ""}><summary>More synthetic samples, one per branch</summary><ul>${SAMPLES.slice(1)
        .map((s) => `<li><button type="button" class="link" data-action="use-sample" data-ctx="${esc(ctx)}" data-scenario="${s.scenario}">${esc(s.label)}</button><span class="fine">${esc(s.note)}</span></li>`)
        .join("")}</ul></details>`
    : "";
  let tail = "";
  if (c.stage === "ready") {
    const what = {
      sample: () => `The synthetic sample shopper (${esc(SAMPLES.find((s) => s.scenario === c.source.scenario)?.label ?? c.source.scenario)}): a placeholder, not a person's photo.`,
      recorded: () => `The recorded sample shopper: the photo whose real YouCam responses this page replays.`,
      upload: () => `Your photo, resized in this tab to a ${c.source.photo.width}×${c.source.photo.height} JPEG (${Math.round(c.source.photo.bytes / 1024)} KB).`,
    }[c.source.kind]();
    tail = `<div class="ready">
      <p><strong>Ready to check:</strong> ${what}</p>
      <p class="consent">Starting the check sends this photo for analysis. It is deleted when the check closes, and your order keeps only the reading's numbers.</p>
      <button type="button" class="btn primary" data-action="start-check" data-ctx="${esc(ctx)}"${next("start")}>Start the check</button>
    </div>`;
  } else if (c.stage === "newphoto") {
    tail = `<div class="branch newphoto" role="alert">
      <h3>New photos need live mode</h3>
      <p>Your photo was resized in this tab to a ${c.source.photo.width}×${c.source.photo.height} JPEG (${Math.round(c.source.photo.bytes / 1024)} KB, from ${c.source.photo.original.width}×${c.source.photo.original.height}), the one size every YouCam endpoint accepts.</p>
      <p>This page answers with ${mode().id === "fake" ? "sample data, not YouCam" : "a recording of the sample shopper"}, so it won't pretend to read your face. <strong>Nothing was sent</strong>; the photo stays in this tab.</p>
      ${
        synthetic()
          ? `<button type="button" class="btn" data-action="use-sample" data-ctx="${esc(ctx)}" data-scenario="sample-shopper"${next("alt")}>Use the synthetic sample shopper instead</button>`
          : `<button type="button" class="btn" data-action="use-recorded" data-ctx="${esc(ctx)}"${next("alt")}>Use the recorded sample shopper instead</button>`
      }
    </div>`;
  } else if (c.stage === "problem") {
    tail = `<div class="branch problem" role="alert"><h3>That photo can't be checked</h3><p>${esc(c.problem.message)}</p><p class="fine">Code: ${esc(c.problem.code)}. Nothing was sent.</p></div>`;
  }
  return `<section class="card capture" aria-labelledby="cap-h-${esc(ctx)}">
    <h2 id="cap-h-${esc(ctx)}">Check your shade on your face</h2>
    <ul class="guide">
      <li><b>Bare skin.</b> Makeup changes the reading.</li>
      <li><b>Face the light.</b> A window or a lamp in front of you.</li>
      <li><b>Fill the oval.</b> Straight on, close to the camera.</li>
    </ul>
    <div class="capture-grid">
      <figure class="capture-preview">${preview}</figure>
      <div class="capture-options">
        ${samples}
        <label class="btn upload">Upload a photo<input type="file" accept="image/*" data-action="upload" data-ctx="${esc(ctx)}"></label>
        ${more}
      </div>
    </div>
    ${tail}
  </section>`;
}

function progressHtml(p) {
  const tools = p.entries.map((e) => e.tool);
  const has = (t) => tools.includes(t);
  const count = (t) => tools.filter((x) => x === t).length;
  const units = p.entries.reduce((n, e) => n + (e.units || 0), 0);
  const measured = has("measure_complexion");
  const steps = [
    ["Facial Color Tones Analyzer", "skin colour and the photo's lighting · 20 units", measured],
    ["Skin Analysis (SD)", "skin type, oiliness, moisture, redness · 9 units", measured],
    ["Ranking every shade by ΔE00", "colour science in this app · 0 units", has("rank_shades")],
    ["Makeup Virtual Try-On", `1 unit per render · ${plural(count("preview_shade"), "render")} so far`, has("preview_shade")],
    ["Drafting one recommendation per product", `${count("draft_recommendation")} drafted · only you change the bag`, has("draft_recommendation")],
  ];
  const firstOpen = steps.findIndex((s) => !s[2]);
  const FEATURE = { "skin-tone-analysis": "The Facial Color Tones Analyzer", "skin-analysis": "Skin Analysis", "makeup-vto": "The try-on render" };
  const still = p.stopping
    ? `<div class="branch still-working" role="status"><h3>Stopping</h3><p>The check is closing. The analysis still running is deleted, with your photo, as soon as it ends.</p></div>`
    : p.stillWorking
      ? `<div class="branch still-working" role="alert">
        <h3>Still working</h3>
        <p>${esc(FEATURE[p.runningFeature] ?? "The analysis")} has been running for over ${STILL_WORKING_MS / 1000} seconds. You can keep waiting, or stop: nothing is drafted and your bag stays as it is.</p>
        <button type="button" class="btn" data-action="stop-waiting" data-check="${esc(p.checkId)}">Stop waiting</button>
        <p class="fine">Stopping closes the check. The running analysis can't be deleted until it ends, so it is deleted, with your photo, as soon as it does; the privacy receipt shows when.</p>
      </div>`
      : "";
  return `<div class="card progress" aria-live="polite" aria-labelledby="prog-h">
    <h2 id="prog-h">Checking your shades</h2>
    <ol class="steps">${steps
      .map(([name, sub, done], i) => `<li data-state="${done ? "done" : i === firstOpen ? "active" : "waiting"}"><strong>${esc(name)}</strong><span>${esc(sub)}</span></li>`)
      .join("")}</ol>
    <p class="fine">${plural(p.entries.length, "agent call")} · ${units} units so far · answered by ${esc(mode().label)}</p>
    ${still}
  </div>`;
}

function readingHtml(check) {
  const c = check.complexion;
  if (!c) return "";
  const lighting = c.faceQuality.lighting ?? "unknown";
  return `<section class="card reading" aria-labelledby="rd-${esc(check.checkId)}">
    <header class="reading-head">${swatch(c.skinHex, "swatch big")}<div><h2 id="rd-${esc(check.checkId)}">Your reading</h2><p class="reading-num">${esc(c.skinHex)} · L*&nbsp;${f1(c.lab[0])} · a*&nbsp;${f1(c.lab[1])} · b*&nbsp;${f1(c.lab[2])}</p></div></header>
    <dl class="reading-facts">
      <div><dt>Undertone</dt><dd>reads ${esc(c.undertoneReading)} (hue ${Math.round(c.hueAngle)}°)</dd></div>
      <div><dt>Lighting</dt><dd>${esc(lighting)}, the analyser's own verdict${lighting === "good" ? "" : "; the band is widened"}</dd></div>
      <div><dt>Skin type</dt><dd>${esc(c.skinType.whole)} → ${esc(c.skinType.finish)} finish</dd></div>
      <div><dt>How sure</dt><dd>± ${f1(c.band)} ΔE00${c.bandProvisional ? " (provisional until repeat readings are measured)" : ""}</dd></div>
    </dl>
    ${c.synthetic ? `<p class="synthetic-note">Synthetic reading from the sample provider, not YouCam.</p>` : ""}
    <p class="fine">${check.unitsSpent} units spent on this check, under a cap of ${S().budget.unitCapPerCheck}.</p>
  </section>`;
}

function checkHtml(check, ctx) {
  const lines = Object.entries(check.lines);
  const closed = check.status === "closed" && check.privacyReceipt;
  const out = [];
  if (check.closeReason === "stopped_waiting") {
    out.push(`<div class="card branch stopped" role="status">
      <h2>You stopped waiting</h2>
      <p>Nothing was drafted, and nothing in your bag changed.</p>
      <button type="button" class="btn" data-action="again" data-ctx="${esc(ctx)}" data-focus-next>Try again</button>
    </div>`);
  } else if (check.retake) {
    out.push(`<div class="card branch retake" role="alert">
      <h2>Let's take that again</h2>
      <p class="guidance">${esc(check.retake.guidance)}</p>
      <p>The analyser couldn't read the photo (<code>${esc(check.retake.errorCode)}</code>). Nothing was charged: an error costs 0 units.</p>
      <button type="button" class="btn primary" data-action="again" data-ctx="${esc(ctx)}" data-focus-next>Take another photo</button>
    </div>`);
  } else if (lines.every(([, l]) => l.draft?.decision === "unavailable")) {
    const credit = lines[0][1].draft.evidence.reason === "credit";
    out.push(`<div class="card branch unavailable" role="alert">
      <h2>Not checked</h2>
      <p>${credit ? "This store's try-on budget is used up." : `This store caps each check at ${S().budget.unitCapPerCheck} units. Checking ${plural(lines.length, "product")} needs 29 units to measure plus up to 3 per product.`}</p>
      <p>Nothing was uploaded, and this store's copy of your photo is deleted.</p>
    </div>`);
  } else if (lines.some(([, l]) => !l.draft)) {
    out.push(`<div class="card branch problem" role="alert"><h2>The check didn't finish</h2><p>${esc(ui.lastOutcome ?? "The agent stopped before drafting.")}</p></div>`);
  }
  // The decided path leads with its receipt; a branch that ended the check leads with its message.
  if (closed) {
    if (out.length) out.push(receiptHtml(check, ctx));
    else out.unshift(receiptHtml(check, ctx));
  }
  out.push(readingHtml(check));
  if (ctx === "cart" && !check.retake && check.closeReason !== "stopped_waiting") for (const [lineId, l] of lines) out.push(lineCardHtml(check, lineId, l));
  return out.join("");
}

function compareFor(l) {
  const d = l.draft;
  const sh = (code) => ({ ...shadeOf(l.productId, code), de00: l.ranking?.find((r) => r.code === code)?.de00 });
  const cart = sh(l.shadeCode);
  switch (d.decision) {
    case "swap":
      return { left: cart, right: sh(d.shadeCode), buttons: ["Cart shade", "Split", "Recommended"], roles: ["in your bag", "recommended"] };
    case "sample_duo":
      return { left: sh(d.shadeCodes[0]), right: sh(d.shadeCodes[1]), extra: cart, buttons: [d.shadeCodes[0], "Split", d.shadeCodes[1]], roles: ["closest", "too close to call"] };
    case "no_match":
      return { left: cart, right: sh(d.nearest.code), buttons: ["Cart shade", "Split", "Nearest"], roles: ["in your bag", "nearest, still off"] };
    default:
      return { left: cart, right: null, buttons: [], roles: ["in your bag"] };
  }
}

function lineCardHtml(check, lineId, l) {
  const p = product(l.productId);
  const d = l.draft;
  if (!d) return "";
  const cartShade = shadeOf(l.productId, l.shadeCode);
  const [headline, tone] = HEADLINE[d.decision];
  const head = `<header class="line-head"><h3>${esc(shortName(p.name))}</h3><p class="in-bag">In your bag: ${esc(cartShade.name)} (${esc(l.shadeCode)})</p><span class="chip ${tone}">${esc(headline)}</span></header>`;
  if (d.decision === "unavailable") {
    return `<article class="card line-card">${head}<p>${esc(d.summary)}</p><p class="fine">Nothing was rendered for this product.</p></article>`;
  }
  const cmp = compareFor(l);
  const key = `${check.checkId}:${lineId}`;
  const split = ui.splits[key] ?? 50;
  const skinHex = check.complexion.skinHex;
  const dim = check.complexion.faceQuality.lighting !== "good";
  let figure;
  const previewOf = (code) => l.previews.find((p) => p.shadeCode === code)?.previewId;
  if (check.status !== "open") {
    figure = `<div class="face-gone"><p>Your photo and these previews were deleted when the check closed.</p></div>`;
  } else if (!synthetic()) {
    figure = renderFigure(check, key, split, cmp, previewOf);
  } else if (cmp.right) {
    const label = `Synthetic placeholder face: left in ${cmp.left.code}, right in ${cmp.right.code}; the neck shows the bare measured skin`;
    figure = `<figure class="split">
      ${faceCanvas({ skinHex, left: { code: cmp.left.code, hex: cmp.left.hex }, right: { code: cmp.right.code, hex: cmp.right.hex }, split: split / 100, dim }, { key, label })}
      ${dividerHtml(key, split, cmp)}
      <figcaption>Left: ${esc(cmp.left.code)}, ${esc(cmp.roles[0])}. Right: ${esc(cmp.right.code)}, ${esc(cmp.roles[1])}. <span class="synthetic-note">Synthetic placeholder drawn in this tab, not a YouCam render.</span></figcaption>
    </figure>`;
  } else {
    figure = `<figure class="split">${faceCanvas({ skinHex, left: { code: cmp.left.code, hex: cmp.left.hex }, dim }, { key, label: `Synthetic placeholder face in ${cmp.left.code}` })}
      <figcaption>${esc(cmp.left.code)} on the face. <span class="synthetic-note">Synthetic placeholder drawn in this tab, not a YouCam render.</span></figcaption></figure>`;
  }
  const pick = { swap: "right", sample_duo: "both", keep: "left" }[d.decision] ?? "";
  const strip = [
    { hex: skinHex, title: "Your skin", sub: "measured", de: skinHex, kind: "skin" },
    ...(cmp.extra ? [{ hex: cmp.extra.hex, title: cmp.extra.code, sub: "in your bag", de: `ΔE00 ${f1(cmp.extra.de00)}`, kind: "bag" }] : []),
    { hex: cmp.left.hex, title: cmp.left.code, sub: cmp.roles[0], de: `ΔE00 ${f1(cmp.left.de00)}`, kind: pick === "left" || pick === "both" ? "pick" : "bag" },
    ...(cmp.right ? [{ hex: cmp.right.hex, title: cmp.right.code, sub: cmp.roles[1], de: `ΔE00 ${f1(cmp.right.de00)}`, kind: pick === "right" || pick === "both" ? "pick" : "off" }] : []),
  ];
  const stripHtml = `<div class="jawline" role="list" aria-label="Jawline strip: your skin next to the shades">${strip
    .map((s) => `<div class="jaw jaw-${s.kind}" role="listitem">${swatch(s.hex, "jaw-sw")}<span class="jaw-title">${esc(s.title)}</span><span class="jaw-sub">${esc(s.sub)}</span><span class="jaw-de">${esc(s.de)}</span></div>`)
    .join("")}</div>`;
  const c = check.complexion;
  const decided = Boolean(l.outcome);
  const buttons = {
    swap: [`Swap to ${d.shadeCode}`, "Keep mine"],
    sample_duo: ["Get the sample duo", "Keep mine"],
    no_match: ["Remove it", "Keep mine"],
    keep: ["Keep it", null],
  }[d.decision];
  const actionsHtml = decided
    ? `<p class="outcome">${esc(outcomeText(l, l.shadeCode))} <span class="fine">${esc(clock(l.outcome.at))}</span></p>`
    : `<div class="actions">
        <button type="button" class="btn primary" data-action="apply" data-check="${esc(check.checkId)}" data-line="${esc(lineId)}" data-focus-next>${esc(buttons[0])}</button>
        ${buttons[1] ? `<button type="button" class="btn" data-action="keep" data-check="${esc(check.checkId)}" data-line="${esc(lineId)}">${esc(buttons[1])}</button>` : ""}
      </div>`;
  const gapLine =
    d.decision === "no_match"
      ? `<p class="gap-line">No shade in this range is within ΔE00 6.0 of your reading, so we won't guess. Your reading is ${esc(d.nearest.direction)} than ${esc(d.nearest.code)}.</p>`
      : d.decision === "sample_duo"
        ? `<p class="gap-line">${esc(d.shadeCodes[0])} and ${esc(d.shadeCodes[1])} sit within the ± ${f1(c.band)} band of each other. The two-shade sample settles it on your skin.</p>`
        : "";
  return `<article class="card line-card decision-${esc(d.decision)}${decided ? " decided" : ""}" aria-label="${esc(shortName(p.name))}">
    ${head}
    <div class="evidence">${figure}<div class="verdict">${stripHtml}
      ${gapLine}
      <blockquote class="draft"><span class="who">The agent's draft</span>${esc(d.summary)}</blockquote>
      ${c.rednessNote ? `<p class="fine">Redness can pull a colour reading pinker, so the preview is the better guide.</p>` : ""}
      ${actionsHtml}
    </div></div>
  </article>`;
}

// The replayed face's own stamp, over the photo and its renders, when the recording says the face
// was generated ("AI-generated · not a real person"). Live renders of a shopper's photo carry none.
function faceStampHtml() {
  const text = mode().id === "replay" ? mode().faceStamp : null;
  return text ? `<span class="face-stamp">${esc(text)}</span>` : "";
}

function stamped(html) {
  const stamp = faceStampHtml();
  return stamp ? `<div class="stamped">${html}${stamp}</div>` : html;
}

// The real Makeup Virtual Try-On renders (replay or live): the cart shade underneath, the other
// shade on top, clipped at the divider. No canvas drawing stands in for them.
function renderFigure(check, key, split, cmp, previewOf) {
  const source = mode().id === "replay" ? `Recorded YouCam Makeup Virtual Try-On renders, replayed from ${esc((mode().recordedAt ?? "").slice(0, 10))}.` : "YouCam Makeup Virtual Try-On renders of your photo.";
  const img = (code, cls) => {
    const id = previewOf(code);
    return id ? `<img class="${cls}" data-preview="${esc(`${check.checkId}|${id}`)}" alt="Try-on render of ${esc(code)}">` : "";
  };
  if (!cmp.right) {
    return `<figure class="split"><div class="split-photo" data-face-key="${esc(key)}" data-split="100">${img(cmp.left.code, "pv-left")}${faceStampHtml()}</div>
      <figcaption>${esc(cmp.left.code)} on the face. ${source}</figcaption></figure>`;
  }
  return `<figure class="split">
    <div class="split-photo" data-face-key="${esc(key)}" data-split="${split}" role="img" aria-label="Left of the divider: ${esc(cmp.left.code)}. Right of it: ${esc(cmp.right.code)}">${img(cmp.left.code, "pv-left")}${img(cmp.right.code, "pv-right")}${faceStampHtml()}</div>
    ${dividerHtml(key, split, cmp)}
    <figcaption>Left: ${esc(cmp.left.code)}, ${esc(cmp.roles[0])}. Right: ${esc(cmp.right.code)}, ${esc(cmp.roles[1])}. ${source}</figcaption>
  </figure>`;
}

function receiptHtml(check, ctx) {
  const r = check.privacyReceipt;
  const sample = mode().id === "fake";
  const where = sample ? "the sample provider" : "YouCam's servers";
  const fate = {
    deleted_with_tasks: `deleted from ${where} with the tasks`,
    never_uploaded: "never sent for analysis",
    kept_up_to_30_days: `kept on ${where} for up to 30 days (no task used it)`,
    pending: "deleted as soon as the running task ends",
  }[r.photoOnYouCam];
  const note = sample
    ? "Nothing reached YouCam: this page runs on sample data. In live mode the same close deletes every task on YouCam's servers, which per the YouCam docs also removes the uploaded photo."
    : r.note;
  const cleanup =
    r.pending > 0
      ? `<p class="cleanup pending"><b>Cleanup pending:</b> ${plural(r.pending, "analysis task")} still finishing on ${where}. ${r.pending === 1 ? "It" : "Each"} can't be deleted until it ends, and is deleted, with your photo, as soon as it does. This receipt updates by itself.</p>`
      : check.closeReason === "stopped_waiting"
        ? `<p class="cleanup done"><b>Cleanup done:</b> the analysis you stopped waiting for has ended and been deleted, and the deletion confirmed.</p>`
        : "";
  return `<section class="card receipt" aria-labelledby="rc-${esc(check.checkId)}">
    <h2 id="rc-${esc(check.checkId)}">Privacy receipt</h2>
    ${cleanup}
    <ul class="receipt-list">
      <li><b>${r.deletedTasks}</b> analysis ${r.deletedTasks === 1 ? "task" : "tasks"} deleted, each confirmed by a follow-up read</li>
      <li><b>${r.pending}</b> still finishing</li>
      <li>Your photo: <b>${esc(fate)}</b></li>
      <li>This store's copy of the photo and the previews: <b>deleted</b></li>
    </ul>
    <p>${esc(note)}</p>
    <p class="fine">The order keeps only the reading's numbers: L*, a*, b*, the ΔE00 values and the decision. Never the photo.${r.confirmedAt ? ` Confirmed ${esc(clock(r.confirmedAt))}.` : ""}</p>
    ${ctx === "cart" ? `<button type="button" class="btn" data-action="again" data-ctx="cart" data-stage="intro" data-focus-next>Back to the bag</button>` : ""}
  </section>`;
}

// ---------------------------------------------------------------- the shopper's return page

const STATUS_LABEL = {
  open: "Open",
  awaiting_check: "Waiting for the shopper's check",
  drafted: "Drafted, waiting for staff",
  exchange_approved: "Exchange approved",
  refund_approved: "Refund approved",
};

function returnView(caseId) {
  const rc = getCase(caseId);
  if (!rc) return `<section class="card"><h1>No return ${esc(caseId)}</h1></section>`;
  const p = product(rc.productId);
  const s = shadeOf(rc.productId, rc.shadeCode);
  const check = latestCheck(caseId);
  const showCheck = check && ui.dismissed[caseId] !== check.checkId;
  const out = [
    `<section class="shop returns" aria-labelledby="ret-h"><h1 id="ret-h" class="page-title">Your return ${esc(rc.caseId)}</h1>
    <div class="card return-head">${swatch(s.hex, "swatch big")}<div><strong>${esc(shortName(p.name))} · ${esc(s.name)} (${esc(rc.shadeCode)})</strong><p>Order ${esc(rc.orderId)} · reason: “${esc(rc.reason)}”</p><span class="chip status-${esc(rc.status)}">${esc(STATUS_LABEL[rc.status])}</span></div></div>`,
  ];
  if (ui.progress?.ctx === caseId) out.push(progressHtml(ui.progress));
  else if (rc.status === "awaiting_check") {
    if (showCheck && (check.retake || check.closeReason === "stopped_waiting")) out.push(checkHtml(check, caseId));
    else {
      out.push(`<div class="card prompt"><p class="prompt-lead">Check your shade for a free exchange.</p>
        <p>Your order was bought without a shade check. A 30-second photo check, bare skin, lets the store offer the right shade instead of a refund. Your photo is deleted afterwards.</p>
        ${cap(caseId).stage === "intro" ? `<button type="button" class="btn primary" data-action="capture-open" data-ctx="${esc(caseId)}">Check my shade</button>` : ""}</div>`);
      if (cap(caseId).stage !== "intro") out.push(captureHtml(caseId));
    }
  } else {
    const rd = rc.reading;
    const best = rd?.ranking?.[0];
    const returned = rd?.ranking?.find((r) => r.code === rc.shadeCode);
    const next = {
      open: "The store's agent is drafting a resolution.",
      drafted: rc.draft ? `The store's staff are reviewing: ${rc.draft.resolution === "exchange" ? `an exchange for ${rc.draft.shadeCode}` : "a refund"}. Only a staff member approves it.` : "",
      exchange_approved: `Exchange approved: ${rc.approval?.replacement ?? ""} is on its way (simulated).`,
      refund_approved: "Refund approved (simulated; no real money moves in this demo).",
    }[rc.status];
    out.push(`<div class="card"><h2>Your shade check</h2>
      ${rd ? `<p>Your reading put <b>${esc(best.code)}</b> closest (ΔE00 ${f1(best.de00)}); the ${esc(rc.shadeCode)} you're returning was ${returned ? f1(returned.de00) : "further"}. It is attached to the return as numbers only.</p>` : "<p>No reading is attached to this return.</p>"}
      <p><b>${esc(next)}</b></p></div>`);
    if (showCheck && check.status === "closed" && check.privacyReceipt) out.push(receiptHtml(check, caseId));
  }
  out.push("</section>");
  return out.join("");
}

// ---------------------------------------------------------------- returns desk (staff)

function deskView() {
  const cards = S().returnCases.map((rc) => {
    const p = product(rc.productId);
    const s = shadeOf(rc.productId, rc.shadeCode);
    const rd = rc.reading;
    const closed = rc.status === "exchange_approved" || rc.status === "refund_approved";
    const readingHtml = rd
      ? `<table class="nums"><caption>Shade reading on the order, numbers only</caption>
          <thead><tr><th scope="col">Shade</th><th scope="col">ΔE00</th><th scope="col">Note</th></tr></thead>
          <tbody>${rd.ranking
            .map(
              (r) =>
                `<tr><th scope="row">${swatch(shadeOf(rc.productId, r.code)?.hex ?? "#ccc")} ${esc(r.code)}</th><td>${r.de00.toFixed(2)}</td><td>${[
                  r.code === rc.shadeCode ? `<span class="chip muted">returned</span>` : "",
                  rd.recommended?.includes(r.code) ? `<span class="chip swap">recommended</span>` : "",
                ]
                  .filter(Boolean)
                  .join(" ")}</td></tr>`,
            )
            .join("")}</tbody></table>
          <p class="fine">L* ${f1(rd.lab[0])} · a* ${f1(rd.lab[1])} · b* ${f1(rd.lab[2])} · band ± ${f1(rd.band)} · checked ${esc(new Date(rd.checkedAt).toLocaleDateString())}.
          ${rd.shopperOutcome === "keep_my_shade" ? `At checkout the agent drafted ${esc(rd.draftDecision)} and the shopper kept ${esc(rc.shadeCode)}.` : rd.checkId ? "From the shopper's check on the return page." : ""}</p>`
      : `<p class="no-reading"><b>No reading on this order.</b> The agent can't draft an exchange without one, and it can't ask for a photo: the shopper's return page offers the check. <a href="#/return/${esc(rc.caseId)}">Open the shopper's return page</a></p>`;
    const draftHtml = rc.draft
      ? `<blockquote class="draft"><span class="who">The agent's draft · not approved</span>${esc(rc.draft.summary)}</blockquote>`
      : `<p class="fine">No draft yet.${ui.deskOutcome[rc.caseId] === "awaiting_shopper_check" ? " The agent found no reading and stopped: the case waits for the shopper's check." : ""}</p>`;
    const approval = rc.approval
      ? `<p class="outcome">${rc.approval.verb === "approve_exchange" ? `Exchange approved by staff: ${esc(rc.approval.replacement)} sent as a simulated replacement` : "Refund approved by staff (simulated)"} · ${esc(clock(rc.approval.at))}</p>`
      : "";
    const canDraft = !closed && rc.status !== "drafted";
    return `<article class="card case" aria-labelledby="case-${esc(rc.caseId)}">
      <header class="case-head"><h2 id="case-${esc(rc.caseId)}">${esc(rc.caseId)}</h2><span class="chip status-${esc(rc.status)}">${esc(STATUS_LABEL[rc.status])}</span></header>
      <p class="case-line">${swatch(s.hex)} ${esc(shortName(p.name))} · ${esc(s.name)} (${esc(rc.shadeCode)}) · ${esc(rc.finish)} · order ${esc(rc.orderId)} · “${esc(rc.reason)}”</p>
      <div class="case-grid"><section>${readingHtml}</section><section><h3>Resolution</h3>${draftHtml}${approval}</section></div>
      ${
        closed
          ? ""
          : `<div class="actions">
        <button type="button" class="btn" data-action="desk-draft" data-case="${esc(rc.caseId)}" ${canDraft ? "" : "disabled"}>Draft with the agent</button>
        <button type="button" class="btn primary" data-action="approve-exchange" data-case="${esc(rc.caseId)}" ${rc.draft?.resolution === "exchange" ? "" : "disabled"}>Approve exchange</button>
        <button type="button" class="btn" data-action="approve-refund" data-case="${esc(rc.caseId)}">Approve refund</button>
      </div>`
      }
    </article>`;
  });
  return `<section class="desk" aria-labelledby="desk-h"><h1 id="desk-h" class="page-title">Returns desk</h1>
    <p class="lede">Wrong-shade returns, with the shade reading attached to each order. The agent drafts; only staff approve an exchange or a refund. Opened cosmetics can't be resold, so the right exchange keeps the customer.</p>
    <div class="cases">${cards.join("")}</div></section>`;
}

// ---------------------------------------------------------------- merchant panel

function merchantView() {
  const m = server.merchant;
  const gaps = S().rangeGaps;
  const gapHtml = m.rangeGaps.length
    ? `<ul class="gap-sentences">${m.rangeGaps.map((g) => `<li>${esc(g.sentence)}</li>`).join("")}</ul>
      <table class="nums"><caption>Each reading with no close shade, numbers only</caption>
        <thead><tr><th scope="col">Product</th><th scope="col">L*</th><th scope="col">C*</th><th scope="col">h°</th><th scope="col">Nearest</th><th scope="col">ΔE00</th><th scope="col">Reading is</th></tr></thead>
        <tbody>${gaps
          .map(
            (g) =>
              `<tr><th scope="row">${esc(shortName(product(g.productId).name))}</th><td>${f1(g.lab[0])}</td><td>${f1(g.chroma)}</td><td>${Math.round(g.hueAngle)}</td><td>${swatch(shadeOf(g.productId, g.nearest.code).hex)} ${esc(g.nearest.code)}</td><td>${f1(g.nearest.de00)}</td><td>${esc(g.direction)}</td></tr>`,
          )
          .join("")}</tbody></table>`
    : `<p class="empty">No range gaps yet. Each “no close match” from a shopper's check lands here, as numbers only.</p>`;
  const outcomes = Object.entries(m.checksByOutcome);
  const maxOutcome = Math.max(1, ...outcomes.map(([, n]) => n));
  const outcomeHtml = `<ul class="bars">${outcomes
    .map(([k, n]) => `<li><span class="bar-label">${esc(k.replace("_", " "))}</span><span class="bar o-${esc(k)}" data-pct="${Math.round((100 * n) / maxOutcome)}"><span></span></span><span class="bar-n">${n}</span></li>`)
    .join("")}</ul>`;
  const capNow = m.unitCapPerCheck;
  const perCheck = m.unitsPerCheck.length
    ? `<table class="nums"><caption>Units each check spent against the ${capNow}-unit cap</caption>
        <thead><tr><th scope="col">Check</th><th scope="col">From</th><th scope="col">Products</th><th scope="col">Units</th><th scope="col">Of the cap</th></tr></thead>
        <tbody>${m.unitsPerCheck
          .map(
            (c) =>
              `<tr><th scope="row">${esc(c.checkId)}</th><td>${esc(c.origin === "cart" ? "cart" : "return page")}</td><td>${c.lines}</td><td>${c.units}</td><td><span class="bar small" data-pct="${Math.min(100, Math.round((100 * c.units) / Math.max(1, capNow)))}"><span></span></span></td></tr>`,
          )
          .join("")}</tbody></table>`
    : `<p class="empty">No checks yet this session.</p>`;
  return `<section class="merchant" aria-labelledby="m-h"><h1 id="m-h" class="page-title">Merchant panel</h1>
    <div class="m-grid"><div class="m-col">
      <section class="card m-gaps" aria-labelledby="gap-h"><h2 id="gap-h">Range gaps</h2><p class="lede">Shoppers whose reading had no shade within ΔE00 6.0: the shade the range lacks, measured from each check rather than guessed.</p>${gapHtml}</section>
      <section class="card" aria-labelledby="cap-h"><h2 id="cap-h">Spending cap</h2>
        <p>A check is priced before the photo is uploaded: 29 units to measure, plus up to 3 renders per product (38 for three). Only the merchant changes the cap; the agent can't.</p>
        <div class="cap-form"><label for="cap-input">Units per check</label><input id="cap-input" type="number" min="0" max="1000" step="1" value="${capNow}"><button type="button" class="btn primary" data-action="set-cap">Set cap</button></div>
      </section>
      </div><div class="m-col">
      <section class="card" aria-labelledby="out-h"><h2 id="out-h">Drafts by outcome</h2><p class="fine">One draft per product checked.</p>${outcomeHtml}</section>
      <section class="card" aria-labelledby="u-h"><h2 id="u-h">Units per check</h2>${perCheck}<p class="fine">${m.unitsSpentTotal} units spent this session${S().budget.balance !== null ? ` · balance ${S().budget.balance}` : ""}.</p></section>
    </div></div></section>`;
}

// ---------------------------------------------------------------- behind the scenes

function btsHtml() {
  const log = S().activityLog.slice(-80).reverse();
  const out = ui.tryOut
    ? `<div class="try-out"><p><b>${esc(ui.tryOut.call.actor)}</b> → <code>${esc(ui.tryOut.call.tool)}</code>: ${ui.tryOut.response.ok ? "allowed" : `<b class="refused">refused, ${esc(ui.tryOut.response.error.code)}</b>`}</p><p>${esc(ui.tryOut.response.ok ? "" : ui.tryOut.response.error.message)}</p><pre>${esc(JSON.stringify(ui.tryOut.call.args, null, 1))}</pre></div>`
    : "";
  return `<div class="bts-head"><h2>Behind the scenes</h2><button type="button" class="btn small" data-action="bts-toggle">Close</button></div>
    <section aria-labelledby="try-h"><h3 id="try-h">Try it as the agent</h3>
      <p class="fine">Two calls the agent is refused. Both go through the same chokepoint as every button on this page, with actor “agent”.</p>
      <div class="actions"><button type="button" class="btn small" data-action="try-apply">Change the bag (apply_draft)</button>
      <button type="button" class="btn small" data-action="try-smuggle">Smuggle a cart field into a draft</button></div>${out}
    </section>
    <section aria-labelledby="tools-h"><h3 id="tools-h">Agent tools (${tools.length})</h3>
      <p class="fine">What tool discovery lists. The seven human-only verbs are never registered as a tool.</p>
      <ul class="tool-list">${tools.map((t) => `<li><code>${esc(t.name)}</code></li>`).join("")}</ul></section>
    <section aria-labelledby="act-h"><h3 id="act-h">Activity (${S().activityLog.length})</h3>
      <ol class="activity">${log
        .map(
          (e) =>
            `<li class="act ${esc(e.result)}"><span class="actor a-${esc(e.actor)}">${esc(e.actor)}</span> <code>${esc(e.tool)}</code> <span class="res">${esc(e.result)}${e.code ? ` · ${esc(e.code)}` : ""}${e.fields ? ` (${esc(e.fields.join(", "))})` : ""}</span> <span class="units">${e.units ? `${e.units} u` : ""}</span></li>`,
        )
        .join("")}</ol></section>`;
}

// ---------------------------------------------------------------- frame

function renderChrome() {
  const m = mode();
  const badge = $("#mode-badge");
  badge.textContent = `${m.badge} · ${m.label}`;
  badge.dataset.mode = m.id;
  $("#mode-banner").textContent = m.banner + (m.notice ? ` ${m.notice}` : "");
  for (const a of document.querySelectorAll(".tabs a")) {
    if (a.dataset.route === ui.route) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  $("#bts-toggle").setAttribute("aria-expanded", String(ui.bts));
  document.documentElement.classList.toggle("bts-open", ui.bts);
}

// Re-rendering replaces the buttons, so keyboard focus is carried across: to the same control
// if it is still there, else to another control of the same return case, else to the stage's
// next step (data-focus-next), else to the view itself, never back to the top of the page.
const FOCUS_KEYS = ["action", "ctx", "case", "check", "line", "key", "value", "scenario"];
function focusedControl() {
  const a = document.activeElement;
  if (!a || a === document.body || !a.closest("#view, #bts") || a.id === "view") return null;
  if (a.id) return { exact: `#${CSS.escape(a.id)}` };
  const attrs = FOCUS_KEYS.filter((k) => a.dataset[k] !== undefined).map((k) => `[data-${k}="${CSS.escape(a.dataset[k])}"]`);
  return attrs.length ? { exact: attrs.join(""), caseId: a.dataset.case, inBts: Boolean(a.closest("#bts")) } : { inBts: Boolean(a.closest("#bts")) };
}

function restoreFocus(was) {
  if (!was) return;
  const usable = (el) => el && !el.disabled && el.offsetParent !== null;
  const root = was.inBts && ui.bts ? $("#bts") : $("#view");
  const advance = ui.advance;
  ui.advance = false;
  const candidates = [
    advance && root.querySelector("[data-focus-next]"),
    was.exact && root.querySelector(was.exact),
    was.caseId && [...root.querySelectorAll(`[data-case="${CSS.escape(was.caseId)}"]`)].find(usable),
    root.querySelector("[data-focus-next]"),
  ];
  const target = candidates.find(usable);
  if (target) target.focus({ preventScroll: true });
  else $("#view").focus({ preventScroll: true });
}

function render() {
  if (!server) return;
  const was = focusedControl();
  faces.clear();
  renderChrome();
  const view = $("#view");
  const html = { shop: shopView, return: () => returnView(ui.caseId), desk: deskView, merchant: merchantView }[ui.route]();
  view.innerHTML = html;
  hydrate(view);
  const bts = $("#bts");
  bts.hidden = !ui.bts;
  if (ui.bts) {
    bts.innerHTML = btsHtml();
    hydrate(bts);
  }
  restoreFocus(was);
}

function parseRoute() {
  const [r, arg] = location.hash.replace(/^#\/?/, "").split("/");
  ui.route = ["shop", "return", "desk", "merchant"].includes(r) ? r : "shop";
  ui.caseId = ui.route === "return" ? arg || "R-107" : null;
}

async function boot() {
  if (new URLSearchParams(location.search).get("frame") === "phone") document.documentElement.classList.add("frame-phone");
  api = await createTransport();
  tools = (await api.request("GET", "/api/tools")).tools;
  parseRoute();
  window.addEventListener("hashchange", () => {
    parseRoute();
    flash("");
    render();
    $("#view").focus({ preventScroll: true });
  });
  document.addEventListener("click", async (e) => {
    const el = e.target.closest("[data-action]");
    if (!el || el.disabled || el.matches("input")) return;
    const fn = actions[el.dataset.action];
    if (!fn) return;
    ui.advance = ADVANCING_ACTIONS.has(el.dataset.action);
    if (CONCURRENT_ACTIONS.has(el.dataset.action)) return fn(el);
    if (ui.busy) return;
    ui.busy = true;
    document.documentElement.classList.add("busy");
    try {
      await fn(el);
    } finally {
      ui.busy = false;
      document.documentElement.classList.remove("busy");
    }
  });
  document.addEventListener("change", (e) => {
    if (e.target.matches('input[type="file"][data-action="upload"]')) onUpload(e.target);
  });
  document.addEventListener(
    "toggle",
    (e) => {
      if (e.target.matches?.("details.more")) ui.moreOpen = e.target.open;
    },
    true,
  );
  document.addEventListener("input", (e) => {
    if (e.target.matches('input[data-action="split"]')) setSplit(e.target.dataset.key, Number(e.target.value));
  });
  await refresh();
}

boot().catch((e) => {
  $("#view").innerHTML = `<p class="card branch problem">The store couldn't load: ${esc(e.message)}</p>`;
});
