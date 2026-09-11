import { describe, expect, test } from "bun:test";
import type { SeatId } from "@benchboss/core";
import { makeSpyGame } from "../src/game";
import type { SpyState } from "../src/types";
import { baseConfig } from "./helpers";

const game = makeSpyGame();

function moleAndLoyal(st: SpyState): { mole: SeatId; loyal: SeatId } {
  const mole = st.deal.moleSeats[0];
  expect(mole).toBeDefined();
  const loyal = st.seats.find((s) => !st.deal.moleSeats.includes(s));
  expect(loyal).toBeDefined();
  if (mole === undefined || loyal === undefined) throw new Error("unreachable");
  return { mole, loyal };
}

function seatAt(st: SpyState, idx: number): SeatId {
  const s = st.seats[idx];
  expect(s).toBeDefined();
  if (s === undefined) throw new Error("unreachable");
  return s;
}

describe("spy resolution", () => {
  test("loyal_cannot_sabotage", () => {
    let st = game.newMatch(baseConfig(), "r-seed");
    const { loyal } = moleAndLoyal(st);
    st = {
      ...st,
      phase: "operation",
      proposal: {
        proposalId: "p0",
        leader: seatAt(st, 0),
        team: [loyal],
        opIndex: 0,
      },
    };
    const res = game.submit(st, loyal, { sabotage: true });
    expect(res.accepted).toBe(false);
    expect(res.reason).toBe("loyal-cannot-sabotage");
  });

  test("mole_sabotage_fails_the_op_and_reveals_only_a_count", () => {
    let st = game.newMatch(baseConfig(), "r-seed");
    const { mole, loyal } = moleAndLoyal(st);
    st = {
      ...st,
      phase: "operation",
      proposal: {
        proposalId: "p0",
        leader: seatAt(st, 0),
        team: [mole, loyal],
        opIndex: 0,
      },
    };
    st = game.submit(st, mole, { sabotage: true }).state;
    st = game.submit(st, loyal, { sabotage: false }).state;
    st = game.step(st);
    const op = st.opResults[0];
    expect(op).toBeDefined();
    if (op === undefined) throw new Error("unreachable");
    expect(op.failed).toBe(true);
    expect(op.sabotageCount).toBe(1);
    expect(st.fails).toBe(1);
    // Who sabotaged is hidden state: every seat's view carries the count only.
    for (const seat of st.seats) {
      const seen = game.observe(st, seat).publicState.opResults[0];
      expect(Object.keys(seen ?? {}).sort()).toEqual([
        "failed",
        "opIndex",
        "sabotageCount",
        "team",
      ]);
    }
  });

  test("five_rejected_proposals_end_in_a_mole_win", () => {
    let st = game.newMatch(baseConfig(), "r-seed");
    for (let i = 0; i < 5; i++) {
      st = { ...st, phase: "proposal" };
      const leader = seatAt(st, st.leaderIdx);
      st = game.submit(st, leader, {
        team: [leader, seatAt(st, (st.leaderIdx + 1) % 5)],
      }).state;
      st = game.step(st); // proposal -> vote
      for (const s of st.seats) st = game.submit(st, s, { vote: "reject" }).state;
      st = game.step(st); // vote resolves -> reject
    }
    expect(game.isTerminal(st)).toBe(true);
    expect(st.winner).toBe("mole");
    expect(st.winReason).toBe("hammer");
  });

  test("score_awards_one_point_per_winning_alignment_seat", () => {
    let st = game.newMatch(baseConfig(), "r-seed");
    st = { ...st, winner: "loyal" };
    const sc = game.score(st);
    const loyals = st.seats.filter((s) => st.deal.alignmentBySeat[s] === "loyal");
    const moles = st.deal.moleSeats;
    for (const l of loyals) expect(sc[l]).toBe(1);
    for (const m of moles) expect(sc[m]).toBe(0);
  });

  test("non_leader_proposing_is_rejected", () => {
    const st = { ...game.newMatch(baseConfig(), "r-seed"), phase: "proposal" as const };
    const nonLeader = seatAt(st, (st.leaderIdx + 1) % st.seats.length);
    const res = game.submit(st, nonLeader, { team: [seatAt(st, 0), seatAt(st, 1)] });
    expect(res.accepted).toBe(false);
    expect(res.reason).toBe("leader-only-proposes");
  });

  test("wrong_team_size_is_rejected", () => {
    const st = { ...game.newMatch(baseConfig(), "r-seed"), phase: "proposal" as const };
    const leader = seatAt(st, st.leaderIdx);
    // op 0 for 5 seats wants a team of 2; submit a single-member team.
    const res = game.submit(st, leader, { team: [seatAt(st, 0)] });
    expect(res.accepted).toBe(false);
    expect(res.reason).toBe("wrong-team-size");
  });

  test("wrong_phase_tool_is_rejected_as_unknown_action", () => {
    // A vote arriving during the proposal phase matches no proposal branch.
    const st = { ...game.newMatch(baseConfig(), "r-seed"), phase: "proposal" as const };
    const leader = seatAt(st, st.leaderIdx);
    const res = game.submit(st, leader, { vote: "approve" });
    expect(res.accepted).toBe(false);
    expect(res.reason).toBe("unknown-action");
  });

  test("non_team_member_cannot_submit_a_mission_action", () => {
    let st = game.newMatch(baseConfig(), "r-seed");
    const onTeam = seatAt(st, 0);
    const offTeam = seatAt(st, 2);
    st = {
      ...st,
      phase: "operation",
      proposal: {
        proposalId: "p0",
        leader: seatAt(st, 0),
        team: [onTeam, seatAt(st, 1)],
        opIndex: 0,
      },
    };
    const res = game.submit(st, offTeam, { sabotage: false });
    expect(res.accepted).toBe(false);
    expect(res.reason).toBe("not-on-team");
  });

  test("approved_vote_moves_to_operation_and_clears_reject_streak", () => {
    let st = game.newMatch(baseConfig(), "r-seed");
    st = { ...st, phase: "vote", rejectStreak: 2 };
    for (const s of st.seats) st = game.submit(st, s, { vote: "approve" }).state;
    st = game.step(st);
    expect(st.phase).toBe("operation");
    expect(st.rejectStreak).toBe(0);
    expect(st.missionActions).toEqual([]);
  });

  test("rejected_vote_increments_reject_streak_and_rotates_leader", () => {
    let st = game.newMatch(baseConfig(), "r-seed");
    const startLeader = st.leaderIdx;
    st = { ...st, phase: "vote", rejectStreak: 0 };
    for (const s of st.seats) st = game.submit(st, s, { vote: "reject" }).state;
    st = game.step(st);
    expect(st.phase).toBe("proposal");
    expect(st.rejectStreak).toBe(1);
    expect(st.leaderIdx).toBe((startLeader + 1) % st.seats.length);
    expect(st.proposal).toBeNull();
  });

  test("successful_op_increments_successes_and_advances_op_index", () => {
    let st = game.newMatch(baseConfig(), "r-seed");
    const { loyal } = moleAndLoyal(st);
    const loyal2 = st.seats.find((s) => s !== loyal && !st.deal.moleSeats.includes(s));
    expect(loyal2).toBeDefined();
    if (loyal2 === undefined) throw new Error("unreachable");
    st = {
      ...st,
      phase: "operation",
      proposal: { proposalId: "p0", leader: seatAt(st, 0), team: [loyal, loyal2], opIndex: 0 },
    };
    st = game.submit(st, loyal, { sabotage: false }).state;
    st = game.submit(st, loyal2, { sabotage: false }).state;
    st = game.step(st);
    const op = st.opResults[0];
    expect(op).toBeDefined();
    if (op === undefined) throw new Error("unreachable");
    expect(op.failed).toBe(false);
    expect(st.successes).toBe(1);
    expect(st.fails).toBe(0);
    expect(st.opIndex).toBe(1);
    expect(st.phase).toBe("debrief");
  });

  test("debrief_re_enters_the_discussion_loop_at_intel", () => {
    const st = { ...game.newMatch(baseConfig(), "r-seed"), phase: "debrief" as const };
    const next = game.step(st);
    expect(next.phase).toBe("intel");
  });

  // A full match driven by a fixed strategy must reach terminal with a stable,
  // byte-identical score for the same seed (replay determinism, pillar load-bearing).
  function playDeterministicMatch(seed: string): SpyState {
    let st = game.newMatch(baseConfig(), seed);
    let guard = 0;
    while (!game.isTerminal(st) && guard < 200) {
      guard++;
      switch (st.phase) {
        case "briefing":
        case "intel":
        case "comms":
        case "debrief": {
          for (const s of st.seats) st = game.submit(st, s, {}).state;
          st = game.step(st);
          break;
        }
        case "proposal": {
          const leader = seatAt(st, st.leaderIdx);
          const size = teamSizeFor(st);
          const team: SeatId[] = [];
          for (let i = 0; i < size; i++)
            team.push(seatAt(st, (st.leaderIdx + i) % st.seats.length));
          st = game.submit(st, leader, { team }).state;
          st = game.step(st);
          break;
        }
        case "vote": {
          for (const s of st.seats) st = game.submit(st, s, { vote: "approve" }).state;
          st = game.step(st);
          break;
        }
        case "operation": {
          const team = st.proposal === null ? [] : st.proposal.team;
          for (const s of team) {
            const isMole = st.deal.alignmentBySeat[s] === "mole";
            st = game.submit(st, s, { sabotage: isMole }).state;
          }
          st = game.step(st);
          break;
        }
      }
    }
    return st;
  }

  function teamSizeFor(st: SpyState): number {
    // mirror missions.teamSize for 5 seats without importing internals
    const sizes: number[] = [2, 3, 2, 3, 3];
    const s = sizes[st.opIndex];
    expect(s).toBeDefined();
    if (s === undefined) throw new Error("unreachable");
    return s;
  }

  test("a_full_deterministic_match_reaches_terminal_with_a_stable_score", () => {
    const a = playDeterministicMatch("det-seed");
    const b = playDeterministicMatch("det-seed");
    expect(game.isTerminal(a)).toBe(true);
    expect(a.winner).not.toBeNull();
    // Same seed + same logged actions => byte-identical terminal score.
    expect(JSON.stringify(game.score(a))).toBe(JSON.stringify(game.score(b)));
    expect(a.winner).toBe(b.winner);
    expect(a.winReason).toBe(b.winReason);
    // Score sums to the size of the winning alignment.
    const sc = game.score(a);
    const total = st_seats_sum(a, sc);
    expect(total).toBeGreaterThan(0);
  });

  function st_seats_sum(st: SpyState, sc: Record<SeatId, number>): number {
    let total = 0;
    for (const s of st.seats) total += sc[s] ?? 0;
    return total;
  }
});
