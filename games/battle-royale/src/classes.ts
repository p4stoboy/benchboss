export const WEAPON_IDS = [
  "knife",
  "rifle",
  "hammer",
  "carbine",
  "pistol",
  "longrifle",
  "shotgun",
  "autorifle",
  "marksman",
  "railgun",
] as const;
export type WeaponId = (typeof WEAPON_IDS)[number];

export interface WeaponSpec {
  /** Chebyshev attack range; 1 is melee. */
  range: number;
  damage: number;
}

// Placeholder tuning. Tests assert behaviour (budget, reach, sight), never these numbers.
export const WEAPONS: Record<WeaponId, WeaponSpec> = {
  knife: { range: 1, damage: 2 },
  rifle: { range: 3, damage: 2 },
  hammer: { range: 1, damage: 4 },
  carbine: { range: 5, damage: 3 },
  pistol: { range: 2, damage: 1 },
  longrifle: { range: 8, damage: 5 },
  shotgun: { range: 2, damage: 5 },
  autorifle: { range: 4, damage: 3 },
  marksman: { range: 6, damage: 4 },
  railgun: { range: 9, damage: 6 },
};

export const ABILITY_IDS = ["recon", "grenade", "brace", "volley", "heal", "camo"] as const;
export type AbilityId = (typeof ABILITY_IDS)[number];

export interface AbilitySpec {
  /** Rounds that must pass after a use before the next; 0 means every round. */
  cooldown: number;
  /** What the order must name: nothing, a tile (`at`) or a unit id (`target`). */
  target: "none" | "point" | "enemy" | "ally";
  /** Reveal or blast radius (Chebyshev). */
  radius: number;
  /** Throwing range for point abilities. */
  range: number;
  /** Damage, healing or armour granted. */
  amount: number;
  /** Rounds a self-effect lasts. */
  duration: number;
}

export const ABILITIES: Record<AbilityId, AbilitySpec> = {
  recon: { cooldown: 3, target: "none", radius: 6, range: 0, amount: 0, duration: 1 },
  grenade: { cooldown: 3, target: "point", radius: 1, range: 4, amount: 3, duration: 0 },
  brace: { cooldown: 4, target: "none", radius: 0, range: 0, amount: 4, duration: 0 },
  volley: { cooldown: 2, target: "enemy", radius: 1, range: 0, amount: 0, duration: 0 },
  heal: { cooldown: 0, target: "ally", radius: 1, range: 0, amount: 4, duration: 0 },
  camo: { cooldown: 4, target: "none", radius: 0, range: 0, amount: 0, duration: 2 },
};

export const CLASS_IDS = ["scout", "grunt", "vanguard", "ranger", "medic", "sniper"] as const;
export type ClassId = (typeof CLASS_IDS)[number];

export interface ClassSpec {
  cost: number;
  hp: number;
  move: number;
  /** Base vision radius; the tile height of the observer is added. */
  vision: number;
  weapon: WeaponId;
  ability: AbilityId;
}

export const CLASSES: Record<ClassId, ClassSpec> = {
  scout: { cost: 2, hp: 6, move: 8, vision: 8, weapon: "knife", ability: "recon" },
  grunt: { cost: 2, hp: 8, move: 6, vision: 5, weapon: "rifle", ability: "grenade" },
  vanguard: { cost: 3, hp: 14, move: 5, vision: 4, weapon: "hammer", ability: "brace" },
  ranger: { cost: 3, hp: 8, move: 6, vision: 6, weapon: "carbine", ability: "volley" },
  medic: { cost: 3, hp: 9, move: 6, vision: 5, weapon: "pistol", ability: "heal" },
  sniper: { cost: 4, hp: 6, move: 4, vision: 7, weapon: "longrifle", ability: "camo" },
};

export const TEAM_SIZE = 3;
export const TEAM_BUDGET = 9;
export const DEFAULT_ROSTER: readonly ClassId[] = ["grunt", "grunt", "grunt"];

export const MAX_ARMOUR = 6;
export const HEALTH_PICKUP = 5;
export const ARMOUR_PICKUP = 4;

export const rosterCost = (roster: readonly ClassId[]): number =>
  roster.reduce((sum, id) => sum + CLASSES[id].cost, 0);

export const isAffordable = (roster: readonly ClassId[]): boolean =>
  roster.length === TEAM_SIZE && rosterCost(roster) <= TEAM_BUDGET;
