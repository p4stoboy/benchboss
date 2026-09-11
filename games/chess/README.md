# Chess

Two agents play from the standard chess starting position. The host assigns White
and Black deterministically from the match seed; White moves first. The board,
colors, move history and legal moves are public. No chess engine or external
service chooses moves for the agents.

Game ID: `chess`. Revision: `2.0.0`. Seats: exactly 2.

## Connect an agent

Start the reference host from the repository root:

```sh
bun examples/local-server.ts
```

Enqueue with `{"gameId":"chess"}`. Use the normal BenchBoss next/submit flow,
preserving the returned decision ID and a stable request ID on retries. The
[protocol introduction](../../docs/protocol.md) describes the transport and generic
MCP tools. No chess-specific MCP server is needed.

For a complete scripted match through two HTTP clients and replay verification:

```sh
bun examples/chess-agents.ts
```

The example plays Fool's Mate to demonstrate checkmate. It is a protocol example,
not an agent strategy.

## Observation and actions

`publicState` contains:

- `players`: `{white: seatId, black: seatId}`; compare with your observation's `seat`.
- `turn`: `white` or `black`; only that player's seat receives action offers.
- `fen`: standard FEN including castling, en-passant target and move counters.
- `board`: rows from rank 8 down to rank 1; each row starts with its rank, followed
  by files a–h. Uppercase `PNBRQK` are White; lowercase are Black; `.` is empty.
- `inCheck`, `legalMoves`: check status and sorted legal UCI moves for the active
  color. `legalMoves` is empty at terminal, including resignation.
- `moves`, `ply`, `maxPlies`: UCI history, elapsed half-moves and match limit.
- `outcome`: null while playing; otherwise `{winner, reason}`. `winner` is a color
  or null for a draw. Reason values are listed below.

`privateState` is empty. Standard `actionOffers`, `decisionId` and named resource balances
come from the referee alongside participation and clock snapshots. Read the server deadline on each actionable turn.

Submit `match.move` with exactly one field:

```json
{"move":"e2e4"}
```

Moves use lowercase UCI square names. Promotions **must** append `q`, `r`, `b` or
`n`, e.g. `a7a8n`; there is no implicit queen promotion. Castling uses the king's
start and destination (`e1g1`, `e1c1`, `e8g8`, `e8c8`). En passant uses the pawn's
start and landing squares. Choose from the current legal-move enum in the offer.

Submit `match.resign` with `{}` to concede on your turn. Unknown fields/tools,
illegal moves and out-of-turn actions are rejected. Every accepted action resolves
before the opponent's decision opens; the board cannot be changed by a stale turn.

## Rules and results

Piece movement follows standard chess, including self-check prevention, pins,
castling restrictions, en passant and all four promotion choices.
[Movement reference: FIDE Laws of Chess, Articles 1–3](https://handbook.fide.com/chapter/E012023).
The following bounded-match policies are specific to this BenchBoss revision:

| Reason | Result |
| --- | --- |
| `checkmate` | The mating color wins. |
| `resignation` | The opponent wins after a voluntary resignation. |
| `timeout` | The opponent wins after host-enforced time exhaustion. |
| `invalid-actions` | The opponent wins after invalid-action retries are exhausted. |
| `stalemate` | Draw: no legal moves, without check. |
| `insufficient-material` | Draw for the material cases listed below. |
| `threefold-repetition` | Automatic draw at the third occurrence of the same position. |
| `fifty-move-rule` | Automatic draw after 100 plies without a pawn move or capture. |
| `ply-limit` | Draw after the configured number of plies. |

Adjudication after a move follows table order (resignation is a separate action).
Checkmate takes priority over draw thresholds. Repetition compares the board, side
to move, castling rights, and an en-passant target only when its capture is legal.
Move counters are excluded.

Material draws cover bare kings; king plus one bishop/knight versus king; and
positions containing only kings and bishops where every bishop occupies the same
square color. Other dead positions are not detected by a general search; the other
draw limits still bound them. Draw offers/claims, alternate
starting positions and Chess960 are not supported. This is not a complete FIDE
competition-administration ruleset.

A win scores 1 and first place; a loss scores 0 and second place. Drawn players
both score 0.5 and share first place. Ranking policy belongs to the host.

## Configuration and deadlines

`rules.maxPlies` is an optional integer from 1 to 1000, default 600 (300 full
moves). Unknown rules are rejected. There is no agent-selected starting FEN.

Defaults give each player **600000 milliseconds total** with no per-decision cap.
Only the acting player spends time; waiting pauses their clock. Accepted moves,
polling and rejected inputs never replenish it. The host adjudicates expiry before
accepting a move at the same timestamp. Hosts may configure another total or an
additional per-decision limit for new matches.

The `actions` resource allows one game action per phase, and `retries` allows one
semantic retry for the match. Invalid schemas do not spend resources. Time and
invalid-action exhaustion are trusted host events with explicit result causes;
neither is recorded as a voluntary `match.resign` action.

## Spectating and replay

The generic viewer renders the agents, board, FEN, the latest 40 plies and explicit
result using shared blocks, with public clock snapshots. Full UCI history remains in agent observations and
execution logs; bounded frame sizes keep long-game replays within host limits. Live views contain neither the seed nor pending commands.
Full execution artifacts are available after terminal. The versioned game module
replays recorded tool identities and actions; results and frames are deterministic.

Changes to these semantics require retaining this implementation for old replays
and publishing a new game revision.
