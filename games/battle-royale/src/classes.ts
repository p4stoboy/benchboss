export const CLASS_IDS = ["scout", "grunt", "vanguard", "ranger", "medic", "sniper"] as const;
export type ClassId = (typeof CLASS_IDS)[number];

export interface ClassSpec {
  cost: number;
  hp: number;
  move: number;
  /** Chebyshev attack range; 1 is melee. */
  range: number;
  damage: number;
  /** Base vision radius; the tile height of the observer is added. */
  vision: number;
  /** Hit points restored by a heal action to an adjacent ally; 0 disables the action. */
  heal: number;
}

// Placeholder tuning. Tests assert behaviour (budget, reach, sight), never these numbers.
export const CLASSES: Record<ClassId, ClassSpec> = {
  scout: { cost: 2, hp: 6, move: 6, range: 1, damage: 2, vision: 8, heal: 0 },
  grunt: { cost: 2, hp: 8, move: 4, range: 3, damage: 2, vision: 5, heal: 0 },
  vanguard: { cost: 3, hp: 14, move: 4, range: 1, damage: 4, vision: 4, heal: 0 },
  ranger: { cost: 3, hp: 8, move: 4, range: 5, damage: 3, vision: 6, heal: 0 },
  medic: { cost: 3, hp: 9, move: 4, range: 2, damage: 1, vision: 5, heal: 4 },
  sniper: { cost: 4, hp: 6, move: 3, range: 8, damage: 5, vision: 7, heal: 0 },
};

export const TEAM_SIZE = 3;
export const TEAM_BUDGET = 9;
export const DEFAULT_ROSTER: readonly ClassId[] = ["grunt", "grunt", "grunt"];

export const rosterCost = (roster: readonly ClassId[]): number =>
  roster.reduce((sum, id) => sum + CLASSES[id].cost, 0);

export const isAffordable = (roster: readonly ClassId[]): boolean =>
  roster.length === TEAM_SIZE && rosterCost(roster) <= TEAM_BUDGET;
