import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const importRe = /^\s*(?:import|export)\s[^;]*?\sfrom\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/gm;

function closure(entry) {
  const seen = new Set();
  const stack = [resolve(root, entry)];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(importRe)) {
      const spec = m[1] || m[2] || m[3];
      if (spec.startsWith(".")) stack.push(resolve(dirname(file), spec));
    }
  }
  return [...seen].map((f) => relative(root, f));
}

test("nothing the agent's tools or the planner import, however indirectly, is the chat transport, the chat verbs or the SDK module", () => {
  for (const entry of ["src/tools.js", "src/agent/planner.js"]) {
    const files = closure(entry);
    assert.ok(files.length >= 2, entry);
    const bad = files.filter((f) => f.startsWith(join("src", "chat") + "/") || /chat-verbs|chat-sdk|human-verbs/.test(f));
    assert.deepEqual(bad, [], `${entry} reaches ${bad.join(", ")}`);
  }
});

test("the lint rule that enforces it exists", () => {
  const lint = readFileSync(join(root, "scripts/lint.js"), "utf8");
  assert.match(lint, /agentSide/);
  assert.match(lint, /chat-verbs/);
});
