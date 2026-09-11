import { describe, expect, test } from "bun:test";
import { type SeatId, mkSeatId } from "@benchboss/core";
import { makeSpyGame } from "../src/game";
import { baseConfig, handlerConfig } from "./helpers";

const game = makeSpyGame();
const seats = [0, 1, 2, 3, 4].map(mkSeatId);

function findLoyal(alignmentBySeat: Record<SeatId, string>): SeatId {
  const loyal = seats.find((s) => alignmentBySeat[s] === "loyal");
  expect(loyal).toBeDefined();
  if (loyal === undefined) throw new Error("expected a loyal seat");
  return loyal;
}

// A schema is closed iff it rejects unknown keys: either additionalProperties:false
// at the root (plain object) or on every branch of an anyOf (discriminated union).
function isClosedSchema(schema: Record<string, unknown>): boolean {
  if (schema.additionalProperties === false) return true;
  const branches = schema.anyOf;
  if (Array.isArray(branches) && branches.length > 0) {
    return branches.every(
      (b) =>
        typeof b === "object" &&
        b !== null &&
        (b as Record<string, unknown>).additionalProperties === false,
    );
  }
  return false;
}

describe("spy observe", () => {
  test("loyal_observation_never_reveals_other_seats_roles", () => {
    const st = game.newMatch(baseConfig(), "leak-seed");
    const loyal = findLoyal(st.deal.alignmentBySeat);
    const obs = game.observe(st, loyal);
    expect(obs.privateState.ownRole).toBe("loyal");
    expect(obs.privateState.knownMoles).toEqual([]); // a loyal knows no moles
    const serialized = JSON.stringify(obs);
    // No other seat's alignment is recoverable from the loyal observation.
    for (const other of seats) {
      if (other === loyal) continue;
      expect(serialized).not.toContain(`"${other}":"mole"`);
      expect(serialized).not.toContain(`"${other}":"loyal"`);
    }
    // The full alignment map and mole list must not be present at all.
    expect(serialized).not.toContain("alignmentBySeat");
    expect(serialized).not.toContain("moleSeats");
  });

  test("mole_observation_reveals_only_mutual_mole_knowledge", () => {
    const st = game.newMatch(baseConfig(), "leak-seed");
    const mole = st.deal.moleSeats[0];
    expect(mole).toBeDefined();
    if (mole === undefined) throw new Error("expected a mole seat");
    const obs = game.observe(st, mole);
    expect(obs.privateState.ownRole).toBe("mole");
    expect(new Set(obs.privateState.knownMoles)).toEqual(new Set(st.deal.moleSeats));
    // A mole's knownMoles is exactly the mole set — never the loyal identities.
    const serialized = JSON.stringify(obs);
    const loyals = seats.filter((s) => !st.deal.moleSeats.includes(s));
    for (const l of loyals) expect(obs.privateState.knownMoles).not.toContain(l);
    expect(serialized).not.toContain("alignmentBySeat");
  });

  test("legal_actions_in_proposal_phase_include_propose_team_only_for_leader", () => {
    let st = game.newMatch(baseConfig(), "leak-seed");
    st = { ...st, phase: "proposal" };
    const leader = st.seats[st.leaderIdx];
    expect(leader).toBeDefined();
    if (leader === undefined) throw new Error("expected a leader seat");
    const nonLeader = st.seats.find((s) => s !== leader);
    expect(nonLeader).toBeDefined();
    if (nonLeader === undefined) throw new Error("expected a non-leader seat");
    const leaderTools = game.legalActions(st, leader).map((a) => a.tool);
    const otherTools = game.legalActions(st, nonLeader).map((a) => a.tool);
    expect(leaderTools).toContain("match.propose_team");
    expect(otherTools).not.toContain("match.propose_team");
  });

  test("legal_action_schemas_are_additional_properties_false", () => {
    let st = game.newMatch(baseConfig(), "leak-seed");
    st = { ...st, phase: "comms" };
    const seat0 = st.seats[0];
    expect(seat0).toBeDefined();
    if (seat0 === undefined) throw new Error("expected seat 0");
    // Every legal-action schema is closed against unknown keys: a plain object
    // schema carries additionalProperties:false at the root; a discriminated
    // union (e.g. comms.send) carries it on every `anyOf` branch instead.
    for (const spec of game.legalActions(st, seat0)) {
      expect(isClosedSchema(spec.jsonSchema)).toBe(true);
    }
  });
});

describe("spy observe at the end of the mission table", () => {
  test("observe does not throw after the fifth operation resolves the match", () => {
    const base = game.newMatch(baseConfig(), "five-ops");
    const mole = seats.find((s) => base.deal.alignmentBySeat[s] === "mole");
    if (mole === undefined) throw new Error("expected a mole seat");
    const loyal = findLoyal(base.deal.alignmentBySeat);
    const beforeLast = {
      ...base,
      phase: "operation" as const,
      opIndex: 4,
      successes: 2,
      fails: 2,
      proposal: {
        proposalId: "p",
        leader: loyal,
        team: [mole, loyal, seats[2] as SeatId],
        opIndex: 4,
      },
      missionActions: [
        { seat: mole, sabotage: true },
        { seat: loyal, sabotage: false },
        { seat: seats[2] as SeatId, sabotage: false },
      ],
    };
    const done = game.step(beforeLast);
    expect(game.isTerminal(done)).toBe(true);
    expect(done.opIndex).toBe(5);
    for (const seat of seats) {
      const obs = game.observe(done, seat);
      expect(obs.publicState.teamSize).toBe(0);
    }
  });

  test("observe does not throw when the fifth operation sends the match to assassinate", () => {
    const base = game.newMatch(handlerConfig(), "five-ops-m3");
    const loyals = seats.filter((s) => base.deal.alignmentBySeat[s] === "loyal");
    const beforeLast = {
      ...base,
      phase: "operation" as const,
      opIndex: 4,
      successes: 2,
      fails: 2,
      proposal: { proposalId: "p", leader: loyals[0] as SeatId, team: loyals, opIndex: 4 },
      missionActions: loyals.map((seat) => ({ seat, sabotage: false })),
    };
    const next = game.step(beforeLast);
    expect(next.phase).toBe("assassinate");
    expect(next.opIndex).toBe(5);
    for (const seat of seats) {
      expect(game.observe(next, seat).publicState.teamSize).toBe(0);
    }
  });
});

describe("spy observe hides intel-economy state", () => {
  test("saboteurs, untraceable, misinfo flags and protections never reach any seat", () => {
    const base = game.newMatch(baseConfig(), "hide-seed");
    const mole = seats.find((s) => base.deal.alignmentBySeat[s] === "mole") as SeatId;
    const st = {
      ...base,
      opResults: [
        {
          opIndex: 0,
          team: [mole, seats[0] as SeatId],
          sabotageCount: 1,
          failed: true,
          saboteurs: [mole],
          untraceable: [mole],
        },
      ],
      misinfoFlags: { [mole]: true as const },
      protectedSources: [mole],
    };
    for (const seat of seats) {
      const serialized = JSON.stringify(game.observe(st, seat));
      expect(serialized).not.toContain("saboteurs");
      expect(serialized).not.toContain("untraceable");
      expect(serialized).not.toContain("misinfoFlags");
      expect(serialized).not.toContain("protectedSources");
    }
  });
});
