import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseJsonl } from "@benchboss/core";
import { SERVER_CAPABILITIES, type SubmissionIdentity } from "@benchboss/protocol";
import { verifyPluginReplay } from "@benchboss/referee";
import { createLobby } from "./lobby";
import type { GameRegistry } from "./registry";
import { type MatchArtifact, createMatchRunner } from "./runner";

export interface ArtifactStore {
  save(artifact: MatchArtifact): Promise<void>;
  get(id: string): Promise<MatchArtifact | null>;
}
export function createArtifactStore(dir?: string): ArtifactStore {
  const memory = new Map<string, MatchArtifact>();
  const file = (id: string) => join(dir as string, `${Buffer.from(id).toString("hex")}.json`);
  return {
    async save(artifact) {
      if (dir) {
        await mkdir(dir, { recursive: true });
        const target = file(artifact.record.id);
        const temp = `${target}.${randomUUID()}.tmp`;
        await writeFile(temp, JSON.stringify(artifact));
        await rename(temp, target);
      }
      memory.set(artifact.record.id, structuredClone(artifact));
    },
    async get(id) {
      const cached = memory.get(id);
      if (cached) return structuredClone(cached);
      if (!dir) return null;
      try {
        return JSON.parse(await readFile(file(id), "utf8")) as MatchArtifact;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
  };
}
export function buildLocalServer(opts: {
  registry: GameRegistry;
  dir?: string;
  artifacts?: ArtifactStore;
}) {
  const { registry } = opts;
  const artifacts = opts.artifacts ?? createArtifactStore(opts.dir);
  const runner = createMatchRunner({ registry, persist: artifacts.save });
  const lobby = createLobby();
  const json = (body: unknown, status = 200, cache?: string) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
        ...(cache ? { "cache-control": cache } : {}),
      },
    });
  const app = {
    async fetch(req: Request): Promise<Response> {
      const path = new URL(req.url).pathname;
      if (req.method === "GET") {
        if (path === "/health") return json({ ok: true, mode: "local" });
        if (path === "/games") return json(registry.list());
        if (path === "/capabilities") return json(SERVER_CAPABILITIES);
        const view = path.match(/^\/match\/([^/]+)\/view$/);
        if (view) {
          const id = decodeURIComponent(view[1] as string);
          const v = runner.view(id);
          if (v) return json(v, 200, "no-store");
          const a = await artifacts.get(id);
          const frames = a?.record.presentation?.frames;
          return frames?.length
            ? json(frames[frames.length - 1]?.view, 200, "no-store")
            : json({ error: "not_found" }, 404);
        }
        const record = path.match(/^\/match\/([^/]+)$/);
        if (record) {
          const a = await artifacts.get(decodeURIComponent(record[1] as string));
          if (!a) return json({ error: "not_found" }, 404);
          return json({
            ...a.record,
            seats: a.seats.map((s) => ({
              ...s,
              handle: s.agentId,
              ratingBefore: null,
              ratingAfter: null,
            })),
            replayUrl: `/replay/${encodeURIComponent(a.record.id)}`,
            verifyUrl: `/replay/${encodeURIComponent(a.record.id)}/verify`,
          });
        }
        const verify = path.match(/^\/replay\/([^/]+)\/verify$/);
        if (verify) {
          const a = await artifacts.get(decodeURIComponent(verify[1] as string));
          if (!a) return json({ error: "not_found" }, 404);
          try {
            return json(
              verifyPluginReplay({
                plugin: registry.resolve(a.record.config),
                publishedResult: a.record.presentation
                  ? (a.record.presentation.frames.at(-1)?.view.result ?? null)
                  : undefined,
                config: a.record.config,
                seed: a.record.seed,
                log: parseJsonl(a.replayJsonl),
              }),
            );
          } catch (error) {
            return json({ ok: false, detail: String(error) });
          }
        }
        const replay = path.match(/^\/replay\/([^/]+)(?:\/(presentation))?$/);
        if (replay) {
          const a = await artifacts.get(decodeURIComponent(replay[1] as string));
          if (!a) return json({ error: "not_found" }, 404);
          return replay[2]
            ? a.record.presentation
              ? json(a.record.presentation, 200, "public, max-age=31536000, immutable")
              : json({ error: "legacy_presentation_unavailable" }, 404)
            : new Response(a.replayJsonl);
        }
      }
      if (req.method !== "POST") return json({ error: "not_found" }, 404);
      let body: Record<string, unknown>;
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        return json({ error: "bad_request" }, 400);
      }
      if (!body || typeof body !== "object" || Array.isArray(body))
        return json({ error: "bad_request" }, 400);
      if (path === "/lobby/enqueue") {
        if (typeof body.gameId !== "string" || !registry.has(body.gameId))
          return json({ error: "unsupported_game" }, 400);
        const token = randomUUID();
        lobby.enqueue({ agentId: token, principalId: token, gameId: body.gameId }, Date.now());
        for (const spec of lobby.matchmake({
          nextMatchId: (id) => `${id}:${randomUUID()}`,
          nextSeed: () => randomBytes(16).toString("hex"),
          seatsForGame: registry.seatsFor,
          buildConfig: registry.buildConfig,
        }))
          runner.start(spec);
        return json({ queued: true, seatToken: token });
      }
      const token = req.headers.get("x-bb-seat");
      if (!token) return json({ error: "unauthenticated" }, 401);
      if (path === "/match/next") {
        const envelope = await runner.next(token);
        return json(envelope.kind === "idle" ? { protocolVersion: 2, ...envelope } : envelope);
      }
      if (path === "/match/submit") {
        if (
          Object.keys(body).some(
            (key) => !["matchId", "tool", "input", "decisionId", "requestId"].includes(key),
          ) ||
          typeof body.matchId !== "string" ||
          typeof body.tool !== "string"
        )
          return json({ error: "bad_request" }, 400);
        let identity: SubmissionIdentity | undefined;
        if (body.decisionId !== undefined || body.requestId !== undefined) {
          if (
            typeof body.decisionId !== "string" ||
            !body.decisionId ||
            typeof body.requestId !== "string" ||
            !body.requestId
          )
            return json({ error: "bad_request" }, 400);
          identity = { decisionId: body.decisionId, requestId: body.requestId };
        }
        return json(await runner.submit(token, body.matchId, body.tool, body.input, identity));
      }
      return json({ error: "not_found" }, 404);
    },
  };
  return { app, runner, artifacts };
}

export function startLocalServer(
  opts: Parameters<typeof buildLocalServer>[0] & {
    port?: number;
    hostname?: string;
    reapIntervalMs?: number;
    onError?: (error: unknown) => void;
  },
) {
  const built = buildLocalServer(opts);
  const server = Bun.serve({
    port: opts.port ?? 3000,
    hostname: opts.hostname ?? "127.0.0.1",
    fetch: built.app.fetch,
  });
  const reaper = setInterval(() => {
    void built.runner.reap().catch((error) => (opts.onError ?? console.error)(error));
  }, opts.reapIntervalMs ?? 1000);
  return {
    ...built,
    server,
    stop: () => {
      clearInterval(reaper);
      server.stop(true);
    },
  };
}
