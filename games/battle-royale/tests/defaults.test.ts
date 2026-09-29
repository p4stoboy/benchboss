import { expect, test } from "bun:test";
import { createRng } from "@benchboss/core";
import { validateSchema } from "@benchboss/protocol";
import { defaultOrders, safeDefault } from "../src/defaults";
import { chebyshev, zoneCenter, zoneRadius } from "../src/map";
import { game, newMatch, unit } from "./helpers";
import { randomOrders } from "./random-orders";

test("default orders are legal and never leave a unit more exposed to the next storm", () => {
  const rng = createRng("defaults");
  for (const seatCount of [2, 6]) {
    let state = newMatch(seatCount, `defaults:${seatCount}`, { maxRounds: 10 });
    for (const seat of state.seats) {
      const chosen = safeDefault(state, seat);
      expect(chosen.tool).toBe("match.loadout");
      const offer = game.legalActions(state, seat)[0];
      expect(validateSchema(offer?.jsonSchema ?? {}, chosen.input).ok).toBe(true);
      state = game.submit(state, seat, chosen.input, chosen.tool).state;
    }
    state = game.step(state);
    while (state.phase === "orders") {
      const center = zoneCenter(state.map);
      const radius = zoneRadius(state.map, state.rules.maxRounds, state.round + 1);
      const exposure = (p: { x: number; y: number }) => Math.max(0, chebyshev(center, p) - radius);
      for (const seat of state.seats) {
        if (state.teams[seat]?.placement !== null) continue;
        const chosen = safeDefault(state, seat);
        const offer = game.legalActions(state, seat)[0];
        expect(validateSchema(offer?.jsonSchema ?? {}, chosen.input).ok).toBe(true);
        expect(game.submit(state, seat, chosen.input, chosen.tool).accepted).toBe(true);
        for (const order of defaultOrders(state, seat)) {
          expect(order.action).toBeUndefined();
          expect(exposure(order.moveTo as never)).toBeLessThanOrEqual(
            exposure(unit(state, order.unit)),
          );
        }
        const input = rng.int(2) ? chosen.input : randomOrders(state, seat, rng);
        state = game.submit(state, seat, input, "match.orders").state;
      }
      state = game.step(state);
    }
  }
});
