// The authored, fictional store: catalogue, demo cart, orders and return cases. Each call
// returns fresh copies, so every store starts from the same state.
import catalogue from "../fixtures/catalogue.json" with { type: "json" };
import cart from "../fixtures/cart.json" with { type: "json" };
import returns from "../fixtures/returns.json" with { type: "json" };

export function loadFixtures() {
  return structuredClone({ catalogue, cart, returns });
}
