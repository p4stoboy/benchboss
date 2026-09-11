import { randomUUID } from "node:crypto";
import {
  SERVER_CAPABILITIES,
  type ServerCapabilities,
  type SubmissionIdentity,
  validateCapabilities,
  validateNextEnvelope,
  validateSubmitEnvelope,
} from "@benchboss/protocol";

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
  const observedDecisions = new Map<string, { id: string; generation: number }>();
  const inactive = new Set<string>();
  const waitingOffers = new Map<string, Set<string>>();
  const versionedMatches = new Set<string>();
  let capabilities: Promise<void> | undefined;
  async function validateResponse(
    result: unknown,
    kind: "next" | "submit",
    versioned = false,
  ): Promise<void> {
    const explicitVersion = result && typeof result === "object" && "protocolVersion" in result;
    if (!explicitVersion && !versioned) return;
    const verdict = kind === "next" ? validateNextEnvelope(result) : validateSubmitEnvelope(result);
    if (!verdict.ok)
      throw Object.assign(Error(`protocol_error: ${verdict.reason ?? "unsupported envelope"}`), {
        kind: "protocol_error",
      });
    capabilities ??= transport.request("GET", "/capabilities").then((value) => {
      if (!validateCapabilities(value).ok) throw Error("unsupported_capabilities");
      const supported = value as ServerCapabilities;
      if (
        !supported.supportedProtocolVersions.includes(2) ||
        SERVER_CAPABILITIES.features.some((feature) => !supported.features.includes(feature))
      )
        throw Error("unsupported_capabilities");
    });
    await capabilities;
  }
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
        observedDecisions.set(matchId, { id: observation.decisionId, generation: observedAt });
        waitingOffers.delete(matchId);
        if (
          "participation" in observation &&
          observation.participation &&
          typeof observation.participation === "object" &&
          "status" in observation.participation &&
          observation.participation.status !== "acting"
        ) {
          decisions.delete(matchId);
          inactive.add(matchId);
          if (
            observation.participation.status === "waiting" &&
            "legalTools" in observation &&
            Array.isArray(observation.legalTools)
          )
            waitingOffers.set(
              matchId,
              new Set(
                observation.legalTools.filter((tool): tool is string => typeof tool === "string"),
              ),
            );
        } else {
          inactive.delete(matchId);
          decisions.set(matchId, { id: observation.decisionId, generation: observedAt });
        }
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
      await validateResponse(result, "next");
      if (
        result &&
        typeof result === "object" &&
        "matchId" in result &&
        typeof result.matchId === "string"
      ) {
        if (
          "observation" in result &&
          (epoch !== mutationEpoch ||
            (observedDecisions.get(result.matchId)?.generation ?? 0) > startedAt)
        ) {
          throw Object.assign(Error("stale_observation: request the current decision again"), {
            kind: "stale_observation",
          });
        }
        if ("protocolVersion" in result && result.protocolVersion === 2)
          versionedMatches.add(result.matchId);
        rememberDecision(result.matchId, result, startedAt);
        if ("kind" in result && result.kind === "seat_finished") {
          decisions.delete(result.matchId);
          inactive.add(result.matchId);
          waitingOffers.delete(result.matchId);
          observedDecisions.set(result.matchId, { id: "", generation: startedAt });
        }
        if ("kind" in result && (result.kind === "match_over" || result.kind === "match_aborted")) {
          decisions.delete(result.matchId);
          inactive.add(result.matchId);
          waitingOffers.delete(result.matchId);
          observedDecisions.set(result.matchId, { id: "", generation: startedAt });
          if (lastMatchId === result.matchId) lastMatchId = undefined;
        } else lastMatchId = result.matchId;
      }
      return result;
    },
    async submit(matchId, tool, input, suppliedIdentity) {
      const isWaitingOffer = waitingOffers.get(matchId)?.has(tool) === true;
      if (!suppliedIdentity && inactive.has(matchId) && !isWaitingOffer)
        throw Error("seat_not_acting");
      const current =
        decisions.get(matchId) ?? (isWaitingOffer ? observedDecisions.get(matchId) : undefined);
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
      await validateResponse(result, "submit", versionedMatches.has(matchId));
      const latest = observedDecisions.get(matchId);
      if (!identity || !latest || latest.id === identity.decisionId)
        rememberDecision(matchId, result, ++generation);
      return result;
    },
  };
}
