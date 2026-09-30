import { expect, test } from "bun:test";
import { createRng, mkSeatId } from "@benchboss/core";
import { renderSpectatorView } from "@benchboss/viewer";
import { type TileKind, key } from "../src/map";
import { plugin } from "../src/plugin";
import { visionOf } from "../src/state";
import type { BrState } from "../src/types";
import { flatRows, game, newMatch, scenario, submitAll } from "./helpers";
import { randomOrders } from "./random-orders";

const s0 = mkSeatId(0);
const s1 = mkSeatId(1);
const TERRAIN_CHAR: Record<TileKind, string> = { open: ".", cover: "+", wall: "#" };

/** Every position a seat learns about belongs to its own units or lies inside its current vision. */
function assertObservationPrivacy(state: BrState, seat: ReturnType<typeof mkSeatId>): void {
  const observation = game.observe(state, seat);
  const seen = visionOf(state, seat);
  const own = new Set(state.units.filter((u) => u.seat === seat).map((u) => u.id));
  const mine = state.units.filter((u) => u.seat === seat && u.alive);
  for (const enemy of observation.privateState.visibleEnemies) {
    expect(seen.has(key(enemy))).toBe(true);
    const actual = state.units.find((u) => u.id === enemy.id);
    if (actual && actual.hiddenUntil >= state.round)
      expect(
        mine.some((u) => Math.max(Math.abs(u.x - actual.x), Math.abs(u.y - actual.y)) <= 1) ||
          state.reveals.some(
            (r) =>
              r.seat === seat &&
              r.untilRound >= state.round &&
              Math.max(Math.abs(r.center.x - actual.x), Math.abs(r.center.y - actual.y)) <=
                r.radius,
          ),
      ).toBe(true);
  }
  for (const unit of observation.privateState.units) {
    const reach = new Set(unit.reach.split(" "));
    for (const [tile, targets] of Object.entries(unit.shots)) {
      expect(reach.has(tile)).toBe(true);
      for (const target of targets)
        expect(seen.has(key(state.units.find((u) => u.id === target) as never))).toBe(true);
    }
  }
  const view = observation.privateState.view;
  expect(view === null).toBe(seen.size === 0);
  if (view) {
    expect(view.terrain.length).toBe(view.heights.length);
    view.terrain.forEach((row, dy) => {
      expect(row.length).toBe(view.heights[dy]?.length ?? -1);
      [...row].forEach((ch, dx) => {
        const at = { x: view.x + dx, y: view.y + dy };
        const tile = state.map.tiles[at.y]?.[at.x];
        const shown = view.heights[dy]?.[dx];
        if (!seen.has(key(at))) {
          expect(ch).toBe("?");
          expect(shown).toBe("?");
          return;
        }
        expect(ch).toBe(TERRAIN_CHAR[tile?.kind ?? "open"]);
        expect(shown).toBe(String(tile?.h));
      });
    });
    for (const tile of seen) {
      const [x, y] = tile.split(",").map(Number);
      expect(view.terrain[(y ?? 0) - view.y]?.[(x ?? 0) - view.x]).not.toBe("?");
    }
  }
  expect(JSON.stringify(observation.publicState)).not.toContain('"tiles"');
  expect(JSON.stringify(observation.publicState)).not.toContain('"terrain"');
  for (const remembered of observation.privateState.lastSeen) {
    const memory = state.memory[seat]?.[remembered.id];
    expect(memory).toEqual(remembered);
  }
  for (const item of observation.privateState.items) {
    expect(state.itemMemory[seat]?.[key(item)]).toEqual(item);
    if (seen.has(key(item))) {
      const { round: _round, ...actual } = item;
      expect(state.items).toContainEqual(actual);
    }
  }
  expect(JSON.stringify(observation.publicState)).not.toContain('"items"');
  for (const event of observation.privateState.lastRound) {
    if (event.kind === "eliminated") continue;
    if (own.has(event.unit) || ("target" in event && own.has(event.target ?? ""))) continue;
    if (event.kind === "move") expect(seen.has(key(event.to))).toBe(true);
    if (event.kind === "attack" || event.kind === "heal") {
      expect(seen.has(key(event.from))).toBe(true);
      expect(seen.has(key(event.at))).toBe(true);
    }
    if (event.kind === "storm" || event.kind === "death" || event.kind === "pickup")
      expect(seen.has(key(event.at))).toBe(true);
    if (event.kind === "ability") expect(seen.has(key(event.from))).toBe(true);
    if (event.kind === "blast") expect(seen.has(key(event.at))).toBe(true);
    expect(event.kind).not.toBe("fizzle");
  }
}

test("a wall hides an enemy from observation, attacks and memory until it is seen", () => {
  const state = scenario(
    ["0#0"],
    [
      { seat: 0, cls: "grunt", x: 0, y: 0 },
      { seat: 1, cls: "grunt", x: 2, y: 0 },
    ],
  );
  const hidden = game.observe(state, s0);
  expect(hidden.privateState.visibleEnemies).toEqual([]);
  expect(hidden.privateState.lastSeen).toEqual([]);
  expect(hidden.privateState.units[0]?.shots).toEqual({});
  expect(JSON.stringify(hidden)).not.toContain("seat:1/0");
  const open = scenario(
    ["000"],
    [
      { seat: 0, cls: "grunt", x: 0, y: 0 },
      { seat: 1, cls: "grunt", x: 2, y: 0 },
    ],
  );
  expect(game.observe(open, s0).privateState.visibleEnemies.map((u) => u.id)).toEqual(["seat:1/0"]);
});

test("memory keeps the last sighting after an enemy walks out of view", () => {
  const state = scenario(
    ["0000000000"],
    [
      { seat: 0, cls: "vanguard", x: 0, y: 0 },
      { seat: 1, cls: "scout", x: 3, y: 0 },
    ],
  );
  const withMemory = { ...state, memory: { [s0]: {}, [s1]: {} } };
  const start = game.step({
    ...withMemory,
    orders: { [s0]: { orders: [] }, [s1]: { orders: [] } },
    paths: {},
  });
  expect(game.observe(start, s0).privateState.visibleEnemies).toHaveLength(1);
  const after = submitAll(start, {
    [s1]: { orders: [{ unit: "seat:1/0", moveTo: { x: 9, y: 0 } }] },
  });
  const observation = game.observe(after, s0);
  expect(observation.privateState.visibleEnemies).toEqual([]);
  expect(observation.privateState.lastSeen).toEqual([
    {
      id: "seat:1/0",
      seat: s1,
      cls: "scout",
      x: 3,
      y: 0,
      hp: 6,
      armour: 0,
      weapon: "knife",
      round: 2,
    },
  ]);
  expect(
    observation.privateState.lastRound.some((e) => e.kind === "move" && e.unit === "seat:1/0"),
  ).toBe(false);
});

test("live public views depend only on disclosed state; terminal views disclose rosters and history", () => {
  let state = newMatch(4, "privacy");
  for (const seat of state.seats)
    state = game.submit(
      state,
      seat,
      { actors: ["scout", "ranger", "medic"] },
      "match.loadout",
    ).state;
  state = game.step(state);
  const scrambled: BrState = {
    ...state,
    units: state.units.map((u) => ({ ...u, x: 0, y: 0, hp: 1, cls: "sniper" })),
    loadouts: {},
    memory: {},
    lastRound: [{ kind: "death", unit: "seat:0/0", at: { x: 1, y: 1 } }],
    history: [],
    paths: {},
    items: [],
    itemMemory: {},
  };
  expect(plugin.publicView(scrambled)).toEqual(plugin.publicView(state));
  expect(JSON.stringify(plugin.publicView(state))).not.toContain("ranger");
  const chatted: BrState = { ...state, chat: [{ round: 1, seat: s1, text: "we see you" }] };
  expect(JSON.stringify(plugin.publicView(chatted).blocks)).toContain("seat:1: we see you");
  expect(renderSpectatorView(plugin.publicView(state))).toContain("Terrain");
  const terminal = plugin.onHostEvent?.(state, {
    kind: "player_time_exhausted",
    seats: state.seats.slice(1),
    phaseId: "p",
    at: 1,
  }) as BrState;
  const view = plugin.publicView(terminal);
  expect(view.result?.seats.find((s) => s.seat === s0)?.placement).toBe(1);
  expect(JSON.stringify(view.blocks)).toContain("scout, ranger, medic");
  const units = view.blocks.find((b) => b.kind === "table" && b.title === "Units");
  const rows = units && "rows" in units ? units.rows : [];
  const spawn = state.units.find((u) => u.id === "seat:0/0");
  if (!spawn) throw Error("missing spawn unit");
  expect(rows).toContainEqual([
    0,
    "seat:0/0",
    s0,
    "scout",
    spawn.x,
    spawn.y,
    spawn.hp,
    0,
    "knife",
    1,
    0,
  ]);
});

test("generated matches never leak unseen positions through observations or live public views", () => {
  const rng = createRng("privacy-generated");
  for (const seatCount of [2, 5]) {
    let state = newMatch(seatCount, `privacy:${seatCount}`, { maxRounds: 12 });
    for (const seat of state.seats)
      state = game.submit(
        state,
        seat,
        { actors: ["scout", "grunt", "grunt"] },
        "match.loadout",
      ).state;
    state = game.step(state);
    while (state.phase === "orders") {
      for (const seat of state.seats) assertObservationPrivacy(state, seat);
      const hidden = {
        ...state,
        units: state.units.map((u) => ({ ...u, x: 0, y: 0 })),
        memory: {},
        items: [],
        itemMemory: {},
        history: [],
      };
      expect(plugin.publicView(hidden)).toEqual(plugin.publicView(state));
      const orders = Object.fromEntries(
        state.seats
          .filter((seat) => state.teams[seat]?.placement === null)
          .map((seat) => [seat, randomOrders(state, seat, rng)]),
      );
      state = submitAll(state, orders);
    }
    expect(state.phase).toBe("terminal");
  }
});
