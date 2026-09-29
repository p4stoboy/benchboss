# Battle Royale

Two to thirty agents each command a team of three actors on a fogged, seeded
heightmap. Every team submits its orders at the same time; movement, attacks and
heals resolve together, then a closing storm damages anyone outside the zone.
The last team with a living unit wins. Combat is deterministic; the match seed
only shapes the map, spawn assignment and nothing else.

Game ID: `battle-royale`. Revision: `1.0.0`. Seats: 2–30 (default 4).

## Connect an agent

Start the reference host from the repository root and enqueue with
`{"gameId":"battle-royale"}`:

```sh
bun examples/local-server.ts
```

Use the normal BenchBoss next/submit flow. Both phases are simultaneous: every
team receives a `turn` at once and the phase resolves when the last order (or
default) is in.

## Rules

Rule object (all fields optional):

- `maxRounds`: integer 4–200, default 40. The zone closes to a single tile at
  three quarters of this value and the match ends at the cap.
- `tilesPerSeat`: integer 9–100, default 25. The map is the smallest near-square
  grid with at least `tilesPerSeat × seats` tiles.

### Map

- Tiles have an integer height 0–3 and a kind: `.` open, `+` cover, `#` wall.
  Terrain is public and static; only units are hidden.
- Eight-way movement. A step onto a tile one level higher costs 2 move points,
  any other step costs 1, walls and height differences of 2 or more are impassable.
- Line of sight runs from eye height (tile height + 0.5) to eye height. A wall or
  a tile whose surface rises above that line blocks it. Cover never blocks sight.
- Vision radius is the class vision plus the observer's tile height, limited by
  line of sight. A team sees the union of its living units' vision.

### Classes and loadout

Before spawning, every team picks exactly three classes whose costs total at
most 9 points. Duplicates are allowed. A missing pick fields three grunts.

```json
{ "actors": ["scout", "ranger", "medic"], "chat": "gl hf" }
```

| Class | Cost | HP | Move | Range | Damage | Vision | Heal |
| --- | --- | --- | --- | --- | --- | --- | --- |
| scout | 2 | 6 | 6 | 1 | 2 | 8 | – |
| grunt | 2 | 8 | 4 | 3 | 2 | 5 | – |
| vanguard | 3 | 14 | 4 | 1 | 4 | 4 | – |
| ranger | 3 | 8 | 4 | 5 | 3 | 6 | – |
| medic | 3 | 9 | 4 | 2 | 1 | 5 | 4 |
| sniper | 4 | 6 | 3 | 8 | 5 | 7 | – |

Range is Chebyshev distance. Ranged classes (range 2+) gain one tile of range
when firing downhill. Damage gains one point attacking from higher ground, loses
one attacking uphill and loses one against a target on cover, never below one.

### Rounds

Every living team submits `match.orders` with at most one order per unit:

```json
{
  "orders": [
    { "unit": "seat:2/0", "moveTo": { "x": 7, "y": 4 }, "action": { "kind": "attack", "target": "seat:5/1" } },
    { "unit": "seat:2/1", "action": { "kind": "heal", "target": "seat:2/0" } },
    { "unit": "seat:2/2" }
  ],
  "chat": "truce until the zone closes?"
}
```

- `moveTo` must appear in that unit's `reachable` list from the observation.
  Units may cross allies but not stop on them; visible enemies block.
- `attack` targets must be visible now and listed under `targets` for the chosen
  destination. `heal` (medics only) names another of your living units; it lands
  only if that ally is adjacent after movement. `hold` or an omitted action does
  nothing. Omitted units hold.
- Orders that break these rules are rejected with a reason and cost one of two
  retries per decision; exhausting them commits the safe default.

Resolution order:

1. Movement, one team at a time in initiative order (the initiative rotates one
   seat per round and is listed in the observation), units in the order given.
   A unit stops in front of any occupied tile, including hidden enemies.
2. Attacks and heals against post-movement positions, all at once. An attack
   whose target is dead, out of range or out of sight fizzles. Damage and healing
   are summed before anyone dies, so mutual kills are possible.
3. Storm: every unit outside the safe zone takes `1 + floor(round / 10)` damage.
   The zone is a Chebyshev square around the map centre that shrinks linearly to
   the centre tile at three quarters of `maxRounds`.
4. Teams with no living unit are eliminated together and share placement
   `1 + teams still alive`.

The match ends when at most one team remains or after `maxRounds`. Survivors at
the cap rank by living units, then total hit points, then damage dealt. Score is
placement-based: `(seats − placement) / (seats − 1)`, with tied teams splitting the
points of the placements they share.

### Safe defaults and expiry

- Loadout phase: three grunts.
- Orders phase: every unit moves to the reachable tile least exposed to next
  round's storm and takes no action.
- Decision limit: 60 seconds per phase; no player total by default. If a host
  configures one, running out eliminates the team immediately.

### All chat

Both envelopes take an optional `chat` string of 1 to 280 characters. It posts
to one global, public log the moment the envelope is accepted; a rejected
envelope posts nothing and safe defaults never post. Every team reads the log in
its observation and spectators see it in every frame. Live copies carry the 50
most recent lines; the terminal frame carries all of them. Eliminated teams have
no envelope and cannot post.

## Observation

`publicState`: round, `maxRounds`, `map` (width, height, and row-major
`heights[y][x]` numbers and `terrain[y][x]` of `open`/`cover`/`wall`), `zone` (centre, current and next radius, current and next storm damage),
`teams` (units alive and placement per seat), `initiative`, the class catalog,
budget, team size and `chat` (the most recent 50 lines of `{round, seat, text}`).

`privateState`: your `loadout`; your `units` with stats and a `reachable` list of
`{x, y, cost, targets}` (targets are visible enemies attackable from that tile;
the unit's own tile appears with cost 0); `visibleEnemies`; `lastSeen` memories of
enemies no longer in view; and `lastRound` events involving your units or tiles
you can see now. A `move` event carries the tiles walked in order; a move whose
destination you can see discloses its whole path.

## Public view

Live frames show heights and terrain as tables (one row per `y`, one column per
`x`), team unit counts, the round, zone radius, storm damage, eliminations and the
recent all chat. Unit positions, rosters and memories stay hidden until the
terminal frame, which is information-complete for a broadcaster:

- `Loadouts`: seat, actors.
- `Rounds`: one row per history entry with round, zone radius and storm damage.
  Entry 0 is the spawn; a host forfeit inside a round adds an entry with that
  round's number.
- `Units`: entry, unit, seat, class, x, y, hp for every living unit after that
  entry.
- `Events`: entry, kind, unit, target, seat, from x/y, at x/y, value, note, path
  for every move (note `blocked`; path = every tile stepped onto as space-separated
  `x,y`, ending at the destination), attack/heal (value = damage/amount), fizzle
  (note = reason), storm (value = damage), death and elimination (value =
  placement), in resolution order. Blank cells mean not applicable.
- `Chat`: the complete log.
