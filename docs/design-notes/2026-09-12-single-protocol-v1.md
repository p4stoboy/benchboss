# Single protocol v1

## Problem & constraints

There are no users or published replay obligations. The user wants the newly added
clock, lifecycle and generic resource functionality to remain protocol v1, without
historical compatibility layers. Keep all working game mechanics and transport,
privacy, timing, metering and replay invariants. No dependencies or deployment.

## States and semantics

- Exactly protocolVersion 1, runtimeVersion 0.1.0, catalog game revisions 1.0.0.
  Config identity is required and exact; unknown versions/revisions and unversioned
  configs fail admission. There is no fallback to an old executor or old envelope.
- One MatchConfig has identity, matchId, gameId, seats, rules, timing, resources and
  metering. No budget field, fixed resource names or Current/Legacy/Any unions.
- TimingPolicy keeps playerTotalMs and decisionLimitMs (positive integer ms or null),
  fixed phase limits and private/public clock visibility. Chess keeps 600000 ms
  per player without a per-decision cap. Safehouse keeps its fixed comms cutoff.
- ResourceAllowance keeps safe-integer amount, match/phase/decision reset and
  private/public visibility. ResourceBook stores balances; sensing uses resource
  and cost. Safehouse research remains three private units per match, every sensing
  tool pays from it. Any game may declare its own resource names and costs.
- All next/submit envelopes require protocolVersion 1 and the existing lifecycle,
  clock and named-balance fields. Waiting sensing, terminal acknowledgement and
  identity-safe retries retain their behavior. Capabilities advertise only [1].
- One referee logs timestamped commands and regenerates complete replay output.
  Old reduced logs and old budget configs are unsupported. Core no longer exposes
  the incomplete historical verifier; referee verifyPluginReplay/verifySessionReplay
  remain the authoritative APIs. Elapsed time remains host-owned and monotonic.
- Acting/waiting/finished transitions, deadline equality, simultaneous expiry,
  resource scope resets and public/private projections remain unchanged.
- Exactly one shipped implementation of each catalog game; remove legacy-v0 and
  legacy-v1 copies and their historical fixtures. Revision identity remains useful
  for rejecting wrong game configurations, without speculative fallback machinery.

## Threat model

Agents control tool/input and request identity, never host timestamps or expiry
commands. Keep strict plain-data validation, no resource minting, bounded rejected
input retention, deterministic replay and private sensing/clock boundaries.

## Mechanism

- Protocol contracts become unprefixed GameManifest, GameRevision, Observation,
  NextEnvelope and SubmitEnvelope in contracts.ts; remove legacy.ts and v2.ts.
- Core exposes MatchConfig and ResourceBook in resources.ts; remove old accounting,
  tournament overloads and historical replay verifier. Schemas admit only v1.
- Referee consolidates the current reducer into match-server.ts, with runtime and
  resources fields. Remove legacy/v2 reducer dispatch and historical sense types.
- Core match-config.ts shares strict plain-data admission across session, registry,
  direct host construction and replay. Validate before cloning or invoking game
  capabilities; plugin entry points also enforce exact revision and game rules.
- Host, registry, process runner and client have one versioned execution path.
- Games, examples, conformance, tests and docs adopt the single contract together.

## Rejected alternatives

- Preserve compatibility with no users: unnecessary duplicate implementations and
  confusing resource names undermine the requested developer-facing API.
- Relabel protocol v2 without deleting branches: leaves the original complexity
  and creates ambiguity about what a protocol-v1 record means.

## Blast radius & rollback

This source change deliberately invalidates experimental old artifacts and configs.
There is no data migration or live-session restart support. Prior source commits can
still run prior experiments. Deliver through a feature PR to dev; human merge only.

## Test plan

Migrate meaningful existing behavioral tests to the one contract. Verify strict
version/shape rejection, generic sensing costs and exhaustion, cumulative clocks,
fixed phases, privacy, lifecycle/retry semantics, both runners and complete replay.
Run repository check and full suite plus real HTTP chess/RPS examples. Scan for
remaining version-dispatch branches and retired allowance names in executable code.
