import { describe, expect, test } from "bun:test";
import {
  type Command,
  type MatchHandle,
  type MatchSession,
  newSession,
  observe,
  sessionLog,
  sessionState,
  step,
} from "@benchboss/referee";
import { makeSpyGame } from "../src/game";
import { SPY_PHASE_TOOLS, currentPhase, isReady, spySafeDefault } from "../src/phases";
import { spySenseResolvers } from "../src/sensing";
import type { SpyState } from "../src/types";
import { baseConfig } from "./helpers";

function harness<State>(session: MatchSession<State>): MatchHandle<State> {
  let s = session;
  return {
    get: () => s,
    advance: (cmd: Command) => {
      const r = step(s, cmd);
      s = r.session;
      return r.output;
    },
  };
}

function intelServer(seed = "sense-srv") {
  return harness(
    newSession<SpyState>({
      game: makeSpyGame(),
      config: baseConfig(),
      seed,
      phaseToTools: SPY_PHASE_TOOLS,
      currentPhase,
      isReady,
      safeDefault: spySafeDefault,
      senseResolvers: spySenseResolvers(seed),
    }),
  );
}

function toIntelPhase(server: ReturnType<typeof intelServer>) {
  const seats = sessionState(server.get()).seats;
  for (const s of seats)
    server.advance({ kind: "callTool", seat: s, tool: "match.submit_phase_end", input: {} });
  // now in intel phase
}

describe("intel sensing at the server boundary", () => {
  test("scan_spends_intel_points_not_tool_calls_and_keeps_the_phase", () => {
    const server = intelServer();
    toIntelPhase(server);
    expect(currentPhase(sessionState(server.get()))).toBe("intel");
    const seats = sessionState(server.get()).seats;
    const seat0 = seats[0];
    const seat3 = seats[3];
    expect(seat0).toBeDefined();
    expect(seat3).toBeDefined();
    if (seat0 === undefined || seat3 === undefined) throw new Error("seats must be defined");
    const token = seat0;
    // Warmup: fire a sensing call to open the turn (triggers ledger.reset), then
    // use the observation it returns as the stable "before" baseline for the next call.
    const warmup = server.advance({
      kind: "callTool",
      seat: token,
      tool: "intel.scan_alignment",
      input: { target: seat3 },
    });
    expect(warmup.ok).toBe(true);
    const before = (warmup.observation as { budgets: Record<string, number> }).budgets;
    expect(before.intelOrScoutPoints).toBeDefined();
    expect(before.toolCallsPerTurn).toBeDefined();
    if (before.intelOrScoutPoints === undefined || before.toolCallsPerTurn === undefined)
      throw new Error("budget keys missing before");
    const r = server.advance({
      kind: "callTool",
      seat: token,
      tool: "intel.scan_alignment",
      input: { target: seat3 },
    });
    expect(r.ok).toBe(true);
    const after = (observe(server.get(), token) as { budgets: Record<string, number> }).budgets;
    expect(after.intelOrScoutPoints).toBeDefined();
    expect(after.toolCallsPerTurn).toBeDefined();
    if (after.intelOrScoutPoints === undefined || after.toolCallsPerTurn === undefined)
      throw new Error("budget keys missing after");
    expect(after.intelOrScoutPoints).toBe(before.intelOrScoutPoints - 1);
    expect(after.toolCallsPerTurn).toBe(before.toolCallsPerTurn); // sensing does NOT spend tool calls
    expect(currentPhase(sessionState(server.get()))).toBe("intel"); // phase not advanced
  });

  test("intel_budget_exhaustion_refuses_further_scans", () => {
    const server = intelServer();
    toIntelPhase(server);
    const seats = sessionState(server.get()).seats;
    const seat0 = seats[0];
    const seat3 = seats[3];
    expect(seat0).toBeDefined();
    expect(seat3).toBeDefined();
    if (seat0 === undefined || seat3 === undefined) throw new Error("seats must be defined");
    const token = seat0;
    // baseConfig grants intelOrScoutPoints: 3.
    for (let i = 0; i < 3; i++)
      expect(
        server.advance({
          kind: "callTool",
          seat: token,
          tool: "intel.scan_alignment",
          input: { target: seat3 },
        }).ok,
      ).toBe(true);
    const refused = server.advance({
      kind: "callTool",
      seat: token,
      tool: "intel.scan_alignment",
      input: { target: seat3 },
    });
    expect(refused.ok).toBe(false);
    expect(refused.reason).toBe("intelOrScoutPoints-exhausted");
  });

  test("scan_serve_logs_a_leak_free_sense_serve_event", () => {
    const server = intelServer();
    toIntelPhase(server);
    const seats = sessionState(server.get()).seats;
    const seat0 = seats[0];
    const seat3 = seats[3];
    expect(seat0).toBeDefined();
    expect(seat3).toBeDefined();
    if (seat0 === undefined || seat3 === undefined) throw new Error("seats must be defined");
    const token = seat0;
    server.advance({
      kind: "callTool",
      seat: token,
      tool: "intel.scan_alignment",
      input: { target: seat3 },
    });
    const serve = sessionLog(server.get()).find((e) => e.kind === "sense.serve");
    expect(serve).toBeDefined();
    if (serve === undefined) throw new Error("sense.serve event missing");
    // The public log carries ONLY tool + cost — never the sensed signal.
    expect(serve.payload).toEqual({ tool: "intel.scan_alignment", cost: 1 });
    expect(JSON.stringify(serve.payload)).not.toContain("signal");
  });

  test("intel_result_is_private_to_caller_and_absent_from_other_seats", () => {
    const server = intelServer();
    toIntelPhase(server);
    const seats = sessionState(server.get()).seats;
    const seat0 = seats[0];
    const seat1 = seats[1];
    const seat3 = seats[3];
    expect(seat0).toBeDefined();
    expect(seat1).toBeDefined();
    expect(seat3).toBeDefined();
    if (seat0 === undefined || seat1 === undefined || seat3 === undefined)
      throw new Error("seats must be defined");
    const token0 = seat0;
    const token1 = seat1;
    const r = server.advance({
      kind: "callTool",
      seat: token0,
      tool: "intel.scan_alignment",
      input: { target: seat3 },
    });
    expect(r.ok).toBe(true);
    expect(r.result).toBeDefined();
    if (r.result === undefined) throw new Error("result missing from sensing response");
    // Caller's privateState includes the intel result.
    const obs0 = observe(server.get(), token0) as {
      privateState: { ownIntel: Array<Record<string, unknown>> };
    };
    expect(obs0.privateState.ownIntel.length).toBe(1);
    // Other seat's privateState has no intel from seat0's scan.
    const obs1 = observe(server.get(), token1) as {
      privateState: { ownIntel: Array<Record<string, unknown>> };
    };
    expect(obs1.privateState.ownIntel.length).toBe(0);
    // The intel payload (actId unique to this scan) is absent from other seat's intel.
    const scanActId = `intel:intel.scan_alignment:${seat0}:0`;
    expect(JSON.stringify(obs1.privateState.ownIntel)).not.toContain(scanActId);
  });
});
