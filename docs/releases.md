# Package releases and first cut

Public packages and the official MCP client use MIT, copyright 2026 Oscar Harris.
The initial versions are 0.1.0, then version independently. Version 1 protocol
envelopes and immutable game revisions are separate from npm package versions.

## Candidate rehearsal

From the public checkout, build and inspect an immutable candidate:

```sh
bun install --frozen-lockfile
bun run check
bun test
bun run pack:release --output .local/release-0.1.0
bun run test:packages --packages .local/release-0.1.0
```

The candidate contains `manifest.json` and tarballs. Manifest schema version 1
records names, versions, filenames, runtime dependencies, SHA-256 and npm SHA-512
integrity. Package source allowlists omit tests and local files; published metadata
omits development dependencies and build scripts. Do not edit an existing candidate.

From the private platform checkout, explicitly pass that candidate directory:

```sh
bun scripts/test-extraction.ts --packages ../benchboss/.local/release-0.1.0
```

Python 3.10 or newer is required. If `python3` is older, select an installed
interpreter with `BENCHBOSS_TEST_PYTHON=python3.14` when invoking the rehearsal.

Only the rehearsal accepts a filesystem argument. It copies the platform into a
disposable directory and applies tarball overrides there. Committed dependencies
remain exact registry versions. The checks include actual PostgreSQL, the compiled
Linux server and an installed official MCP without game or private packages.

## Publication

Merging code does not publish npm packages. After reviewing the source and candidate,
merge the release changes to main and explicitly run `Publish packages`, selecting
`all` or comma-separated package names. CI rebuilds, checks and retains the exact
tarballs; the publication job downloads those artifacts instead of rebuilding.
Selected dependencies publish before consumers. Omitted public dependencies must
already exist at their required versions. Existing package versions with different
bytes fail preflight; identical published artifacts can be skipped during a retry.
If a run partially publishes, rerun only the publish job from that run so it uses
the original artifact. A new build is a new candidate and may require new versions.

Configure each npm package's trusted publisher for GitHub owner `p4stoboy`, its
source repository (`benchboss`, or `benchboss-platform` for official MCP), workflow
`publish-npm.yml`, and environment `npm`. Restrict that GitHub environment to main.
Bun owns dependency installation, lockfiles and builds. npm is used only as the
OIDC upload client (npm >=11.5.1 and Node >=22.14.0). No long-lived token is stored
in the workflow. First-time package creation/trusted-publisher setup is an operator
step; do not publish placeholder packages to reserve names. See
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

## Platform promotion

After the first public npm release, run `bun install` in the private platform to
generate its registry `bun.lock`, then verify `bun install --frozen-lockfile`,
`bun run check`, `bun test`, `bun run test:database`, `bun run test:artifact`, and
`bun run test:extraction`. Commit that lockfile with the cut before merging to main.
A candidate lockfile with local overrides must never be committed or deployed.

The private repository keeps all existing history. The public repository starts
with a reviewed clean commit; no private history or operator files are exported.
Netlify's package directory is `site`, its root build uses `bun run build`, and
its publish directory is `site/dist`. API deployment remains main-only. Validate
registration, real-agent play, public replay, restart cancellation and rollback
on the actual deployment before announcing launch. This cut changes no SQL schema.
