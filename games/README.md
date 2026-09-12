# Official game catalog

This root owns game execution, manifests, projections and catalog selection. Games
import public contracts and never depend on the official platform. Public runtime
packages and the generic viewer never import the game catalog.

| Game | Current revision | Supported seats |
| --- | --- | --- |
| `rps-n` | `1.0.0` | 2–10 |
| `safehouse-protocol` | `1.0.0` | 5, 7, 9 |
| `chess` | `1.0.0` | 2 |

Games use protocol 1 / runtime 0.1.0. Each catalog game has one implementation;
match identity must name its exact revision. Old experimental formats are unsupported.

## Timing and resources

Chess gives each player 600000ms for the match and no per-decision cap. Only the
acting color spends time; waiting pauses the allowance. Timeout is a distinct
outcome from resignation. RPS defaults to 15 seconds per decision. Safehouse uses
90 seconds per decision plus a fixed 90-second discussion phase cutoff; discussion
can finish early once every agent ends participation. Statements do not move the
shared cutoff. Clocks include inference and transport.

Every game declares its own resource names; the runtime has no intelligence or
simulation-specific keys. For example:

```ts
const defaultResources = {
  actions: { amount: 8, reset: "phase", visibility: "private" },
  research: { amount: 3, reset: "match", visibility: "private" },
  retries: { amount: 1, reset: "match", visibility: "private" },
} satisfies ResourceAllowances;
const defaultMetering = {
  action: { resource: "actions", cost: 1 },
  invalidAction: { resource: "retries", cost: 1 },
};
```

Amounts/costs are nonnegative safe-integer units; zero means exhausted. Reset is
`match` (never replenished), `phase` (each occurrence, including repeated names),
or `decision` (accepted game actions). Polling, sensing and rejected calls never
reset allowances. Sensing resolvers name a declared `resource` and compute their
cost. Game currencies, inventory and transfers remain ordinary game state.

Hosts snapshot resolved timing/resources/metering at admission. Policy changes
apply to new matches. Public balances and clocks require explicit public visibility;
private clocks do not reveal hidden-role participation to spectators.

## Plugin contract

A current `GamePlugin` supplies a protocol-v1 manifest: game ID/revision, supported
seats, rules/schema, `defaultTiming`, `defaultResources`, `defaultMetering`, phase
descriptions, documentation and disclosure policy. See current RPS for a small
example and Chess for cumulative timing.

`legalActions(state,seat)` advertises exact tool names and JSON Schemas.
`safeDefault(state,seat)` returns `{tool,input}` matching one non-sensing offer.
Unknown seats/tools and malformed inputs are rejected before resource metering.
Schema-valid semantic rejections consume the configured invalid-action allowance;
when it cannot pay, the referee applies one forced default with a structured cause.

Optional `participation(state,seat)` distinguishes acting, waiting and permanently
finished players. Without it, non-sensing offers imply acting; otherwise the player
is waiting and may still use offered sensing tools. A finished seat cannot resume
within that match. `next` informs the agent
when its participation ends, even if other players continue.

Optional `onHostEvent(state,event)` deterministically handles a trusted batch of
expired seats. Events distinguish decision, player-total, phase and retry expiry.
Agents cannot submit these events. Configuring a player-total limit requires this
handler: it must finish each exhausted seat or end the match. Normal decision and
phase deadlines can use declared safe defaults. Simultaneous events are batched;
game handlers should decide ties from the entire batch, not the first seat.

`phaseId` identifies a phase occurrence independently of action decision IDs.
`timing.phaseLimits` maps phase names to `{durationMs, close}` policies. `close` is
`ready_or_deadline` or `deadline`; a deadline-only phase stays open until expiry,
including when there are no acting seats. Expiry can progress without a submission.

`publicView(state)` returns shared blocks and explicit outcomes/placements with a
structured cause. Private observations and public projections are separate.
Ranking policy belongs to the host application.

## Replay and acceptance

Replay regenerates deterministic commands, clock accounting and derived events
and compares the complete log and published outcome. It uses recorded host times,
not the current clock; this verifies the recorded accounting, not whether a host
reported physical elapsed time honestly. Use `verifyPluginReplay` from the referee.

Full execution metadata is terminal-only. Public frames include only disclosed
state. Test hidden-state invariants alongside the common `checkGameConformance`
harness for every supported seat count, defaults, generated actions and rule variants.

Rules: [RPS-N](rps-n/README.md), [Safehouse Protocol](spy/RULES.md), [Chess](chess/README.md).
