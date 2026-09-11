import type { GameModule, Phase, PhaseMachine, SeatId, SubmitResult } from "./types";

export function createPhaseMachine<State>(
  // biome-ignore lint/suspicious/noExplicitAny: GameModule is covariant here; the machine is Action/Observation/Score-agnostic
  game: GameModule<State, any, any, any>,
  phaseToTools: Record<Phase, string[]>,
  currentPhase: (s: State) => Phase,
  isReady: (s: State) => boolean,
): PhaseMachine<State> {
  const current = (state: State): Phase => currentPhase(state);
  const toolsLegalIn = (phase: Phase): string[] => phaseToTools[phase] ?? [];
  return {
    current,
    toolsLegalIn,
    collect(state: State, seat: SeatId, tool: string, input: unknown): SubmitResult<State> {
      const phase = current(state);
      if (!toolsLegalIn(phase).includes(tool)) {
        return { accepted: false, reason: `tool ${tool} not legal in phase ${phase}`, state };
      }
      return game.submit(state, seat, input, tool);
    },
    ready(state: State): boolean {
      return isReady(state);
    },
    resolve(state: State): State {
      return game.step(state);
    },
  };
}
