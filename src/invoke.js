// The one chokepoint. Every tool call and every human verb, from the store's buttons or from
// the agent, runs through invoke(tool, args, actor), in this order:
//   1. the actor is one of the four known actors;
//   2. the name is a registered tool or a human verb, and a verb is called by its own actor;
//   3. the arguments carry only declared fields (a smuggled cart or status field is refused
//      and logged, never dropped), with the declared types;
//   4. a paid call fits the check's unit cap, checked before the provider is touched;
//   5. the call runs, and the activity log records actor, arguments, result and units.
// Calls run one at a time, so the units a call spent are exactly the ledger's change. The one
// exception is a verb marked concurrent (stop_waiting): it must reach a check whose own call
// is still waiting on a task, it spends nothing, and it is logged with 0 units.
import { Refusal } from "./refusal.js";
import { YouCamError, messageFor } from "./providers/errors.js";

export const ACTORS = Object.freeze(["agent", "shopper", "staff", "merchant"]);

const TYPES = {
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number" && Number.isFinite(v),
  integer: (v) => Number.isInteger(v),
  object: (v) => v !== null && typeof v === "object" && !Array.isArray(v),
  array: (v) => Array.isArray(v),
};

function checkArgs(def, args) {
  if (!TYPES.object(args)) throw new Refusal("bad_args", "Arguments must be an object.");
  const declared = def.args;
  const extra = Object.keys(args).filter((k) => !Object.hasOwn(declared, k));
  if (extra.length) {
    throw new Refusal("smuggled_field", `${def.name} does not take ${extra.join(", ")}; the call was refused and logged.`, { fields: extra });
  }
  for (const [k, spec] of Object.entries(declared)) {
    const v = args[k];
    if (v === undefined) {
      if (spec.required) throw new Refusal("bad_args", `${def.name} needs ${k}.`);
      continue;
    }
    if (!TYPES[spec.type](v)) throw new Refusal("bad_args", `${k} must be ${spec.type === "integer" ? "an" : "a"} ${spec.type}.`);
    if (spec.enum && !spec.enum.includes(v)) throw new Refusal("bad_args", `${k} must be one of ${spec.enum.join(", ")}.`);
  }
}

// The log keeps what was asked, never the photo itself.
function redact(args) {
  if (!TYPES.object(args)) return args;
  const out = structuredClone(args);
  if (typeof out.photo === "string") out.photo = `[photo, ${out.photo.length} base64 characters, not logged]`;
  return out;
}

export function createInvoke({ store, provider, tools, verbs, costs, wait = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const verbMap = new Map(verbs.map((v) => [v.name, v]));
  let tail = Promise.resolve();

  async function call(name, args, actor, concurrent = false) {
    const entry = { at: store.now(), actor: String(actor), tool: String(name), args: redact(args), result: "ok", units: 0 };
    const spentBefore = store.state.budget.unitsSpentTotal;
    try {
      if (!ACTORS.includes(actor)) {
        const named = actor === undefined || actor === null || actor === "" ? "No actor was named" : `Unknown actor ${actor}`;
        throw new Refusal("unknown_actor", `${named}; the actors are ${ACTORS.join(", ")}.`);
      }
      const verb = verbMap.get(name);
      const def = verb ?? toolMap.get(name);
      if (!def) throw new Refusal("unknown_tool", `No tool or verb is named ${name}.`);
      if (verb && actor !== verb.actor) {
        throw new Refusal("wrong_actor", `${name} belongs to the ${verb.actor}; ${actor === "agent" ? "the agent never calls a human verb" : `a ${actor} can't call it`}.`);
      }
      checkArgs(def, args ?? {});
      const ctx = { store, provider, costs, wait, actor };
      if (def.gate) {
        const { checkId, units } = def.gate(args, ctx);
        const check = store.getCheck(checkId);
        if (!check) throw new Refusal("unknown_check", `No check ${checkId} exists.`);
        const cap = store.state.budget.unitCapPerCheck;
        if (check.unitsSpent + units > cap) {
          throw new Refusal("unit_cap", `This call needs ${units} units of headroom; check ${checkId} has spent ${check.unitsSpent} of its ${cap}-unit cap. Nothing was sent.`, {
            needed: units,
            spent: check.unitsSpent,
            cap,
          });
        }
      }
      const result = await def.run(args ?? {}, ctx);
      entry.units = concurrent ? 0 : store.state.budget.unitsSpentTotal - spentBefore;
      return { ok: true, result, units: entry.units };
    } catch (e) {
      entry.units = concurrent ? 0 : store.state.budget.unitsSpentTotal - spentBefore;
      if (e instanceof Refusal) {
        entry.result = "refused";
        entry.code = e.code;
        if (e.details.fields) entry.fields = e.details.fields;
        return { ok: false, error: { code: e.code, message: e.message, ...e.details }, units: entry.units };
      }
      if (e instanceof YouCamError) {
        entry.result = "error";
        entry.code = e.code;
        return { ok: false, error: { code: e.code, message: messageFor(e.code) }, units: entry.units };
      }
      entry.result = "error";
      entry.code = "internal_error";
      throw e;
    } finally {
      store.state.activityLog.push(entry);
    }
  }

  return function invoke(name, args, actor) {
    if (verbMap.get(name)?.concurrent) return call(name, args, actor, true);
    const run = tail.then(() => call(name, args, actor));
    tail = run.catch(() => {});
    return run;
  };
}
