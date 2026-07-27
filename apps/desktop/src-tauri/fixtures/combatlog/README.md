# Combat logs

All but one of these was written by hand, and nothing in the test suite needs a game install
— that is the point of the folder. A parser that can only be exercised against a real raid
night is a parser nobody can change safely.

They are `.txt` because that is what the client writes, and they carry the client's own
line shape: a timestamp, two spaces, then a comma-separated payload whose field layout
depends on the event and on whether advanced logging was on when the line was written.

`real-client.txt` is the exception and is the one the others answer to. A hand-written fixture
can only ever restate what its author believed, and two of those beliefs turned out to be
wrong — see below.

| File | What it is for |
| --- | --- |
| `real-client.txt` | The only one a client wrote. A 12.0.7 retail session in Terokkar Forest, anonymised and otherwise untouched. It is what settles the timestamp, the map bounds and the advanced block, and what a hand-written fixture is checked against. |
| `raid-night.txt` | The ordinary case. Modern stamps with a year and a UTC offset, advanced logging on, a map change, a wipe and a kill, combatant snapshots, and a position track. |
| `mythic-plus.txt` | A keystone run: `CHALLENGE_MODE_START`/`END` with affixes, two maps in one run, and a position track that crosses between them. |
| `advanced-off.txt` | The same kind of night with advanced logging off. Every line is short, no line carries a position, and none of it may error. |
| `mixed-sections.txt` | Advanced logging off for one session and on for the next, in one file — two `COMBAT_LOG_VERSION` lines, which is what a session boundary looks like from the outside. |
| `legacy-stamps.txt` | The old timestamp: month and day, no year, no zone. Crosses midnight and then the new year, which is the pair of moments that make the format painful. |
| `awkward-fields.txt` | Names with commas and quotes in them, non-ASCII names, `nil` where a number is expected, negative and exponent-form coordinates, an event from a client newer than this parser, and blank lines. |
| `partial-tail.txt` | Ends mid-line, with no trailing newline — a file caught while the client was still writing to it. |
| `rotated-before.txt`, `rotated-after.txt` | Two different logs for one path. The tests write the first, read it, then write the second over it, which is what rotation and truncation look like to a cursor that remembers an offset. |

## The numbers in the hand-written ones are chosen, not observed

The map bounds are round on purpose. `raid-night.txt` uses a map spanning 800 yards
north-to-south and 1000 east-to-west, so a position at `4200, -2500` normalises to exactly
`0.25, 0.5` and a test can say so without a tolerance. Real bounds are never that tidy —
Terokkar Forest states `7083.330078` for one of its edges — so the tests over `real-client.txt`
round to three decimals instead.

## What the real one corrected

Two things, both of which had been written down here from a documented layout and were wrong
about a current client.

**The timestamp carries an offset with no sign on it.** `16:24:38.4081` is 38.408 seconds an
hour east of UTC, not a fraction written with four digits. Nothing separates the two, so what
tells them apart is that the client writes exactly three digits of milliseconds and the offset
is whatever follows. Every line of `real-client.txt` ends in that `1`, which no fourth digit of
a fraction ever would. The hand-written fixtures use the `-5` form, which is the same thing
when the offset is west and is all anyone had seen.

**The advanced block has grown.** It was seventeen fields with the position twelve fields in;
a 12.0.7 client writes nineteen with the position fourteen fields in, having gained two
somewhere between the armour and the power. So the parser stopped counting to the position and
started looking for its shape — two coordinates with a decimal point, a map id, a facing —
which is the one thing about it that has not moved. Read by the old count, a Demon Hunter's
120 fury became a world X coordinate, which is a number that looks exactly like an answer.

What the file could not settle, because it has none in it, is `ENCOUNTER_START`/`END` and
`COMBATANT_INFO`. Those are still described only by the hand-written fixtures.
