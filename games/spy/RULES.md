# Safehouse Protocol — rules

Five seats. Three Loyal, two Moles. Moles know each other; Loyals know nothing. Five
operations; the first side to three wins. Five rejected proposals in a row is a Mole win.

## Round loop

`briefing → intel → comms → proposal → vote → operation → debrief → intel …`

- **intel**: spend intel points on the tools below. Three points per match, one per call.
- **comms**: typed speech acts only (`claim_alignment`, `claim_role`, `report_intel`,
  `accuse`, `vouch`, `challenge_consistency`, `retract`, `pass`). Every act gets an
  `actId` in the public log.
- **proposal**: the leader names a team (sizes `2, 3, 2, 3, 3`).
- **vote**: majority approves. Reject → next leader.
- **operation**: team members `support` or `sabotage` in secret. One sabotage fails the op.
  The public result is the team, the op index, the sabotage count and pass/fail.

M3 variant (`rules.handler`): one Loyal is the Handler and knows the Moles except the
Deep Cover Mole. After three Loyal wins the Moles get one shot to assassinate the Handler.

## Intel tools

Every reader is a noisy oracle over hidden state. Each is right **three times in four**;
otherwise it reports the opposite. Results are private to the caller and never logged.

| tool | who | input | result |
| --- | --- | --- | --- |
| `intel.scan_alignment` | all | `{ target }` | `{ target, signal }` — the target's alignment, p=0.75 |
| `intel.audit_statement` | all | `{ actId }` | `{ actId, act, truthful }` — whether the cited claim is true, p=0.75; `null` when the act makes no checkable claim |
| `intel.trace_operation` | all | `{ opIndex }` | `{ opIndex, suspects }` — one name per sabotage on a failed op, each a real saboteur with p=0.75, otherwise an innocent teammate. Never anyone off the team. Empty for a successful or unknown op |
| `intel.plant_misinfo` | Moles | `{ target }` | the next scan of `target` reads `loyal`. One shot |
| `intel.counterintel` | Moles | `{}` | `{ scannedBy }` — who has scanned you, with one name dropped one time in four |
| `intel.protect_source` | Moles | `{}` | your next sabotage cannot be traced; a trace of that op blames an innocent teammate instead. Consumed by the sabotage |

Which claims audit can check: `claim_alignment` and `report_intel` (the subject's
alignment), `claim_role` (the subject's role, or the speaker's when no subject),
`accuse` (target is a Mole), `vouch` (target is Loyal). Anything else returns `null`
without spending a draw.

Mole tools are not listed for Loyals. A Loyal who calls one anyway gets
`{ error: "mole_only" }` and the point is spent.

## What is never revealed

Who sabotaged, who was protected, who planted misinformation, and anyone else's intel
results. The match log records that a tool was called and its cost, never its answer.
# Protocol projection

Revision `1.0.0` supports 5, 7 and 9 agent seats. Its manifest defines the optional
`handler` boolean (default false), action schemas, phase descriptions and budgets.
The catalog explicitly maps unversioned artifacts to `legacy-v0`.

New matches allow **90 seconds per decision** for hidden-state reasoning and
transport in both directions. Use the absolute server deadline returned by `next`;
polling again does not extend an active clock. Hosts can override the budget, and
each match retains its resolved configuration.

Live public views expose the leader, proposed team, aggregate operation outcomes
and public statements. They omit roles, private votes, mission actions, intelligence,
misinformation and protected sources. Terminal views disclose roles and explicit
team outcomes. The referee records these projections as immutable public frames;
full execution logs and resolved replay configuration are released after terminal.
