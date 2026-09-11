import { type MatchConfig, type Rng, type SeatId, createRng, mkSeatId } from "@benchboss/core";
import { type ActionInvocation, validateSchema } from "@benchboss/protocol";
import type { GamePlugin } from "./game-plugin";
import {
  clockSnapshot,
  isTerminal,
  newSession,
  publicFrames,
  sessionLog,
  step,
} from "./match-server";
import { verifyPluginReplay } from "./replay-verifier";

export interface ConformanceOptions<State> {
  seeds: readonly string[];
  rules?: readonly Record<string, unknown>[];
  maxCommands?: number;
  choose?: (state: State, seat: SeatId, rng: Rng) => ActionInvocation;
}
export interface ConformanceReport {
  seed: string;
  seatCount: number;
  ruleCase: number;
  ok: boolean;
  detail?: string;
}

// Executable acceptance contract, independent of any test framework or catalog.
// Callers supply generated legal actions when they want paths beyond defaults.
export function checkGameConformance<State>(
  plugin: GamePlugin<State>,
  options: ConformanceOptions<State>,
): ConformanceReport[] {
  const reports: ConformanceReport[] = [];
  const assertConformance = (condition: unknown, message: string) => {
    if (!condition) throw Error(message);
  };
  assertConformance(options.seeds.length > 0, "at least one seed is required");
  const maxCommands = options.maxCommands ?? 1000;
  assertConformance(Number.isSafeInteger(maxCommands) && maxCommands > 0, "invalid command bound");
  const rules = options.rules ?? [plugin.manifest.defaultRules];
  assertConformance(
    rules.length > 0 && plugin.manifest.seatCounts.length > 0,
    "empty conformance matrix",
  );
  for (const seed of options.seeds)
    for (const seatCount of plugin.manifest.seatCounts)
      for (const [ruleCase, rule] of rules.entries()) {
        const report: ConformanceReport = { seed, seatCount, ruleCase, ok: false };
        try {
          assertConformance(
            validateSchema(plugin.manifest.rulesSchema, rule).ok,
            "invalid rule case",
          );
          const base = {
            matchId: "conformance",
            gameId: plugin.id,
            seats: Array.from({ length: seatCount }, (_, i) => mkSeatId(i)),
            rules: structuredClone(rule),
          };
          const config: MatchConfig =
            plugin.manifest.protocolVersion === 2
              ? {
                  ...base,
                  identity: {
                    protocolVersion: 2,
                    runtimeVersion: "0.2.0",
                    gameId: plugin.id,
                    revision: plugin.manifest.revision,
                  },
                  timing: structuredClone(plugin.manifest.defaultTiming),
                  resources: structuredClone(plugin.manifest.defaultResources),
                  metering: structuredClone(plugin.manifest.defaultMetering),
                }
              : {
                  ...base,
                  identity: {
                    protocolVersion: 1,
                    runtimeVersion: "0.1.0",
                    gameId: plugin.id,
                    revision: plugin.manifest.revision,
                  },
                  budgets: structuredClone(plugin.manifest.defaultBudgets),
                };
          const run = () => {
            const game = plugin.makeGame();
            let session = newSession({
              game,
              config: structuredClone(config),
              seed,
              publicView: plugin.publicView,
              phaseToTools: plugin.phaseToTools,
              currentPhase: plugin.currentPhase,
              isReady: plugin.isReady,
              safeDefault: (state, seat) => plugin.safeDefault(state, seat).input,
              defaultAction: plugin.safeDefault,
              senseResolvers: plugin.senseResolvers?.(seed),
              participation: plugin.participation,
              onHostEvent: plugin.onHostEvent,
            });
            if (config.identity?.protocolVersion === 2)
              session = step(session, { kind: "advanceTime", at: 0 }).session;
            const rng = createRng(`actions:${seed}`);
            let commands = 0;
            while (!isTerminal(session)) {
              let progressed = false;
              for (const seat of rng.shuffle([...config.seats])) {
                if (isTerminal(session)) break;
                const offers = game.legalActions(session.state, seat);
                if (!offers.some((offer) => !session.senseResolvers.has(offer.tool))) continue;
                assertConformance(++commands <= maxCommands, "game exceeded command bound");
                const fallback = plugin.safeDefault(structuredClone(session.state), seat);
                assertConformance(
                  offers.some(
                    (offer) =>
                      offer.tool === fallback.tool &&
                      !session.senseResolvers.has(offer.tool) &&
                      validateSchema(offer.jsonSchema, fallback.input).ok,
                  ),
                  "safe default does not match a legal action",
                );
                const before = JSON.stringify(session);
                const invalid = step(session, {
                  kind: "callTool",
                  seat: mkSeatId(seatCount + 1),
                  tool: fallback.tool,
                  input: fallback.input,
                });
                assertConformance(
                  !invalid.output.ok && JSON.stringify(invalid.session) === before,
                  "unknown seat changed execution or budgets",
                );
                const action =
                  options.choose?.(structuredClone(session.state), seat, rng) ?? fallback;
                const advanced = options.choose
                  ? step(session, { kind: "callTool", seat, ...action })
                  : step(session, { kind: "commitDefault", seat });
                assertConformance(
                  advanced.output.ok,
                  `legal scenario/default rejected: ${advanced.output.reason}`,
                );
                session = advanced.session;
                progressed = true;
              }
              if (!progressed && config.identity?.protocolVersion === 2) {
                const deadlines = config.seats.flatMap((seat) => {
                  const clock = clockSnapshot(session, seat);
                  return [clock?.deadline, clock?.phaseDeadline].filter(
                    (value): value is number => value !== null && value !== undefined,
                  );
                });
                if (deadlines.length) {
                  assertConformance(++commands <= maxCommands, "game exceeded command bound");
                  session = step(session, {
                    kind: "advanceTime",
                    at: Math.min(...deadlines),
                  }).session;
                  progressed = true;
                }
              }
              assertConformance(progressed, "nonterminal game has no actionable seats or deadline");
            }
            const outcome = plugin.publicView(session.state).result;
            assertConformance(
              outcome &&
                outcome.seats.length === seatCount &&
                new Set(outcome.seats.map((s) => s.seat)).size === seatCount &&
                outcome.seats.every(
                  (s) =>
                    config.seats.includes(s.seat as SeatId) &&
                    ["win", "loss", "draw"].includes(s.outcome) &&
                    Number.isSafeInteger(s.placement) &&
                    s.placement >= 1,
                ),
              "invalid terminal outcomes",
            );
            const scores = game.score(session.state) as Record<string, number>;
            assertConformance(
              Object.keys(scores).length === seatCount &&
                config.seats.every((s) => Number.isFinite(scores[s])),
              "invalid terminal scores",
            );
            const log = sessionLog(session);
            const verification = verifyPluginReplay({
              plugin,
              config,
              seed,
              log,
            });
            assertConformance(verification.ok, `replay failed: ${verification.detail}`);
            assertConformance(
              !verifyPluginReplay({ plugin, config, seed, log: log.slice(0, -1) }).ok,
              "truncated replay accepted",
            );
            return JSON.stringify({ log, frames: publicFrames(session) });
          };
          const original = run();
          const repeated = run();
          assertConformance(
            original === repeated,
            "same seed/actions produced different logs or public frames",
          );
          report.ok = true;
        } catch (error) {
          report.detail = error instanceof Error ? error.message : "game threw";
        }
        reports.push(report);
      }
  return reports;
}
