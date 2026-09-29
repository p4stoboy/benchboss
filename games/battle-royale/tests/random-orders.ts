import type { Rng, SeatId } from "@benchboss/core";
import { CLASSES } from "../src/classes";
import { plans } from "../src/state";
import type { BrState, Orders, UnitOrder } from "../src/types";

/** Uniformly random legal orders, used by generated conformance and privacy runs. */
export function randomOrders(state: BrState, seat: SeatId, rng: Rng): Orders & { chat?: string } {
  const planned = plans(state, seat);
  const orders: UnitOrder[] = [];
  for (const { unit, reaches } of planned) {
    if (rng.int(4) === 0) continue;
    const reach = rng.pick(reaches);
    const order: UnitOrder = { unit: unit.id };
    if (reach.cost > 0) order.moveTo = { x: reach.x, y: reach.y };
    if (reach.targets.length && rng.int(5) > 0)
      order.action = { kind: "attack", target: rng.pick(reach.targets) };
    else if (CLASSES[unit.cls].heal > 0 && planned.length > 1 && rng.int(2) === 0)
      order.action = {
        kind: "heal",
        target: rng.pick(planned.filter((p) => p.unit.id !== unit.id)).unit.id,
      };
    else if (rng.int(3) === 0) order.action = { kind: "hold" };
    orders.push(order);
  }
  const chat = rng.int(4) === 0 ? { chat: `r${state.round} ${seat} ${rng.int(1000)}` } : {};
  return { orders: rng.shuffle(orders), ...chat };
}
