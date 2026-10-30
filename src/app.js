// Wires one store, one provider and the one chokepoint together. This is the only module that
// sees both the agent's tools and the human-only verbs.
import { createStore, DEFAULT_UNIT_CAP_PER_CHECK } from "./store.js";
import { createInvoke } from "./invoke.js";
import { TOOLS, listTools } from "./tools.js";
import { HUMAN_VERBS } from "./human-verbs.js";
import { assertProvider, loadFeatureCosts } from "./providers/provider.js";
import { loadFixtures } from "./fixtures.js";

export async function createApp({ provider, unitCapPerCheck = DEFAULT_UNIT_CAP_PER_CHECK, now, wait, fixtures = loadFixtures() }) {
  assertProvider(provider);
  const store = createStore({ ...fixtures, unitCapPerCheck, now });
  const costs = await loadFeatureCosts(provider);
  const invoke = createInvoke({ store, provider, tools: TOOLS, verbs: HUMAN_VERBS, costs, wait });
  return { store, provider, costs, invoke, listTools };
}
