import type { NextEnvelope, SubmitResult } from "@benchboss/host";
import { type BenchBossClient, createBenchBossClient, readJsonResponse } from "@benchboss/mcp";
import { startExampleServer } from "./local-server";

// Everything stays on loopback. Each agent talks to the host through HTTP.
const host = startExampleServer(0);
const baseUrl = host.server.url.origin;

async function join(): Promise<BenchBossClient> {
  const response = await fetch(`${baseUrl}/lobby/enqueue`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ gameId: "rps-n" }),
    signal: AbortSignal.timeout(5000),
  });
  const { seatToken } = (await readJsonResponse(response)) as { seatToken: string };
  return createBenchBossClient({
    // Temporary seat tokens are this example host's authentication policy.
    transport: {
      async request(method, path, body) {
        return readJsonResponse(
          await fetch(`${baseUrl}${path}`, {
            method,
            headers: { "content-type": "application/json", "x-bb-seat": seatToken },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(5000),
          }),
        );
      },
    },
  });
}

async function play(client: BenchBossClient, move: "rock" | "paper"): Promise<string> {
  const stopAt = Date.now() + 10_000;
  while (Date.now() < stopAt) {
    const next = (await client.next()) as NextEnvelope;
    if (next.kind === "idle") {
      await Bun.sleep(25);
      continue;
    }
    if (next.kind === "match_aborted") throw Error(`Match aborted: ${next.reason}`);
    if (next.kind === "match_over") return next.matchId;
    // The client carries the observation's decision ID into the submission.
    const submitted = (await client.submit(next.matchId, "match.throw", {
      throw: move,
    })) as SubmitResult;
    if (!submitted.ok) throw Error(`Move rejected: ${submitted.reason}`);
    console.log(`${next.seat} chose ${move}`);
  }
  throw Error("Example match did not finish in time");
}

try {
  const rock = await join();
  const paper = await join();
  const [matchId] = await Promise.all([play(rock, "rock"), play(paper, "paper")]);
  const path = encodeURIComponent(matchId);
  const view = await readJsonResponse(await fetch(`${baseUrl}/match/${path}/view`));
  console.log("Final public view:", JSON.stringify(view, null, 2));
  const replay = (await readJsonResponse(await fetch(`${baseUrl}/replay/${path}/verify`))) as {
    ok: boolean;
  };
  if (!replay.ok) throw Error("Replay verification failed");
  console.log("Replay verification: passed");
} finally {
  host.stop();
}
