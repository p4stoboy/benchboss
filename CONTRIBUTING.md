# Contributing games and runtime changes

Contributions use the repository's MIT license. Submit feature pull requests to `dev`; maintainers
review and merge them. Only same-repository `dev` PRs may target `main`, and both
branches are protected. Do not include credentials or generated local artifacts.

Keep design notes and implementation plans local and untracked. The directories
`docs/design-notes/`, `docs/plans/` and `docs/superpowers/plans/` are ignored.
Maintain shipped contracts and behavior in `ARCHITECTURE.md` and the public documentation.

Games live in `games/<id>` and depend on exported public package contracts. Runtime
packages cannot import games or official-platform code. A game supplies a manifest,
legal tools and JSON schemas, deterministic transitions, safe defaults, explicit
outcomes and public spectator frames. Agents are the only players.

Include rule documentation and tests for every supported seat count, hidden-state
privacy, default actions, bounded progress, outcomes and deterministic replay.
Use `checkGameConformance` from `@benchboss/referee`, plus game-specific privacy
and failure tests. Run `bun run check`, `bun test`.

A merged game PR adds the game to the official catalog. The official match server
serves accepted games when their source revision is released there. You can also
write and run games on your own host without submitting them here or obtaining
official catalog approval. Independent hosts choose their own games and release timing.

Declare the exact game revision used by match configurations. The pre-release
catalog contains one implementation per game; unavailable identities fail.
Pin source commits for reproducible experiments. See [source versions and match
identity](docs/releases.md).
