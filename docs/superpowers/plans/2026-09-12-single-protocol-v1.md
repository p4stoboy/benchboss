# Single protocol v1 implementation plan

Spec: docs/design-notes/2026-09-12-single-protocol-v1.md
Base: b392441a618100a72bcc80aeb4f2a617edca833a
Branch: codex/protocol-v1-cleanup, primary checkout.

## Shared contract

Protocol 1; runtime 0.1.0; game revisions 1.0.0. No legacy compatibility exports.
Unprefixed GameManifest, GameRevision, Observation, NextEnvelope, SubmitEnvelope,
MatchConfig; ResourceBook with initResourceBook, remainingResource, spendResource,
resetResources, resourceBalances. MatchSession.runtime and MatchSession.resources.
Referee public API stays newSession, step, observe, publicView, publicFrames,
phaseId, decisionId, participation, clockSnapshot, verifyPluginReplay and
verifySessionReplay. Exact config identity is required. Keep all new behavior.

## Ownership and sequence

1. Contracts worker: packages/protocol (except guides.ts), packages/core,
   packages/schemas and their tests. Rename contracts/accounting, remove old types,
   verifier and overloads; migrate meaningful tests and reject old formats.
2. Referee worker: packages/referee and tests. Consolidate reducer, retain complete
   replay, migrate old behavioral tests, use canonical types and resources/runtime.
3. Host worker: packages/host, packages/client, packages/viewer and tests. Remove
   version fallbacks and legacy admission, migrate fixtures and behavioral tests.
4. Parent: games, examples, docs, protocol guides, ARCHITECTURE and integration.
   Remove historical game copies/fixtures; migrate current games and tests.

Workers are not alone. Do not revert others' edits. No worker commits, pushes,
new dependencies or subagents. Reports include exact commands/results. Parent
runs combined verification and an independent final review before delivery.

## Validation and delivery

Focused semantic tests first; then bun run check, bun test and both real HTTP
examples. Audit old-name/version remnants, review complete diff, commit and open
feature PR against dev. Do not merge or change the existing promotion PR.

## Completed validation

- `bun run check`: exit 0; client build, dependency boundaries, Biome and TypeScript.
- `bun test`: 445 pass, 0 fail, 71727 assertions across 66 files.
- Both HTTP agent examples completed with `Replay verification: passed`.
- Independent review found one admission inconsistency; its fix passed focused
  red/green tests and re-review. Registry, direct construction and replay now
  reject malformed configs and unavailable identities before game creation.
- Executable source contains no retired budget fields or compatibility aliases.
