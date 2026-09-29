import type { SeatId } from "@benchboss/core";
import type { ActionInvocation } from "@benchboss/protocol";
import { DEFAULT_ROSTER } from "./classes";
import { chebyshev, zoneCenter, zoneRadius } from "./map";
import { isEliminated, plans } from "./state";
import type { BrState, UnitOrder } from "./types";

/** Every unit heads for the tile that leaves it least exposed to next round's storm. */
export function defaultOrders(state: BrState, seat: SeatId): UnitOrder[] {
  const center = zoneCenter(state.map);
  const radius = zoneRadius(state.map, state.rules.maxRounds, state.round + 1);
  const exposure = (p: { x: number; y: number }): number =>
    Math.max(0, chebyshev(center, p) - radius);
  return plans(state, seat).flatMap(({ unit, reaches }) => {
    let best = reaches[0];
    for (const reach of reaches) {
      if (!best) best = reach;
      const better =
        exposure(reach) !== exposure(best)
          ? exposure(reach) < exposure(best)
          : reach.cost !== best.cost
            ? reach.cost < best.cost
            : reach.x !== best.x
              ? reach.x < best.x
              : reach.y < best.y;
      if (better) best = reach;
    }
    if (!best || best.cost === 0) return [];
    return [{ unit: unit.id, moveTo: { x: best.x, y: best.y } }];
  });
}

export function safeDefault(state: BrState, seat: SeatId): ActionInvocation {
  if (state.phase === "loadout")
    return { tool: "match.loadout", input: { actors: [...DEFAULT_ROSTER] } };
  if (state.phase === "orders" && !isEliminated(state, seat))
    return { tool: "match.orders", input: { orders: defaultOrders(state, seat) } };
  return { tool: "match.orders", input: { orders: [] } };
}
