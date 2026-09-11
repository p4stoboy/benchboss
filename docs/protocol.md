# The BenchBoss protocol

BenchBoss separates the agent choosing a move from the host executing the game.
A game describes what a player can observe and which actions they can take.
The same client can carry those descriptions and submissions for different games;
the agent still has to understand each game's rules and choose a strategy.

## The pieces

- An **agent** is a program making decisions. It can use an LLM or a scripted policy.
- A **seat** is one player's position in a match. Observations are specific to that
  seat; hidden information is not shared with other players or spectators.
- A **game plugin** implements the rules and produces observations, legal actions,
  default moves, outcomes and public views.
- The **referee** checks submitted actions, applies the rules and records events.
- A **host** connects agents to matches and supplies clocks, queues and storage.
- A **client** carries messages between an agent and a host. Authentication belongs
  to the host's transport adapter; the protocol requires no particular identity system.

## Discover a game

`GET /games` on the reference host returns the available games and their manifests.
A **manifest** describes a game's ID and revision, rules, player counts, phases,
win conditions, timing, named resource allowances and metering defaults. For example, RPS-N has ID
`rps-n`, supports 2–10 players, and defaults to two players and three rounds.

`GET /capabilities` reports protocol version `2`, supported versions `[1,2]` and
features for player-total timing, decision limits, fixed phase deadlines,
participation and named resources. Check compatibility before play. Version 1
remains available for historical game revisions; its shapes are explicitly legacy.
The [protocol types](../packages/protocol/src/index.ts) define these structures.

## Join, observe, act

The reference HTTP host uses three requests:

| Request | Purpose |
| --- | --- |
| `POST /lobby/enqueue` with `{ "gameId": "rps-n" }` | Queue an agent for a game. |
| `POST /match/next` with `{}` | Get that agent's next decision or terminal message. |
| `POST /match/submit` | Submit the match ID, action, input and request identity as shown below. |

On this host, enqueue returns a `seatToken`. Subsequent requests send it in the
`x-bb-seat` header. This token scheme is specific to the reference host. The
[local example](../examples/rps-agents.ts) implements it in a small client transport.

A v2 `next` response has `protocolVersion: 2` and one of these `kind` values:

| Kind | What the agent does |
| --- | --- |
| `idle` | Wait and poll again; no unacknowledged assignment is available. |
| `waiting` | No game decision is due. Use any offered sensing tools or poll again. |
| `seat_finished` | This player has permanently finished; other players may still continue. |
| `turn` | Read the observation and submit an offered action before the deadline. |
| `match_over` | Read the result; the match has finished. |
| `match_aborted` | Stop playing this match; it ended without a result. |

A `turn` contains `matchId`, `seat`, `observation` and `deadline` (null when there
is no active time limit). A `waiting` response carries the same context. The
observation contains game-specific information, named `resources`, `participation`,
a `clock` snapshot, `phaseId`, `decisionId`, and `actionOffers`. Every offer has a tool name, description, phase and JSON Schema
for its input. RPS-N offers `match.throw`; its submission body looks like this:

```json
{
  "matchId": "<matchId from the turn>",
  "tool": "match.throw",
  "input": { "throw": "rock" },
  "decisionId": "<decisionId from the observation>",
  "requestId": "<unique ID for this submission>"
}
```

Replace the placeholder IDs with the values for your match and request.

Use the current offers rather than assuming actions are available in every phase.
Games may use simultaneous decisions: after submitting, an agent can receive
`waiting` while opponents are still choosing. A rejected submission reports
`protocolVersion: 2, ok: false` and a reason; it does not establish that a move was accepted.

The deadline is an absolute Unix time in milliseconds, set by the host. Time spent
receiving observations, running inference and delivering submissions counts while
the player is acting. Waiting and finished players spend no time. Polling, sensing,
rejections and retries never replenish time. If a move arrives at the deadline,
expiry is processed first.

Each match has an explicit timing policy:

```ts
timing: {
  playerTotalMs: 600_000,
  decisionLimitMs: null,
  phaseLimits: {},
  clockVisibility: "public",
}
```

This gives every player a cumulative ten-minute allowance, with no per-decision
cap. Multiple acting players spend time concurrently. Positive integer millisecond
limits may be combined; the earliest expiry applies. `null` disables a limit.
Chess uses this policy. RPS uses a 15-second decision limit; Safehouse uses a
90-second decision limit plus a fixed 90-second `comms` phase cutoff.

`phaseLimits` maps phase names to `{durationMs, close}`. The cutoff belongs to one
`phaseId` and cannot be extended by actions. `ready_or_deadline` allows everyone
finishing to close early; `deadline` keeps the phase open until expiry. Repeated
phase names receive new IDs. Timed phases can expire with no acting players.

`clock` contains `sampledAt`, `remainingMs`, `running`, `deadline`, `phaseId` and
`phaseDeadline`. The server derives snapshots without adding log events for every
poll. Public clock disclosure is explicitly configured; hidden-role clocks stay
private. The host uses monotonic elapsed time and records authoritative expiry.

Resource allowances are game-declared names, for example:

```ts
resources: {
  actions: { amount: 8, reset: "phase", visibility: "private" },
  research: { amount: 3, reset: "match", visibility: "private" },
},
metering: { action: { resource: "actions", cost: 1 } },
```

Observations return remaining numbers under those names. `match` never resets,
`phase` resets for each phase occurrence, and `decision` resets after accepted game
actions. Sensing names its own resource; polling/sensing/rejections do not renew
allowances. Zero is exhausted. Invalid names, unknown references and fractional, unsafe, negative or
nonfinite amounts/costs fail validation. Schema-invalid input spends no resources;
active time still counts. The optional `invalidAction` metering reference controls
semantic retries. Exhaustion invokes a forced default with a structured cause.

Decision, total-player, shared-phase and retry exhaustion are trusted host events.
Games determine their consequences; agents cannot submit these events. A finite
player-total policy requires a game exhaustion handler that finishes affected
players or the match. In chess, timeout and voluntary resignation have different
result causes.

`decisionId` identifies the decision being answered. `requestId` identifies one
submission attempt. Keep both IDs and the payload unchanged when retrying after a
lost response: a repeated request returns its prior response, while conflicting
reuse or a stale decision is rejected. The generic client remembers observed
decision IDs and creates request IDs for submissions. If supplying them yourself,
supply both together. Receipt deduplication lasts for the host's retention window.

## Where MCP fits

Model Context Protocol (MCP) lets an agent application call tools. BenchBoss uses
MCP as one way to expose its agent interface. The game protocol defines the match
messages and rules-facing data that those tools carry.

The [generic client module](../packages/client/src/index.ts) provides these tools:

| MCP tool | Client operation |
| --- | --- |
| `benchboss_enqueue` | Join a game's queue. |
| `benchboss_next` | Receive a decision, waiting state, player completion, result or cancellation. |
| `benchboss_submit` | Submit a game action by its offered tool name and input. |

An action such as `match.throw` is passed to `benchboss_submit`; it is not a
separately installed MCP tool. Game implementations execute on the host. A remote
agent needs the client and that host's connection instructions, not a copy of the
engine or game source.

Host integrators supply a `ClientTransport` to `createBenchBossClient`, then pass
the client to `createMcpServer`. The transport supplies the host's credentials
or session handling. The bare HTTP transport does not manage seat tokens; use the
transport in the local example when connecting to the reference host.

## Spectators and replays

Games produce a public view separately from each player's observation. Views use
shared blocks such as text, tables, participants and progress, plus explicit
win/loss/draw outcomes when the match ends. A viewer renders those blocks without
needing a new interface for every game.

The reference host exposes:

- `GET /match/:id/view`: the current public view, or the final view after completion.
- `GET /match/:id`: the completed match record.
- `GET /replay/:id/presentation`: recorded public frames for replay display.
- `GET /replay/:id`: the completed execution log.
- `GET /replay/:id/verify`: replay verification against the recorded configuration,
  seed and game revision.

Match and replay routes other than the public view become available after the
match finishes. V2 verification re-executes deterministic recorded commands, including host time,
resource charges and expiry, and compares the entire regenerated log and outcome.
It does not call an LLM or consult the current clock. It verifies the host's recorded
accounting, not whether reported physical elapsed time was truthful. V1 artifacts
use their original action/result verifier. A stored replay retains its game revision so later rule
changes do not silently reinterpret it.

For implementing games, continue with the [game contract](../games/README.md).
For module boundaries and implementation details, see [ARCHITECTURE.md](../ARCHITECTURE.md).

## Embedding the runtime

Use `verifyPluginReplay` from `@benchboss/referee` for versioned game verification;
it dispatches to the correct verifier. The legacy core `verifyReplay` rejects v2
records, so timing events cannot silently escape verification. Both the in-process
and process runners use the same referee and shared message contracts.

Active sessions and request receipts are still in memory. A restart aborts active
matches; durable terminal artifacts remain readable. This protocol does not add
pause/resume or durable active-match recovery.
