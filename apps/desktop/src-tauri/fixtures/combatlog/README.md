# Synthetic combat logs

Every one of these was written by hand. None of them came out of a game install, and nothing
in the test suite needs one — that is the point of the folder. A parser that can only be
exercised against a real raid night is a parser nobody can change safely.

They are `.txt` because that is what the client writes, and they carry the client's own
line shape: a timestamp, two spaces, then a comma-separated payload whose field layout
depends on the event and on whether advanced logging was on when the line was written.

| File | What it is for |
| --- | --- |
| `raid-night.txt` | The ordinary case. Modern stamps with a year and a UTC offset, advanced logging on, a map change, a wipe and a kill, combatant snapshots, and a position track. |
| `mythic-plus.txt` | A keystone run: `CHALLENGE_MODE_START`/`END` with affixes, two maps in one run, and a position track that crosses between them. |
| `advanced-off.txt` | The same kind of night with advanced logging off. Every line is short, no line carries a position, and none of it may error. |
| `mixed-sections.txt` | Advanced logging off for one session and on for the next, in one file — two `COMBAT_LOG_VERSION` lines, which is what a session boundary looks like from the outside. |
| `legacy-stamps.txt` | The old timestamp: month and day, no year, no zone. Crosses midnight and then the new year, which is the pair of moments that make the format painful. |
| `awkward-fields.txt` | Names with commas and quotes in them, non-ASCII names, `nil` where a number is expected, negative and exponent-form coordinates, an event from a client newer than this parser, and blank lines. |
| `partial-tail.txt` | Ends mid-line, with no trailing newline — a file caught while the client was still writing to it. |
| `rotated-before.txt`, `rotated-after.txt` | Two different logs for one path. The tests write the first, read it, then write the second over it, which is what rotation and truncation look like to a cursor that remembers an offset. |

## The numbers in them are chosen, not observed

The map bounds are round on purpose. `raid-night.txt` uses a map spanning 800 yards
north-to-south and 1000 east-to-west, so a position at `4200, -2500` normalises to exactly
`0.25, 0.5` and a test can say so without a tolerance. Real bounds are never that tidy.
