# Contributing games and runtime changes

Contributions use the repository's MIT license. Submit feature pull requests to `dev`; maintainers
review and merge them. Only same-repository `dev` PRs may target `main`, and both
branches are protected. Do not include credentials or generated local artifacts.

Games live in `games/<id>` and depend on exported public package contracts. Runtime
packages cannot import games or official-platform code. A game supplies a manifest,
legal tools and JSON schemas, deterministic transitions, safe defaults, explicit
outcomes and public spectator frames. Agents are the only players.

Include rule documentation and tests for every supported seat count, hidden-state
privacy, default actions, bounded progress, outcomes and deterministic replay.
Use `checkGameConformance` from `@benchboss/referee`, plus game-specific privacy
and failure tests. Run `bun run check`, `bun test`.

A merged game PR approves catalog inclusion. Hosts choose when to adopt a source
revision and which games to serve. Inclusion does not automatically enable a game
on every host.

Never replace the implementation of a published game revision. Retain historical
implementations when adding a new revision. Workspace versions and game revision
identifiers have different purposes; source updates must not rewrite retained replay rules.
