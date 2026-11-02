// The persona prompt file (fixtures/persona-prompt.txt) as a text-to-image request, and the
// provenance block the recorder writes into recording.json for a face made from it.
//
// Request shape per the YouCam docs, read 30 Oct 2026:
//   docs.makeupar.com/reference/ai_image_generator/v2.0/paths/~1s2s~1v2.0~1task~1text-to-image~1youcam/post.md
//   model (required, enum youcam-image-v2), prompt (required, ≤ 800 characters, each letter,
//   digit or symbol one), negative_prompt (≤ 500), size (enum, 1104*1472 is 3:4, which scales
//   exactly to 768×1024), prompt_extend ("smart prompt rewriting"; typed boolean, but the
//   page lists its enum as the strings "true" and "false". UNVERIFIED which one the server
//   takes; a boolean is sent).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GENERATED_PERSONA_SOURCE } from "../src/persona.js";

export const PERSONA_PROMPT_FILE = fileURLToPath(new URL("../fixtures/persona-prompt.txt", import.meta.url));
export const GEN_MODEL = "youcam-image-v2";
export const GEN_SIZE = "1104*1472";
const PROMPT_MAX = 800;
const NEGATIVE_MAX = 500;

export class PromptError extends Error {}

const chars = (s) => [...s].length;

function parse(text) {
  const fields = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("#")) continue;
    const m = /^([a-z_.-]+):\s*(.*)$/.exec(line);
    if (!m) throw new PromptError(`the persona prompt file has a line that is not "key: value": ${line.slice(0, 40)}`);
    fields[m[1]] = m[2].trim();
  }
  return fields;
}

// bytes: the prompt file's contents. variant: null for the persona, else a prompt.<variant> line.
export function personaRequest(bytes, variant = null) {
  const fields = parse(Buffer.from(bytes).toString("utf8"));
  const key = variant ? `prompt.${variant}` : "prompt";
  const prompt = fields[key];
  if (!prompt) throw new PromptError(`the persona prompt file has no ${key} line`);
  if (chars(prompt) > PROMPT_MAX) throw new PromptError(`${key} is ${chars(prompt)} characters; the generator takes ${PROMPT_MAX}`);
  const negative = fields.negative_prompt ?? "";
  if (chars(negative) > NEGATIVE_MAX) throw new PromptError(`negative_prompt is ${chars(negative)} characters; the generator takes ${NEGATIVE_MAX}`);
  const body = { model: GEN_MODEL, prompt, ...(negative ? { negative_prompt: negative } : {}), size: GEN_SIZE, prompt_extend: false };
  return { body, sha256: sha256(bytes) };
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// What recording.json says about a face generated from this prompt file.
export function generatedPersona(path = PERSONA_PROMPT_FILE) {
  return { source: GENERATED_PERSONA_SOURCE, model: GEN_MODEL, promptSha256: sha256(readFileSync(path)) };
}
