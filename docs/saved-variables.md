# SavedVariables compatibility

`ChronieDB` is a wire format between addon builds and desktop builds that may be installed
months apart. It is not the desktop app's domain model. The addon writes plain Lua tables; the
desktop app first deserializes tolerant `Raw*` records in `saved_variables.rs`, then normalizes
segments into the typed records used by SQL persistence and activity inference.

## Segment schema version

The addon writes `ChronieDB.segmentSchemaVersion = 1`. The version belongs only to the segment
feed, not to unrelated account snapshots in the same SavedVariables table. Additive evolution
does not increment it: unknown root, segment, detail and event fields are ignored. Increment the
version before shipping a change that alters or removes an existing meaning.

The collector handles versions as follows:

- An absent version is a legacy file. It is normalized with the historical defaults below.
- A version lower than the collector's current version is an older file and receives the same
  compatibility normalization.
- The current version is normalized normally.
- A version higher than the collector's current version is read best-effort. Known fields are
  imported and unknown fields are ignored, so an additive future producer remains usable.

A future incompatible version must add an explicit normalization branch before the producer is
shipped. It must not make the best-effort branch silently reinterpret an old field.

## Segment boundary rules

`id`, `character` and `endedAt` identify a usable segment. A record missing one of them, or
carrying it with the wrong scalar type, is skipped without affecting its neighbours.

Historical omissions are normalized explicitly:

- `startedAt` defaults to `endedAt`.
- `day` is derived from `endedAt` in local time, or becomes `Unknown` for an out-of-range time.
- `instance` defaults to `Unknown`; `difficulty` and `instanceType` default to an empty string.
- Numeric tallies default to zero and event lists default to empty.
- Optional scalar values remain optional. Missing is not rewritten as zero or false.
- `keystone`, `delve` and `experience` remain absent when the wire record omitted them.

Every event list is deserialized entry by entry. A malformed optional event is discarded while
the rest of the list and its segment survive. An event that lacks the identifier its SQL row
requires is malformed for this purpose. Unknown event fields are ignored.

The synthetic Lua files under `apps/desktop/src-tauri/fixtures/savedvariables` are written
independently of the Rust types. They cover an unversioned, partially populated historical
record, the current version, malformed optional data, and a newer record with unknown fields.

## When the file is written, and what a crash costs

Once, at UI teardown. `ChronieDB` is a plain Lua table that lives in memory for the whole
session — `SegmentLog` mutates `db.segments` in place — and the client reads the file at load
and rewrites the whole of it from memory on the way out. The addon's only write trigger is the
`PLAYER_LOGOUT` handler in `apps/addon/Main.lua`. There is no ticker and no periodic flush.

So a crash, a force-quit or a power cut loses the entire session, including segments that
already closed cleanly at a zone change. Worse, the file left on disk still holds the
*previous* session, and the collector skips a file whose mtime and size have not changed, so
the loss is silent. `/reload` is safe: it is a full unload and rewrite.

The client keeps one generation of backup — every `SavedVariables/*.lua` has a `.lua.bak`
beside it — so a crash *during* the write does not lose everything. It is not a periodic save.

**There is no addon-callable "save now".** The only lever is forcing an unload, which means
`/reload`, and nothing may do that under a player.

### The logging APIs, read from the 12.0.5 client binary

Contrary to the usual claim that addons have no file I/O, the retail binary registers several
undocumented Lua entry points that take a string. None appears on Warcraft Wiki's API list.

- `C_Log.LogMessage`, `LogErrorMessage`, `LogWarningMessage`, `LogMessageWithPriority`, with
  `Enum.LogPriority` = `Fatal, Warning, Spam`.
- `SendSystemMessage(message)`.
- `C_CombatLogSecure.CreateCombatLogMessage(message, color, order)` — a protected namespace.
- `LoggingChat` / `LoggingCombat`, switches on the client's own writers. Destinations are
  hardcoded: `Logs\WoWChatLog.txt` (one fixed file, **never rotates**), `Logs\WoWCombatLog.txt`
  and `Logs\WoWCombatLog-%s.txt` (rotates per session).

`General.log`, `Aurora.log`, `Housing.log`, `Professions.log` and `TestSuite.log` are channels
of a `LoggingSystem` whose line format is `[%s] %s` — source tag, then message. `DeveloperLog.log`
is a separate subsystem. `FrameXML.log` sits beside the `scriptProfile` CVar; `taint.log` is
driven by `taintLog`, values 0–4.

`C_EncodingUtil.SerializeJSON` and `SerializeCBOR` are also registered, if structured records
are ever wanted.

**Which file any of these reaches, and whether they are no-ops on retail, is not answerable
from the binary** — it is control flow, not strings. `/chronie logprobe` asks the running
client instead; see issue #209 for what it writes and how to read the result. Until that
returns, nothing in the addon may depend on any of these.
