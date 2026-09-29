import type { Rng, SeatId } from "@benchboss/core";
import { ABILITIES, CLASSES } from "../src/classes";
import { itemAt } from "../src/loot";
import { inBounds } from "../src/map";
import { abilityReady, plans } from "../src/state";
import type { Action, BrState, Orders, UnitOrder } from "../src/types";

/** Uniformly random legal orders, used by generated conformance and privacy runs. */
export function randomOrders(state: BrState, seat: SeatId, rng: Rng): Orders & { chat?: string } {
  const planned = plans(state, seat);
  const orders: UnitOrder[] = [];
  for (const { unit, reaches } of planned) {
    if (rng.int(4) === 0) continue;
    const reach = rng.pick(reaches);
    const order: UnitOrder = { unit: unit.id };
    if (reach.cost > 0) order.moveTo = { x: reach.x, y: reach.y };
    const ability = ABILITIES[CLASSES[unit.cls].ability];
    const choices: Action[] = [];
    if (reach.targets.length) choices.push({ kind: "attack", target: rng.pick(reach.targets) });
    if (itemAt(state.items, reach)) choices.push({ kind: "pickup" });
    if (abilityReady(state, unit)) {
      if (ability.target === "none") choices.push({ kind: "ability" });
      if (ability.target === "enemy" && reach.targets.length)
        choices.push({ kind: "ability", target: rng.pick(reach.targets) });
      if (ability.target === "ally" && planned.length > 1)
        choices.push({
          kind: "ability",
          target: rng.pick(planned.filter((p) => p.unit.id !== unit.id)).unit.id,
        });
      if (ability.target === "point") {
        const at = {
          x: reach.x + rng.int(2 * ability.range + 1) - ability.range,
          y: reach.y + rng.int(2 * ability.range + 1) - ability.range,
        };
        if (inBounds(state.map, at)) choices.push({ kind: "ability", at });
      }
    }
    if (choices.length && rng.int(5) > 0) order.action = rng.pick(choices);
    else if (rng.int(3) === 0) order.action = { kind: "hold" };
    orders.push(order);
  }
  const chat = rng.int(4) === 0 ? { chat: `r${state.round} ${seat} ${rng.int(1000)}` } : {};
  return { orders: rng.shuffle(orders), ...chat };
}
