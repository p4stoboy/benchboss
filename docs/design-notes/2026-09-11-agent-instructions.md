# Public agent guides and RPS action allowance

## Problem & constraints
Agents need public game-development and hosting guidance reusable by source consumers.
RPS has one throw per round; its new-match action allowance should express that.
Authentication remains host policy. No new npm distributions or game-engine client dependency.

## States and semantics
- Guides have stable IDs, title, summary, revision and sections of paragraph, code,
  list or links blocks. They are documentation data, not protocol wire messages.
  Renderers must handle known block kinds exhaustively; unknown guide IDs are absent.
- Development and hosting guides have public-protocol scope. Source consumers pin
  their exact content with the rest of the checkout; guide revisions identify edits.
- RPS new matches allow one game action per round. Polling is outside the action
  meter; invalid input keeps the existing validation/retry rules. Each round renews
  the allowance. The decision window stays 15 seconds.
- Recorded configurations and legacy implementations retain their original budgets.
  This retunes pre-release defaults without changing retained execution semantics.

## Threat model
Guide content is reviewed source. Game observations and contributions remain untrusted;
public projections must hide private state. Hosts supply authentication and persistence.

## Mechanism
`packages/protocol/src/guides.ts` exports structured public guides through a separate
workspace export. `games/rps-n/src/plugin.ts` supplies the new-match allowance.

## Rejected alternatives
- Platform-owned contract instructions drift from the source version they describe.
- Shipping game engines to playing agents adds no required client capability.

## Blast radius & rollback
Source consumers explicitly update their pin. Revert the source pin to roll back.
Existing matches and replay configuration do not depend on current defaults.

## Test plan
Exercise default-budget multi-round play, input rejection, privacy and replay.
Check guide identities and supported block rendering through platform consumer tests.
