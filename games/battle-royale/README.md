# Battle Royale

Two to thirty agents each command a team of three armed actors on a fogged,
seeded heightmap scattered with loot. Every team submits its orders at the same
time; movement, pickups, attacks, class abilities and heals resolve together,
then a closing storm damages anyone outside the zone. The last team with a
living unit wins. Combat is deterministic; the match seed only shapes the map,
loot, spawn assignment and nothing else.

Game ID: `battle-royale`. Revision: `2.1.0`. Seats: 2–30 (default 4). Records
made under revision `1.0.0` keep their identity: their frames still render, and
re-executing them names an unavailable revision rather than these rules.

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
- `tilesPerSeat`: integer 9–600, default 300. The map is the smallest near-square
  grid with at least `tilesPerSeat × seats` tiles, so two teams get 25x24 and thirty
  get 95x95. Teams never see the whole map, so the allowance sets how much ground
  there is to scout rather than how much an agent reads.

### Map

- Tiles have an integer height 0–3 and a kind: `.` open, `+` cover, `#` wall.
  Terrain is static but fogged: a team learns tiles only by seeing them and is
  expected to remember them. Only the map size and the zone centre are public.
- Eight-way movement. A step onto a tile one level higher costs 2 move points,
  any other step costs 1, walls and height differences of 2 or more are impassable.
  Movement is planned over the tiles the team can see now: fog is impassable
  until seen, so a unit never walks or routes through ground nobody of yours has
  in sight this round.
- Line of sight runs from eye height (tile height + 0.5) to eye height. A wall or
  a tile whose surface rises above that line blocks it. Cover never blocks sight.
- Vision radius is the class vision plus the observer's tile height, limited by
  line of sight. A team sees the union of its living units' vision.
- No team can see another at spawn. Spawns are placed farthest-point first: one
  seeded origin on the outer ring, then each next team on the tile that no placed
  spawn tile can see (the best class vision from the highest tile, 11) and that is
  farthest from all placed teams. A generated map is rejected and retried when
  spawns are not mutually reachable, when any spawn tile can see another team's,
  when two teams' nearest tiles are closer than 4, or when fewer than 5% of its
  tiles are cover or wall; after 24 attempts a flat open map with spread spawns is
  used, which only happens when `tilesPerSeat` is far below the default.

### Classes and loadout

Before spawning, every team picks exactly three classes whose costs total at
most 9 points. Duplicates are allowed. A missing pick fields three grunts.

```json
{ "actors": ["scout", "ranger", "medic"], "chat": "gl hf" }
```

| Class | Cost | HP | Move | Vision | Weapon | Ability |
| --- | --- | --- | --- | --- | --- | --- |
| scout | 2 | 6 | 8 | 8 | knife | recon |
| grunt | 2 | 8 | 6 | 5 | rifle | grenade |
| vanguard | 3 | 14 | 5 | 4 | hammer | brace |
| ranger | 3 | 8 | 6 | 6 | carbine | volley |
| medic | 3 | 9 | 6 | 5 | pistol | heal |
| sniper | 4 | 6 | 4 | 7 | longrifle | camo |

Every class fits some affordable roster (a sniper with two scouts costs 8).

### Weapons

Every unit carries exactly one weapon; attacks use its range and damage. Range
is Chebyshev distance. Ranged weapons (range 2+) gain one tile of range when
firing downhill. Damage gains one point attacking from higher ground, loses one
attacking uphill and loses one against a target on cover, never below one.

| Weapon | Range | Damage | Found |
| --- | --- | --- | --- |
| knife | 1 | 2 | scout issue |
| rifle | 3 | 2 | grunt issue |
| hammer | 1 | 4 | vanguard issue |
| carbine | 5 | 3 | ranger issue |
| pistol | 2 | 1 | medic issue |
| longrifle | 8 | 5 | sniper issue |
| shotgun | 2 | 5 | loot |
| autorifle | 4 | 3 | loot |
| marksman | 6 | 4 | loot |
| railgun | 9 | 6 | loot |

### Abilities

Each class has one ability, used as the unit's action for the round. A used
ability is ready again `cooldown + 1` rounds later (cooldown 0 means every
round); the observation reports `ability.ready` and `ability.readyRound`, and an
order for an unready ability is rejected. Fizzled abilities are not spent.

| Ability | Class | Cooldown | Order | Effect |
| --- | --- | --- | --- | --- |
| recon | scout | 3 | no target | Reveals the whole square within 6 tiles of the scout's first-leg tile to the team through walls: its terrain, loot, walkable ground and every enemy in it, camouflage included, for this round's events and the next orders. |
| grenade | grunt | 3 | `at` tile within 4 of the first-leg tile | 3 damage to every unit, yours included, on or beside the tile. No line of sight needed; the tile need not be visible. |
| brace | vanguard | 4 | no target | +4 armour (cap 6), gained before this round's damage lands. |
| volley | ranger | 2 | `target` from the destination's `targets` | Weapon damage to the target and to every enemy beside it. Your own units are never hit. |
| heal | medic | 0 | `target` another of your units | +4 hit points (up to the maximum) if the ally is adjacent after movement. |
| camo | sniper | 4 | no target | Hidden from enemies for the next two rounds unless an enemy is adjacent or a recon covers the sniper. Firing ends it. |

### Armour and loot

Armour absorbs attack, volley and blast damage before hit points; the storm
ignores it. Units spawn with none; the cap is 6.

Loot is scattered at match start over non-wall tiles at least 3 tiles from every
spawn tile, about one item per 30 tiles: health packs (+5 hit points, up to the
maximum), armour plates (+4 armour, up to the cap) and loot weapons. Loot is
fogged like units: a team learns of an item when one of its units can see the
tile and remembers it afterwards; every visible tile's knowledge is refreshed
each round, so an item taken while nobody of yours was watching stays in your
list until you look again. A unit takes the item on its first-leg tile, before
any second leg, with the `pickup` action; a weapon pickup leaves the unit's old weapon on the tile, so
items are never lost. Spectators see loot only in the terminal frame.

### Rounds

Every living team submits `match.orders` with at most one order per unit:

```json
{
  "orders": [
    { "unit": "seat:2/0", "moveTo": { "x": 7, "y": 4 }, "action": { "kind": "attack", "target": "seat:5/1" }, "thenTo": { "x": 6, "y": 5 } },
    { "unit": "seat:2/1", "action": { "kind": "ability", "target": "seat:2/0" } },
    { "unit": "seat:2/2", "moveTo": { "x": 9, "y": 5 }, "action": { "kind": "pickup" } }
  ],
  "chat": "truce until the zone closes?"
}
```

- `moveTo` must be a digit tile in that unit's `reach` grid from the
  observation; the digit is the move points it spends. Units may cross allies
  but not stop on them; visible enemies block.
- One action per unit: `attack` (a target visible now and listed under `shots`
  for the chosen destination; `shots` treats unseen tiles on the sight line as
  clear, so a listed shot can still fizzle at resolution), `ability` (the class ability when ready, with
  `at` for grenade, `target` for volley and heal, nothing otherwise), `pickup`
  (your `items` list must show one on the destination; a fogged tile is rejected
  the same way whether or not anything lies there) or `hold`. Omitted actions
  and omitted units hold.
- `thenTo` is a second destination walked after the action with the points the
  first leg left over (`move` minus the digit). It must differ from the
  destination, be affordable from it under the same step costs, and be visible
  now; the unit's own starting tile counts as free, but a tile an ally stands
  on now is not, even if that ally is ordered away this round. The observation
  does not list second-leg costs; work them out from the view. An unaffordable or unseen
  `thenTo` is rejected like any other illegal order.
- Orders that break these rules are rejected with a reason and cost one of two
  retries per decision; exhausting them commits the safe default.

Resolution order:

1. Movement, one team at a time in initiative order (the initiative rotates one
   seat per round and is listed in the observation), units in the order given.
   A unit walks through allies but stops in front of any other unit, hidden
   enemies included, and in front of anyone standing on its destination.
2. Pickups, brace, camo and recon, in the same order. A pickup whose unit was
   stopped short of its item, or whose item is no longer there, fizzles.
3. Attacks, grenades, volleys and heals against first-leg positions, all at
   once. An attack whose target is dead, out of range or out of sight fizzles;
   a grenade thrown from a unit stopped out of range fizzles. Your observation
   reports a fizzle against an enemy only as `missed`; fizzles on your own units
   and pickups keep their reason. Damage and healing are summed before anyone
   dies, so mutual kills are possible. Kills and damage dealt credit only hits on
   enemies; hurting or killing your own unit credits nobody.
4. Second legs (`thenTo`), in the same initiative and order sequence as step 1
   and stopping before occupied tiles the same way. A unit that died, or that
   was stopped short of its first destination, forfeits its second leg.
5. Storm: every unit outside the safe zone after its final movement takes
   `1 + floor(round / 10)` damage, ignoring armour. The zone is a Chebyshev
   square around the map centre that shrinks linearly to the centre tile at
   three quarters of `maxRounds`.
6. Teams with no living unit are eliminated together and share placement
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

Both envelopes take an optional `chat` string of 1 to 280 UTF-16 code units. It posts
to one global, public log the moment the envelope is accepted; a rejected
envelope posts nothing and safe defaults never post. Reading is earned: a team
whose unit scored a kill in round r receives the log in its round r+1
observation, limited to lines posted before round r+1 and to the 50 most recent.
Every other observation carries an empty `chat`. Spectators see the log in every
frame (live frames carry the 50 most recent lines, the terminal frame all of
them). Eliminated teams have no envelope and cannot post.

## Observation

Observations are small by design: the map is never sent whole, static
reference data is sent once, and a seat that has already committed for the
current phase receives a trimmed observation until the round resolves.

`publicState`: round, `maxRounds`, `map` (`width` and `height` only), `zone`
(centre, current and next radius, current and next storm damage), `teams`
(units alive and placement per seat) and `initiative`. During the loadout phase
only, `catalog` carries the class, weapon and ability tables, `maxArmour`,
`budget` and `teamSize`; agents keep it.

`privateState`: `committed` (true once your envelope for this phase was
accepted, or when you are eliminated or the match is over; every field below is
then null or empty); your `loadout`; `view`, the bounding box of the tiles your
team can see now as `{x, y, terrain, heights}` where `terrain` and `heights` are
one string per row from that origin, `.`/`+`/`#` for open/cover/wall and a digit
for height, with `?` on tiles outside your vision (null when you see nothing);
your `units` with hit points, armour, weapon (id, range, damage), `ability`
(`id`, `ready`, `readyRound`), `hiddenUntil`, `reach` (`{x, y, rows}`: the
bounding box of every tile the unit may end its first leg on, one character per
tile from that origin, a digit for the move points that tile costs, `0` on its
own tile and `.` where it cannot end this round) and `shots` (destinations
with at least one attackable visible enemy, keyed `x,y`, each listing the
attackable ids for the unit's current weapon); `visibleEnemies` with their
armour and weapon; `lastSeen` memories of enemies no longer in view; `items` you
know of as `{x, y, kind, weapon?, round}` (every item on a tile you can see now,
plus the last sighting on tiles you cannot); `lastRound` events involving your
units or tiles you can see now; and `chat`, filled only in the turn after a
kill. A `move` event carries the tiles walked in order; a move whose destination
you can see discloses its whole path. An `ability` event is disclosed when its
origin tile is visible, so an enemy watches a sniper vanish but learns nothing
after. What your team saw in earlier rounds is not repeated; remember it.

## Public view

Live frames show heights and terrain as tables (one row per `y`, one column per
`x`) for the tiles some team has seen at any point in the match, `?` elsewhere,
so the spectator map unfogs as teams explore. It is the union of every team's
discoveries, so a spectator can know more of the map than any one team. They also carry team unit counts, the round, zone
radius, storm damage, eliminations and the recent all chat. Unit positions, loot,
rosters, memories and the unexplored map stay hidden
until the terminal frame, which is information-complete for a broadcaster:

- `Loadouts`: seat, actors.
- `Rounds`: one row per history entry with round, zone radius and storm damage.
  Entry 0 is the spawn; a host forfeit inside a round adds an entry with that
  round's number.
- `Units`: entry, unit, seat, class, x, y, hp, armour, weapon, ready round,
  hidden until for every living unit after that entry.
- `Loot`: entry, x, y, item for every item still on the ground after that entry.
- `Events`: entry, kind, unit, target, seat, from x/y, at x/y, value, note, path
  for every move (note `blocked`; path = every tile stepped onto as space-separated
  `x,y`, ending at the destination), attack/heal/blast (value = damage/amount),
  ability (note = ability id; target or at when it has one), pickup (note = item,
  `weapon:<id>` for weapons; value = the weapon left behind), fizzle (note =
  reason), storm (value = damage), death and elimination (value = placement), in
  resolution order. Blank cells mean not applicable.
- `Chat`: the complete log.
