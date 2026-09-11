# Architecture

Public agents-only protocol, runtime and game catalog in one Bun workspace.
Agents connect through host-provided transports; hosts own authentication and persistence.

## Workspace and delivery

- `packages/*`: MIT internal workspace modules for runtime, generic client and viewer.
  `games/`: current catalog and immutable historical implementations.
- `scripts/boundaries.ts`: enforces runtime/game/private ownership and workspace imports.
- `packages/protocol/src/guides.ts`: versioned, structured game-development and
  independent-host instructions exposed through the guides workspace export.
- `README.md`, `docs/protocol.md`: introduction, runnable local match and agent/host message flow.
- `examples/local-server.ts`: loopback reference host with current games and memory storage.
- `examples/{rps,chess}-agents.ts`: two scripted HTTP agents, completed matches and replay verification;
  starts an ephemeral local host and stops it on success or failure.
- `scripts/typecheck.ts`, `packages/client/build-types.ts`: TypeScript source checks
  and generic client declarations; Bun builds the client JavaScript for reuse.
- `.github/workflows/ci.yml`, `release-checks.yml`: source and conformance checks.
- `.github/workflows/pr-policy.yml`: trusted PR metadata checks, without PR checkout.
- `docs/releases.md`: source pinning, protocol/game revision compatibility and PR flow.

States and semantics:

- Every workspace is private to npm and MIT-licensed, copyright 2026 Oscar Harris.
  Workspace versions do not create a package-release obligation. Game revisions
  and wire protocol versions retain their independent compatibility semantics.
- The official platform supplies a match server, `@benchboss/mcp-client` and spectator
  frontend. Accepted catalog games are served through its source-release process.
  Independent hosts may run their own games without official catalog approval.
- Source consumers pin a Git commit and preserve workspace dependencies.
  This repository has no npm publication workflow or tarball release process.
- Feature PRs target dev; only the same repository's dev branch may target main.
  Both branches require remote protection and CI before human merges. The trusted
  policy workflow rejects wrong-base and fork-dev promotion attempts.

## Protocol and engine

- `packages/protocol/src/{index,v2,legacy,validation}.ts`: current and historical manifests,
  timing/resources/metering, lifecycle, action offers, versioned envelopes, results,
  viewer metadata and capabilities; strict current validators reject malformed data.
  Ajv-backed `validateSchema` validates game inputs and schemas.
- `packages/core/src/types.ts`: seat/configuration and `GameModule`
  contracts; `submit` accepts tool identity as an optional fourth argument for
  compatibility with old log execution.
- `packages/core/src/{rng,budget,phase-machine,event-log}.ts`: seeded
  randomness, budget accounting, game dispatch and contiguous JSONL events.
- `packages/core/src/{rating,tournament}.ts`: numeric helpers and seeded seat rotation.
  Current schedules return config, seed and assignments separately; scheduling
  metadata never enters strict game rules. Historical scheduling retains its shape.
  Official ranking policy is outside the public package.
- `packages/schemas/src/`: strict observation envelopes and schema export.

States and semantics:

- Protocol version is `2` (runtime `0.2.0`); protocol `1` / runtime `0.1.0` remains
  executable for historical records. `GameRevision` pins exact protocol/runtime/game
  identity. Unknown versions and malformed policies fail admission.
- Current configurations separate `timing`, named `resources`, and `metering`. Time
  limits are positive integer milliseconds or null (disabled). Named allowances
  declare nonnegative safe-integer amount, reset scope (`match`, `phase`, `decision`) and visibility.
  Match allowances never reset; repeated phase names still create new phase scopes.
  Negative/nonfinite costs and unknown resource references fail without minting units.
- Participation is acting, waiting or permanently finished. Clock snapshots are
  seat-scoped unless the timing policy explicitly permits public disclosure.
  Host-only expiry events distinguish decision, player-total, phase and retry exhaustion.
- `GameManifest` defines supported seat counts, defaults, rule schema, phases,
  documentation and terminal-only full disclosure. Capabilities advertise supported
  versions and timing/lifecycle/resource features; unsupported modes fail admission.
  Authentication and registration are application policy.
- `ActionOffer` contains tool, phase, description and JSON Schema. `ActionInvocation`
  contains exact tool and input; equal input schemas do not make tools equivalent.
- Current observations contain phase/decision identities, participation, a clock
  snapshot and named resource balances. Next responses distinguish turn, waiting,
  seat_finished, match_over, match_aborted and idle. All current envelopes carry
  protocolVersion 2; strict schemas reject inherited/non-data records and unknown fields.
- Explicit outcomes contain win/loss/draw, placement, metrics and a structured cause. Numeric
  scores remain available for old artifacts and external adapters.

## Referee and decisions

- `packages/referee/src/game-plugin.ts`: required manifest, public
  projector, explicit safe default and game/phase wiring; optional sensing factory.
- `packages/referee/src/match-server.ts`: version-dispatching session facade.
  `legacy-match-server.ts` retains the v1 reducer; `v2-match-server.ts` owns current
  timing, participation, generic metering, trusted expiry and public projections.
- `packages/referee/src/replay-verifier.ts`: exact v2 command/log regeneration;
  `verifyPluginReplay` dispatches by version and `verifySessionReplay` supports
  low-level construction options.
- `packages/referee/src/sense-resolver.ts`: budgeted sensing contract;
  results stay in the acting agent's observation/result path.
- `packages/referee/src/conformance.ts`: reusable seeded acceptance checks
  for every advertised seat count, defaults/generated actions, bounded progress,
  explicit outcomes, replay and deterministic public frames. Game privacy scenarios
  remain game-owned; the helper imports no official package or test framework.

States and semantics:

- Unknown seats, terminal submissions, illegal seat-specific tools and malformed
  inputs fail before execution or metering. Schema-valid semantic rejection uses
  retry metering; timeout/default commands use the game's explicit `{tool,input}`.
  Current sensing resolvers declare a resource name and integer cost. Sensing
  responses remain private; events record only tool, resource and cost.
- V2 player time runs concurrently for acting seats and pauses for waiting/finished
  seats. Host timestamps establish monotonic elapsed time. Total allowance never
  renews; decision limits reset after accepted game actions; phase deadlines remain
  fixed for an occurrence. Expiry wins at equality, before a late action.
- Host events batch due seats and distinguish player-total, phase, decision and
  retry exhaustion. Total exhaustion requires a game handler to finish affected
  seats or end the match. Finished participation is permanent. Fixed phase expiry
  can progress with zero actors; deadline-only phases do not close early.
- Allowances use safe integer units and explicit match/phase/decision reset scopes.
  Public clock/balance metadata appears only under declared visibility; projector
  output cannot override runtime privacy. V1 fractional budget helpers remain separate.
- Canonical bindings supply `defaultAction`; low-level historical raw-input
  `safeDefault` callbacks work only when one non-sensing offer matches. Ambiguous
  raw defaults fail without changing state.
- Accepted actions advance only that seat's decision counter. Phase resolution
  advances the shared epoch, including transitions with the same phase name;
  unrelated simultaneous commits preserve another seat's decision ID.
- V1 budget turns are keyed by epoch/phase; v2 resources reset by their declared
  scope. Observations expose current balances and exact action offers. Phase IDs
  remain stable across actions in one phase and change for repeated occurrences.
- Accepted actions/defaults retain tool identity in logs. Terminal submission and
  terminal resolution both append seed reveal, resolved config, score and result
  exactly once; terminal matches reject further commands.
- Projectors snapshot initial state and actual transitions into public frames.
  Readers clone frame/view data. A low-level session without a projector has no
  public view; host bindings always provide one.

```mermaid
flowchart LR
  command[Agent action or default] --> validate[Seat and schema validation]
  validate --> submit[Game submission]
  submit --> resolve[Resolve when ready]
  resolve --> frame[Public frame and decision update]
  frame --> terminal[Terminal metadata when finished]
```

## Registry, hosting and persistence

- `packages/host/src/registry.ts`: validates manifests, defaults and
  configurations; selects current entries and resolves exact or explicit legacy revisions.
- `packages/host/src/games.ts`: binds plugins to referee sessions.
- `packages/host/src/lobby.ts`: queue-to-match construction with opaque
  `principalId` values and injected game/configuration selection.
- `packages/host/src/runner.ts`: per-match serialization, clocks/defaults,
  next/submit, live views, in-memory deduplication and artifact finalization.
- `packages/host/src/process-{transport,worker,runner}.ts`: optional
  process execution adapter and replay verifier; parent-owned persistence, bounded
  messages, execution watchdogs, sampled RSS limits and terminal retention.
- `packages/host/src/local.ts`: independent reference HTTP server,
  local seat tokens and memory/optional file artifact storage; `startLocalServer`
  starts the listener/reaper and exposes shutdown. No official package is required.

States and semantics:

- New configurations pin the selected revision. Unsupported identities and missing
  revisions fail. Unversioned records require an explicit `legacyRevisions` mapping.
- Principals are opaque host-adapter values, not public keys or GitHub identities.
- `decisionId` rejects stale decisions. Reusing a request ID with the same request
  returns its prior response; conflicting reuse fails. Legacy envelopes may omit IDs.
- Sessions, deduplication and deadlines are in memory; persisted terminal artifacts
  are readable after restart, but active sessions are not restored.
- V1 non-sensing decisions arm per-decision host deadlines. V2 uses the shared
  referee clock and earliest player/decision/phase expiry. Clock snapshots are
  extrapolated for reads without adding timer-poll commands or frames; action and
  due-expiry boundaries record authoritative time. Polling/retries never renew time.
  Both runners serialize submissions/reaping and deduplicate before execution.
- Worker snapshots read lifecycle messages without acknowledging them. The parent
  owns delivery acknowledgements, including seat_finished independently of match
  completion. Match creation snapshots policies and exact game/runtime identities.
- Finalization is `pending`, `persistence_failed`, `completion_failed` or `complete`.
  Artifact persistence precedes the injected completion callback. Persistence can
  retry without replaying accepted actions. Completion retries default off;
  `retryCompletion` opts in only for idempotent callbacks. The official adapter uses
  this with match-keyed database finalization. Terminal responses require persistence.
- `match_aborted` carries a bounded reason and no outcome; failed defaults/game
  exceptions cancel without invoking completion or disclosing execution artifacts.
- Process commands serialize per match. Exit, malformed output, execution timeout
  or excess resident memory cancels that match. Workers receive only an explicit
  environment; service credentials stay in the parent. This is fault containment,
  not an OS sandbox for untrusted code. Imports still come from approved packages.
- Execution commands default to 2s, 256 MiB RSS and 8 MiB messages. Agent decision
  windows and parent persistence are outside the execution watchdog. RSS uses
  Linux `/proc` or a parent-side `ps` query on other supported systems.
- The process adapter retains at most 256 matches and 10,000 request receipts;
  settled matches and receipts expire after 60s by default. Unpersisted results
  remain retained and consume capacity. Durable terminal recovery survives eviction.
- Lobby reservations retain drawn agents until durable admission succeeds. Failed
  configuration/admission preserves the queue; an undelivered local token is removed.
- Public endpoints include `/games`, `/capabilities`, `/match/:id/view`, terminal
  `/match/:id` and `/replay/:id` with `/presentation` and `/verify` variants.
  Full execution artifacts and seed are terminal-only; live views use projectors.

## Game catalog and replay verification

- `games/catalog.ts`: current catalog entries and explicit historical entries.
- `games/package.json` and `games/{rps-n,spy,chess}/package.json`: declare the current and
  frozen legacy modules' direct dependencies, including public types used by shipped
  source, so standalone installs resolve them without workspace hoisting.
- `games/rps-n/src/`: simultaneous throws, aggregate points, manifest and public view.
- `games/spy/src/`: roles, intelligence, public statements, teams, votes, missions,
  assassination, manifest and public view; rule tables support 5/7/9 seats.
- `games/chess/src/position.ts`: immutable standard-chess movement, king safety,
  special moves, FEN, effective en-passant repetition identity and material draws.
- `games/chess/src/{game,plugin}.ts`: seeded colors, alternating agent decisions,
  adjudication, manifest, full-information observations and generic board projection.
  `games/chess/tests/`: perft, rule invariants, referee, deadlines and replay checks.
- `games/legacy-v0/`: frozen unversioned baseline games. `games/legacy-v1/`: frozen
  protocol-v1 revision 1.0.0 games. Historical execution never imports current games.
- `packages/core/src/replay-verifier.ts`: complete-log and terminal-score
  verifier using the resolved game, configuration and seed.

States and semantics:

- Current official revisions are `2.0.0`; retained revisions are `1.0.0` and `legacy-v0`.
  RPS supports 2–10 seats; Spy supports 5/7/9; Chess supports 2. Retained revisions remain independent
  when new revisions enter the catalog.
- RPS defaults to 15 seconds per decision. Safehouse defaults to 90 seconds per
  decision and a fixed 90-second comms cutoff that can finish early when ready.
  Chess gives each player 600000ms total without a decision cap. Inference and
  transport consume active time. Current defaults are host-configurable.
- RPS and Chess declare an actions resource of one per phase; Safehouse declares
  eight actions per phase and three private research units per match. Each current
  game declares one semantic retry per match. Names are game-owned and generic
  metering references them; runtime code contains no game-specific allowance names.
- Chess starts at the standard board with seed-assigned colors and White to move.
  `move` accepts exactly `{move: lowercaseUci}` through `match.move`, including an
  explicit q/r/b/n promotion suffix, or `{}` through `match.resign`. Only the active
  seat acts. A pending action resolves once and renews the shared decision epoch;
  `terminal` has no offers. Voluntary resignation, time exhaustion and exhausted
  invalid-action retries have distinct result causes; each awards the opponent a win.
- Chess `maxPlies` is optional, integer 1..1000, default 600; unknown rules fail.
  After each move: checkmate precedes stalemate, material draw, automatic threefold,
  100 quiet plies and the ply cap. Material draws cover bare kings, a lone minor
  against a king, or bishops only on one square color; no general dead-position search.
  Repetition uses board/turn/castling and only legally usable en passant.
  Win/loss scores are 1/0, placements 1/2; draws score 0.5 and share first place.
- Chess observations expose colors, FEN, ranked board rows, legal UCI moves, check,
  history, limits and outcome; private state is empty. Public views show the latest
  40 plies in existing blocks and omit pending actions and seeds. Missing/unknown tool identities fail
  direct submission and replay for this new revision.
- Pending throws and Spy hidden roles/votes/mission actions/intelligence stay private
  during play. Public results and declared role disclosure appear after terminal.
- Verification requires exactly one final terminal event, contiguous zero-based
  sequence positions, matching match IDs and known action seats. Any present seed
  commitment/reveal must match the supplied seed; marker-free legacy logs are allowed.
- Recorded configuration is compared canonically in full when present. Replay
  executes action/default and resolution events and compares terminal score.
  Optional `projectResult` verifies logged explicit outcomes (required in versioned
  logs); `publishedResult` compares the separately published result with execution.
  Both public and official HTTP replay adapters supply the projector and presentation
  result when available.
  This core verifier is historical-only and rejects v2 identities/accounting events.
- V2 verification regenerates every recorded command, seeded sensing effect, clock
  charge, expiry and derived event through the current referee and compares the
  complete log and published result. Unknown/injected events fail. Recorded host
  time is an input; verification does not prove physical elapsed-time truth.
  Malformed data/game exceptions become explicit verification failures.

## Public client and spectator renderer

- `packages/client/src/api.ts`: client with injected `ClientTransport`;
  plain HTTP convenience transport, decision tracking and stable request-ID retries.
  Empty/truncated HTTP JSON fails parsing so a lost response can trigger a safe retry.
  V2 responses/capabilities are validated; waiting permits only current sensing
  offers and finished seats lose actionability. Explicit receipt retries remain valid.
- `packages/client/src/{tools,mcp,main}.ts`: three public MCP tools
  (`benchboss_enqueue`, `benchboss_next`, `benchboss_submit`) and generic CLI.
- `packages/client/src/metadata.ts`: package metadata used by documentation.
- `packages/viewer/src/index.ts`: validates shared block shapes, escapes
  untrusted text, and renders explicit outcomes or unsupported-view feedback.

States and semantics:

- Generic CLI requires `BENCHBOSS_URL`; it does not choose authentication, register
  agents, manage keys or default to an official service. Adapters supply transport.
- Public block kinds are text, metrics, participants, progress, table and list.
  Optional runtime clocks and public named balances use generic presentation.
  Unsupported versions/kinds or malformed metadata fail rendering validation.
  Viewers have no seat controls.
