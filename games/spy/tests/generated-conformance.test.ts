import { afterAll, describe, expect, test } from "bun:test";
import { checkGameConformance } from "@benchboss/referee";
import { teamSize } from "../src/missions";
import { plugin } from "../src/plugin";

describe("generated Safehouse play", () => {
  const phases = new Set<string>();
  const seeds = Array.from({ length: 16 }, (_, i) => `safehouse-generated:${i}`);

  // Each seed covers every seat count and rule variant within its own time limit.
  test.each(seeds)(
    "%s preserves privacy and verifies every outcome",
    (seed) => {
      const reports = checkGameConformance(plugin, {
        seeds: [seed],
        rules: [{ handler: false }, { handler: true }],
        choose(state, seat, rng) {
          phases.add(state.phase);
          const hidden = structuredClone(state);
          hidden.deal.roleBySeat = {};
          hidden.deal.alignmentBySeat = {};
          hidden.deal.knownMolesBySeat = {};
          hidden.votes = {};
          hidden.missionActions = [];
          hidden.intelResults = {};
          hidden.protectedSources = [];
          hidden.misinfoFlags = {};
          hidden.opResults = hidden.opResults.map((r) => ({
            ...r,
            saboteurs: [],
            untraceable: [],
          }));
          expect(plugin.publicView(hidden)).toEqual(plugin.publicView(state));
          const game = plugin.makeGame();
          const observer = state.seats.find((s) => s !== seat);
          if (!observer) throw Error("missing observer");
          const privateChange = structuredClone(state);
          privateChange.intelResults[seat] = [];
          expect(game.observe(privateChange, observer)).toEqual(game.observe(state, observer));
          switch (state.phase) {
            case "proposal":
              return {
                tool: "match.propose_team",
                input: {
                  team: rng
                    .shuffle([...state.seats])
                    .slice(0, teamSize(state.seats.length, state.opIndex)),
                },
              };
            case "vote":
              return {
                tool: "match.vote",
                input: { vote: rng.pick(["approve", "approve", "approve", "reject"]) },
              };
            case "operation":
              return {
                tool: "match.mission_action",
                input: {
                  sabotage: state.deal.alignmentBySeat[seat] === "mole" && rng.pick([true, false]),
                },
              };
            case "assassinate":
              return { tool: "match.assassinate", input: { target: rng.pick(state.seats) } };
            default:
              return { tool: "match.submit_phase_end", input: {} };
          }
        },
      });
      expect(reports.filter((r) => !r.ok)).toEqual([]);
    },
    60000,
  );

  afterAll(() => {
    expect([...phases].sort()).toEqual([
      "assassinate",
      "briefing",
      "comms",
      "debrief",
      "intel",
      "operation",
      "proposal",
      "vote",
    ]);
  });
});
