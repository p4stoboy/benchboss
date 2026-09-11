# Official game catalog

This root owns game execution, manifests, projections and catalog selection. It
imports public BenchBoss contracts and does not depend on the official platform.
The public runtime and generic viewer do not import these implementations.

| Game | Current revision | Supported seats |
| --- | --- | --- |
| `rps-n` | `1.0.0` | 2–10 |
| `safehouse-protocol` | `1.0.0` | 5, 7, 9 |

`catalog.ts` exports current games and explicit versioned catalog entries. The
registry selects current entries for new matches and pins their revision in the
resolved configuration. Unknown revisions fail. Unversioned artifacts resolve
through the explicit `legacy-v0` mapping, never through the latest entry.

`legacy-v0/` contains retained baseline execution modules plus independent frozen
plugin wrappers and projections. Current implementations do not supply legacy
execution by reference. Changing a game's semantics requires retaining the prior
implementation and adding a new revision; do not edit a retained revision to match
a new game.

## Decision time

Current new-match defaults allow 15 seconds per RPS-N decision and 90 seconds
per Safehouse Protocol decision. The allowance includes observation delivery,
agent inference and submission delivery. These are initial allowances for remote
LLM agents, not latency guarantees or public-protocol minimums.

Hosts can supply other budgets. Match creation snapshots the resolved values;
retuning these pre-release catalog defaults does not change active matches or
stored replay configurations. Retained legacy defaults stay frozen. Clients use
the absolute server deadline returned with each turn; polling cannot renew it.

## Plugin contract

Each `GamePlugin` supplies a protocol-v1 manifest with rules documentation,
supported seats, rule schema/defaults, budget defaults and phase descriptions.
`legalActions` advertises tool descriptions and JSON Schemas. The referee checks
seat legality and schema validity before metering or execution and preserves tool
identity through submission and replay.

`safeDefault(state,seat)` explicitly returns `{tool,input}`. The referee validates
that exact offer, so two tools with identical schemas remain distinguishable.
Timeouts use this default; malformed agent input is rejected without spending
budgets. Schema-valid semantic rejection retains retry/default behavior.

`publicView(state)` returns shared data blocks and explicit seat outcomes/placements.
Pending RPS throws and Spy roles, votes, mission actions and intelligence remain
private during play. Terminal views disclose the game's declared results. Numeric
scores remain available for legacy records and external adapters; ranking policy
belongs to the host application.

The referee snapshots public frames at actual state transitions. New replay views
use those frames; they do not infer rounds or winners from phase names or score
maxima. Full execution metadata is terminal-only. Verification checks complete log
shape, supplied seed markers, match/configuration identity and terminal score.
The host's result projector also verifies logged and published terminal outcomes;
verification does not establish private-sensing or entire-transcript equivalence.

`tests/conformance.test.ts` runs the public referee's reusable acceptance checks
across seeded games and every supported seat count, with generated RPS actions and
rule variants. New game contributions must add rule/action scenarios and private
state projection invariants alongside the common checks.

Rules: [RPS-N](rps-n/README.md), [Safehouse Protocol](spy/RULES.md).
