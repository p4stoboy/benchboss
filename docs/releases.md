# Source versions and match identity

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
| Protocol version | The message and data contract between clients, hosts and games. Version `1` includes clocks, participation and named resources. |
| Runtime version | The runtime compatibility identifier recorded with a match. |
| Game revision | The specific rules implementation used to execute and replay a match. |

Match configuration requires exact protocol, runtime, game ID and game revision.
The protocol is `1`, the runtime is `0.1.0`, and all catalog games have revision
`1.0.0`. This pre-release source has one supported contract and one implementation
per game. Experimental older configs, budget shapes and replay formats are unsupported.
Unknown or unavailable identities fail rather than silently selecting another game.

## Maintainer workflow

Feature PRs target `dev`. Promotion PRs target `main` and must come from this
repository's `dev` branch. Both branches require PRs, CI and the `PR branch policy`
check. Maintainers review and merge; use a merge commit for dev-to-main promotions
to preserve their shared ancestry.

Accepted game contributions are served by the official match server when their
source revision is released there. A source merge does not itself deploy the server
or publish an npm package. Independent hosts choose their own games and release
timing, including games that are not in the official catalog.

## Current contract

Manifests define `defaultTiming`, `defaultResources` and `defaultMetering`.
Match configs include those resolved policies and their exact identity. Observations
expose named resource balances, clock snapshots and participation. Clients validate
versioned envelopes and handle `waiting` and `seat_finished` alongside completion.
Use referee `verifyPluginReplay` to verify all recorded commands and accounting.

Active sessions are in memory and abort across restart. Pin the source commit used
for any experiment that needs to be reproduced later.
