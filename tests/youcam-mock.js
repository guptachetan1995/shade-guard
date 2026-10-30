// A stand-in for the YouCam API server on a loopback socket, for the live provider's tests and
// the scripts' tests. It answers in the shapes the docs describe (and the shapes the live
// provider assumes where the docs give none), records every request it receives (method,
// path, headers, body), and never touches the network. Nothing here is a real YouCam response.
import { createServer } from "node:http";
import { fakePhoto } from "../src/providers/fake-photos.js";

const GOOD = { lighting: "good", frontal: "good", area: "good", faceangle: "good" };

const COSTS = { "skin-tone-analysis": 20, "skin-analysis": 9, "makeup-vto": 1 };

// key: the one key the mock accepts. keyError: the code a wrong key gets (no key at all always
// gets InvalidAccessToken, as observed on the real server). pollsUntilDone: polls before a
// task finishes, per feature or for all. engineError: { [feature]: code } for a finished task.
// skinHex: the tone reading, or a function of the task's src_file_id (the default reproduces
// the demo story's sample shopper).
export async function startYouCamMock({ key, keyError = "InvalidApiKey", balance = 1000, pollsUntilDone = 1, engineError = {}, skinHex = "#B9947C" } = {}) {
  const state = { requests: [], files: new Map(), tasks: new Map(), balance, seq: 0, injected: [] };
  let base = "";

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };
  const fail = (res, status, code) => send(res, status, { status, error: code, error_code: code });

  const polls = (feature) => (typeof pollsUntilDone === "number" ? pollsUntilDone : (pollsUntilDone[feature] ?? 1));

  function results(task) {
    if (task.feature === "skin-tone-analysis") {
      const hex = typeof skinHex === "function" ? skinHex(task.body.src_file_id) : skinHex;
      return { color: { skin_color: hex }, face_quality: { ...GOOD } };
    }
    if (task.feature === "skin-analysis") {
      const raw = { oiliness: 58.1, moisture: 61, redness: 71.4 };
      return {
        output: task.body.dst_actions.map((type) =>
          type === "skin_type"
            ? { type, whole: "Combination", t_zone: "Oily", u_zone: "Normal" }
            : { type, ui_score: Math.round(raw[type] + 12), raw_score: raw[type], mask_urls: [`${base}/masks/${task.taskId}-${type}.png`] },
        ),
      };
    }
    return { url: `${base}/results/${task.taskId}.jpg` };
  }

  function handle(req, res, body) {
    const url = new URL(req.url, base);
    const path = url.pathname;
    state.requests.push({ method: req.method, path, query: url.search, headers: { ...req.headers }, body });

    // One-shot canned answers, for errors and shapes the docs don't promise.
    const i = state.injected.findIndex((x) => x.method === req.method && path.startsWith(x.path));
    if (i >= 0) {
      const [{ status, body: b, headers }] = state.injected.splice(i, 1);
      return send(res, status, b, headers);
    }

    if (req.method === "PUT" && path.startsWith("/upload/")) {
      const file = state.files.get(path.slice("/upload/".length));
      if (!file) return send(res, 404, "");
      file.uploaded = body;
      file.uploadHeaders = { ...req.headers };
      return send(res, 200, "");
    }
    if (req.method === "GET" && path.startsWith("/results/")) {
      const taskId = path.slice("/results/".length).replace(/\.jpg$/, "");
      if (!state.tasks.has(taskId)) return send(res, 404, "");
      res.writeHead(200, { "content-type": "image/jpeg" });
      return res.end(Buffer.from(fakePhoto(`render:${taskId}`)));
    }
    if (!path.startsWith("/s2s/")) return send(res, 404, "");

    const auth = req.headers.authorization;
    if (!auth) return fail(res, 401, "InvalidAccessToken");
    if (auth !== `Bearer ${key}`) return fail(res, 401, keyError);
    const json = body.length ? JSON.parse(body.toString("utf8")) : null;

    if (req.method === "POST" && path === "/s2s/v2.0/file") {
      const f = json.files[0];
      const fileId = `file_${++state.seq}`;
      state.files.set(fileId, { fileId, declared: f, uploaded: null, deleted: false });
      return send(res, 200, {
        status: 200,
        data: {
          files: [
            {
              content_type: f.content_type,
              file_name: f.file_name,
              file_id: fileId,
              requests: [{ method: "PUT", url: `${base}/upload/${fileId}?sig=mock`, headers: { "Content-Length": String(f.file_size), "Content-Type": f.content_type } }],
            },
          ],
        },
      });
    }
    if (req.method === "POST" && path === "/s2s/v2.0/task/delete") {
      const task = state.tasks.get(json.task_id);
      if (!task || task.deleted) return fail(res, 404, "InvalidTaskId");
      if (task.status === "running") return fail(res, 400, "OperationInvalid");
      task.deleted = true;
      state.files.get(task.body.src_file_id).deleted = true;
      return send(res, 200, { status: 200, data: {} });
    }
    let m = /^\/s2s\/v2\.0\/task\/([a-z-]+)$/.exec(path);
    if (req.method === "POST" && m) {
      const feature = m[1];
      const file = state.files.get(json.src_file_id);
      if (!file || file.deleted) return fail(res, 400, "InvalidParameters");
      if (!file.uploaded) return fail(res, 500, "unknown_internal_error");
      if (state.balance < COSTS[feature]) return fail(res, 400, "CreditInsufficiency");
      const taskId = `task_${++state.seq}`;
      state.tasks.set(taskId, { taskId, feature, body: json, polls: 0, status: "running", deleted: false });
      return send(res, 200, { status: 200, data: { task_id: taskId } });
    }
    m = /^\/s2s\/v2\.0\/task\/([a-z-]+)\/([^/]+)$/.exec(path);
    if (req.method === "GET" && m) {
      const task = state.tasks.get(decodeURIComponent(m[2]));
      if (!task || task.deleted || task.feature !== m[1]) return fail(res, 404, "InvalidTaskId");
      task.polls += 1;
      if (task.status === "running" && task.polls >= polls(task.feature)) {
        if (engineError[task.feature]) task.status = "error";
        else {
          task.status = "success";
          state.balance -= COSTS[task.feature];
        }
      }
      if (task.status === "running") return send(res, 200, { status: 200, data: { task_status: "running" } });
      if (task.status === "error") return send(res, 200, { status: 200, data: { task_status: "error", error: engineError[task.feature] } });
      return send(res, 200, { status: 200, data: { task_status: "success", results: results(task) } });
    }
    if (req.method === "GET" && path === "/s2s/v1.0/client/credit") {
      return send(res, 200, { status: 200, results: [{ amount: state.balance }] });
    }
    if (req.method === "GET" && path === "/s2s/v2.0/credit/feature-cost") {
      return send(res, 200, { status: 200, data: { features: Object.entries(COSTS).map(([feature, units]) => ({ feature, units })) } });
    }
    return fail(res, 404, "NotFound");
  }

  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => handle(req, res, Buffer.concat(chunks)));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  return {
    url: base,
    state,
    // The next request with this method whose path starts with path gets this answer once.
    inject(method, path, status, body, headers = {}) {
      state.injected.push({ method, path, status, body, headers });
    },
    apiRequests: () => state.requests.filter((r) => r.path.startsWith("/s2s/")),
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}
