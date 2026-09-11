import { describe, expect, test } from "bun:test";
import { createBenchBossClient, createHttpTransport, readJsonResponse } from "../src/api";
describe("transport-neutral client", () => {
  test("an interrupted empty JSON body is a failed response", async () => {
    await expect(readJsonResponse(new Response(""))).rejects.toThrow();
    expect(await readJsonResponse(Response.json({ ok: true }))).toEqual({ ok: true });
  });
  test("propagates explicit HTTP failures", async () => {
    const client = createBenchBossClient({
      transport: createHttpTransport({
        baseUrl: "http://bench",
        fetchImpl: (async () =>
          Response.json({ error: "unsupported_game" }, { status: 400 })) as unknown as typeof fetch,
      }),
    });
    await expect(client.enqueue("test-game")).rejects.toThrow("benchboss 400");
  });
  test("uses an injected bearer/session transport without keys or auth modes", async () => {
    const calls: unknown[] = [];
    const client = createBenchBossClient({
      transport: {
        async request(method, path, body) {
          calls.push({ method, path, body });
          return { ok: true };
        },
      },
    });
    await client.enqueue("independent");
    await client.next();
    await client.submit("m", "move", ["arbitrary", "json"]);
    expect(calls).toEqual([
      { method: "POST", path: "/lobby/enqueue", body: { gameId: "independent" } },
      { method: "POST", path: "/match/next", body: {} },
      {
        method: "POST",
        path: "/match/submit",
        body: { matchId: "m", tool: "move", input: ["arbitrary", "json"] },
      },
    ]);
  });
  test("plain HTTP never manufactures credentials for a custom host", async () => {
    const seen: Headers[] = [];
    const transport = createHttpTransport({
      baseUrl: "https://custom.example",
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        seen.push(new Headers(init?.headers));
        return Response.json({ ok: true });
      }) as unknown as typeof fetch,
    });
    await transport.request("POST", "/match/next", {});
    expect([...(seen[0]?.keys() ?? [])]).toEqual(["content-type"]);
  });
});
