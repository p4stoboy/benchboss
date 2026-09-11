# Source delivery and the official MCP distribution

## Problem & constraints

Public code boundaries are workspace modules, not npm releases. Only the official
agent client is distributed through npm as `@benchboss/mcp-client`, initially 0.1.0.
Public protocol/runtime and games remain MIT source in `p4stoboy/benchboss`.
The platform keeps its existing private history and official application policy.

## States and semantics

- Every public workspace is `private: true`: this blocks npm publication without
  changing its MIT license or exported source interfaces.
- The platform records `vendor/benchboss` as a Git submodule from the public HTTPS
  repository, pinned by a full commit ID. Bun includes its modules as workspaces.
  A missing checkout, wrong revision or modified tracked source fails validation.
  Untracked build outputs are ignored. Updates require a reviewed platform PR
  changing the gitlink and any resulting Bun lockfile changes.
- Public module imports use workspace names and exports, not sibling checkout paths.
  No public module may import private application code. Runtime stays game-neutral.
- Only `@benchboss/mcp-client` may be packed for publication. Its JavaScript and
  declarations bundle the shared generic client and official identity code; runtime
  dependencies contain no internal workspace modules, games, host or database code.
- Both repositories use feature PRs into protected `dev`, then same-repository
  `dev` PRs into protected `main`. Direct pushes, force pushes and deletion are
  blocked by repository settings. The trusted PR policy workflow rejects other
  routes to main, including a fork branch named dev; it never runs PR source.
- Ordinary merges do not publish npm. Explicit main-only release checks build and
  retain one checksummed client tarball. Retries skip an identical published version
  and reject an existing version with different integrity.
- npm trusted publishing requires the package to already exist. The first real
  client release needs an explicit authenticated bootstrap after source reaches
  main; subsequent releases use the main-only OIDC workflow. No placeholder release.
- The empty public remote needs a shared seed before feature PRs can be opened.
  Initial branch creation is a separate operator step; application source still
  enters dev and main through PRs. Branch protections must be verified remotely.

## Threat model

The public repo owns shared source. Its tracked commit is the build input; an
uncommitted local edit must not silently alter a platform release. Package allowlists
and clean-consumer installation prevent private source or engine dependencies from
being distributed to agents. PR metadata is data, never executable shell text.

## Mechanism

Public CI checks source, game conformance and an independent host/viewer composition.
Platform checkout initializes the pinned submodule, validates it, and installs the
combined Bun workspace using its own frozen lockfile. `scripts/test-extraction.ts`
exports only tracked pinned public source into a disposable platform copy and checks
builds, the installed client, real local PostgreSQL and the compiled Linux artifact.
`.github/workflows/pr-policy.yml` validates the PR route from trusted base workflow
code. GitHub protections require the policy and CI checks before human merges.

## Rejected alternatives

- Ten npm packages: adds publication and version coordination with no distribution need.
- Floating Git branches or sibling source links: builds can change without a platform PR.
- Copied public source committed privately: creates a second source of truth.

## Blast radius & rollback

Workspace resolution, client install commands, CI and deployment checkout change.
Protocol envelopes, game revision IDs and SQL remain unchanged. A previous platform
commit restores the previous source pin and lockfile; deployed binary rollback is
unchanged and preserves stored replay revisions.

## Test plan

Reject publication of public workspaces or any client dependency on internal modules.
Reject missing/wrong/dirty source pins and unsafe cross-boundary imports. Exercise
allowed and denied PR routes against the actual workflow script, including fork dev.
Install the sole client tarball in a fresh consumer and verify imports, CLI startup
and declarations without engine or platform modules. Rehearse frozen installs,
real disposable PostgreSQL and Linux replay, restart cancellation and rollback.
