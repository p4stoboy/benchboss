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
  for (const item of observation.privateState.items) {
    expect(seen.has(key(item))).toBe(true);
    expect(state.items).toContainEqual(item);
  }
  for (const item of state.items)
    if (seen.has(key(item))) expect(observation.privateState.items).toContainEqual(item);
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

type View = ReturnType<typeof plugin.publicView>;
const rowsOf = (view: View, title: string): (string | number)[][] => {
  const block = view.blocks.find((b) => b.kind === "table" && b.title === title);
  return block && "rows" in block ? block.rows : [];
};
const itemsOf = (view: View, title: string): string[] => {
  const block = view.blocks.find((b) => b.kind === "list" && b.title === title);
  return block && "items" in block ? block.items : [];
};

/** The full view is complete and current: whole map, every living unit, item, order, vision row and reveal. */
function assertFullView(state: BrState): void {
  const view = plugin.fullView(state);
  const pub = plugin.publicView(state);
  expect(decodeMap(view)).toEqual(state.map.tiles);
  expect(rowsOf(view, "Units").map((r) => [r[0], r[3], r[4], r[9]])).toEqual(
    state.units.filter((u) => u.alive).map((u) => [u.id, u.x, u.y, u.hiddenUntil]),
  );
  expect(rowsOf(view, "Loot").map((r) => [r[0], r[1]])).toEqual(state.items.map((i) => [i.x, i.y]));
  expect(rowsOf(view, "Orders")).toHaveLength(
    Object.values(state.orders).reduce((n, o) => n + o.orders.length, 0),
  );
  const vision = rowsOf(view, "Vision");
  for (const seat of state.seats) {
    const mine = vision.filter((r) => r[0] === seat);
    if (state.teams[seat]?.placement !== null) {
      expect(mine).toEqual([]);
      continue;
    }
    const seen = visionOf(state, seat);
    expect(mine.map((r) => r[1])).toEqual(state.map.tiles.map((_, y) => y));
    for (const r of mine)
      [...String(r[2])].forEach((ch, x) => expect(ch === "#").toBe(seen.has(`${x},${r[1]}`)));
  }
  expect(rowsOf(view, "Recon").map((r) => [r[0], r[1], r[2], r[3], r[4]])).toEqual(
    state.reveals
      .filter((r) => r.untilRound >= state.round)
      .map((r) => [r.seat, r.center.x, r.center.y, r.radius, r.untilRound]),
  );
  expect(rowsOf(view, "Events")).toHaveLength(state.lastRound.length);
  expect(itemsOf(view, "Chat")).toHaveLength(state.chat.length);
  expect(view.result).toEqual(pub.result);
  expect(view.progress).toEqual(pub.progress);
  for (const title of ["Teams", "Round", "Eliminations"])
    expect(view.blocks.find((b) => b.title === title)).toEqual(
      pub.blocks.find((b) => b.title === title),
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
  assertFullView(state);
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
  assertFullView(moved);
  for (const tile of spawnExplored) expect(moved.explored[tile]).toBe(true);
  expect(Object.keys(moved.explored).length).toBeGreaterThanOrEqual(spawnExplored.length);
  const terminal = plugin.onHostEvent?.(moved, {
    kind: "player_time_exhausted",
    seats: [s1],
    phaseId: "p",
    at: 1,
  }) as BrState;
  expect(decodeMap(plugin.publicView(terminal))).toEqual(terminal.map.tiles);
  // Terminal parity: everything the public terminal frame discloses, the full frame carries too.
  assertFullView(terminal);
  const full = plugin.fullView(terminal);
  const pub = plugin.publicView(terminal);
  for (const block of pub.blocks)
    if (!["Units", "Loot", "Events"].includes(block.title))
      expect(full.blocks).toContainEqual(block);
  expect(rowsOf(full, "Units by entry")).toEqual(rowsOf(pub, "Units"));
  expect(rowsOf(full, "Loot by entry")).toEqual(rowsOf(pub, "Loot"));
  expect(rowsOf(full, "Events by entry")).toEqual(rowsOf(pub, "Events"));
});

test("the full view lists orders as they arrive and clears them at resolution; camouflage and recon are shown", () => {
  const state = scenario(
    ["000000", "000000"],
    [
      { seat: 0, cls: "scout", x: 0, y: 0 },
      { seat: 1, cls: "sniper", x: 5, y: 1, hiddenUntil: 9 },
    ],
    { reveals: [{ seat: s0, center: { x: 4, y: 1 }, radius: 1, untilRound: 3 }] },
    [{ x: 1, y: 0, kind: "health" }],
  );
  assertFullView(state);
  const before = plugin.fullView(state);
  expect(rowsOf(before, "Units").map((r) => [r[0], r[9]])).toEqual([
    ["seat:0/0", 0],
    ["seat:1/0", 9],
  ]);
  expect(rowsOf(before, "Recon")).toEqual([[s0, 4, 1, 1, 3]]);
  expect(rowsOf(before, "Loot")).toEqual([[1, 0, "health"]]);
  expect(rowsOf(before, "Orders")).toEqual([]);
  expect(JSON.stringify(plugin.publicView(state))).not.toContain("seat:1/0");
  const submitted = game.submit(
    state,
    s0,
    { orders: [{ unit: "seat:0/0", moveTo: { x: 1, y: 0 }, action: { kind: "pickup" } }] },
    "match.orders",
  );
  expect(submitted.accepted).toBe(true);
  assertFullView(submitted.state);
  expect(rowsOf(plugin.fullView(submitted.state), "Orders")).toEqual([
    [s0, "seat:0/0", "1,0", "", "pickup", "", ""],
  ]);
  const other = game.submit(submitted.state, s1, { orders: [] }, "match.orders");
  expect(other.accepted).toBe(true);
  const resolved = game.step(other.state);
  assertFullView(resolved);
  const after = plugin.fullView(resolved);
  expect(rowsOf(after, "Orders")).toEqual([]);
  expect(rowsOf(after, "Events").map((r) => r[1])).toContain("pickup");
  expect(rowsOf(after, "Loot")).toEqual([]);
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

test("a wall hides an enemy from observation and attacks until it is seen", () => {
  const state = scenario(
    ["0#0"],
    [
      { seat: 0, cls: "grunt", x: 0, y: 0 },
      { seat: 1, cls: "grunt", x: 2, y: 0 },
    ],
  );
  const hidden = game.observe(state, s0);
  expect(hidden.privateState.visibleEnemies).toEqual([]);
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

test("an enemy that walks out of view leaves no trace in the next observation", () => {
  const state = scenario(
    ["0000000000"],
    [
      { seat: 0, cls: "vanguard", x: 0, y: 0 },
      { seat: 1, cls: "scout", x: 3, y: 0 },
    ],
  );
  const start = game.step({
    ...state,
    orders: { [s0]: { orders: [] }, [s1]: { orders: [] } },
    paths: {},
  });
  expect(game.observe(start, s0).privateState.visibleEnemies).toHaveLength(1);
  const after = submitAll(start, {
    [s1]: { orders: [{ unit: "seat:1/0", moveTo: { x: 9, y: 0 } }] },
  });
  const observation = game.observe(after, s0);
  expect(observation.privateState.visibleEnemies).toEqual([]);
  expect(JSON.stringify(observation)).not.toContain("seat:1/0");
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
    lastRound: [{ kind: "death", unit: "seat:0/0", at: { x: 1, y: 1 } }],
    history: [],
    paths: {},
    items: [],
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
      assertFullView(state);
      for (const seat of state.seats)
        if (state.teams[seat]?.placement === null)
          for (const tile of visionOf(state, seat)) everSeen.add(tile);
      for (const tile of Object.keys(state.explored)) expect(everSeen.has(tile)).toBe(true);
      const hidden = {
        ...state,
        units: state.units.map((u) => ({ ...u, x: 0, y: 0 })),
        items: [],
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
    assertFullView(state);
  }
});
