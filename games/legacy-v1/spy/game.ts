// Frozen protocol v1 / game revision 1.0.0. Preserve for historical replay.
import {
  type GameModule,
  type LegalActionSpec,
  type MatchConfig,
  type SeatId,
  type SubmitResult,
  createRng,
} from "@benchboss/core";
import { failThreshold, nextTeamSize, teamSize } from "./missions";
import { dealRoles, dealRolesM3 } from "./roles";
import {
  type SpyAction,
  assassinateInputSchema,
  auditStatementInputSchema,
  counterIntelInputSchema,
  missionActionInputSchema,
  plantMisinfoInputSchema,
  proposeTeamInputSchema,
  protectSourceInputSchema,
  scanAlignmentInputSchema,
  speechActInputSchema,
  submitPhaseEndInputSchema,
  traceOperationInputSchema,
  voteInputSchema,
} from "./schemas";
import type { Role, SpeechActRecord, SpyObservation, SpyPhase, SpyState } from "./types";
import { evaluateWin } from "./win";

export const SPY_GAME_ID = "safehouse-protocol";
const TOOL_DESCRIPTIONS: Record<string, string> = {
  "comms.send": "Publish a structured statement to all agents.",
  "match.propose_team": "Select the required number of unique agents for this operation.",
  "match.vote": "Privately approve or reject the proposed team.",
  "match.mission_action": "Privately support the operation or sabotage it if you are a mole.",
  "match.submit_phase_end": "Finish your participation in this phase.",
  "intel.scan_alignment": "Spend intelligence to privately scan an agent's alignment.",
  "intel.audit_statement": "Spend intelligence to privately audit a public statement.",
  "intel.trace_operation": "Spend intelligence to investigate sabotage in a completed operation.",
  "intel.plant_misinfo": "Plant misinformation on a target as a mole.",
  "intel.counterintel": "Use mole counterintelligence.",
  "intel.protect_source": "Protect a mole source from tracing.",
  "match.assassinate": "Choose the agent you believe is the Handler.",
};

const SCHEMA_BY_TOOL: Record<string, Record<string, unknown>> = {
  "comms.send": speechActInputSchema,
  "match.propose_team": proposeTeamInputSchema,
  "match.vote": voteInputSchema,
  "match.mission_action": missionActionInputSchema,
  "match.submit_phase_end": submitPhaseEndInputSchema,
  "intel.scan_alignment": scanAlignmentInputSchema,
  "intel.audit_statement": auditStatementInputSchema,
  "intel.trace_operation": traceOperationInputSchema,
  "intel.plant_misinfo": plantMisinfoInputSchema,
  "intel.counterintel": counterIntelInputSchema,
  "intel.protect_source": protectSourceInputSchema,
  "match.assassinate": assassinateInputSchema,
};

// Phase -> legal tool names. Re-exported via phases.ts as SPY_PHASE_TOOLS.
export const PHASE_TOOLS: Record<SpyPhase, string[]> = {
  briefing: ["match.submit_phase_end"],
  intel: [
    "intel.scan_alignment",
    "intel.audit_statement",
    "intel.trace_operation",
    "intel.plant_misinfo",
    "intel.counterintel",
    "intel.protect_source",
    "match.submit_phase_end",
  ],
  comms: ["comms.send", "match.submit_phase_end"],
  proposal: ["match.propose_team"],
  vote: ["match.vote"],
  operation: ["match.mission_action"],
  debrief: ["match.submit_phase_end"],
  assassinate: ["match.assassinate"],
};

function leaderSeat(state: SpyState): SeatId {
  const leader = state.seats[state.leaderIdx];
  if (leader === undefined) {
    throw new Error(`invalid leaderIdx ${state.leaderIdx} for ${state.seats.length} seats`);
  }
  return leader;
}

// True once `seat` has made its decision for the current phase: no legal action remains,
// the runner arms no clock, and a repeat submit is rejected rather than overwriting.
const MOLE_ONLY_TOOLS = ["intel.plant_misinfo", "intel.counterintel", "intel.protect_source"];

function hasDecided(state: SpyState, seat: SeatId): boolean {
  switch (state.phase) {
    case "briefing":
    case "intel":
    case "comms":
    case "debrief":
      return state.phaseEnded[seat] === true;
    case "vote":
      return state.votes[seat] !== undefined;
    case "operation":
      return state.missionActions.some((m) => m.seat === seat);
    default:
      return false;
  }
}

function roleOf(state: SpyState, seat: SeatId): Role {
  const role = state.deal.roleBySeat[seat];
  if (role === undefined) throw new Error(`no role for seat ${seat}`);
  return role;
}

export function makeSpyGame(): GameModule<SpyState, SpyAction, SpyObservation, number> {
  return {
    id: SPY_GAME_ID,

    newMatch(config: MatchConfig, seed: string): SpyState {
      const rng = createRng(seed);
      const seats = config.seats;
      const deal = (config.rules.handler === true ? dealRolesM3 : dealRoles)(seats, rng);
      return {
        matchId: config.matchId,
        seats,
        deal,
        phase: "briefing",
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
        intelResults: Object.fromEntries(seats.map((s) => [s, []])),
        commsCountThisRound: Object.fromEntries(seats.map((s) => [s, 0])),
        phaseEnded: Object.fromEntries(seats.map((s) => [s, false])),
        winner: null,
        winReason: "",
        nextActSeq: 0,
        assassinGuess: null,
        misinfoFlags: {},
        protectedSources: [],
      };
    },

    observe(state: SpyState, seat: SeatId): SpyObservation {
      const ownRole = roleOf(state, seat);
      const isMole = state.deal.alignmentBySeat[seat] === "mole";
      const ownIntel = state.intelResults[seat] ?? [];
      // Partial envelope (sensing addendum): the server injects legalTools +
      // budgets from its phase machine + budget book at observe().
      return {
        matchId: state.matchId,
        phase: state.phase,
        seat,
        publicState: {
          seats: [...state.seats],
          round: state.round,
          opIndex: state.opIndex,
          leader: leaderSeat(state),
          teamSize: nextTeamSize(state.seats.length, state.opIndex),
          successes: state.successes,
          fails: state.fails,
          rejectStreak: state.rejectStreak,
          proposal: state.proposal
            ? {
                team: [...state.proposal.team],
                proposalId: state.proposal.proposalId,
              }
            : null,
          // Sabotage COUNT only — never which member sabotaged.
          opResults: state.opResults.map((o) => ({
            opIndex: o.opIndex,
            sabotageCount: o.sabotageCount,
            failed: o.failed,
            team: [...o.team],
          })),
          log: state.log.map((e) => ({ ...e })),
        },
        privateState: {
          ownRole,
          // Per-seat knowledge: Moles see all moles (incl. self); Handler sees moles minus Deep Cover; plain Loyal sees [].
          knownMoles: state.deal.knownMolesBySeat[seat] ?? [],
          ownIntel: [...ownIntel],
        },
      };
    },

    legalActions(state: SpyState, seat: SeatId): LegalActionSpec[] {
      if (state.winner !== null || !state.seats.includes(seat)) return [];
      if (hasDecided(state, seat)) return [];
      let tools = PHASE_TOOLS[state.phase] ?? [];
      if (state.phase === "proposal" && seat !== leaderSeat(state)) {
        tools = []; // leader-only-proposes
      }
      if (state.phase === "operation" && (!state.proposal || !state.proposal.team.includes(seat))) {
        tools = []; // only team members act
      }
      if (state.phase === "assassinate" && state.deal.alignmentBySeat[seat] !== "mole") {
        tools = []; // only moles assassinate
      }
      if (state.deal.alignmentBySeat[seat] !== "mole") {
        tools = tools.filter((t) => !MOLE_ONLY_TOOLS.includes(t));
      }
      return tools.flatMap((tool) => {
        const jsonSchema = SCHEMA_BY_TOOL[tool];
        if (jsonSchema === undefined) return [];
        return [
          { tool, phase: state.phase, description: TOOL_DESCRIPTIONS[tool] ?? tool, jsonSchema },
        ];
      });
    },

    submit(
      state: SpyState,
      seat: SeatId,
      action: SpyAction,
      tool?: string,
    ): SubmitResult<SpyState> {
      const reject = (reason: string): SubmitResult<SpyState> => ({
        accepted: false,
        reason,
        state,
      });
      // The raw schema-validated tool input arrives WITHOUT a synthetic `kind`
      // discriminant (step()'s callTool -> pm.collect passes the bare object).
      // Route on state.phase + the input's own fields. An empty object in a
      // discussion phase is a match.submit_phase_end.
      const a = action as Record<string, unknown>;
      const isPhaseEnd = tool
        ? tool === "match.submit_phase_end"
        : !("act" in a) &&
          !("team" in a) &&
          !("vote" in a) &&
          !("sabotage" in a) &&
          !("target" in a);

      const phaseEnd = (): SubmitResult<SpyState> => ({
        accepted: true,
        reason: "ok",
        committedActionId: `end:${seat}:${state.phase}`,
        state: { ...state, phaseEnded: { ...state.phaseEnded, [seat]: true } },
      });

      switch (state.phase) {
        case "briefing":
        case "intel":
        case "debrief": {
          if (isPhaseEnd) return phaseEnd();
          return reject("unknown-action");
        }
        case "comms": {
          if (isPhaseEnd) return phaseEnd();
          if (state.phaseEnded[seat]) return reject("phase-already-ended");
          if (!("act" in a)) return reject("unknown-action");
          const seq = state.nextActSeq;
          const actId = `act:${seq}`;
          const rec: SpeechActRecord = {
            actId,
            seat,
            seq,
            act: a.act as string,
            subject: (a.subject as SeatId | null | undefined) ?? null,
            target: (a.target as SeatId | null | undefined) ?? null,
            roleClaim: (a.roleClaim as SpeechActRecord["roleClaim"] | undefined) ?? null,
            allegiance: (a.allegiance as SpeechActRecord["allegiance"] | undefined) ?? null,
            confidence: (a.confidence as number | null | undefined) ?? null,
            evidenceRef: (a.evidenceRef as string | null | undefined) ?? null,
          };
          return {
            accepted: true,
            reason: "ok",
            committedActionId: actId,
            state: {
              ...state,
              log: [...state.log, rec],
              nextActSeq: seq + 1,
              commsCountThisRound: {
                ...state.commsCountThisRound,
                [seat]: (state.commsCountThisRound[seat] ?? 0) + 1,
              },
            },
          };
        }
        case "proposal": {
          if (!("team" in a)) return reject("unknown-action");
          if (seat !== state.seats[state.leaderIdx]) return reject("leader-only-proposes");
          const team = a.team as SeatId[];
          const want = teamSize(state.seats.length, state.opIndex);
          if (team.length !== want) return reject("wrong-team-size");
          const unique = new Set(team);
          if (unique.size !== team.length) return reject("duplicate-team-member");
          if (team.some((s) => !state.seats.includes(s))) return reject("unknown-seat");
          const proposalId = `prop:${state.opIndex}:${state.rejectStreak}`;
          return {
            accepted: true,
            reason: "ok",
            committedActionId: proposalId,
            state: {
              ...state,
              proposal: { proposalId, leader: seat, team: [...team], opIndex: state.opIndex },
            },
          };
        }
        case "vote": {
          if (!("vote" in a)) return reject("unknown-action");
          if (state.votes[seat] !== undefined) return reject("already-voted");
          return {
            accepted: true,
            reason: "ok",
            committedActionId: `vote:${seat}`,
            state: { ...state, votes: { ...state.votes, [seat]: a.vote as "approve" | "reject" } },
          };
        }
        case "operation": {
          if (!("sabotage" in a)) return reject("unknown-action");
          if (!state.proposal || !state.proposal.team.includes(seat)) return reject("not-on-team");
          if (state.missionActions.some((m) => m.seat === seat)) return reject("already-acted");
          const sabotage = a.sabotage as boolean;
          if (sabotage && state.deal.alignmentBySeat[seat] === "loyal") {
            return reject("loyal-cannot-sabotage");
          }
          return {
            accepted: true,
            reason: "ok",
            committedActionId: `mission:${seat}`,
            state: { ...state, missionActions: [...state.missionActions, { seat, sabotage }] },
          };
        }
        case "assassinate": {
          if (!("target" in a)) return reject("unknown-action");
          if (state.deal.alignmentBySeat[seat] !== "mole") return reject("only-moles-assassinate");
          return {
            accepted: true,
            reason: "ok",
            committedActionId: `assassinate:${seat}`,
            state: { ...state, assassinGuess: a.target as SeatId },
          };
        }
        default:
          return reject("unknown-action");
      }
    },

    step(state: SpyState): SpyState {
      const order: SpyPhase[] = [
        "briefing",
        "intel",
        "comms",
        "proposal",
        "vote",
        "operation",
        "debrief",
      ];
      const resetPerRound = (s: SpyState): SpyState => ({
        ...s,
        phaseEnded: Object.fromEntries(s.seats.map((seat) => [seat, false])) as Record<
          SeatId,
          boolean
        >,
        commsCountThisRound: Object.fromEntries(s.seats.map((seat) => [seat, 0])) as Record<
          SeatId,
          number
        >,
      });

      if (state.phase === "vote") {
        const approvals = state.seats.filter((s) => state.votes[s] === "approve").length;
        const approved = approvals * 2 > state.seats.length;
        if (!approved) {
          const next: SpyState = {
            ...resetPerRound(state),
            phase: "proposal",
            proposal: null,
            votes: {},
            leaderIdx: (state.leaderIdx + 1) % state.seats.length,
            rejectStreak: state.rejectStreak + 1,
            round: state.round + 1,
          };
          const win = evaluateWin(next);
          return win.over ? { ...next, winner: win.winner, winReason: win.reason } : next;
        }
        return { ...state, phase: "operation", votes: {}, rejectStreak: 0, missionActions: [] };
      }

      if (state.phase === "assassinate" && state.assassinGuess !== null) {
        const win = evaluateWin(state);
        return { ...state, winner: win.winner, winReason: win.reason };
      }

      if (state.phase === "operation") {
        const sabotageCount = state.missionActions.filter((m) => m.sabotage).length;
        const failed = sabotageCount >= failThreshold(state.seats.length, state.opIndex);
        const team = state.proposal ? [...state.proposal.team] : [];
        const saboteurs = team.filter((s) =>
          state.missionActions.some((m) => m.seat === s && m.sabotage),
        );
        const untraceable = saboteurs.filter((s) => state.protectedSources.includes(s));
        // Operation resolves INTO debrief, which then re-enters the discussion
        // loop (debrief -> intel -> comms -> proposal). This keeps the typed-
        // speech-act (pillar A) and budgeted-intel (pillar B) windows recurring
        // every op cycle — not just round 1.
        const next: SpyState = {
          ...resetPerRound(state),
          phase: "debrief",
          proposal: null,
          missionActions: [],
          protectedSources: state.protectedSources.filter((s) => !saboteurs.includes(s)),
          opResults: [
            ...state.opResults,
            { opIndex: state.opIndex, team, sabotageCount, failed, saboteurs, untraceable },
          ],
          successes: state.successes + (failed ? 0 : 1),
          fails: state.fails + (failed ? 1 : 0),
          opIndex: state.opIndex + 1,
          leaderIdx: (state.leaderIdx + 1) % state.seats.length,
          round: state.round + 1,
        };
        const win = evaluateWin(next);
        if (win.over) return { ...next, winner: win.winner, winReason: win.reason };
        if (next.successes >= 3 && next.deal.handlerSeat !== null) {
          return { ...next, phase: "assassinate" };
        }
        return next;
      }

      const idx = order.indexOf(state.phase);
      const nextPhase = order[(idx + 1) % order.length];
      const advanced: SpyState = { ...resetPerRound(state), phase: nextPhase ?? "briefing" };
      // debrief re-enters the discussion loop at intel (then comms -> proposal),
      // so intel/comms recur every op cycle.
      if (state.phase === "debrief") return { ...advanced, phase: "intel" };
      return advanced;
    },

    isTerminal(state: SpyState): boolean {
      return state.winner !== null;
    },

    score(state: SpyState): Record<SeatId, number> {
      const out: Record<SeatId, number> = {};
      for (const s of state.seats) {
        out[s] = state.winner !== null && state.deal.alignmentBySeat[s] === state.winner ? 1 : 0;
      }
      return out;
    },
  };
}
