import { createInterface } from "node:readline";
import { type MatchConfig, parseJsonl } from "@benchboss/core";
import type { GameResult, SpectatorView, SubmissionIdentity } from "@benchboss/protocol";
import { verifyPluginReplay } from "@benchboss/referee";
import type { MatchSpec } from "./games";
import type { GameRegistry } from "./registry";
import {
  type MatchAbortion,
  type MatchArtifact,
  type NextEnvelope,
  type OpsMatch,
  type SubmitResult,
  createMatchRunner,
  monotonicEpochMs,
} from "./runner";

export type WorkerCommand =
  | { kind: "start"; spec: MatchSpec; at?: number }
  | { kind: "reap"; at?: number }
  | {
      kind: "submit";
      at?: number;
      principalId: string;
      matchId: string;
      tool: string;
      input: unknown;
      identity?: SubmissionIdentity;
    }
  | {
      kind: "verify";
      config: MatchConfig;
      seed: string;
      jsonl: string;
      publishedResult?: GameResult | null;
    };
export interface WorkerSnapshot {
  inspection: OpsMatch;
  view: SpectatorView | null;
  turns: Record<string, NextEnvelope>;
  artifact?: MatchArtifact;
  abortion?: MatchAbortion;
}
export interface WorkerReply {
  snapshot: WorkerSnapshot;
  result?: SubmitResult;
}

// Invoked only in the child entry point. The parent owns all durable side effects.
export async function runMatchWorker(registry: GameRegistry): Promise<void> {
  let spec: MatchSpec | undefined;
  let sampledAt = monotonicEpochMs();
  let artifact: MatchArtifact | undefined;
  let abortion: MatchAbortion | undefined;
  const runner = createMatchRunner({
    registry,
    maxHoldMs: 0,
    now: () => sampledAt,
    persist: async (value) => {
      artifact = value;
    },
    persistAborted: async (value) => {
      abortion = value;
    },
  });
  for await (const line of createInterface({ input: process.stdin })) {
    let id: unknown;
    try {
      const request = JSON.parse(line) as { id: number; payload: WorkerCommand };
      id = request.id;
      if (!Number.isSafeInteger(id)) throw Error("invalid worker request");
      const command = request.payload;
      if (command.kind !== "verify") sampledAt = command.at ?? monotonicEpochMs();
      let value: unknown;
      if (command.kind === "verify") {
        const plugin = registry.resolve(command.config);
        value = verifyPluginReplay({
          plugin,
          config: command.config,
          seed: command.seed,
          log: parseJsonl(command.jsonl),
          publishedResult: command.publishedResult,
        });
      } else {
        let result: SubmitResult | undefined;
        if (command.kind === "start") {
          if (spec) throw Error("worker already assigned");
          spec = command.spec;
          runner.start(spec);
        } else if (command.kind === "reap") await runner.reap();
        else if (command.kind === "submit")
          result = await runner.submit(
            command.principalId,
            command.matchId,
            command.tool,
            command.input,
            command.identity,
          );
        else throw Error("unknown worker command");
        if (!spec) throw Error("worker is unassigned");
        const inspection = runner.inspect()[0];
        if (!inspection) throw Error("missing worker state");
        const turns: Record<string, NextEnvelope> = {};
        if (!inspection.over)
          for (const seat of spec.assignments)
            turns[seat.principalId] = runner.poll(seat.principalId, { acknowledge: false });
        value = {
          result,
          snapshot: { inspection, view: runner.view(spec.matchId), turns, artifact, abortion },
        } satisfies WorkerReply;
      }
      process.stdout.write(`${JSON.stringify({ id, ok: true, value })}\n`);
    } catch {
      process.stdout.write(`${JSON.stringify({ id, ok: false })}\n`);
    }
  }
}
