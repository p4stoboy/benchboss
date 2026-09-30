import { expect, test } from "bun:test";
import { createRng, mkSeatId } from "@benchboss/core";
import {
  ABILITIES,
  ARMOUR_PICKUP,
  CLASSES,
  HEALTH_PICKUP,
  MAX_ARMOUR,
  WEAPONS,
} from "../src/classes";
import { generateMap } from "../src/generate";
import { LOOT_SPAWN_GAP, itemAt, scatterLoot } from "../src/loot";
import { chebyshev, key, tileAt } from "../src/map";
import { plugin } from "../src/plugin";
import type { BrState, Item } from "../src/types";
import { flatRows, game, newMatch, reachCosts, scenario, submitAll, unit } from "./helpers";

const s0 = mkSeatId(0);
const s1 = mkSeatId(1);
const orders = (state: BrState, seat: ReturnType<typeof mkSeatId>, list: unknown[]) =>
  game.submit(state, seat, { orders: list }, "match.orders");

test("every class carries a weapon and an ability and the observation reports both", () => {
  for (const spec of Object.values(CLASSES)) {
    expect(WEAPONS[spec.weapon]).toBeDefined();
    expect(ABILITIES[spec.ability]).toBeDefined();
  }
  expect(new Set(Object.values(CLASSES).map((c) => c.ability)).size).toBe(
    Object.keys(CLASSES).length,
  );
  const state = scenario(flatRows(4, 1), [
    { seat: 0, cls: "sniper", x: 0, y: 0 },
    { seat: 1, cls: "grunt", x: 3, y: 0 },
  ]);
  const me = game.observe(state, s0).privateState.units[0];
  expect(me?.weapon).toBe(CLASSES.sniper.weapon);
  expect(me?.range).toBe(WEAPONS[CLASSES.sniper.weapon].range);
  expect(me?.damage).toBe(WEAPONS[CLASSES.sniper.weapon].damage);
  expect(me?.ability).toEqual({ id: CLASSES.sniper.ability, ready: true, readyRound: 1 });
  expect(me?.armour).toBe(0);
  const seen = game.observe(state, s1).privateState.visibleEnemies[0];
  expect(seen?.weapon).toBe(CLASSES.sniper.weapon);
  expect(seen?.armour).toBe(0);
});

test("a health pickup heals up to the maximum, resolves before damage lands and consumes the item", () => {
  const state = scenario(
    flatRows(6, 1),
    [
      { seat: 0, cls: "grunt", x: 0, y: 0, hp: 2 },
      { seat: 1, cls: "grunt", x: 3, y: 0 },
    ],
    {},
    [{ x: 0, y: 0, kind: "health" }],
  );
  const next = submitAll(state, {
    [s0]: { orders: [{ unit: "seat:0/0", action: { kind: "pickup" } }] },
    [s1]: { orders: [{ unit: "seat:1/0", action: { kind: "attack", target: "seat:0/0" } }] },
  });
  const damage = WEAPONS[CLASSES.grunt.weapon].damage;
  expect(unit(next, "seat:0/0").hp).toBe(Math.min(CLASSES.grunt.hp, 2 + HEALTH_PICKUP) - damage);
  expect(next.items).toEqual([]);
  expect(next.lastRound).toContainEqual({
    kind: "pickup",
    unit: "seat:0/0",
    at: { x: 0, y: 0 },
    item: "health",
  });
  expect(orders(next, s0, [{ unit: "seat:0/0", action: { kind: "pickup" } }]).accepted).toBe(false);
});

test("armour pickups stack to the cap, absorb attack damage first and never stop the storm", () => {
  const state = scenario(
    flatRows(9, 9),
    [
      { seat: 0, cls: "grunt", x: 4, y: 4, armour: MAX_ARMOUR - 1 },
      { seat: 1, cls: "grunt", x: 4, y: 7 },
    ],
    {},
    [{ x: 4, y: 4, kind: "armour" }],
  );
  const braced = submitAll(state, {
    [s0]: { orders: [{ unit: "seat:0/0", action: { kind: "pickup" } }] },
    [s1]: { orders: [{ unit: "seat:1/0", action: { kind: "attack", target: "seat:0/0" } }] },
  });
  const damage = WEAPONS[CLASSES.grunt.weapon].damage;
  expect(unit(braced, "seat:0/0").armour).toBe(MAX_ARMOUR - damage);
  expect(unit(braced, "seat:0/0").hp).toBe(CLASSES.grunt.hp);
  expect(braced.teams[s1]?.damageDealt).toBe(damage);
  const closing = {
    ...scenario(flatRows(9, 9), [
      { seat: 0, cls: "grunt", x: 0, y: 0, armour: ARMOUR_PICKUP },
      { seat: 1, cls: "grunt", x: 4, y: 4 },
    ]),
    rules: { maxRounds: 4, tilesPerSeat: 25 },
    round: 3,
  };
  const stormed = submitAll(closing, {});
  expect(unit(stormed, "seat:0/0").armour).toBe(ARMOUR_PICKUP);
  expect(unit(stormed, "seat:0/0").hp).toBeLessThan(CLASSES.grunt.hp);
});

test("a weapon pickup swaps the unit's weapon, leaves the old one behind and changes its reach", () => {
  const state = scenario(
    flatRows(7, 1),
    [
      { seat: 0, cls: "grunt", x: 0, y: 0 },
      { seat: 1, cls: "grunt", x: 6, y: 0 },
    ],
    {},
    [{ x: 1, y: 0, kind: "weapon", weapon: "railgun" }],
  );
  const before = game.observe(state, s0).privateState.units[0];
  expect(reachCosts(before?.reach).get("1,0")).toBe(1);
  expect(before?.shots).toEqual({});
  const armed = submitAll(state, {
    [s0]: { orders: [{ unit: "seat:0/0", moveTo: { x: 1, y: 0 }, action: { kind: "pickup" } }] },
  });
  expect(unit(armed, "seat:0/0").weapon).toBe("railgun");
  expect(armed.items).toEqual([{ x: 1, y: 0, kind: "weapon", weapon: CLASSES.grunt.weapon }]);
  expect(armed.lastRound).toContainEqual({
    kind: "pickup",
    unit: "seat:0/0",
    at: { x: 1, y: 0 },
    item: "weapon",
    weapon: "railgun",
    dropped: CLASSES.grunt.weapon,
  });
  const me = game.observe(armed, s0).privateState.units[0];
  expect(me?.range).toBe(WEAPONS.railgun.range);
  expect(me?.shots["1,0"]).toEqual(["seat:1/0"]);
  const shot = submitAll(armed, {
    [s0]: { orders: [{ unit: "seat:0/0", action: { kind: "attack", target: "seat:1/0" } }] },
  });
  expect(unit(shot, "seat:1/0").hp).toBe(CLASSES.grunt.hp - WEAPONS.railgun.damage);
});

test("a pickup is rejected without an item at the destination and fizzles when the move is cut short", () => {
  const state = scenario(
    flatRows(6, 1),
    [
      { seat: 0, cls: "grunt", x: 0, y: 0 },
      { seat: 1, cls: "sniper", x: 2, y: 0, hiddenUntil: 9 },
    ],
    {},
    [{ x: 3, y: 0, kind: "health" }],
  );
  const rejected = orders(state, s0, [
    { unit: "seat:0/0", moveTo: { x: 4, y: 0 }, action: { kind: "pickup" } },
  ]);
  expect(rejected.accepted).toBe(false);
  expect(rejected.reason).toContain("no known item");
  const blocked = submitAll(state, {
    [s0]: { orders: [{ unit: "seat:0/0", moveTo: { x: 3, y: 0 }, action: { kind: "pickup" } }] },
  });
  expect(unit(blocked, "seat:0/0").x).toBe(1);
  expect(blocked.items).toHaveLength(1);
  expect(blocked.lastRound).toContainEqual({
    kind: "fizzle",
    unit: "seat:0/0",
    target: "",
    reason: "nothing to pick up",
  });
});

test("a grenade lands on a tile in range without sight, hits every unit around it and then cools down", () => {
  const state = scenario(
    ["0#000000"],
    [
      { seat: 0, cls: "grunt", x: 0, y: 0 },
      { seat: 0, cls: "scout", x: 3, y: 0 },
      { seat: 1, cls: "grunt", x: 4, y: 0 },
      { seat: 1, cls: "scout", x: 5, y: 0 },
      { seat: 1, cls: "grunt", x: 7, y: 0 },
    ],
  );
  // The thrower itself is walled off from every enemy; the grenade needs no sight line.
  const thrower = game.observe(state, s0).privateState.units.find((u) => u.id === "seat:0/0");
  expect(thrower?.shots).toEqual({});
  const range = ABILITIES.grenade.range;
  const tooFar = orders(state, s0, [
    { unit: "seat:0/0", action: { kind: "ability", at: { x: range + 1, y: 0 } } },
  ]);
  expect(tooFar.accepted).toBe(false);
  expect(orders(state, s0, [{ unit: "seat:0/0", action: { kind: "ability" } }]).accepted).toBe(
    false,
  );
  const thrown = submitAll(state, {
    [s0]: { orders: [{ unit: "seat:0/0", action: { kind: "ability", at: { x: 4, y: 0 } } }] },
  });
  const blast = ABILITIES.grenade.amount;
  expect(unit(thrown, "seat:0/1").hp).toBe(CLASSES.scout.hp - blast);
  expect(unit(thrown, "seat:1/0").hp).toBe(CLASSES.grunt.hp - blast);
  expect(unit(thrown, "seat:1/1").hp).toBe(CLASSES.scout.hp - blast);
  expect(unit(thrown, "seat:1/2").hp).toBe(CLASSES.grunt.hp);
  expect(thrown.teams[s0]?.damageDealt).toBe(3 * blast);
  expect(thrown.lastRound.filter((e) => e.kind === "blast")).toHaveLength(3);
  expect(thrown.lastRound).toContainEqual({
    kind: "ability",
    unit: "seat:0/0",
    ability: "grenade",
    from: { x: 0, y: 0 },
    at: { x: 4, y: 0 },
  });
  const again = orders(thrown, s0, [
    { unit: "seat:0/0", action: { kind: "ability", at: { x: 4, y: 0 } } },
  ]);
  expect(again.accepted).toBe(false);
  expect(again.reason).toContain(`round ${1 + ABILITIES.grenade.cooldown + 1}`);
  expect(game.observe(thrown, s0).privateState.units[0]?.ability.ready).toBe(false);
});

test("killing your own unit with a grenade credits no kill", () => {
  const state = scenario(flatRows(9, 1), [
    { seat: 0, cls: "grunt", x: 0, y: 0 },
    { seat: 0, cls: "scout", x: 4, y: 0, hp: 1 },
    { seat: 1, cls: "grunt", x: 8, y: 0 },
  ]);
  const next = submitAll(state, {
    [s0]: { orders: [{ unit: "seat:0/0", action: { kind: "ability", at: { x: 4, y: 0 } } }] },
  });
  expect(unit(next, "seat:0/1").alive).toBe(false);
  expect(next.teams[s0]?.kills).toBe(0);
});

test("brace adds armour before the same round's damage and the ability then cools down", () => {
  const state = scenario(flatRows(5, 1), [
    { seat: 0, cls: "vanguard", x: 0, y: 0 },
    { seat: 1, cls: "grunt", x: 3, y: 0 },
  ]);
  const next = submitAll(state, {
    [s0]: { orders: [{ unit: "seat:0/0", action: { kind: "ability" } }] },
    [s1]: { orders: [{ unit: "seat:1/0", action: { kind: "attack", target: "seat:0/0" } }] },
  });
  const damage = WEAPONS[CLASSES.grunt.weapon].damage;
  expect(unit(next, "seat:0/0").hp).toBe(CLASSES.vanguard.hp);
  expect(unit(next, "seat:0/0").armour).toBe(Math.min(MAX_ARMOUR, ABILITIES.brace.amount) - damage);
  expect(orders(next, s0, [{ unit: "seat:0/0", action: { kind: "ability" } }]).accepted).toBe(
    false,
  );
  expect(
    orders(state, s0, [{ unit: "seat:0/0", action: { kind: "ability", target: "seat:1/0" } }])
      .accepted,
  ).toBe(false);
});

test("a volley hits the target and the enemies beside it but never your own units", () => {
  const state = scenario(flatRows(8, 1), [
    { seat: 0, cls: "ranger", x: 0, y: 0 },
    { seat: 0, cls: "scout", x: 3, y: 0 },
    { seat: 1, cls: "grunt", x: 4, y: 0 },
    { seat: 1, cls: "scout", x: 5, y: 0 },
    { seat: 1, cls: "grunt", x: 7, y: 0 },
  ]);
  const next = submitAll(state, {
    [s0]: {
      orders: [{ unit: "seat:0/0", action: { kind: "ability", target: "seat:1/0" } }],
    },
  });
  const damage = WEAPONS[CLASSES.ranger.weapon].damage;
  expect(unit(next, "seat:0/1").hp).toBe(CLASSES.scout.hp);
  expect(unit(next, "seat:1/0").hp).toBe(CLASSES.grunt.hp - damage);
  expect(unit(next, "seat:1/1").hp).toBe(CLASSES.scout.hp - damage);
  expect(unit(next, "seat:1/2").hp).toBe(CLASSES.grunt.hp);
  expect(
    orders(state, s0, [{ unit: "seat:0/0", action: { kind: "ability", target: "seat:1/2" } }])
      .accepted,
  ).toBe(false);
});

test("camouflage hides a sniper from enemies unless they stand beside it, and its own shot ends it", () => {
  const state = scenario(flatRows(10, 1), [
    { seat: 0, cls: "sniper", x: 0, y: 0 },
    { seat: 1, cls: "grunt", x: 4, y: 0 },
  ]);
  const hidden = submitAll(state, {
    [s0]: { orders: [{ unit: "seat:0/0", action: { kind: "ability" } }] },
  });
  const blind = game.observe(hidden, s1);
  expect(blind.privateState.visibleEnemies).toEqual([]);
  expect(blind.privateState.lastSeen).toEqual([]);
  // The enemy watched the sniper vanish: the activation is disclosed, nothing after it is.
  expect(blind.privateState.lastRound.map((e) => e.kind)).toEqual(["ability"]);
  const later = game.observe(submitAll(hidden, {}), s1);
  expect(JSON.stringify(later)).not.toContain("seat:0/0");
  expect(
    orders(hidden, s1, [{ unit: "seat:1/0", action: { kind: "attack", target: "seat:0/0" } }])
      .accepted,
  ).toBe(false);
  expect(JSON.stringify(plugin.publicView(hidden))).not.toContain("seat:0/0");
  const adjacent = submitAll(hidden, {
    [s1]: { orders: [{ unit: "seat:1/0", moveTo: { x: 1, y: 0 } }] },
  });
  expect(game.observe(adjacent, s1).privateState.visibleEnemies.map((u) => u.id)).toEqual([
    "seat:0/0",
  ]);
  const shot = submitAll(hidden, {
    [s0]: { orders: [{ unit: "seat:0/0", action: { kind: "attack", target: "seat:1/0" } }] },
  });
  expect(unit(shot, "seat:0/0").hiddenUntil).toBe(0);
  expect(game.observe(shot, s1).privateState.visibleEnemies.map((u) => u.id)).toEqual(["seat:0/0"]);
  let quiet = hidden;
  for (let i = 0; i < ABILITIES.camo.duration; i++) {
    expect(game.observe(quiet, s1).privateState.visibleEnemies).toEqual([]);
    quiet = submitAll(quiet, {});
  }
  expect(game.observe(quiet, s1).privateState.visibleEnemies.map((u) => u.id)).toEqual([
    "seat:0/0",
  ]);
});

test("recon reveals enemies behind walls and through camouflage for the next orders, then fades", () => {
  const state = scenario(
    ["0#0000"],
    [
      { seat: 0, cls: "scout", x: 0, y: 0 },
      { seat: 1, cls: "sniper", x: 3, y: 0, hiddenUntil: 9 },
    ],
  );
  expect(game.observe(state, s0).privateState.visibleEnemies).toEqual([]);
  const revealed = submitAll(state, {
    [s0]: { orders: [{ unit: "seat:0/0", action: { kind: "ability" } }] },
  });
  const seen = game.observe(revealed, s0);
  expect(seen.privateState.visibleEnemies.map((u) => u.id)).toEqual(["seat:1/0"]);
  expect(seen.privateState.units[0]?.shots).toEqual({});
  expect(revealed.memory[s0]?.["seat:1/0"]?.x).toBe(3);
  const faded = submitAll(revealed, {});
  expect(game.observe(faded, s0).privateState.visibleEnemies).toEqual([]);
  expect(faded.reveals).toEqual([]);
});

test("loot is seeded, one item per tile, never on walls or beside spawns, and hidden until seen", () => {
  for (const seats of [2, 5, 12]) {
    const map = generateMap(createRng(`loot-${seats}`).fork("map"), seats, 150, 3);
    const items = scatterLoot(createRng(`loot-${seats}`).fork("loot"), map);
    expect(items.length).toBeGreaterThan(seats);
    expect(new Set(items.map(key)).size).toBe(items.length);
    const spawnTiles = map.spawns.flat();
    for (const item of items) {
      expect(tileAt(map, item).kind).not.toBe("wall");
      expect(Math.min(...spawnTiles.map((s) => chebyshev(s, item)))).toBeGreaterThanOrEqual(
        LOOT_SPAWN_GAP,
      );
    }
    expect(scatterLoot(createRng(`loot-${seats}`).fork("loot"), map)).toEqual(items);
    expect(scatterLoot(createRng("other").fork("loot"), map)).not.toEqual(items);
    expect(items.some((item) => item.kind === "weapon")).toBe(true);
  }
  const state = newMatch(4, "loot-fogged");
  expect(state.items.length).toBeGreaterThan(0);
  expect(game.observe(state, s1).privateState.items).toEqual([]);
  expect(JSON.stringify(plugin.publicView(state))).not.toContain("Items");
  const first = state.items[0] as Item;
  expect(itemAt(state.items, first)).toEqual(first);
});

test("a team learns of an item when it sees the tile, remembers it out of sight and cannot probe fogged tiles", () => {
  const state = scenario(
    ["00#00000000"],
    [
      { seat: 0, cls: "grunt", x: 0, y: 0 },
      { seat: 1, cls: "grunt", x: 10, y: 0 },
    ],
    {},
    [
      { x: 1, y: 0, kind: "armour" },
      { x: 4, y: 0, kind: "health" },
    ],
  );
  const known = game.observe(state, s0).privateState.items;
  expect(known).toEqual([{ x: 1, y: 0, kind: "armour", round: 1 }]);
  // Seat 0 walks over the armour and away again; seat 1 reaches sight of the health pack.
  const scouted = submitAll(state, {
    [s0]: { orders: [{ unit: "seat:0/0", moveTo: { x: 1, y: 0 } }] },
    [s1]: { orders: [{ unit: "seat:1/0", moveTo: { x: 9, y: 0 } }] },
  });
  expect(game.observe(scouted, s1).privateState.items).toEqual([
    { x: 4, y: 0, kind: "health", round: 2 },
  ]);
  // Seat 1 takes the health pack while seat 0 has never seen that tile.
  const taken = submitAll(scouted, {
    [s1]: {
      orders: [{ unit: "seat:1/0", moveTo: { x: 5, y: 0 } }],
    },
  });
  const grabbed = submitAll(taken, {
    [s1]: {
      orders: [{ unit: "seat:1/0", moveTo: { x: 4, y: 0 }, action: { kind: "pickup" } }],
    },
  });
  expect(grabbed.items).toEqual([{ x: 1, y: 0, kind: "armour" }]);
  expect(game.observe(grabbed, s1).privateState.items).toEqual([]);
  expect(game.observe(grabbed, s0).privateState.items).toEqual([
    { x: 1, y: 0, kind: "armour", round: 4 },
  ]);
  // The wall keeps the armour tile out of seat 1's sight throughout.
  const seat1Knows = game.observe(grabbed, s1).privateState.items.map((i) => i.kind);
  expect(seat1Knows).toEqual([]);
});

test("a fogged tile is unreachable and rejected identically whether or not an item lies there", () => {
  // The wall hides (6,0) and (6,1) from the grunt at (10,2); both are within its move points.
  const fog = scenario(
    ["00000000000", "0000000#000", "0000000#000"],
    [
      { seat: 0, cls: "grunt", x: 0, y: 0 },
      { seat: 1, cls: "grunt", x: 10, y: 2 },
    ],
    {},
    [{ x: 6, y: 1, kind: "health" }],
  );
  expect(game.observe(fog, s1).privateState.items).toEqual([]);
  const order = (x: number, y: number, pickup: boolean) =>
    orders(fog, s1, [
      { unit: "seat:1/0", moveTo: { x, y }, ...(pickup ? { action: { kind: "pickup" } } : {}) },
    ]);
  const reach = reachCosts(game.observe(fog, s1).privateState.units[0]?.reach);
  expect(reach.has("8,0")).toBe(true);
  expect(reach.has("6,0")).toBe(false);
  expect(reach.has("6,1")).toBe(false);
  for (const pickup of [false, true]) {
    const withItem = order(6, 1, pickup);
    const without = order(6, 0, pickup);
    expect(withItem.accepted).toBe(false);
    expect(withItem.reason.replace("6,1", "")).toBe(without.reason.replace("6,0", ""));
  }
  expect(order(8, 0, false).accepted).toBe(true);
});
