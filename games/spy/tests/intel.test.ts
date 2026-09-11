import { describe, expect, test } from "bun:test";
import { type SeatId, createRng, mkSeatId } from "@benchboss/core";
import { auditStatement, scanAlignment, traceOperation } from "../src/intel";
import { spySenseResolvers } from "../src/sensing";
import type { OpResult, SpeechActRecord, SpyState } from "../src/types";

const s0 = mkSeatId(0);
const s1 = mkSeatId(1);
const s2 = mkSeatId(2);
const s3 = mkSeatId(3);
const s4 = mkSeatId(4);
const seats = [s0, s1, s2, s3, s4];
const N = 400;
const seeds = (prefix: string) => Array.from({ length: N }, (_, i) => createRng(`${prefix}${i}`));

function stateWith(over: Partial<SpyState> = {}): SpyState {
  return {
    matchId: "m",
    seats,
    deal: {
      roleBySeat: { [s0]: "loyal", [s1]: "loyal", [s2]: "loyal", [s3]: "mole", [s4]: "mole" },
      moleSeats: [s3, s4],
      alignmentBySeat: {
        [s0]: "loyal",
        [s1]: "loyal",
        [s2]: "loyal",
        [s3]: "mole",
        [s4]: "mole",
      },
      knownMolesBySeat: {},
      handlerSeat: null,
      deepCoverSeat: null,
    },
    phase: "intel",
    round: 0,
    opIndex: 0,
    leaderIdx: 0,
    rejectStreak: 0,
    successes: 0,
    fails: 0,
    proposal: null,
    votes: {},
    missionActions: [],
    opResults: [],
    log: [],
    intelResults: {},
    commsCountThisRound: {},
    phaseEnded: {},
    winner: null,
    winReason: "",
    nextActSeq: 0,
    assassinGuess: null,
    misinfoFlags: {},
    protectedSources: [],
    ...over,
  };
}

function act(over: Partial<SpeechActRecord> & { actId: string; seat: SeatId; act: string }) {
  return {
    seq: 0,
    subject: null,
    target: null,
    roleClaim: null,
    allegiance: null,
    confidence: null,
    evidenceRef: null,
    ...over,
  } satisfies SpeechActRecord;
}

function failedOp(over: Partial<OpResult> = {}): OpResult {
  return {
    opIndex: 2,
    team: [s0, s1, s3],
    sabotageCount: 1,
    failed: true,
    saboteurs: [s3],
    untraceable: [],
    ...over,
  };
}

describe("scan_alignment", () => {
  test("is replay deterministic for the same seed", () => {
    const a = scanAlignment(stateWith(), s3, createRng("x").fork("scan:0"));
    const b = scanAlignment(stateWith(), s3, createRng("x").fork("scan:0"));
    expect(a.result).toEqual(b.result);
    expect(["loyal", "mole"]).toContain(a.result.signal);
  });

  test("is right well above chance but not always", () => {
    const correct = seeds("s").filter(
      (rng) => scanAlignment(stateWith(), s3, rng).result.signal === "mole",
    ).length;
    expect(correct).toBeGreaterThan(N * 0.6);
    expect(correct).toBeLessThan(N);
  });

  test("reads loyal on a misinfo target every time and clears the flag", () => {
    const st = stateWith({ misinfoFlags: { [s3]: true } });
    for (const rng of seeds("mis").slice(0, 60)) {
      const { result, nextState } = scanAlignment(st, s3, rng);
      expect(result.signal).toBe("loyal");
      expect(nextState.misinfoFlags[s3]).toBeUndefined();
    }
    // A flag on another seat is untouched by a scan of s3.
    const other = scanAlignment(stateWith({ misinfoFlags: { [s4]: true } }), s3, createRng("o"));
    expect(other.nextState.misinfoFlags[s4]).toBe(true);
  });
});

describe("audit_statement", () => {
  const falseClaim = stateWith({
    log: [act({ actId: "a1", seat: s3, act: "claim_alignment", subject: s3, allegiance: "loyal" })],
  });
  const trueVouch = stateWith({
    log: [act({ actId: "a1", seat: s0, act: "vouch", target: s1 })],
  });

  test("calls a false claim false well above chance but not always", () => {
    const correct = seeds("af").filter(
      (rng) => auditStatement(falseClaim, "a1", rng).truthful === false,
    ).length;
    expect(correct).toBeGreaterThan(N * 0.6);
    expect(correct).toBeLessThan(N);
  });

  test("calls a true vouch true well above chance", () => {
    const correct = seeds("at").filter(
      (rng) => auditStatement(trueVouch, "a1", rng).truthful === true,
    ).length;
    expect(correct).toBeGreaterThan(N * 0.6);
  });

  test("judges an accusation by the target's hidden alignment", () => {
    const st = stateWith({ log: [act({ actId: "a1", seat: s0, act: "accuse", target: s4 })] });
    const correct = seeds("ac").filter(
      (rng) => auditStatement(st, "a1", rng).truthful === true,
    ).length;
    expect(correct).toBeGreaterThan(N * 0.6);
  });

  test("judges a role claim about the speaker when subject is absent", () => {
    const st = stateWith({
      log: [act({ actId: "a1", seat: s3, act: "claim_role", roleClaim: "loyal" })],
    });
    const correct = seeds("ar").filter(
      (rng) => auditStatement(st, "a1", rng).truthful === false,
    ).length;
    expect(correct).toBeGreaterThan(N * 0.6);
  });

  test("returns null for acts without a claim and for unknown act ids", () => {
    const st = stateWith({ log: [act({ actId: "a1", seat: s0, act: "pass" })] });
    expect(auditStatement(st, "a1", createRng("n"))).toEqual({
      actId: "a1",
      act: "pass",
      truthful: null,
    });
    expect(auditStatement(st, "nope", createRng("n"))).toEqual({
      actId: "nope",
      act: null,
      truthful: null,
    });
  });

  test("never leaks the alignment vocabulary in its result", () => {
    const r = auditStatement(falseClaim, "a1", createRng("leak"));
    expect(JSON.stringify(r)).not.toContain("loyal");
    expect(JSON.stringify(r)).not.toContain("mole");
  });
});

describe("trace_operation", () => {
  test("names the saboteur well above team-random but not always", () => {
    const st = stateWith({ opResults: [failedOp()] });
    const hits = seeds("t").filter((rng) =>
      traceOperation(st, 2, rng).suspects.includes(s3),
    ).length;
    // Three on the team, one saboteur: naming at random hits one time in three.
    expect(hits).toBeGreaterThan(N * 0.55);
    expect(hits).toBeLessThan(N);
  });

  test("never names a seat that was not on the team", () => {
    const st = stateWith({ opResults: [failedOp()] });
    for (const rng of seeds("off")) {
      const { suspects } = traceOperation(st, 2, rng);
      expect(suspects).toHaveLength(1);
      for (const s of suspects) expect([s0, s1, s3]).toContain(s);
    }
  });

  test("returns no suspects for a successful op or an unknown op index", () => {
    const st = stateWith({
      opResults: [failedOp({ failed: false, sabotageCount: 0, saboteurs: [] })],
    });
    expect(traceOperation(st, 2, createRng("e")).suspects).toEqual([]);
    expect(traceOperation(stateWith(), 7, createRng("e")).suspects).toEqual([]);
  });

  test("never names a protected saboteur and blames an innocent teammate instead", () => {
    const st = stateWith({ opResults: [failedOp({ untraceable: [s3] })] });
    for (const rng of seeds("prot")) {
      const { suspects } = traceOperation(st, 2, rng);
      expect(suspects).toHaveLength(1);
      expect(suspects).not.toContain(s3);
      for (const s of suspects) expect([s0, s1]).toContain(s);
    }
  });

  test("names the whole team when everyone on it sabotaged", () => {
    const st = stateWith({
      opResults: [failedOp({ team: [s4, s3], sabotageCount: 2, saboteurs: [s3, s4] })],
    });
    expect(traceOperation(st, 2, createRng("all")).suspects).toEqual([s3, s4]);
  });

  test("is deterministic for the same seed", () => {
    const st = stateWith({ opResults: [failedOp()] });
    expect(traceOperation(st, 2, createRng("d"))).toEqual(traceOperation(st, 2, createRng("d")));
  });
});

describe("intel sensing resolvers", () => {
  const byTool = (tool: string) => {
    const r = spySenseResolvers("sense-seed").find((x) => x.tool === tool);
    if (r === undefined) throw new Error(`${tool} resolver not found`);
    return r;
  };

  test("registers all six intel tools on the intel budget", () => {
    const tools = spySenseResolvers("z")
      .map((r) => r.tool)
      .sort();
    expect(tools).toEqual([
      "intel.audit_statement",
      "intel.counterintel",
      "intel.plant_misinfo",
      "intel.protect_source",
      "intel.scan_alignment",
      "intel.trace_operation",
    ]);
    for (const r of spySenseResolvers("z")) expect(r.budgetKey).toBe("intelOrScoutPoints");
  });

  test("scan appends a private intel result for the caller only", () => {
    const { nextState, result } = byTool("intel.scan_alignment").resolve(
      stateWith(),
      s0,
      { target: s3 },
      createRng("sense-seed"),
    );
    expect(nextState.intelResults[s0]).toHaveLength(1);
    expect(["loyal", "mole"]).toContain(result.signal as string);
    expect((nextState.intelResults[s1] ?? []).length).toBe(0);
  });

  test("scan resolver is replay deterministic", () => {
    const a = byTool("intel.scan_alignment").resolve(
      stateWith(),
      s0,
      { target: s3 },
      createRng("sd"),
    );
    const b = byTool("intel.scan_alignment").resolve(
      stateWith(),
      s0,
      { target: s3 },
      createRng("sd"),
    );
    expect(a.result).toEqual(b.result);
  });

  test("trace resolver reports the op index it was asked about", () => {
    const st = stateWith({ opResults: [failedOp()] });
    const { result } = byTool("intel.trace_operation").resolve(
      st,
      s0,
      { opIndex: 2 },
      createRng("t"),
    );
    expect(result.opIndex).toBe(2);
    expect(Array.isArray(result.suspects)).toBe(true);
  });

  test.each(["intel.plant_misinfo", "intel.counterintel", "intel.protect_source"])(
    "a loyal seat calling %s gets mole_only and changes nothing",
    (tool) => {
      const st = stateWith();
      const { result, nextState } = byTool(tool).resolve(st, s0, { target: s0 }, createRng("g"));
      expect(result).toEqual({ error: "mole_only" });
      expect(nextState).toEqual(st);
    },
  );
});
