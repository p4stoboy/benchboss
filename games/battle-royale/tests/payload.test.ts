import { expect, test } from "bun:test";
import { mkSeatId } from "@benchboss/core";
import { createMatchRunner, createRegistry } from "@benchboss/host";
import { validateNextEnvelope } from "@benchboss/protocol";
import { CLASSES } from "../src/classes";
import { plugin } from "../src/plugin";
import { plans } from "../src/state";
import type { BrState } from "../src/types";
import { flatRows, game, newMatch, reachCosts, scenario } from "./helpers";

const s0 = mkSeatId(0);
const s1 = mkSeatId(1);
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
const decisionBytes = (state: BrState): number =>
  bytes({
    ...game.observe(state, s0),
    actionOffers: game.legalActions(state, s0),
  });

function combat(): BrState {
  return scenario(flatRows(25, 25), [
    { seat: 0, cls: "ranger", x: 10, y: 10 },
    { seat: 0, cls: "ranger", x: 11, y: 10 },
    { seat: 0, cls: "ranger", x: 12, y: 10 },
    { seat: 1, cls: "grunt", x: 10, y: 14 },
    { seat: 1, cls: "grunt", x: 11, y: 14 },
    { seat: 1, cls: "grunt", x: 12, y: 14 },
  ]);
}

test("shot grids preserve every offered destination and target, including move cost", () => {
  for (const state of [
    combat(),
    scenario(
      ["000#000", "0122100", "0000000"],
      [
        { seat: 0, cls: "ranger", x: 0, y: 0 },
        { seat: 1, cls: "grunt", x: 6, y: 2 },
      ],
    ),
  ]) {
    for (const observed of game.observe(state, s0).privateState.units) {
      const decoded = Object.fromEntries(
        Object.entries(observed.shots).map(([id, grid]) => [id, reachCosts(grid)]),
      );
      const plan = plans(state, s0).find((p) => p.unit.id === observed.id);
      if (!plan) throw Error("missing plan");
      const expected: string[] = [];
      for (const reach of plan.reaches)
        for (const target of reach.targets)
          expected.push(`${target}:${reach.x},${reach.y}:${reach.cost}`);
      const actual = Object.entries(decoded).flatMap(([id, costs]) =>
        [...costs].map(([tile, cost]) => `${id}:${tile}:${cost}`),
      );
      expect(actual.sort()).toEqual(expected.sort());
      // Exercise the advertised pairs through authoritative submission, not just a codec.
      for (const [target, costs] of Object.entries(decoded))
        for (const [tile] of costs) {
          const [x, y] = tile.split(",").map(Number);
          expect(
            game.submit(
              state,
              s0,
              {
                orders: [
                  { unit: observed.id, moveTo: { x, y }, action: { kind: "attack", target } },
                ],
              },
              "match.orders",
            ).accepted,
          ).toBe(true);
        }
    }
  }
});

test("payloads remain small for distant squads, crowded fights and thirty seats", () => {
  const spread = scenario(flatRows(140, 140), [
    { seat: 0, cls: "ranger", x: 8, y: 8 },
    { seat: 0, cls: "ranger", x: 130, y: 8 },
    { seat: 0, cls: "ranger", x: 130, y: 130 },
    { seat: 1, cls: "grunt", x: 70, y: 70 },
  ]);
  let spawn = newMatch(30, "payload-baseline");
  for (const seat of spawn.seats)
    spawn = game.submit(
      spawn,
      seat,
      { actors: ["grunt", "grunt", "grunt"] },
      "match.loadout",
    ).state;
  spawn = game.step(spawn);
  const sizes = {
    spread: decisionBytes(spread),
    combat: decisionBytes(combat()),
    spawn30: decisionBytes(spawn),
    waiting30: bytes(game.observe(spawn, s1)),
  };
  console.log("Battle Royale decision bytes:", JSON.stringify(sizes));
  // Budgets constrain actual encoded output, using the pre-change fixed-fixture measurements.
  expect(sizes.spread).toBeLessThan(41725 / 4);
  expect(sizes.combat).toBeLessThan(15942 / 2);
  expect(sizes.spawn30).toBeLessThan(7129 / 2);
  expect(sizes.waiting30).toBeLessThan(3090 / 4);
});

test("waiting and accepted-submit observations disclose no battlefield state through the host", async () => {
  const registry = createRegistry([plugin]);
  const seats = [s0, s1, mkSeatId(2)];
  const config = registry.buildConfig("payload-host", plugin.id, seats);
  config.rules = { ...config.rules, tilesPerSeat: 25 };
  const runner = createMatchRunner({ registry, persist: async () => {}, now: () => 0 });
  runner.start({
    matchId: config.matchId,
    gameId: plugin.id,
    seed: "payload-host",
    config,
    assignments: seats.map((seat) => ({ seat, principalId: seat, agentId: seat })),
  });
  for (const seat of seats) {
    const next = await runner.next(seat);
    expect(next.kind).toBe("turn");
    if (next.kind !== "turn") throw Error("missing loadout turn");
    const submitted = await runner.submit(
      seat,
      config.matchId,
      "match.loadout",
      { actors: ["grunt", "grunt", "grunt"] },
      { decisionId: next.observation.decisionId, requestId: `loadout-${seat}` },
    );
    expect(submitted.ok).toBe(true);
    expect(submitted.observation?.publicState).toEqual({});
    expect(submitted.observation?.privateState).toMatchObject({
      committed: true,
      loadout: null,
      units: [],
      view: null,
    });
  }
  const waiting = await runner.next(s1);
  expect(validateNextEnvelope(waiting).ok).toBe(true);
  expect(waiting.kind).toBe("waiting");
  if (waiting.kind !== "waiting") throw Error("expected waiting");
  expect(waiting.observation.publicState).toEqual({});
  expect(JSON.stringify(waiting)).not.toContain(s0);
  expect(waiting.observation.actionOffers).toEqual([]);
  expect(await runner.next(s1)).toEqual(waiting);
  const turn = await runner.next(s0);
  if (turn.kind !== "turn") throw Error("missing orders turn");
  expect(JSON.stringify(turn)).not.toContain('"turnOrder"');
  expect(JSON.stringify(turn)).not.toContain('"teams"');
  const submitted = await runner.submit(
    s0,
    config.matchId,
    "match.orders",
    { orders: [] },
    { decisionId: turn.observation.decisionId, requestId: "orders" },
  );
  expect(submitted.ok).toBe(true);
  expect(submitted.observation?.publicState).toEqual({});
  const nextTurn = await runner.next(s1);
  expect(validateNextEnvelope(nextTurn).ok).toBe(true);
  expect(nextTurn.kind).toBe("turn");
  if (nextTurn.kind !== "turn") throw Error("missing next turn");
  expect(nextTurn.observation.privateState).toMatchObject({ committed: false });
  expect(await runner.next(s1)).toEqual(nextTurn);
  console.log(
    "Battle Royale host next bytes:",
    JSON.stringify({ waiting: bytes(waiting), turn: bytes(nextTurn) }),
  );
});

test("unseen enemy state, turn markers and eliminations cannot change an agent observation", () => {
  const state = scenario(flatRows(50, 3), [
    { seat: 0, cls: "grunt", x: 0, y: 0 },
    { seat: 1, cls: "grunt", x: 45, y: 0 },
    { seat: 2, cls: "grunt", x: 45, y: 2 },
  ]);
  const team = state.teams[s1];
  if (!team) throw Error("missing team");
  const changed: BrState = {
    ...state,
    teams: { ...state.teams, [s1]: { ...team, placement: 3, eliminatedRound: 1 } },
    units: state.units.map((u) =>
      u.seat === s1 ? { ...u, alive: false, hp: 0, x: 40, weapon: "railgun" } : u,
    ),
    events: [
      { kind: "turn", seat: s1 },
      { kind: "eliminated", seat: s1, placement: 3 },
      { kind: "death", unit: "seat:1/0", at: { x: 40, y: 0 } },
    ],
  };
  expect(game.observe(changed, s0)).toEqual(game.observe(state, s0));
  expect(JSON.stringify(game.observe(state, s0))).not.toContain(s1);
});

test("visible endpoints do not disclose hidden movement paths or hidden actors", () => {
  const state = scenario(flatRows(30, 3), [
    { seat: 0, cls: "grunt", x: 0, y: 0 },
    { seat: 1, cls: "grunt", x: 2, y: 0 },
    { seat: 2, cls: "grunt", x: 25, y: 0 },
  ]);
  const changed: BrState = {
    ...state,
    units: state.units.map((u) => (u.seat === s0 ? { ...u, hp: u.hp - 2 } : u)),
    events: [
      {
        kind: "move",
        unit: "seat:1/0",
        from: { x: 10, y: 0 },
        to: { x: 2, y: 0 },
        path: [9, 8, 7, 6, 5, 4, 3, 2].map((x) => ({ x, y: 0 })),
        blocked: false,
      },
      { kind: "blast", unit: "seat:2/0", target: "seat:0/0", at: { x: 0, y: 0 }, damage: 2 },
      {
        kind: "ability",
        unit: "seat:1/0",
        ability: "grenade",
        from: { x: 2, y: 0 },
        at: { x: 25, y: 0 },
      },
    ],
  };
  expect(game.observe(changed, s0).privateState.events).toEqual([]);
  expect(game.observe(changed, s0).privateState.units[0]?.hp).toBe(CLASSES.grunt.hp - 2);
});

test("fully visible events survive filtering and global chat remains the kill-gated fog exception", () => {
  const state = scenario(
    flatRows(30, 3),
    [
      { seat: 0, cls: "grunt", x: 0, y: 0 },
      { seat: 1, cls: "grunt", x: 2, y: 0 },
      { seat: 2, cls: "grunt", x: 25, y: 0 },
    ],
    {
      round: 2,
      turns: [
        { seat: s1, orders: [] },
        { seat: mkSeatId(2), orders: [] },
      ],
      events: [
        {
          kind: "move",
          unit: "seat:1/0",
          from: { x: 1, y: 0 },
          to: { x: 2, y: 0 },
          path: [{ x: 2, y: 0 }],
          blocked: false,
        },
      ],
      chat: [{ round: 1, seat: mkSeatId(2), text: "global chat from outside vision" }],
    },
  );
  const quiet = game.observe(state, s0);
  expect(quiet.privateState.events).toEqual(state.events);
  expect(quiet.privateState.chat).toEqual([]);
  const unlocked = game.observe({ ...state, recentKills: { [s0]: 1 } }, s0);
  expect(unlocked.privateState.chat).toEqual(state.chat);
  expect(unlocked.privateState.visibleEnemies.some((u) => u.seat === mkSeatId(2))).toBe(false);
});

test("submit echoes a turn snapshot when the submitting seat immediately acts again", async () => {
  const registry = createRegistry([plugin]);
  const config = registry.buildConfig("consecutive", plugin.id, [s0, s1]);
  config.rules = { ...config.rules, tilesPerSeat: 25 };
  const runner = createMatchRunner({ registry, persist: async () => {}, now: () => 0 });
  runner.start({
    matchId: config.matchId,
    gameId: plugin.id,
    seed: "consecutive",
    config,
    assignments: [s0, s1].map((seat) => ({ seat, principalId: seat, agentId: seat })),
  });
  // Seat zero chooses last, so resolving its loadout immediately gives it an orders turn.
  expect(
    (
      await runner.submit(s1, config.matchId, "match.loadout", {
        actors: ["grunt", "grunt", "grunt"],
      })
    ).ok,
  ).toBe(true);
  const started = await runner.submit(s0, config.matchId, "match.loadout", {
    actors: ["grunt", "grunt", "grunt"],
  });
  expect(started.ok).toBe(true);
  const first = await runner.next(s0);
  if (first.kind !== "turn") throw Error("missing first turn");
  expect(started.observation).toEqual(first.observation);
  expect(started.observation?.privateState).toMatchObject({ committed: false });
  expect((await runner.submit(s0, config.matchId, "match.orders", { orders: [] })).ok).toBe(true);
  // With two seats, seat one closes round one and opens round two.
  const repeated = await runner.submit(s1, config.matchId, "match.orders", { orders: [] });
  expect(repeated.ok).toBe(true);
  const next = await runner.next(s1);
  if (next.kind !== "turn") throw Error("missing consecutive turn");
  expect(repeated.observation).toEqual(next.observation);
  expect(next.observation.publicState).toMatchObject({ round: 2 });
  expect(next.observation.privateState).toMatchObject({ committed: false });
});
