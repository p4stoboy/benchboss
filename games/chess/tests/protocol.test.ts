import { describe, expect, test } from "bun:test";
import { mkSeatId, parseJsonl } from "@benchboss/core";
import { type MatchArtifact, createMatchRunner, createRegistry } from "@benchboss/host";
import {
  checkGameConformance,
  decisionId,
  newSession,
  observe,
  publicFrames,
  step,
  verifyPluginReplay,
} from "@benchboss/referee";
import { renderSpectatorView } from "@benchboss/viewer";
import type { ChessObservation } from "../src/game";
import { plugin } from "../src/plugin";
import { legalMoves } from "../src/position";

const seats = [mkSeatId(0), mkSeatId(1)];
const seed = "private-chess-seed";
function session(maxPlies = 80) {
  const registry = createRegistry([plugin]);
  const config = registry.buildConfig("chess-protocol", "chess", seats);
  config.rules = { maxPlies };
  return newSession({
    ...plugin,
    game: plugin.makeGame(),
    config,
    seed,
    defaultAction: plugin.safeDefault,
  });
}

test("referee rejects illegal offers and inactive-seat commands before spending resources", () => {
  const initial = session();
  const { white, black } = initial.state.players;
  for (const input of [
    null,
    [],
    {},
    { move: "a1a8" },
    { move: "e2e5" },
    { move: "e2e4", extra: true },
  ]) {
    const result = step(initial, { kind: "callTool", seat: white, tool: "match.move", input });
    expect(result.output.ok).toBe(false);
    expect(result.session.state).toEqual(initial.state);
    expect(result.session.resources).toEqual(initial.resources);
    expect(decisionId(result.session, white)).toBe(decisionId(initial, white));
  }
  for (const seat of [black, mkSeatId(99)]) {
    expect(
      step(initial, { kind: "callTool", seat, tool: "match.resign", input: {} }).session.state,
    ).toEqual(initial.state);
    expect(step(initial, { kind: "commitDefault", seat }).session.state).toEqual(initial.state);
  }
  expect((observe(initial, white) as { actionOffers: unknown[] }).actionOffers).toHaveLength(2);
  expect((observe(initial, black) as { actionOffers: unknown[] }).actionOffers).toEqual([]);
});

test("repeated move phases renew decisions and action allowances for returning seats", () => {
  let current = session();
  const { white, black } = current.state.players;
  const original = decisionId(current, white);
  for (const move of ["e2e4", "e7e5", "g1f3", "b8c6"]) {
    const seat = current.state.players[current.state.position.turn];
    const next = step(current, { kind: "callTool", seat, tool: "match.move", input: { move } });
    expect(next.output.ok).toBe(true);
    current = next.session;
  }
  expect(decisionId(current, white)).not.toBe(original);
  expect(current.game.legalActions(current.state, white)).toHaveLength(2);
  expect(current.game.legalActions(current.state, black)).toEqual([]);
});

test("versioned checkmate replay verifies exact tools and outcomes and rejects tampering", () => {
  let current = session(4);
  const initialView = publicFrames(current)[0]?.view;
  if (!initialView) throw Error("Missing initial frame");
  expect(renderSpectatorView(initialView)).toContain("Board");
  for (const move of ["f2f3", "e7e5", "g2g4", "d8h4"])
    current = step(current, {
      kind: "callTool",
      seat: current.state.players[current.state.position.turn],
      tool: "match.move",
      input: { move },
    }).session;
  const result = plugin.publicView(current.state).result;
  const args = {
    plugin,
    config: current.config,
    seed,
    log: current.log,
    projectResult: (state: typeof current.state) => plugin.publicView(state).result,
    publishedResult: result,
  };
  expect(verifyPluginReplay(args)).toEqual({ ok: true });
  expect(current.log.filter((event) => event.kind === "match.terminal")).toHaveLength(1);
  expect(publicFrames(current).at(-1)?.view).toMatchObject(plugin.publicView(current.state));
  expect(JSON.stringify(publicFrames(current))).not.toContain(seed);
  expect(renderSpectatorView(plugin.publicView(current.state))).toContain("checkmate");
  for (const tool of ["match.resign", "missing", undefined]) {
    const log = structuredClone(current.log);
    const action = log.find((event) => event.kind === "action.submit");
    if (!action) throw Error("Missing submitted action");
    if (tool) action.payload.tool = tool;
    else action.payload = { action: action.payload.action };
    expect(verifyPluginReplay({ ...args, log }).ok).toBe(false);
  }
  expect(verifyPluginReplay({ ...args, log: current.log.slice(0, -1) }).ok).toBe(false);
  expect(verifyPluginReplay({ ...args, seed: "wrong" }).ok).toBe(false);
  expect(
    verifyPluginReplay({ ...args, publishedResult: { summary: "forged", seats: [] } }).ok,
  ).toBe(false);
});

test("generated legal moves conform across seeds and rule limits", () => {
  const reports = checkGameConformance(plugin, {
    seeds: ["one", "two", "three", "four"],
    rules: [{ maxPlies: 1 }, { maxPlies: 24 }, { maxPlies: 80 }],
    choose: (state, _seat, rng) => ({
      tool: "match.move",
      input: { move: rng.pick(legalMoves(state.position)) },
    }),
  });
  expect(reports.filter((report) => !report.ok)).toEqual([]);
}, 60000);

describe("host turn deadlines", () => {
  test("only the active color spends time and expiry persists a replayable timeout", async () => {
    const registry = createRegistry([plugin]);
    const config = registry.buildConfig("clock-chess", "chess", seats);
    if (config.identity?.protocolVersion !== 1 || !config.timing)
      throw Error("expected versioned config");
    config.timing.playerTotalMs = 1000;
    const colors = plugin.makeGame().newMatch(config, seed).players;
    const artifacts: MatchArtifact[] = [];
    let time = 0;
    const runner = createMatchRunner({
      registry,
      now: () => time,
      persist: async (artifact) => {
        artifacts.push(artifact);
      },
    });
    runner.start({
      matchId: config.matchId,
      gameId: "chess",
      config,
      seed,
      assignments: seats.map((seat) => ({ seat, principalId: seat, agentId: seat })),
    });
    expect(runner.poll(colors.black).kind).toBe("waiting");
    const first = runner.poll(colors.white);
    if (first.kind !== "turn") throw Error("Expected White's turn");
    expect(first.deadline).toBe(1000);
    time = 999;
    const input = { move: "e2e4" };
    const identity = {
      decisionId: (first.observation as { decisionId: string }).decisionId,
      requestId: "white-opening",
    };
    expect(
      (await runner.submit(colors.white, config.matchId, "match.move", input, identity)).ok,
    ).toBe(true);
    expect(
      (await runner.submit(colors.white, config.matchId, "match.move", input, identity)).ok,
    ).toBe(true);
    const second = runner.poll(colors.black);
    if (second.kind !== "turn") throw Error("Expected Black's turn");
    expect(second.deadline).toBe(1999);
    expect((second.observation as unknown as ChessObservation).publicState.moves).toEqual(["e2e4"]);
    time = 1000;
    await runner.reap();
    expect(artifacts).toHaveLength(0);
    time = 1999;
    expect(
      (await runner.submit(colors.black, config.matchId, "match.move", { move: "e7e5" })).ok,
    ).toBe(false);
    await runner.reap();
    expect(artifacts).toHaveLength(1);
    const artifact = artifacts[0];
    if (!artifact) throw Error("Missing terminal artifact");
    expect(artifact.record.result).toEqual({ [colors.white]: 1, [colors.black]: 0 });
    const log = parseJsonl(artifact.replayJsonl);
    expect(log.filter((event) => event.kind === "action.submit")).toHaveLength(1);
    expect(artifact.record.presentation?.frames.at(-1)?.view.result?.cause?.kind).toBe(
      "player_time_exhausted",
    );
    expect(
      verifyPluginReplay({
        plugin,
        config,
        seed,
        log,
      }).ok,
    ).toBe(true);
  });
});

test("long matches remain renderable and their frames fit the host message budget", () => {
  const initial = session(1000).state;
  const fullHistory = Array.from(
    { length: initial.maxPlies },
    (_, ply) => ["g1f3", "g8f6", "f3g1", "f6g8"][ply % 4] ?? "g1f3",
  );
  // Projection size fixtures exercise every allowed history length, independent
  // of move selection; execution/replay legality is tested separately above.
  const frames = Array.from({ length: initial.maxPlies * 2 + 1 }, (_, seq) => {
    const ply = Math.floor(seq / 2);
    const state = { ...initial, moves: fullHistory.slice(0, ply) };
    const view = plugin.publicView(state);
    const rendered = renderSpectatorView(view);
    if (ply > 0)
      expect(rendered).toContain(
        `${Math.floor((ply - 1) / 2) + 1}${ply % 2 ? "." : "..."} ${fullHistory[ply - 1]}`,
      );
    return { seq, view };
  });
  // The host's default process message budget is 8 MiB. Leave room for logs,
  // observations and the terminal record as well as all public frames.
  expect(Buffer.byteLength(JSON.stringify(frames))).toBeLessThan(6 * 1024 * 1024);
  expect(
    plugin.makeGame().observe({ ...initial, moves: fullHistory }, initial.players.white).publicState
      .moves,
  ).toEqual(fullHistory);
});
