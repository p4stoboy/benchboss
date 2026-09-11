import { expect, test } from "bun:test";
import { mkSeatId } from "@benchboss/core";
import { plugin } from "../src/plugin";

test("public projections are invariant under changes to hidden role, vote and intelligence state", () => {
  const seats = [0, 1, 2, 3, 4].map(mkSeatId);
  const state = plugin
    .makeGame()
    .newMatch(
      { matchId: "public", gameId: plugin.id, seats, rules: {}, budgets: plugin.defaultBudgets },
      "secret",
    );
  const altered = {
    ...state,
    deal: { ...state.deal, roleBySeat: {} },
    votes: { [mkSeatId(0)]: "reject" as const },
    missionActions: [{ seat: mkSeatId(0), sabotage: true }],
    misinfoFlags: { [mkSeatId(0)]: true },
    protectedSources: seats,
    intelResults: {},
  };
  expect(plugin.publicView(altered)).toEqual(plugin.publicView(state));
  expect(
    plugin
      .publicView({ ...state, winner: "loyal", winReason: "three-successes" })
      .result?.seats.every(
        (seat) =>
          seat.outcome ===
          (state.deal.alignmentBySeat[seat.seat as (typeof seats)[number]] === "loyal"
            ? "win"
            : "loss"),
      ),
  ).toBe(true);
});
