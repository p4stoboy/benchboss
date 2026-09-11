import { randomUUID } from "node:crypto";
import type { SubmissionIdentity } from "@benchboss/protocol";

export interface ClientTransport {
  request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown>;
}
export interface ClientDeps {
  transport: ClientTransport;
}
export interface BenchBossClient {
  enqueue(gameId: string): Promise<unknown>;
  next(): Promise<unknown>;
  submit(
    matchId: string,
    tool: string,
    input: unknown,
    identity?: SubmissionIdentity,
  ): Promise<unknown>;
}

export async function readJsonResponse(response: Response): Promise<unknown> {
  if (!response.ok)
    throw Object.assign(Error(`benchboss ${response.status}: ${await response.text()}`), {
      kind: "http_error" as const,
      status: response.status,
    });
  // Parse the bytes explicitly: some fetch implementations return null for an
  // interrupted empty body. An incomplete response must trigger identity-safe retry.
  return JSON.parse(await response.text()) as unknown;
}

// Convenience HTTP only. Hosts supply authentication through their own transport.
export function createHttpTransport(deps: {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}): ClientTransport {
  const baseUrl = deps.baseUrl.replace(/\/$/, "");
  const fetchImpl = deps.fetchImpl ?? fetch;
  return {
    async request(method, path, body) {
      return readJsonResponse(
        await fetchImpl(`${baseUrl}${path}`, {
          method,
          ...(body === undefined
            ? {}
            : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
        }),
      );
    },
  };
}

function isHttpError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "kind" in error && error.kind === "http_error"
  );
}

export function createBenchBossClient({ transport }: ClientDeps): BenchBossClient {
  const decisions = new Map<string, { id: string; generation: number }>();
  let lastMatchId: string | undefined;
  let generation = 0;
  let mutationEpoch = 0;
  function rememberDecision(matchId: string, result: unknown, observedAt: number): void {
    if (result && typeof result === "object" && "observation" in result) {
      const observation = result.observation;
      if (
        observation &&
        typeof observation === "object" &&
        "decisionId" in observation &&
        typeof observation.decisionId === "string"
      ) {
        decisions.set(matchId, { id: observation.decisionId, generation: observedAt });
      }
    }
  }
  return {
    enqueue: (gameId) => transport.request("POST", "/lobby/enqueue", { gameId }),
    async next() {
      const startedAt = ++generation;
      const epoch = mutationEpoch;
      const result = await transport.request(
        "POST",
        "/match/next",
        lastMatchId ? { matchId: lastMatchId } : {},
      );
      if (
        result &&
        typeof result === "object" &&
        "matchId" in result &&
        typeof result.matchId === "string"
      ) {
        if (
          "observation" in result &&
          (epoch !== mutationEpoch || (decisions.get(result.matchId)?.generation ?? 0) > startedAt)
        ) {
          throw Object.assign(Error("stale_observation: request the current decision again"), {
            kind: "stale_observation",
          });
        }
        rememberDecision(result.matchId, result, startedAt);
        if ("kind" in result && (result.kind === "match_over" || result.kind === "match_aborted")) {
          decisions.delete(result.matchId);
          if (lastMatchId === result.matchId) lastMatchId = undefined;
        } else lastMatchId = result.matchId;
      }
      return result;
    },
    async submit(matchId, tool, input, suppliedIdentity) {
      const current = decisions.get(matchId);
      const identity =
        suppliedIdentity ??
        (current ? { decisionId: current.id, requestId: randomUUID() } : undefined);
      const body = { matchId, tool, input, ...identity };
      mutationEpoch++;
      const send = () => transport.request("POST", "/match/submit", body);
      let result: unknown;
      try {
        result = await send();
      } catch (error) {
        // The transport supplies credentials for each attempt. Request identity
        // makes a lost-response retry safe without prescribing authentication.
        if (!identity || isHttpError(error)) throw error;
        result = await send();
      } finally {
        mutationEpoch++;
      }
      const latest = decisions.get(matchId);
      if (!identity || !latest || latest.id === identity.decisionId)
        rememberDecision(matchId, result, ++generation);
      return result;
    },
  };
}
