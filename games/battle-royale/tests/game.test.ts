import { expect, test } from "bun:test";
import { mkSeatId } from "@benchboss/core";
import { ABILITIES, CLASSES, type ClassId, TEAM_BUDGET, WEAPONS } from "../src/classes";
import { plugin } from "../src/plugin";
import { initiative } from "../src/state";
import { flatRows, game, newMatch, scenario, seatsOf, submitAll, unit } from "./helpers";

const s0 = mkSeatId(0);
const s1 = mkSeatId(1);
const s2 = mkSeatId(2);

test("invalid rules and seat lists fail before a match exists", () => {
  for (const rules of [
    { maxRounds: 3 },
    { maxRounds: 201 },
    { tilesPerSeat: 8 },
    { extra: 1 },
    { maxRounds: "40" },
  ])
    expect(() => newMatch(2, "seed", rules)).toThrow();
  for (const seats of [[], [s0], [s0, s0], seatsOf(31)])
    expect(() => game.newMatch({ ...plugin.manifest, ...configWith(seats) }, "seed")).toThrow();
  expect(newMatch(30).map.spawns).toHaveLength(30);
});
function configWith(seats: ReturnType<typeof seatsOf>) {
  const base = newMatch(2);
  return {
    identity: {
      protocolVersion: 1 as const,
      runtimeVersion: "0.1.0" as const,
      gameId: "battle-royale",
      revision: plugin.manifest.revision,
    },
    matchId: base.matchId,
    gameId: "battle-royale",
    seats,
    rules: {},
    timing: plugin.manifest.defaultTiming,
    resources: plugin.manifest.defaultResources,
    metering: plugin.manifest.defaultMetering,
  };
}

test("loadouts must be three affordable classes and every team spawns on its own cluster", () => {
  let state = newMatch(3);
  expect(
    game.submit(state, s0, { actors: ["sniper", "sniper", "sniper"] }, "match.loadout").accepted,
  ).toBe(false);
  expect(game.submit(state, s0, { actors: ["grunt", "grunt"] }, "match.loadout").accepted).toBe(
    false,
  );
  expect(
    game.submit(state, s0, { actors: ["grunt", "grunt", "wizard"] }, "match.loadout").accepted,
  ).toBe(false);
  expect(game.submit(state, s0, {}, "match.orders").accepted).toBe(false);
  const rosters: Record<string, ClassId[]> = {
    [s0]: ["sniper", "scout", "scout"],
    [s1]: ["medic", "vanguard", "ranger"],
    [s2]: ["grunt", "grunt", "grunt"],
  };
  for (const seat of [s0, s1, s2]) {
    const result = game.submit(state, seat, { actors: rosters[seat] }, "match.loadout");
    expect(result.accepted).toBe(true);
    expect(
      game.submit(result.state, seat, { actors: rosters[seat] }, "match.loadout").accepted,
    ).toBe(false);
    state = result.state;
  }
  expect(plugin.isReady(state)).toBe(true);
  state = game.step(state);
  expect(state.phase).toBe("orders");
  expect(state.round).toBe(1);
  expect(state.units).toHaveLength(9);
  expect(new Set(state.units.map((u) => `${u.x},${u.y}`)).size).toBe(9);
  for (const seat of [s0, s1, s2]) {
    const own = state.units.filter((u) => u.seat === seat);
    expect(own.map((u) => u.cls)).toEqual(rosters[seat] ?? []);
    expect(own.every((u) => u.hp === CLASSES[u.cls].hp)).toBe(true);
    const cluster = state.map.spawns.find((tiles) =>
      tiles.some((t) => t.x === own[0]?.x && t.y === own[0]?.y),
    );
    expect(cluster).toBeDefined();
    expect(own.every((u) => cluster?.some((t) => t.x === u.x && t.y === u.y))).toBe(true);
  }
  expect(CLASSES.sniper.cost + CLASSES.scout.cost * 2).toBeLessThanOrEqual(TEAM_BUDGET);
});

test("orders are rejected for foreign, unknown or duplicate units, unreachable tiles and unseen targets", () => {
  const state = scenario(flatRows(12, 3), [
    { seat: 0, cls: "grunt", x: 0, y: 1 },
    { seat: 1, cls: "grunt", x: 4, y: 1 },
    { seat: 1, cls: "grunt", x: 11, y: 1 },
  ]);
  const attempt = (input: unknown) => game.submit(state, s0, input, "match.orders");
  expect(attempt({ orders: [{ unit: "seat:1/0" }] }).accepted).toBe(false);
  expect(attempt({ orders: [{ unit: "nope" }] }).accepted).toBe(false);
  expect(attempt({ orders: [{ unit: "seat:0/0" }, { unit: "seat:0/0" }] }).accepted).toBe(false);
  expect(attempt({ orders: [{ unit: "seat:0/0", moveTo: { x: 9, y: 1 } }] }).accepted).toBe(false);
  expect(attempt({ orders: [{ unit: "seat:0/0", moveTo: { x: 4, y: 1 } }] }).accepted).toBe(false);
  expect(
    attempt({ orders: [{ unit: "seat:0/0", action: { kind: "attack", target: "seat:1/1" } }] })
      .accepted,
  ).toBe(false);
  expect(
    attempt({ orders: [{ unit: "seat:0/0", action: { kind: "attack", target: "seat:1/0" } }] })
      .accepted,
  ).toBe(false);
  expect(
    attempt({ orders: [{ unit: "seat:0/0", action: { kind: "heal", target: "seat:0/0" } }] })
      .accepted,
  ).toBe(false);
  expect(
    attempt({
      orders: [
        {
          unit: "seat:0/0",
          moveTo: { x: 1, y: 1 },
          action: { kind: "attack", target: "seat:1/0" },
        },
      ],
    }).accepted,
  ).toBe(true);
  expect(attempt({ orders: [] }).accepted).toBe(true);
  expect(attempt({ orders: [{ unit: "seat:0/0", extra: 1 }] }).accepted).toBe(false);
});

test("initiative rotates by round and movement stops in front of an occupied tile", () => {
  const state = scenario(flatRows(8, 1), [
    { seat: 0, cls: "grunt", x: 0, y: 0 },
    { seat: 1, cls: "grunt", x: 7, y: 0 },
  ]);
  expect(initiative(state)).toEqual([s0, s1]);
  expect(initiative({ ...state, round: 2 })).toEqual([s1, s0]);
  const next = submitAll(state, {
    [s0]: { orders: [{ unit: "seat:0/0", moveTo: { x: 4, y: 0 } }] },
    [s1]: { orders: [{ unit: "seat:1/0", moveTo: { x: 3, y: 0 } }] },
  });
  expect(unit(next, "seat:0/0")).toMatchObject({ x: 4, y: 0 });
  expect(unit(next, "seat:1/0")).toMatchObject({ x: 5, y: 0 });
  expect(next.lastRound).toContainEqual({
    kind: "move",
    unit: "seat:1/0",
    from: { x: 7, y: 0 },
    to: { x: 5, y: 0 },
    path: [
      { x: 6, y: 0 },
      { x: 5, y: 0 },
    ],
    blocked: true,
  });
  expect(next.round).toBe(2);
});

test("attacks land simultaneously so mutual kills eliminate both teams into a shared first place", () => {
  const state = scenario(flatRows(5, 1), [
    { seat: 0, cls: "grunt", x: 0, y: 0, hp: 2 },
    { seat: 1, cls: "grunt", x: 3, y: 0, hp: 2 },
  ]);
  const next = submitAll(state, {
    [s0]: { orders: [{ unit: "seat:0/0", action: { kind: "attack", target: "seat:1/0" } }] },
    [s1]: { orders: [{ unit: "seat:1/0", action: { kind: "attack", target: "seat:0/0" } }] },
  });
  expect(next.phase).toBe("terminal");
  expect(next.units.every((u) => !u.alive)).toBe(true);
  expect(next.teams[s0]?.placement).toBe(1);
  expect(next.teams[s1]?.placement).toBe(1);
  expect(next.teams[s0]?.kills).toBe(1);
  expect(game.score(next)).toEqual({ [s0]: 0.5, [s1]: 0.5 });
  expect(plugin.publicView(next).result?.seats.map((s) => s.outcome)).toEqual(["draw", "draw"]);
});

test("an attack fizzles when its target has moved out of reach, and a kill credits the shooter", () => {
  const state = scenario(flatRows(12, 1), [
    { seat: 0, cls: "grunt", x: 0, y: 0 },
    { seat: 1, cls: "grunt", x: 3, y: 0, hp: 1 },
    { seat: 1, cls: "grunt", x: 11, y: 0 },
  ]);
  const escaped = submitAll(state, {
    [s0]: { orders: [{ unit: "seat:0/0", action: { kind: "attack", target: "seat:1/0" } }] },
    [s1]: { orders: [{ unit: "seat:1/0", moveTo: { x: 7, y: 0 } }] },
  });
  expect(unit(escaped, "seat:1/0").alive).toBe(true);
  expect(escaped.lastRound).toContainEqual({
    kind: "fizzle",
    unit: "seat:0/0",
    target: "seat:1/0",
    reason: "out of range",
  });
  const shot = submitAll(state, {
    [s0]: { orders: [{ unit: "seat:0/0", action: { kind: "attack", target: "seat:1/0" } }] },
  });
  expect(unit(shot, "seat:1/0").alive).toBe(false);
  expect(shot.teams[s0]?.kills).toBe(1);
  expect(shot.teams[s0]?.damageDealt).toBe(WEAPONS[CLASSES.grunt.weapon].damage);
  expect(shot.phase).toBe("orders");
});

test("height advantage and cover change damage but never below one point", () => {
  const high = scenario(
    ["1000"],
    [
      { seat: 0, cls: "grunt", x: 0, y: 0 },
      { seat: 1, cls: "vanguard", x: 3, y: 0 },
    ],
  );
  const uphill = submitAll(high, {
    [s0]: { orders: [{ unit: "seat:0/0", action: { kind: "attack", target: "seat:1/0" } }] },
  });
  expect(unit(uphill, "seat:1/0").hp).toBe(
    CLASSES.vanguard.hp - WEAPONS[CLASSES.grunt.weapon].damage - 1,
  );
  const covered = scenario(
    ["00+"],
    [
      { seat: 0, cls: "medic", x: 0, y: 0 },
      { seat: 1, cls: "vanguard", x: 2, y: 0 },
    ],
  );
  const behindCover = submitAll(covered, {
    [s0]: { orders: [{ unit: "seat:0/0", action: { kind: "attack", target: "seat:1/0" } }] },
  });
  expect(unit(behindCover, "seat:1/0").hp).toBe(CLASSES.vanguard.hp - 1);
  expect(WEAPONS[CLASSES.medic.weapon].damage - 1).toBeLessThan(1);
});

test("medics heal an adjacent ally up to full and fizzle when the ally is not adjacent", () => {
  const state = scenario(flatRows(6, 1), [
    { seat: 0, cls: "medic", x: 0, y: 0 },
    { seat: 0, cls: "vanguard", x: 1, y: 0, hp: 3 },
    { seat: 1, cls: "grunt", x: 5, y: 0 },
  ]);
  const healed = submitAll(state, {
    [s0]: { orders: [{ unit: "seat:0/0", action: { kind: "ability", target: "seat:0/1" } }] },
  });
  expect(unit(healed, "seat:0/1").hp).toBe(
    Math.min(CLASSES.vanguard.hp, 3 + ABILITIES.heal.amount),
  );
  // Healing has no cooldown, so the medic may heal again next round.
  expect(
    game.submit(
      healed,
      s0,
      { orders: [{ unit: "seat:0/0", action: { kind: "ability", target: "seat:0/1" } }] },
      "match.orders",
    ).accepted,
  ).toBe(true);
  const apart = submitAll(state, {
    [s0]: {
      orders: [
        { unit: "seat:0/0", action: { kind: "ability", target: "seat:0/1" } },
        { unit: "seat:0/1", moveTo: { x: 4, y: 0 } },
      ],
    },
  });
  expect(unit(apart, "seat:0/1").hp).toBe(3);
  expect(apart.lastRound).toContainEqual({
    kind: "fizzle",
    unit: "seat:0/0",
    target: "seat:0/1",
    reason: "not adjacent",
  });
});

test("the storm damages units outside the zone; teams lost to combat and storm in one round share a placement", () => {
  const state = scenario(flatRows(9, 9), [
    { seat: 0, cls: "grunt", x: 4, y: 4 },
    { seat: 1, cls: "grunt", x: 0, y: 0, hp: 1 },
    { seat: 2, cls: "grunt", x: 4, y: 6, hp: 1 },
    { seat: 3, cls: "grunt", x: 8, y: 8, hp: 1 },
  ]);
  const closing = { ...state, rules: { maxRounds: 4, tilesPerSeat: 25 }, round: 3 };
  const next = submitAll(closing, {
    [s0]: { orders: [{ unit: "seat:0/0", action: { kind: "attack", target: "seat:2/0" } }] },
  });
  expect(unit(next, "seat:0/0").hp).toBe(CLASSES.grunt.hp);
  expect(next.lastRound.filter((e) => e.kind === "storm")).toHaveLength(2);
  expect([s1, s2, mkSeatId(3)].map((seat) => next.teams[seat]?.placement)).toEqual([2, 2, 2]);
  expect(next.teams[s0]?.placement).toBe(1);
  expect(next.phase).toBe("terminal");
  expect(game.score(next)).toEqual({ [s0]: 1, [s1]: 1 / 3, [s2]: 1 / 3, [mkSeatId(3)]: 1 / 3 });
  expect(plugin.publicView(next).result?.seats.find((s) => s.seat === s0)?.outcome).toBe("win");
});

test("the round cap ranks survivors by living units, then hit points, then damage dealt", () => {
  const state = scenario(flatRows(20, 3), [
    { seat: 0, cls: "grunt", x: 0, y: 0 },
    { seat: 0, cls: "grunt", x: 0, y: 2 },
    { seat: 1, cls: "grunt", x: 19, y: 0, hp: 5 },
    { seat: 2, cls: "grunt", x: 19, y: 2, hp: 5 },
  ]);
  const capped = { ...state, rules: { maxRounds: 4, tilesPerSeat: 25 }, round: 4 };
  const team2 = capped.teams[s2];
  if (!team2) throw Error("missing team");
  const withDamage = { ...capped, teams: { ...capped.teams, [s2]: { ...team2, damageDealt: 3 } } };
  const next = submitAll(withDamage, {});
  expect(next.phase).toBe("terminal");
  expect([s0, s1, s2].map((seat) => next.teams[seat]?.placement)).toEqual([1, 3, 2]);
});

test("player time exhaustion removes a batch of seats together and can end the match", () => {
  const state = scenario(flatRows(9, 1), [
    { seat: 0, cls: "grunt", x: 0, y: 0 },
    { seat: 1, cls: "grunt", x: 4, y: 0 },
    { seat: 2, cls: "grunt", x: 8, y: 0 },
  ]);
  const event = { kind: "player_time_exhausted" as const, seats: [s1, s2], phaseId: "p", at: 1 };
  const next = plugin.onHostEvent?.(state, event);
  expect(next?.phase).toBe("terminal");
  expect(next?.teams[s1]?.placement).toBe(2);
  expect(next?.teams[s2]?.placement).toBe(2);
  expect(next?.teams[s0]?.placement).toBe(1);
  expect(next?.cause).toBe("player_time_exhausted");
  expect(plugin.publicView(next as never).result?.cause?.kind).toBe("player_time_exhausted");
  const pregame = plugin.onHostEvent?.(newMatch(3), { ...event, seats: [s2] });
  expect(pregame?.phase).toBe("loadout");
  expect(plugin.participation?.(pregame as never, s2)).toEqual({
    status: "finished",
    reason: "eliminated",
  });
  expect(plugin.isReady(pregame as never)).toBe(false);
  expect(plugin.onHostEvent?.(state, { ...event, kind: "decision_expired", seats: [s0] })).toBe(
    state,
  );
});

test("chat rides on accepted envelopes only and reaches every seat and spectator in order", () => {
  let state = newMatch(3, "chat");
  const loadout = { actors: ["grunt", "grunt", "grunt"] };
  const long = "x".repeat(281);
  expect(game.submit(state, s0, { ...loadout, chat: "" }, "match.loadout").accepted).toBe(false);
  expect(game.submit(state, s0, { ...loadout, chat: long }, "match.loadout").accepted).toBe(false);
  expect(
    game.submit(state, s0, { actors: ["sniper", "sniper", "sniper"], chat: "gg" }, "match.loadout")
      .accepted,
  ).toBe(false);
  expect(state.chat).toEqual([]);
  state = game.submit(state, s0, { ...loadout, chat: "hello all" }, "match.loadout").state;
  state = game.submit(state, s1, loadout, "match.loadout").state;
  state = game.submit(state, s2, { ...loadout, chat: "gl hf" }, "match.loadout").state;
  expect(state.chat).toEqual([
    { round: 0, seat: s0, text: "hello all" },
    { round: 0, seat: s2, text: "gl hf" },
  ]);
  state = game.step(state);
  const bad = game.submit(
    state,
    s1,
    { orders: [{ unit: "nope" }], chat: "should not post" },
    "match.orders",
  );
  expect(bad.accepted).toBe(false);
  state = game.submit(state, s1, { orders: [], chat: "truce?" }, "match.orders").state;
  expect(state.chat).toHaveLength(3);
  expect(state.chat[2]).toEqual({ round: 1, seat: s1, text: "truce?" });
  expect(state.orders[s1]).toEqual({ orders: [] });
  for (const seat of state.seats)
    expect(game.observe(state, seat).publicState.chat).toEqual(state.chat);
  const chatBlock = plugin
    .publicView(state)
    .blocks.find((block) => block.kind === "list" && block.title === "Chat");
  expect(chatBlock).toEqual({
    kind: "list",
    title: "Chat",
    items: ["[r0] seat:0: hello all", "[r0] seat:2: gl hf", "[r1] seat:1: truce?"],
  });
  expect(plugin.safeDefault(state, s0).input).not.toHaveProperty("chat");
});

test("live chat is windowed to the most recent lines while the terminal view carries all of it", () => {
  const flood = Array.from({ length: 60 }, (_, i) => ({ round: 1, seat: s0, text: `m${i}` }));
  const state = scenario(
    flatRows(5, 1),
    [
      { seat: 0, cls: "grunt", x: 0, y: 0 },
      { seat: 1, cls: "grunt", x: 4, y: 0 },
    ],
    { chat: flood },
  );
  const live = game.observe(state, s1).publicState.chat;
  expect(live).toHaveLength(50);
  expect(live[0]?.text).toBe("m10");
  expect(live.at(-1)?.text).toBe("m59");
  const liveBlock = plugin
    .publicView(state)
    .blocks.find((block) => block.kind === "list" && block.title === "Chat");
  expect(liveBlock && "items" in liveBlock ? liveBlock.items : []).toHaveLength(50);
  const terminal = plugin.onHostEvent?.(state, {
    kind: "player_time_exhausted",
    seats: [s1],
    phaseId: "p",
    at: 1,
  }) as never;
  const terminalBlock = plugin
    .publicView(terminal)
    .blocks.find((block) => block.kind === "list" && block.title === "Chat");
  expect(terminalBlock && "items" in terminalBlock ? terminalBlock.items : []).toHaveLength(60);
});

test("observations carry the map as row-major grids", () => {
  const state = scenario(
    ["01#", "2+0"],
    [
      { seat: 0, cls: "grunt", x: 0, y: 0 },
      { seat: 1, cls: "grunt", x: 2, y: 1 },
    ],
  );
  const { map } = game.observe(state, s0).publicState;
  expect(map).toEqual({
    width: 3,
    height: 2,
    heights: [
      [0, 1, 0],
      [2, 0, 0],
    ],
    terrain: [
      ["open", "open", "wall"],
      ["open", "cover", "open"],
    ],
  });
});

test("the terminal view carries every history entry as scalar tables a broadcaster can replay", () => {
  const start = scenario(
    flatRows(6, 1),
    [
      { seat: 0, cls: "grunt", x: 0, y: 0 },
      { seat: 1, cls: "grunt", x: 3, y: 0, hp: 2 },
      { seat: 2, cls: "grunt", x: 5, y: 0 },
    ],
    {},
    [{ x: 4, y: 0, kind: "armour" }],
  );
  // Round 1: seat 0 walks in and kills seat 1's last unit; seat 2 holds.
  const round2 = submitAll(start, {
    [s0]: {
      orders: [
        {
          unit: "seat:0/0",
          moveTo: { x: 1, y: 0 },
          action: { kind: "attack", target: "seat:1/0" },
        },
      ],
    },
  });
  expect(round2.teams[s1]?.placement).toBe(3);
  // Round 2 forfeits seat 2 by host event while orders are open.
  const terminal = plugin.onHostEvent?.(round2, {
    kind: "player_time_exhausted",
    seats: [s2],
    phaseId: "p",
    at: 1,
  }) as typeof round2;
  expect(terminal.phase).toBe("terminal");
  expect(terminal.history.map((entry) => entry.round)).toEqual([0, 1, 2]);
  const view = plugin.publicView(terminal);
  const table = (title: string) => {
    const block = view.blocks.find((b) => b.kind === "table" && b.title === title);
    if (!block || !("rows" in block)) throw Error(`missing table ${title}`);
    return block;
  };
  expect(table("Rounds").rows).toEqual([
    [0, 0, 6, 1],
    [1, 1, 6, 1],
    [2, 2, 6, 1],
  ]);
  expect(table("Units").rows).toEqual([
    [0, "seat:0/0", s0, "grunt", 0, 0, 8, 0, "rifle", 1, 0],
    [0, "seat:1/0", s1, "grunt", 3, 0, 2, 0, "rifle", 1, 0],
    [0, "seat:2/0", s2, "grunt", 5, 0, 8, 0, "rifle", 1, 0],
    [1, "seat:0/0", s0, "grunt", 1, 0, 8, 0, "rifle", 1, 0],
    [1, "seat:2/0", s2, "grunt", 5, 0, 8, 0, "rifle", 1, 0],
    [2, "seat:0/0", s0, "grunt", 1, 0, 8, 0, "rifle", 1, 0],
  ]);
  expect(table("Loot").rows).toEqual([
    [0, 4, 0, "armour"],
    [1, 4, 0, "armour"],
    [2, 4, 0, "armour"],
  ]);
  const events = table("Events");
  expect(events.columns).toEqual([
    "Entry",
    "Kind",
    "Unit",
    "Target",
    "Seat",
    "From x",
    "From y",
    "At x",
    "At y",
    "Value",
    "Note",
    "Path",
  ]);
  expect(events.rows).toEqual([
    [1, "move", "seat:0/0", "", "", 0, 0, 1, 0, "", "", "1,0"],
    [1, "attack", "seat:0/0", "seat:1/0", "", 1, 0, 3, 0, 2, "", ""],
    [1, "death", "seat:1/0", "", "", "", "", 3, 0, "", "", ""],
    [1, "eliminated", "", "", s1, "", "", "", "", 3, "", ""],
    [2, "death", "seat:2/0", "", "", "", "", 5, 0, "", "", ""],
    [2, "eliminated", "", "", s2, "", "", "", "", 2, "", ""],
  ]);
  for (const block of view.blocks)
    if (block.kind === "table")
      for (const row of block.rows) expect(row).toHaveLength(block.columns.length);
});
