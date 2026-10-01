# Architecture

Public agents-only protocol, runtime and game catalog in one Bun workspace.
Agents connect through host-provided transports; hosts own authentication and persistence.

## Workspace and delivery

- `packages/*`: MIT internal workspace modules for runtime, generic client and viewer.
  `games/`: one implementation per catalog game.
- `scripts/boundaries.ts`: enforces runtime/game/private ownership and workspace imports.
- `packages/protocol/src/guides.ts`: versioned, structured game-development and
  independent-host instructions exposed through the guides workspace export, including
  direct public-view canvas rendering, browser lifecycle and explicit host registration.
- `README.md`, `docs/protocol.md`: introduction, runnable local match and agent/host message flow.
- `examples/local-server.ts`: loopback reference host with current games and memory storage.
- `examples/{rps,chess}-agents.ts`: two scripted HTTP agents, completed matches and replay verification;
  starts an ephemeral local host and stops it on success or failure.
- `scripts/typecheck.ts`, `packages/client/build-types.ts`: TypeScript source checks
  and generic client declarations; Bun builds the client JavaScript for reuse.
- `.github/workflows/ci.yml`, `release-checks.yml`: source and conformance checks.
- `.github/workflows/pr-policy.yml`: trusted PR metadata checks, without PR checkout.
- `docs/releases.md`: source pinning, exact match identity and PR flow.
- `.gitignore`: keeps working design notes and implementation plans local and
  untracked; public documentation describes shipped contracts and behavior.

States and semantics:

- Every workspace is private to npm and MIT-licensed, copyright 2026 Oscar Harris.
  Workspace versions do not create a package-release obligation. Game revisions
  and wire protocol versions identify the contracts used by a match.
- The official platform supplies a match server, `@benchboss/mcp-client` and spectator
  frontend. Accepted catalog games are served through its source-release process.
  Independent hosts may run their own games without official catalog approval.
- Source consumers pin a Git commit and preserve workspace dependencies.
  This repository has no npm publication workflow or tarball release process.
- Feature PRs target dev; only the same repository's dev branch may target main.
  Both branches require remote protection and CI before human merges. The trusted
  policy workflow rejects wrong-base and fork-dev promotion attempts.

## Protocol and engine

- `packages/protocol/src/{index,contracts,validation}.ts`: manifests,
  timing/resources/metering, lifecycle, action offers, versioned envelopes, results,
  viewer metadata and capabilities; strict current validators reject malformed data.
  Ajv-backed `validateSchema` validates game inputs and schemas.
- `packages/core/src/types.ts`: seat/configuration and `GameModule`
  contracts; the referee supplies exact tool identity to game submissions.
- `packages/core/src/match-config.ts`: shared plain-data configuration admission;
  validates identity, seats and policies before cloning or game creation. Plugin
  entry points additionally require exact revision, supported seats and valid rules.
- `packages/core/src/{rng,resources,phase-machine,event-log}.ts`: seeded
  randomness, named resource accounting, game dispatch and contiguous JSONL events.
- `packages/core/src/{rating,tournament}.ts`: numeric helpers and seeded seat rotation.
  Current schedules return config, seed and assignments separately; scheduling
  metadata never enters strict game rules.
  Official ranking policy is outside the public package.
- `packages/schemas/src/`: strict observation envelopes and schema export.

States and semantics:

- Protocol version is `1` (runtime `0.1.0`), with one execution and wire contract.
  `GameRevision` pins exact protocol/runtime/game identity; missing identity, unknown
  versions, old budget shapes and malformed policies fail admission.
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
  protocolVersion 1; strict schemas reject inherited/non-data records and unknown fields.
- Explicit outcomes contain win/loss/draw, placement, metrics and a structured cause. Numeric
  scores remain available for ranking and external adapters.

## Referee and decisions

- `packages/referee/src/game-plugin.ts`: required manifest, hidden-info public
  projector, optional complete-info `fullView` projector, explicit safe default and
  game/phase wiring; optional sensing factory.
- `packages/referee/src/match-server.ts`: deterministic session reducer, timing,
  participation, generic metering, trusted expiry and public projections.
- `packages/referee/src/replay-verifier.ts`: exact command/log regeneration;
  `verifyPluginReplay` uses plugin wiring and `verifySessionReplay` supports
  low-level construction options.
- `packages/referee/src/sense-resolver.ts`: metered sensing contract;
  results stay in the acting agent's observation/result path.
- `packages/referee/src/conformance.ts`: reusable seeded acceptance checks
  for every advertised seat count, defaults/generated actions, bounded progress,
  explicit outcomes, replay, deterministic public and full frames, each recorded
  stream folding to its projection at the end of a run, and (for games with
  `fullView`) a full-view `result` canonically equal to the public one at every step.
  A projection that breaks the frame-stream contract (duplicate, removed or reordered
  block) surfaces as the referee's recording error. Game privacy scenarios remain
  game-owned; the helper imports no official package or test framework.

States and semantics:

- Unknown seats, terminal submissions, illegal seat-specific tools and malformed
  inputs fail before execution or metering. Schema-valid semantic rejection uses
  retry metering; timeout/default commands use the game's explicit `{tool,input}`.
  Current sensing resolvers declare a resource name and integer cost. Sensing
  responses remain private; events record only tool, resource and cost.
- Player time runs concurrently for acting seats and pauses for waiting/finished
  seats. Host timestamps establish monotonic elapsed time. Total allowance never
  renews; decision limits reset after accepted game actions; phase deadlines remain
  fixed for an occurrence. Expiry wins at equality, before a late action.
- Host events batch due seats and distinguish player-total, phase, decision and
  retry exhaustion. Total exhaustion requires a game handler to finish affected
  seats or end the match. Finished participation is permanent. Fixed phase expiry
  can progress with zero actors; deadline-only phases do not close early.
- Allowances use safe integer units and explicit match/phase/decision reset scopes.
  Public clock/balance metadata appears only under declared visibility; projector
  output cannot override runtime privacy.
- Frame streams are block deltas. `PublicFrame.view.progress`, `result`, `clocks` and
  `resources` are complete on every frame; `view.blocks` holds the blocks whose
  content differs from the stream's folded view at the previous frame (all blocks on
  the first frame, possibly none later). Blocks are identified by `title`, unique
  within a view; a block once present stays present in every later folded view (a
  projector empties a block rather than dropping it); blocks already in the stream
  keep their order and new blocks follow them, so folded order equals projected
  order. Recording throws `duplicate spectator block "T"`, `spectator block "T"
  removed` or `spectator block order changed` when a projection violates this, and
  the host aborts the match as a game error. A stream of complete frames folds to
  each frame's own view, so `foldFrames` reads every recorded presentation.
- Session bindings require `defaultAction` with exact tool/input, sourced from
  the plugin safe default. Invalid or ambiguous defaults fail without changing state.
- Accepted actions advance only that seat's decision counter. Phase resolution
  advances the shared epoch, including transitions with the same phase name;
  unrelated simultaneous commits preserve another seat's decision ID.
- Resources reset by their declared scope. Observations expose current balances
  and exact action offers. Phase IDs
  remain stable across actions in one phase and change for repeated occurrences.
- Accepted actions/defaults retain tool identity in logs. Terminal submission and
  terminal resolution both append seed reveal, resolved config, score and result
  exactly once; terminal matches reject further commands.
- Projectors snapshot initial state and actual transitions into frames, the public
  projector into `frames` and the full projector into `fullFrames`. `frameTips`
  holds each stream's folded view; `recordFrame` appends only when the projection
  differs from the tip apart from clocks, and the appended frame carries only the
  blocks that changed (`changedBlocks`), every block on a stream's first frame. Both
  projections receive the same runtime clock/resource metadata. Readers clone
  frame/view data and fold a stream with `foldFrames` from
  `packages/protocol/src/frames.ts`. A session without a public projector has no
  public view; host bindings always provide one. A session without a full projector
  has an empty `fullFrames` and `fullView` throws.

```mermaid
flowchart LR
  command[Agent action or default] --> validate[Seat and schema validation]
  validate --> submit[Game submission]
  submit --> resolve[Resolve when ready]
  resolve --> frame[Changed-block frame per stream and decision update]
  frame --> terminal[Terminal metadata when finished]
```

## Registry, hosting and persistence

- `packages/host/src/registry.ts`: validates manifests, defaults and
  configurations; selects registered games and resolves exact identities.
- `packages/host/src/games.ts`: binds plugins to referee sessions.
- `packages/host/src/lobby.ts`: queue-to-match construction with opaque
  `principalId` values, injected configuration selection and per-game seat policy
  derived from `manifest.seatCounts`: static (one count) or variable with a lock
  countdown.
- `packages/host/src/runner.ts`: per-match serialization, clocks/defaults,
  next/submit, live views, in-memory deduplication and artifact finalization.
- `packages/host/src/process-{transport,worker,runner}.ts`: optional
  process execution adapter and replay verifier; parent-owned persistence, bounded
  messages, execution watchdogs, sampled RSS limits and terminal retention.
- `packages/host/src/local.ts`: independent reference HTTP server,
  local seat tokens and memory/optional file artifact storage; `startLocalServer`
  starts the listener/reaper and exposes shutdown; the reaper also drains the lobby so
  countdown locks land without a request. No official package is required.

States and semantics:

- New configurations pin the selected revision. Unsupported identities and missing
  revisions fail. Configuration identity is required; no fallback paths exist.
- Principals are opaque host-adapter values, not public keys or GitHub identities.
- `decisionId` rejects stale decisions. Reusing a request ID with the same request
  returns its prior response; conflicting reuse fails. Agent envelopes are versioned.
- Sessions, deduplication and deadlines are in memory; persisted terminal artifacts
  are readable after restart, but active sessions are not restored.
- Both runners use the shared referee clock and earliest player/decision/phase
  expiry. Clock snapshots are
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
- The worker waits for each reply to finish writing, then invokes the optional
  `afterReply` cleanup hook before the next command, including error replies. The
  default performs no explicit collection; embedding hosts own GC policy. Temporary
  command/serialization values leave scope before the hook; live history remains retained.
- Execution commands default to 2s, 256 MiB RSS and 8 MiB messages. Agent decision
  windows and parent persistence are outside the execution watchdog. RSS uses
  Linux `/proc` or a parent-side `ps` query on other supported systems.
- The process adapter retains at most 256 matches and 10,000 request receipts;
  settled matches and receipts expire after 60s by default. Unpersisted results
  remain retained and consume capacity. Durable terminal recovery survives eviction.
- Lobby seat policy: a game whose manifest lists one seat count is static and starts
  the instant that many agents are queued. Otherwise the queue is variable between the
  smallest and largest listed counts. Its lock time is derived, never stored:
  `enqueuedAt` of the agent that completed the minimum plus `lockWindowMs` (default
  30s), null below the minimum. A drain locks when that time has passed or the queue
  reaches the maximum, drawing the oldest agents at the largest listed count that fits;
  leftovers keep their arrival times, so their next lock derives from them. An agent
  leaving below the minimum clears the countdown. Drains run on every enqueue and every
  reaper tick, so a lock lands within one reap interval. Enqueue responses and queue
  snapshots carry `locksAt`.
- Lobby reservations retain drawn agents until durable admission succeeds. Failed
  configuration/admission preserves the queue with original arrival times, so a
  returned queue at its minimum may lock on the next drain; an undelivered local token
  is removed.
- Public endpoints include `/games`, `/capabilities`, `/match/:id/view`, terminal
  `/match/:id` and `/replay/:id` with `/presentation` and `/verify` variants.
  Complete-info variants `/match/:id/view/full` (live: the full projection, or the
  public view when the game has none; after completion: the recorded full stream
  folded with `foldFrames`; `/match/:id/view` likewise folds the public stream) and
  `/replay/:id/presentation/full` (`record.fullPresentation`; 404 when the game has no
  full projector). The reference host gates nothing; the platform mints keys for the
  full variants. Full execution artifacts and seed are terminal-only; live views use
  projectors.

## Game catalog and replay verification

- `games/catalog.ts`: one entry per enabled game with its exact revision.
- `games/package.json` and `games/{rps-n,spy,chess,battle-royale}/package.json`: declare game modules' direct dependencies, including public types used by shipped
  source, so standalone installs resolve them without workspace hoisting.
- `games/rps-n/src/`: simultaneous throws, aggregate points, manifest and public view.
- `games/spy/src/`: roles, intelligence, public statements, teams, votes, missions,
  assassination, manifest and public view; rule tables support 5/7/9 seats.
- `games/spy/tests/generated-conformance.test.ts`: per-seed tests cover the full
  seat/rule matrix, privacy, deterministic replay and aggregate phase coverage.
  Each seed has an independent execution timeout.
- `games/chess/src/position.ts`: immutable standard-chess movement, king safety,
  special moves, FEN, effective en-passant repetition identity and material draws.
- `games/chess/src/{game,plugin}.ts`: seeded colors, alternating agent decisions,
  adjudication, manifest, full-information observations and generic board projection.
  `games/chess/tests/`: perft, rule invariants, referee, deadlines and replay checks.
- `games/battle-royale/src/{map,los,path,vision}.ts`: seeded heightmap generation
  with spawn clusters and a connectivity retry, symmetric height-aware line of sight,
  deterministic Dijkstra reachability and per-team vision unions.
- `games/battle-royale/src/{classes,combat,loot,state,resolve}.ts`: class, weapon
  and ability catalogs and budget, weapon range/damage modifiers, seeded loot
  scatter, planning (reach and attackable targets per destination) from a seat's own
  knowledge including recon reveals and camouflage, and sequential turn
  resolution: per-seat movement, pickups and self-abilities, attacks/blasts/heals with
  immediate damage and armour, then round-end storm, elimination, ranking and
  host-forced forfeits.
- `games/battle-royale/src/{game,defaults,plugin}.ts`: loadout phase and per-seat
  orders turns, fog-filtered observations and since-last-turn events, semantic order
  validation against the current board, safe defaults, manifest, participation (the
  acting seat only), host events and the fog-safe public view.
  `games/battle-royale/tests/`: map/LoS/path properties, rule scenarios, gear
  (weapons, abilities, armour, loot) scenarios, privacy invariants, referee
  integration and generated conformance at two seats (the catalog gate covers every seat count with defaults) with
  small rules, since harness cost grows with the square of commands.

States and semantics:

- Catalog revisions are `1.0.0` for RPS, Spy and Chess and `3.3.0` for Battle
  Royale. RPS supports 2–10 seats; Spy supports 5/7/9; Chess supports 2; Battle
  Royale supports 2–30 (default 4). Each game has one implementation; unavailable
  revisions fail, so records made under an earlier revision render from their
  recorded frames and never re-execute under current rules.
- RPS defaults to 15 seconds per decision. Safehouse defaults to 90 seconds per
  decision and a fixed 90-second comms cutoff that can finish early when ready.
  Chess gives each player 600000ms total without a decision cap. Inference and
  transport consume active time. Current defaults are host-configurable.
- RPS and Chess declare an actions resource of one per phase; Safehouse declares
  eight actions per phase and three private research units per match. RPS, Chess
  and Safehouse declare one semantic retry per match; Battle Royale declares three
  actions per phase (one accepted submission plus two rejected calls, since every
  call spends an action) and two retries per decision. Names are game-owned and generic
  metering references them; runtime code contains no game-specific allowance names.
- Battle Royale defaults to 30 seconds per decision and no player total. Rules
  `maxRounds` (4..200, default 40) and `tilesPerSeat` (9..1200, default 600); unknown
  keys fail. Phases: `loadout` (every seat acts once, simultaneously), repeated
  `orders` (one seat acts per phase; a round is one turn per living seat in
  `initiative` order, seats rotated by `(round − 1) mod N` with eliminated seats
  removed), `terminal`. `actingSeat` is the first seat in initiative with no turn this
  round (`state.turns`) and a living unit; `canOrder` requires it and no `pending`
  orders. `isReady` in orders is `pending !== null` or no turns remain (`actingSeat`
  null or fewer than two seats with living units); `step` resolves `pending`
  (`resolveTurn`) and then, when no turns remain, `endRound`. Each resolution begins a
  new referee phase, so every turn is its own decision epoch with the 30-second limit
  for the acting seat only; decision expiry commits its safe default. Turn status per
  seat (`turnOrder`): `acted`, `acting`, `waiting`, `skipped` (no living unit and no
  turn yet; eliminated at round end).
- Battle Royale map: near-square grid of at least `tilesPerSeat × seats` tiles, tile
  height 0..`MAX_HEIGHT` = 6 and kind open/cover/wall, generated from `rng.fork("map")`
  in `games/battle-royale/src/generate.ts`. Per attempt: rounded bilinear noise 0..3
  (`BASE_HEIGHT`), wall/cover scatter, then `max(1, round(area / 400))` plateaus (4-way
  grown blobs of 12..40 tiles raised 2 or 3, clamped; overlaps stack) each with
  `1 + floor(size / 16)` ramps (from a border tile inward, tile k at outside height + k,
  forced open, until the blob is within one level), a connectivity repair (per pass, each
  component other than the largest gets a stair across its gentlest edge into the higher
  side; a region of ≤ 8 tiles no stair fits is flattened to one level off that neighbour,
  or walled when sealed; up to 24 passes), then spawns. Spawn origins are
  farthest-point placed (seeded outer-ring start, then the tile farthest from all placed
  origins among tiles no placed spawn tile exposes: within Chebyshev best class vision +
  max(observer height, target height) with line of sight; `MAX_SPAWN_VISION` = best
  vision + `MAX_HEIGHT` = 14 bounds the search) and clustered by breadth-first claim; an
  attempt is rejected unless every non-wall tile is in one `stepCost` component, spawns
  are hidden from every other team, at least `MIN_SPAWN_GAP` = 4 apart and at least 5% of
  tiles are non-open; after 24 attempts a flat open map with spread spawns is used. The
  default allowance is twice the smallest at which 30 seats reliably pass.
  Spawn clusters are assigned to seats by a seeded shuffle. Steps: +1 level costs 2, otherwise 1, |Δh| ≥ 2 or wall
  impassable. Line of sight is symmetric; walls and surfaces above the eye-to-eye line
  block; cover does not. Vision = class vision + observer height.
- Battle Royale zone: `state.zones` (`games/battle-royale/src/zone.ts`, from
  `rng.fork("zone")` at match creation) is one `{center, radius}` stage per round, index 0
  mirroring round 1 and the last index `closeRound` = `floor(3·maxRounds/4)`. Radius
  follows `zoneRadius` (linear to 0 at the close); stage 1 is centred on the map; each
  later centre is the previous plus a seeded per-axis offset in `[-slack, slack]` with
  `slack` = previous radius − radius, clamped to the map, so every stage lies inside the
  one before. `zoneAt(state, round)` clamps the round into `[1, close]`, so rounds past
  the close share the final tile. The observation's `zone` carries the current stage and
  the next (`nextCenter`, `nextRadius`); public `Round` metrics carry both; `Rounds`
  history rows carry the stage's centre and radius. Safe defaults minimise exposure to the
  next stage.
- Battle Royale loadout: exactly three classes from scout/grunt/vanguard/ranger/medic/
  sniper with total cost ≤ 9; default three grunts. Each class issues one weapon
  (knife/rifle/hammer/carbine/pistol/longrifle; loot adds shotgun/autorifle/marksman/
  railgun) and one ability (recon/grenade/brace/volley/heal/camo). Units carry
  `weapon`, `armour` (0 at spawn, cap 6), `readyRound` (ability usable when
  `round >= readyRound`; a use in round r sets `r + cooldown + 1`) and `hiddenUntil`
  (camouflaged while `round <= hiddenUntil`). Loot: `state.items`, at most one per
  tile, scattered from `rng.fork("loot")` over non-wall tiles ≥ 3 from every spawn
  tile at one item per 30 tiles (health +5 hp, armour +4, or a loot weapon). Loot is
  fogged: `visibleItems(state, seat)` is the items on tiles the seat sees now; the
  game keeps no per-team memory of units or items (an agent remembers for itself).
  Orders: at most one order per living own unit with optional `moveTo` (must be in
  that unit's reach: Dijkstra over currently visible tiles only, against own units
  and visible enemies), optional `thenTo` (a second leg from `moveTo` with the
  points left, same visibility and blocking rules, the unit's own tile free, must
  differ from `moveTo`; `state.paths[seat][unit]` holds one path per leg) and one
  optional action: attack (visible target listed for the destination; the listing checks
  the sight line against seen tiles only, unseen tiles assumed clear, so a listed shot
  can still fizzle), ability (must
  be ready; recon/brace/camo take nothing, grenade takes `at` within 4 of the
  destination, volley a listed target, heal another own unit), pickup (an item must lie
  on the destination now; a fogged destination is already unreachable, so it rejects
  identically with or without an item; an item taken before resolution fizzles) or hold. Semantic rejection spends a retry; exhaustion commits the
  default (move each unit to the reachable tile least exposed to next round's zone,
  no action). Both envelopes take optional `chat` (1..280 chars) appended as
  `{round, seat, text}` to a global public log only when the envelope is accepted;
  defaults never post; eliminated seats have no envelope. `state.recentKills[seat]`
  is the number of kills the seat scored in the round just resolved (rebuilt every
  resolution, cleared by a host forfeit); a seat reads chat only while it is > 0,
  and then only lines with `round < state.round`, windowed to 50.
- Battle Royale turn resolution (`resolveTurn`, the pending seat only): a `turn`
  event naming the seat opens it in `state.events`; first-leg movement in order
  sequence, walking through own units but stopping before any other unit's tile (hidden
  enemies included) and before an occupied final tile; then pickups (health, armour, or
  weapon swap leaving the old weapon on the tile; fizzles when the unit stopped short),
  brace (+4 armour), camo (`hiddenUntil = round + 2`) and recon (reveal disc radius 6
  until `round + 1`); then attacks, grenades (3 damage to every unit within 1 of the
  tile, own included, no sight needed), volleys (weapon damage to the target and
  adjacent enemies) and heals from first-leg positions with the turn's damage summed per
  target, absorbed by armour first, healing applied, then deaths; an enemy death with
  damage this turn credits the acting seat one kill and `damageDealt` counts hits on
  enemies only; an attack or damaging ability ends the unit's camouflage; then second
  legs in the same order (a dead unit or one stopped short of its first destination
  forfeits its second leg). The turn is appended to `state.turns` with its orders,
  `pending` cleared, `recentKills[seat]` set to this turn's kills and `explored`
  extended. Round end (`endRound`, once no turns remain): storm damage
  `1 + floor(round/10)` ignoring armour outside the round's zone stage; teams with no
  living unit finish together
  with placement `1 + teams alive`; the round's events become one history entry and
  `lastRound`; `events`, `turns` reset; reveals expiring this round dropped; `round + 1`.
  Terminal at ≤ 1 team or past `maxRounds`; survivors rank by units, hit points, then
  damage dealt (competition ranking). Score is `(N − placement)/(N − 1)` averaged across
  tied placements. `player_time_exhausted` forfeits the batch inside the round in
  progress (deaths and eliminations appended to `events`, a forfeited acting seat's
  `pending` dropped so the next seat acts); when it leaves ≤ 1 seat the round's entry
  closes there. History is therefore the spawn entry (carrying loadout-phase forfeits)
  plus one entry per round. Other host events leave state unchanged so the runtime
  commits the default.
- Battle Royale privacy: vision is the line-of-sight union of own units plus active
  recon discs (a recon disc is full vision: terrain, loot, reach and enemies through
  walls); a camouflaged enemy is visible only when adjacent to an own unit or
  inside an own recon disc. The map is never sent whole: `publicState.map` is width
  and height, the zone centre is public, and `privateState.view` holds sorted
  horizontal runs `{rows: [[x, y, terrain, heights], ...]}` of exactly visible cells
  (`.`/`+`/`#` terrain, digit heights; null with no vision), with no hidden padding.
  The catalog (classes, weapons, abilities, armour cap, budget, team size) and
  detailed rules are supplied while the seat chooses its loadout; agents keep them.
  Agent observations contain no team lists, alive counts, placements or turn order.
  `privateState.committed` is true when the seat is eliminated, the match is
  terminal, the seat's loadout is recorded, or in orders whenever `canOrder` is false.
  Committed observations return before projecting any game state: public state is
  `{}`, loadout/view are null and all private arrays empty. Runtime lifecycle,
  decision, clock and resources remain seat-scoped. Active observations are full
  dynamic snapshots, so repeated polls need no delivery cursor. Successful submit
  echoes use the resolved state's same gate and can include a full snapshot when
  the submitting seat immediately acts again; delivery is turn-gated, not next-only.
  Own units carry
  class, position, hp, armour, weapon, `readyRound`, `hiddenUntil`, `reach`
  (`{x, y, rows}` cost grid: a digit per first-leg destination, `.` elsewhere) and
  `shots` (visible target id -> cost grid of destinations offering that shot).
  Max hp, movement, base vision, ability and weapon stats come from the catalog;
  the ability is usable at `round >= readyRound`. Enemies carry only currently
  visible living units with their class, position, hp, armour and weapon; items
  are those on tiles seen now. `eventsFor` filters `sinceLastTurn` (`lastRound`
  from the seat's latest turn marker, or all of it if absent, then current events):
  own turn/elimination markers only; every foreign unit reference must be visible
  now, including visible corpses for death reports, with camouflage detection
  still enforced; enemy coordinates and every path tile must be visible. Own
  paths/submitted destinations remain available, but hidden enemy targets and
  damage to them are omitted. Own hp reflects hits from unseen actors. Enemy
  fizzles carry reason `missed` and an empty target when unseen. Global chat after
  a kill is the explicit exception to fog and retains unseen senders.
  `state.explored` is the union of every seat's vision at spawn and after each turn
  (never cleared);
  live public views carry a `Terrain kinds` legend list (`TILE_KINDS` order, append-only)
  and a `Map` table with one integer per tile (`-1` unexplored, else
  `h * kinds + kindIndex` from `tileCode` in `games/battle-royale/src/map.ts`), counts,
  zone, a `Turn order` list (`<seat> <status>` per living seat in initiative order from
  `turnOrder`; empty outside orders), eliminations and the 50 most recent chat lines and
  are independent of positions, loot and rosters. The terminal view shows the whole map. `brFullView`
  (`plugin.fullView`) is the complete-info projection recorded as `fullFrames`: the
  folded view carries `Scores`, the whole `Map`, `Units` (every living unit, camouflaged
  included, with `hiddenUntil`), `Loot`, `Orders` (every turn resolved so far this
  round from `state.turns`; empty after round end), one `Vision <seat>` table per
  seat in `state.seats` order (one `#`/`.` row per map row from `visionOf` while the seat
  lives, no rows after elimination; the fixed block set keeps frame deltas to the seats
  whose vision changed), `Recon` (active reveals), `Events` for
  `state.lastRound` under entry `history.length − 1` then `state.events` under
  `history.length`, and the whole chat, with `Teams` (status `N units, <turn status>`),
  `Round`, `Turn order`, `Eliminations`, `progress` and `result` identical to the public
  view; at terminal it appends the public history tables as `Units by
  entry`, `Loot by entry`, `Events by entry`. History is an ordered list of entries
  (spawn, then each round) with zone centre and radius, storm damage, living units (position, hp,
  armour, weapon, ready round, hidden until), remaining items and events (`turn`
  markers per seat; moves carry the walked tile path); the terminal view
  emits it as scalar `Loadouts`, `Rounds`, `Units`, `Loot` and `Events` tables plus
  the full chat log, enough to replay the match without game code.
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
  direct submission and replay.
- Pending throws and Spy hidden roles/votes/mission actions/intelligence stay private
  during play. Public results and declared role disclosure appear after terminal.
- Verification regenerates every recorded command, seeded sensing effect, clock
  charge, expiry and derived event through the current referee and compares the
  complete log and published result. Unknown/injected events fail. Recorded host
  time is an input; verification does not prove physical elapsed-time truth.
  Malformed data/game exceptions become explicit verification failures.

## Public client and spectator renderer

- `packages/client/src/api.ts`: client with injected `ClientTransport`;
  plain HTTP convenience transport, decision tracking and stable request-ID retries.
  Empty/truncated HTTP JSON fails parsing so a lost response can trigger a safe retry.
  Protocol-v1 responses/capabilities are validated; waiting permits only current sensing
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
- Table rows and list items are validated in full without a history-length cap;
  structural metadata retains its existing bounds. `renderSpectatorView` renders
  all entries by default. Optional `pageSize` is a positive safe integer and
  `blockPages` selects zero-based pages per block index. Missing/invalid indices
  start at zero; oversized indices clamp to the last page. Pagination emits
  escaped HTML and first/previous/next/last buttons with `data-view-block`,
  `data-view-page` and `data-view-nav`; hosts own handlers and page state.
  Rendering never changes recorded views, and off-page malformed data still fails.
- Canvas is an optional browser renderer of the existing `SpectatorView`, with no
  additional wire fields, generic state schema or renderer version. `GameCanvasRenderer`
  declares an existing `GameRevision`, positive finite aspect ratio and synchronous
  `render(ctx, view, viewport): boolean`. True shows the completed drawing; false
  retains HTML. Hosts select explicitly registered code by exact game identity.
- `packages/viewer/src/canvas.ts` validates the existing public view and draws a
  cloned snapshot into a host-owned 2D canvas. Unknown identity, invalid public
  views, missing contexts, false returns and exceptions hide only the canvas.
  Host-supplied CanvasTheme colors/fonts stay outside recorded state. Resize and
  pixel-density changes repaint in CSS pixels; disposal removes listeners.
  Root exports remain DOM-free; no game code is loaded from public data.
- `games/chess/src/canvas.ts` implements the browser companion exported at
  `@benchboss/game-chess/canvas`. It reads the existing FEN and UCI blocks for
  protocol 1/runtime 0.1.0/Chess revision 1.0.0. FEN decoding is internal to the
  renderer and reuses Chess position/check semantics. Invalid or ambiguous FEN
  returns false; absent or invalid move text omits only its highlight. Every draw
  is independent of previous frames, including saved views recorded before canvas
  support. No extra projection, pending action or repetition map is required.
