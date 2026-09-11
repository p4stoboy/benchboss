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
| Protocol version | The message and data contract between clients, hosts and games. Currently `1`. |
| Runtime version | The runtime compatibility identifier recorded with a match. |
| Game revision | The specific rules implementation used to execute and replay a match. |

Match configuration records the protocol version, runtime version, game ID and game
revision. Current catalog revisions are `1.0.0`; `legacy-v0` implementations are
retained for historical records. A source update does not itself change those
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
