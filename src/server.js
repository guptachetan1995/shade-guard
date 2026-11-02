// The local server: node:http on 127.0.0.1 only. It serves the page and its ES modules, and
// four API routes that all end in invoke() (plus the agent and preview routes in api.js).
// Run directly (npm start), it reads its settings from src/config.js, the only env reader.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createApp } from "./app.js";
import { createApi, TICK_MS } from "./api.js";
import { chooseMode, describeMode } from "./modes.js";
import { FakeYouCamProvider } from "./providers/youcam-fake.js";
import { YouCamProvider } from "./providers/youcam-live.js";
import { RecordedYouCamProvider } from "./providers/youcam-recorded.js";
import { loadRecording, RECORDING_DIR } from "./recording.js";
import { personaOf } from "./persona.js";

export const HOST = "127.0.0.1";
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
const ROOT = fileURLToPath(new URL("..", import.meta.url));

// Never served: the env reader and the server itself stay on this machine.
const SERVER_ONLY = new Set(["src/config.js", "src/server.js"]);
const STATIC_DIRS = ["public/", "src/", "fixtures/"];
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
};
const CSP = "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'";

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "x-content-type-options": "nosniff", ...headers });
  res.end(body);
}

function sendJson(res, status, body) {
  send(res, status, JSON.stringify(body), { "content-type": TYPES[".json"], "cache-control": "no-store" });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    // An oversized body is drained and discarded, never buffered, so the client still gets
    // its 413 instead of a reset connection.
    req.on("data", (c) => {
      size += c.length;
      if (size <= MAX_BODY_BYTES) chunks.push(c);
    });
    req.on("end", () => {
      if (size > MAX_BODY_BYTES) reject(Object.assign(new Error("too large"), { code: "body_too_large" }));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

async function serveStatic(req, res, root) {
  const { pathname } = new URL(req.url, "http://local.invalid");
  let rel;
  try {
    rel = pathname === "/" ? "index.html" : normalize(decodeURIComponent(pathname).slice(1)).split(sep).join("/");
  } catch {
    return send(res, 400, "Bad path", { "content-type": "text/plain" });
  }
  const allowed = (rel === "index.html" || STATIC_DIRS.some((d) => rel.startsWith(d))) && !rel.includes("..") && !SERVER_ONLY.has(rel) && TYPES[extname(rel)];
  if (!allowed) return send(res, 404, "Not found", { "content-type": "text/plain" });
  try {
    const bytes = await readFile(join(root, rel));
    send(res, 200, bytes, { "content-type": TYPES[extname(rel)], "content-security-policy": CSP, "cache-control": "no-cache" });
  } catch {
    send(res, 404, "Not found", { "content-type": "text/plain" });
  }
}

export function createHttpServer({ api, root = ROOT }) {
  return createServer(async (req, res) => {
    // A page on another origin that rebinds a hostname to 127.0.0.1 still sends its own Host.
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (host !== HOST && host !== "localhost") return sendJson(res, 403, { ok: false, error: { code: "bad_host", message: "This server answers only to 127.0.0.1 or localhost." } });

    const isApi = req.url.startsWith("/api/");
    if (!isApi) {
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed");
      return serveStatic(req, res, root);
    }
    let body = null;
    if (req.method === "POST") {
      let text;
      try {
        text = await readBody(req);
      } catch (e) {
        if (e.code === "body_too_large") return sendJson(res, 413, { ok: false, error: { code: "body_too_large", message: "Request bodies are limited to 2 MB." } });
        throw e;
      }
      try {
        body = JSON.parse(text || "null");
      } catch {
        return sendJson(res, 400, { ok: false, error: { code: "bad_json", message: "The request body is not valid JSON." } });
      }
    } else if (req.method !== "GET") {
      return sendJson(res, 405, { ok: false, error: { code: "method_not_allowed", message: `${req.method} is not supported.` } });
    }
    try {
      const { status, body: out } = await api.handle(req.method, req.url, body);
      sendJson(res, status, out);
    } catch {
      sendJson(res, 500, { ok: false, error: { code: "internal_error", message: "The server hit an unexpected error." } });
    }
  });
}

export async function startServer({ app, mode, port = 0, root = ROOT }) {
  const api = createApi({ app, mode });
  const server = createHttpServer({ api, root });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, resolve);
  });
  const ticker = setInterval(() => api.tick().catch(() => {}), TICK_MS);
  ticker.unref();
  const url = `http://${HOST}:${server.address().port}`;
  return {
    url,
    server,
    close: () =>
      new Promise((resolve) => {
        clearInterval(ticker);
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}

// The recorded sample shopper, or null when none has been recorded into dir.
export function loadRecordingFrom(dir = join(ROOT, RECORDING_DIR)) {
  return loadRecording((name) => {
    const path = join(dir, name);
    return existsSync(path) ? new Uint8Array(readFileSync(path)) : null;
  });
}

// Live only when YOUCAM_MODE=live and a key is configured. Replay (the default with no key) when
// a recording exists. Anything else runs the fake provider and the banner says why. The key goes
// into the live provider and nowhere else.
export function providerFor(config, { recording = null } = {}) {
  const { mode: id, notice } = chooseMode({
    requested: config.requestedMode,
    hasKey: Boolean(config.apiKey),
    liveAvailable: true,
    recordingAvailable: Boolean(recording),
  });
  if (id === "live") return { provider: new YouCamProvider({ apiKey: config.apiKey, apiBase: config.apiBase }), mode: describeMode(id, notice) };
  if (id === "replay") return { provider: new RecordedYouCamProvider(recording), mode: describeMode(id, notice, { recordedAt: recording.recordedAt, persona: personaOf(recording) }) };
  return { provider: new FakeYouCamProvider(), mode: describeMode(id, notice) };
}

async function main() {
  const { loadConfig } = await import("./config.js");
  const config = loadConfig();
  const recording = config.requestedMode === "replay" ? await loadRecordingFrom() : null;
  const { provider, mode } = providerFor(config, { recording });
  const notice = mode.notice;
  const app = await createApp({ provider, unitCapPerCheck: config.unitCapPerCheck });
  const { url } = await startServer({ app, mode, port: config.port });
  process.stdout.write(`Shade Guard: ${url}\nMode: ${mode.badge} (${mode.label})\n${notice ? `${notice}\n` : ""}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    process.stderr.write(`Shade Guard could not start: ${e.message}\n`);
    process.exit(1);
  });
}
