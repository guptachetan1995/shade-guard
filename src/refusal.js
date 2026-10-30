// A refusal is an expected "no" from the chokepoint, a tool or a verb: it is logged and
// returned to the caller as { ok: false, error: { code, message } }, never thrown past invoke.
export class Refusal extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function refuse(code, message, details) {
  throw new Refusal(code, message, details);
}
