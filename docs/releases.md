# Source delivery and client releases

## Repository and branch flow

Public `p4stoboy/benchboss` owns MIT protocol/runtime modules and games. Every
workspace there is `private: true`; none is released to npm. Private
`p4stoboy/benchboss-platform` owns the official service and the one npm distribution,
`@benchboss/mcp-client` (MIT, copyright 2026 Oscar Harris, initially 0.1.0).

Both repositories use feature PRs into `dev`, then `dev` PRs into `main`.
Both branches must require PRs, CI and `PR branch policy`; direct pushes, force
pushes and deletion are disabled, including administrator bypass. The policy runs
from trusted default-branch workflow code and requires the source repository as
well as the branch name for main promotions. Maintainers perform the merges.
Do not require linear history or squash dev-to-main promotions: merge commits keep
shared ancestry for subsequent promotions. Ordinary merges never publish npm.

The empty public remote needs a shared seed commit for main and dev before its
initial feature PR. Seed only repository governance, not application code, then
protect both branches. Initial branch creation requires explicit operator action.
Verify protection and the actual required check names in GitHub; local workflow
files alone do not protect a branch.

## Pinned public source

The platform records the public HTTPS remote in `.gitmodules` and a full commit ID
in the `vendor/benchboss` gitlink. It includes the public modules in its Bun workspace.
Clone with `git clone --recurse-submodules`; after a checkout or pull run:

```sh
git submodule update --init --recursive
bun install --frozen-lockfile
bun run check
bun test
```

The source check rejects a missing submodule, wrong commit or modified tracked source.
Update shared code in the public checkout through feature-to-dev-to-main PRs first.
Then fetch and check out the reviewed public commit in the platform submodule,
run `bun install`, and include its gitlink and lockfile changes in a platform PR.
Never use `git submodule update --remote` in CI, floating branches, sibling symlinks,
or tarball overrides. Third-party dependencies are locked by the platform's Bun lock.

From the platform checkout, `bun run test:extraction` copies its own application and
exports the exact public commit into a disposable workspace. It exercises frozen
installation, source checks, builds, an installed client without engine modules,
real local PostgreSQL, and Linux replay, shutdown and rollback. Python >=3.10 is
required; select another installed interpreter using `BENCHBOSS_TEST_PYTHON`.
The platform can install and pass these checks before any npm publication.

## Sole npm distribution

Agents install `@benchboss/mcp-client`; its command is `benchboss-mcp-client`.
The package bundles the generic client and official adapter, with SDK/Zod as runtime
dependencies. It contains no games, referee, database or private service source.
The generic client still belongs to the public repo and is authentication-neutral.

From the platform checkout, `bun run pack:release --output .local/release-0.1.0`
creates exactly one tarball plus `manifest.json`. The manifest records package
identity, dependencies and SHA-256/SHA-512 checksums. Reusing a candidate directory
fails. Actual tarball installation and declaration checks validate the distribution.

After reviewed code reaches main, explicitly dispatch `Publish MCP client`.
CI retains the checked artifact and the publisher downloads it instead of rebuilding.
It rejects any package other than `@benchboss/mcp-client` and internal runtime
dependencies. An identical published version is skipped; different bytes fail.
Rerun only the publication job after partial failure to reuse its original artifact.

npm requires an existing package before configuring a trusted publisher. Bootstrap
the first real client release explicitly using authenticated npm after main checks;
never publish a placeholder. Then configure `p4stoboy/benchboss-platform`, workflow
`publish-npm.yml`, environment `npm`, with direct publishing allowed. Restrict the
GitHub npm environment to main. Subsequent releases use npm OIDC without a stored
publish token. See [npm trust prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust/).
Bun remains the installer/build tool; npm is only the upload client.

## Deployment

The platform checks out its pinned source before building. Netlify builds at the
repository root and publishes `site/dist`; API delivery uses the tested Linux binary.
Main promotion triggers deployment, while npm publication remains explicit.
The split changes no SQL. Validate real registration, agent play, replay, restart
cancellation and rollback before announcing launch.
