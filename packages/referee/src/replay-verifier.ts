import { type LogEvent, type MatchConfig, validateMatchConfig } from "@benchboss/core";
import type { GameResult } from "@benchboss/protocol";
import type { GamePlugin } from "./game-plugin";
import type { Command, SessionOptions } from "./match-server";
import { canonical, newSession, step } from "./match-server";

interface Verification {
  ok: boolean;
  divergenceSeq?: number;
  detail?: string;
}
function parseCommand(payload: Record<string, unknown>): Command | null {
  const keys = Object.keys(payload).sort().join(",");
  if (
    payload.kind === "advanceTime" &&
    keys === "at,kind" &&
    Number.isSafeInteger(payload.at) &&
    (payload.at as number) >= 0
  )
    return payload as unknown as Command;
  if (payload.kind === "commitDefault" && keys === "kind,seat" && typeof payload.seat === "string")
    return payload as unknown as Command;
  if (
    payload.kind === "callTool" &&
    keys === "input,kind,seat,tool" &&
    typeof payload.seat === "string" &&
    typeof payload.tool === "string"
  )
    return payload as unknown as Command;
  return null;
}
export function verifySessionReplay<State>(args: {
  options: SessionOptions<State>;
  log: readonly LogEvent[];
  publishedResult?: GameResult | null;
}): Verification {
  const { options, log } = args;
  let activeSeq = 0;
  try {
    if (
      log.at(-1)?.kind !== "match.terminal" ||
      log.filter((event) => event.kind === "match.terminal").length !== 1
    )
      return { ok: false, detail: "expected exactly one terminal event at the end" };
    let session = newSession(options);
    for (const event of log) {
      activeSeq = event.seq;
      if (event.kind !== "command") continue;
      const command = parseCommand(event.payload);
      if (!command)
        return { ok: false, divergenceSeq: activeSeq, detail: "unknown or malformed command" };
      session = step(session, command).session;
    }
    const length = Math.max(log.length, session.log.length);
    for (let index = 0; index < length; index++) {
      if (canonical(log[index]) !== canonical(session.log[index]))
        return { ok: false, divergenceSeq: index, detail: "regenerated log differs" };
    }
    if (
      args.publishedResult !== undefined &&
      canonical(options.publicView?.(session.state).result) !== canonical(args.publishedResult)
    )
      return { ok: false, divergenceSeq: log.length - 1, detail: "published outcome mismatch" };
    return { ok: true };
  } catch {
    return {
      ok: false,
      divergenceSeq: activeSeq,
      detail: "malformed replay data or game execution failure",
    };
  }
}
export function verifyPluginReplay<State>(args: {
  plugin: GamePlugin<State>;
  config: MatchConfig;
  seed: string;
  log: readonly LogEvent[];
  publishedResult?: GameResult | null;
}): Verification {
  const { plugin, config, seed, log, publishedResult } = args;
  const validation = validateMatchConfig(config, {
    gameId: plugin.id,
    manifest: plugin.manifest,
    hasHostEventHandler: typeof plugin.onHostEvent === "function",
  });
  if (!validation.ok) return { ok: false, detail: validation.reason };
  return verifySessionReplay({
    options: {
      game: plugin.makeGame(),
      config,
      seed,
      publicView: plugin.publicView,
      phaseToTools: plugin.phaseToTools,
      currentPhase: plugin.currentPhase,
      isReady: plugin.isReady,
      defaultAction: plugin.safeDefault,
      senseResolvers: plugin.senseResolvers?.(seed),
      participation: plugin.participation,
      onHostEvent: plugin.onHostEvent,
    },
    log,
    ...(publishedResult !== undefined ? { publishedResult } : {}),
  });
}
