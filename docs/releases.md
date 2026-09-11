# Source versions and compatibility

BenchBoss is distributed as MIT source in a Bun workspace. Its modules are marked
`private: true` to prevent individual npm publication; that setting does not restrict
your use of the source under the license.

## Choose a source version

`dev` contains reviewed changes awaiting promotion. `main` contains promoted source.
To make a build reproducible, record a full Git commit ID and use the committed
`bun.lock` with `bun install --frozen-lockfile`. A branch name can move; a commit ID
selects an exact source snapshot.

After selecting a checkout, run:

```sh
bun install --frozen-lockfile
bun run check
bun test
```

If embedding the modules into another project, keep their workspace relationships
and use their exported interfaces. Select and test source updates explicitly.

## Version identifiers

| Version | What it identifies |
| --- | --- |
| Source commit | The exact repository contents used for a build. |
| Protocol version | The message and data contract between clients, hosts and games. Currently `2`; version `1` remains supported for historical matches. |
| Runtime version | The runtime compatibility identifier recorded with a match. |
| Game revision | The specific rules implementation used to execute and replay a match. |

Match configuration records the protocol version, runtime version, game ID and game
revision. Current catalog revisions are `2.0.0` on runtime `0.2.0`. `legacy-v1/` retains
revision `1.0.0` on runtime `0.1.0`; `legacy-v0/` retains unversioned history. A source update does not itself change those
identifiers or the rules used by an existing replay.

Do not replace the behavior of a retained game revision. Add a new revision and
keep the implementation needed to verify older matches. Unknown revisions must
fail explicitly instead of silently using the latest rules. See the
[game catalog](../games/README.md) for revision selection and conformance checks.

## Maintainer workflow

Feature PRs target `dev`. Promotion PRs target `main` and must come from this
repository's `dev` branch. Both branches require PRs, CI and the `PR branch policy`
check. Maintainers review and merge; use a merge commit for dev-to-main promotions
to preserve their shared ancestry.

Accepted game contributions are served by the official match server when their
source revision is released there. A source merge does not itself deploy the server
or publish an npm package. Independent hosts choose their own games and release
timing, including games that are not in the official catalog.

## Protocol v2 migration

Current manifests replace fixed budget fields with `defaultTiming`,
`defaultResources` and `defaultMetering`. Current configs and observations use
`timing` and named `resources`. Do not pass old budget objects into v2 matches.
Read capabilities and use the versioned envelopes; handle `waiting` and
`seat_finished` as well as match completion. Update custom viewers to honor clock
and resource visibility. Use referee `verifyPluginReplay` for v2 logs.

Source rollback must retain a v2 executor for artifacts already written by v2.
Active sessions are still in memory and abort across restart; cumulative clocks
do not add durable match resumption.
