import { expect, test } from "bun:test";
import { createRng, mkSeatId } from "@benchboss/core";
import { renderSpectatorView } from "@benchboss/viewer";
import { type Tile, type TileKind, key } from "../src/map";
import { plugin } from "../src/plugin";
import { visionOf } from "../src/state";
import type { BrState } from "../src/types";
import { flatRows, game, newMatch, reachCosts, scenario, submitAll } from "./helpers";
import { randomOrders } from "./random-orders";

const s0 = mkSeatId(0);
const s1 = mkSeatId(1);
const TERRAIN_CHAR: Record<TileKind, string> = { open: ".", cover: "+", wall: "#" };

/** Every position a seat learns about belongs to its own units or lies inside its current vision. */
function assertObservationPrivacy(state: BrState, seat: ReturnType<typeof mkSeatId>): void {
  const observation = game.observe(state, seat);
  if (observation.privateState.committed) {
    expect(observation.privateState.view).toBeNull();
    expect(observation.privateState.units).toEqual([]);
    expect(observation.privateState.visibleEnemies).toEqual([]);
    return;
  }
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
    const costs = reachCosts(unit.reach);
    expect(costs.get(`${unit.x},${unit.y}`)).toBe(0);
    for (const tile of costs.keys()) expect(seen.has(tile)).toBe(true);
    const reach = new Set(costs.keys());
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

/** Decodes a frame's `Map` table with the legend that frame carries; `null` for an unexplored tile. */
function decodeMap(view: ReturnType<typeof plugin.publicView>): (Tile | null)[][] {
  const legend = view.blocks.find((b) => b.kind === "list" && b.title === "Terrain kinds");
  const table = view.blocks.find((b) => b.kind === "table" && b.title === "Map");
  const kinds = legend && "items" in legend ? legend.items : [];
  const rows = table && "rows" in table ? table.rows : [];
  expect(kinds.length).toBeGreaterThan(0);
  return rows.map((row) =>
    row.map((cell) => {
      expect(typeof cell).toBe("number");
      const code = Number(cell);
      if (code < 0) return null;
      const kind = kinds[code % kinds.length];
      expect(kind).toBeDefined();
      return { h: Math.floor(code / kinds.length), kind: kind as TileKind };
    }),
  );
}

/** Live spectator grids show exactly the explored tiles; every tile some living team sees now is explored. */
function assertSpectatorFog(state: BrState): void {
  const decoded = decodeMap(plugin.publicView(state));
  expect(decoded).toHaveLength(state.map.height);
  const seenNow = new Set<string>();
  for (const seat of state.seats)
    if (state.teams[seat]?.placement === null)
      for (const t of visionOf(state, seat)) seenNow.add(t);
  state.map.tiles.forEach((row, y) =>
    row.forEach((tile, x) => {
      const explored = state.explored[`${x},${y}`] === true;
      if (seenNow.has(`${x},${y}`)) expect(explored).toBe(true);
      expect(decoded[y]?.[x]).toEqual(explored ? tile : null);
    }),
  );
}

test("the live spectator map reveals tiles as teams see them and stays revealed; terminal shows all", () => {
  let state = newMatch(2, "fog");
  const before = plugin.publicView(state);
  expect(
    decodeMap(before)
      .flat()
      .every((tile) => tile === null),
  ).toBe(true);
  for (const seat of state.seats)
    state = game.submit(
      state,
      seat,
      { actors: ["scout", "grunt", "grunt"] },
      "match.loadout",
    ).state;
  state = game.step(state);
  assertSpectatorFog(state);
  const spawnExplored = Object.keys(state.explored);
  expect(spawnExplored.length).toBeGreaterThan(0);
  expect(spawnExplored.length).toBeLessThan(state.map.width * state.map.height);
  const moved = submitAll(state, {
    [s0]: {
      orders: state.units
        .filter((u) => u.seat === s0)
        .map((u) => {
          const plan = game.observe(state, s0).privateState.units.find((p) => p.id === u.id);
          const far = [...reachCosts(plan?.reach).keys()].at(-1)?.split(",").map(Number) ?? [
            u.x,
            u.y,
          ];
          return { unit: u.id, moveTo: { x: far[0], y: far[1] } };
        }),
    },
  });
  assertSpectatorFog(moved);
  for (const tile of spawnExplored) expect(moved.explored[tile]).toBe(true);
  expect(Object.keys(moved.explored).length).toBeGreaterThanOrEqual(spawnExplored.length);
  const terminal = plugin.onHostEvent?.(moved, {
    kind: "player_time_exhausted",
    seats: [s1],
    phaseId: "p",
    at: 1,
  }) as BrState;
  expect(decodeMap(plugin.publicView(terminal))).toEqual(terminal.map.tiles);
});

test("shots never read unseen terrain: a fogged cell on the sight line neither offers nor withholds a target", () => {
  // The wall at (1,1) hides (2,2) and (3,2) from the ranger; the enemy at (4,1) is in plain view.
  const rows = (cell: string) => ["00000", "0#000", `00${cell}00`, "00000", "00000"];
  const specs = [
    { seat: 0, cls: "ranger" as const, x: 0, y: 0 },
    { seat: 1, cls: "grunt" as const, x: 4, y: 1 },
  ];
  const clear = scenario(rows("0"), specs);
  const walled = scenario(rows("#"), specs);
  expect(visionOf(clear, s0)).toEqual(visionOf(walled, s0));
  expect(visionOf(clear, s0).has("2,2")).toBe(false);
  const shotsIn = (state: BrState) => game.observe(state, s0).privateState.units[0]?.shots ?? {};
  expect(shotsIn(walled)).toEqual(shotsIn(clear));
  // The line from (0,3) crosses the fogged cell: offered either way, since unseen tiles count as clear.
  expect(shotsIn(walled)["0,3"]).toEqual(["seat:1/0"]);
  // The line from the ranger's own tile also crosses fog, yet the enemy stands in plain view.
  expect(shotsIn(walled)["0,0"]).toEqual(["seat:1/0"]);
  expect(game.observe(walled, s0).privateState.view).toEqual(
    game.observe(clear, s0).privateState.view,
  );
  const order = {
    orders: [
      { unit: "seat:0/0", moveTo: { x: 0, y: 3 }, action: { kind: "attack", target: "seat:1/0" } },
    ],
  };
  const landed = submitAll(clear, { [s0]: order });
  expect(landed.lastRound.some((e) => e.kind === "attack")).toBe(true);
  const fizzled = submitAll(walled, { [s0]: order });
  expect(fizzled.lastRound).toContainEqual({
    kind: "fizzle",
    unit: "seat:0/0",
    target: "seat:1/0",
    reason: "no line of sight",
  });
  expect(game.observe(fizzled, s0).privateState.lastRound).toContainEqual({
    kind: "fizzle",
    unit: "seat:0/0",
    target: "seat:1/0",
    reason: "missed",
  });
});

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
  expect(renderSpectatorView(plugin.publicView(state))).toContain("Map");
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
    const everSeen = new Set<string>();
    while (state.phase === "orders") {
      for (const seat of state.seats) assertObservationPrivacy(state, seat);
      assertSpectatorFog(state);
      for (const seat of state.seats)
        if (state.teams[seat]?.placement === null)
          for (const tile of visionOf(state, seat)) everSeen.add(tile);
      for (const tile of Object.keys(state.explored)) expect(everSeen.has(tile)).toBe(true);
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
