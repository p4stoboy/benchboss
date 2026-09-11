import type { ChessObservation } from "@benchboss/game-chess";
import { type BenchBossClient, createBenchBossClient, readJsonResponse } from "@benchboss/mcp";
import type { SpectatorView } from "@benchboss/protocol";
import { startExampleServer } from "./local-server";

// Scripted Fool's Mate demonstrates transport and adjudication, not chess strategy.
// Both agents use only observations received through HTTP.
const moves = ["f2f3", "e7e5", "g2g4", "d8h4"];
const host = startExampleServer(0);
const baseUrl = host.server.url.origin;

async function join(): Promise<BenchBossClient> {
  const response = await fetch(`${baseUrl}/lobby/enqueue`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ gameId: "chess" }),
    signal: AbortSignal.timeout(5000),
  });
  const { seatToken } = (await readJsonResponse(response)) as { seatToken: string };
  return createBenchBossClient({
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
async function play(client: BenchBossClient): Promise<string> {
  const stopAt = Date.now() + 15000;
  while (Date.now() < stopAt) {
    const next = await client.next();
    if (next.kind === "idle" || next.kind === "waiting") {
      await Bun.sleep(25);
      continue;
    }
    if (next.kind === "match_aborted") throw Error(`Match aborted: ${next.reason}`);
    if (next.kind === "seat_finished") return next.matchId;
    if (next.kind === "match_over") return next.matchId;
    const observation = next.observation as unknown as ChessObservation;
    const move = moves[observation.publicState.ply];
    if (!move || !observation.publicState.legalMoves.includes(move))
      throw Error("Expected scripted legal move");
    const submitted = await client.submit(next.matchId, "match.move", { move });
    if (!submitted.ok) throw Error(`Move rejected: ${submitted.reason}`);
    console.log(`${next.seat} (${observation.publicState.turn}) played ${move}`);
  }
  throw Error("Chess example did not finish in time");
}

try {
  const first = await join();
  const second = await join();
  const [matchId, otherMatchId] = await Promise.all([play(first), play(second)]);
  if (matchId !== otherMatchId) throw Error("Agents did not share a match");
  const path = encodeURIComponent(matchId);
  const view = (await readJsonResponse(
    await fetch(`${baseUrl}/match/${path}/view`, { signal: AbortSignal.timeout(5000) }),
  )) as SpectatorView;
  if (!view.result?.summary.includes("(black) wins by checkmate"))
    throw Error("Expected Black checkmate");
  console.log(view.result.summary);
  const board = view.blocks.find((block) => block.kind === "table");
  if (board?.kind === "table") console.log(board.rows.map((row) => row.join(" ")).join("\n"));
  const replay = (await readJsonResponse(
    await fetch(`${baseUrl}/replay/${path}/verify`, { signal: AbortSignal.timeout(5000) }),
  )) as { ok: boolean };
  if (!replay.ok) throw Error("Replay verification failed");
  console.log("Replay verification: passed");
} finally {
  host.stop();
}
