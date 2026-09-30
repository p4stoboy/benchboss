import type { Rng } from "@benchboss/core";
import { type GameMap, chebyshev, closeRound, mapCenter, zoneRadius } from "./map";
import type { BrState, Point, ZoneStage } from "./types";

/**
 * The safe zone for every round of the match, decided at match creation. Round 1 is the whole
 * map around its centre; each later stage keeps the radius rule and moves its centre by a
 * seeded offset no larger than the shrink, so every stage lies inside the one before. Rounds
 * from `closeRound` on are the single final tile.
 */
export function zoneSchedule(rng: Rng, map: GameMap, maxRounds: number): ZoneStage[] {
  const close = closeRound(maxRounds);
  const first: ZoneStage = { center: mapCenter(map), radius: zoneRadius(map, maxRounds, 1) };
  const stages: ZoneStage[] = [first, first];
  for (let round = 2; round <= close; round++) {
    const previous = stages[round - 1] as ZoneStage;
    const radius = zoneRadius(map, maxRounds, round);
    const slack = previous.radius - radius;
    const drift = (): number => rng.int(2 * slack + 1) - slack;
    stages.push({
      center: {
        x: Math.min(map.width - 1, Math.max(0, previous.center.x + drift())),
        y: Math.min(map.height - 1, Math.max(0, previous.center.y + drift())),
      },
      radius,
    });
  }
  return stages;
}

/** The stage in effect for `round`; rounds past the close share the final tile. */
export function zoneAt(state: BrState, round: number): ZoneStage {
  const last = state.zones.length - 1;
  const stage = state.zones[Math.min(last, Math.max(1, round))];
  if (!stage) throw Error("zone schedule is empty");
  return stage;
}

export const inZone = (stage: ZoneStage, p: Point): boolean =>
  chebyshev(stage.center, p) <= stage.radius;
