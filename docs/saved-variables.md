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

Which file any of these reaches is not answerable from the binary — it is control flow, not
strings — so `/chronie logprobe` asked the running client instead.

### What the client answered, on 12.0.5.67823

`C_Log` writes, and it writes to `Logs\General.log`:

```
7/29 14:58:04.773  [N][Lua] CHRONIE_PROBE_1785333484_c_log_message
7/29 14:58:04.773  [E][Lua] CHRONIE_PROBE_1785333484_c_log_error
7/29 14:58:04.773  [W][Lua] CHRONIE_PROBE_1785333484_c_log_warning
7/29 14:58:04.773  [W][Lua] CHRONIE_PROBE_1785333484_c_log_priority_warning
```

`[N]`, `[E]` and `[W]` are the severity of the call that made them; `[Lua]` is the source tag
the `LoggingSystem`'s `[%s] %s` format puts in front. So a reader can pick Chronie's lines out
of a file the client is also writing to, and the timestamps are the client's own.

The rest of what it answered:

- **`LogPriority.Spam` writes nothing.** It is under the client's threshold and is dropped —
  the fifth token never appeared. Nothing real may be written at that priority.
- **`SendSystemMessage` reaches `Logs\WoWChatLog.txt`; `print` and `AddMessage` do not.** Chat
  logging records chat *events*, not what was drawn in a chat frame. That kills the idea of
  quietly journalling through a chat frame, and it is why the probe's chat channels are now
  opt-in behind `/chronie logprobe chat`.
- **`C_CombatLogSecure` is not defined for addon code at all**, despite being in the binary.

### The open question, and why nothing is built on this yet

**The tokens were in neither log while the client was running, and were still not there after
`/reload`. They were in both the moment the game exited.**

Two things produce that, and they have opposite consequences:

1. The client buffers log writes in its own memory and flushes at shutdown. Then `C_Log` is no
   better than SavedVariables for the case that matters and the journal idea is dead.
2. The client holds the file open without sharing reads, so the search could not see content
   that was already on disk. Then a journal works fine.

A `/reload` distinguishes neither, because it closes no file handle. **Killing the process
does**: run the probe, end the task from Task Manager, restart and read `General.log`. A token
that survives means the write reached the OS and a crash keeps it. **No journal gets built
until that comes back** — see issue #209.

Note for whoever does build it: `General.log` almost certainly rotates per launch, the way
`EditMode.log` and `QuestCache.log` keep a single `.old` beside them. A crashed session's log
is likely `General.log` at the moment of death and `General.log.old` after the next start, so
a reader has to look at both.

### What is built: saying the session is gone

Recovering a lost session needs a journal and the journal needs that answer. *Noticing* one
needs neither, and it is the half that is wanted whichever way the other goes — a journal that
worked would still only be replayed for a session the app could see had ended badly, so this
is its precondition as much as it is its fallback.

The client writes two files and only one of them at logout. The combat log is written line by
line as it goes, so its last stamped line is the last moment the client can be *proved* to have
been alive; the newest `endedAt` in the database is how far the record reaches. When the log
has been quiet for an hour — long enough that an evening spent in a city cannot be mistaken for
a dead client — and its last line is meaningfully later than that, a session ended without the
client writing it out.

- `logfile::tail_at` reads the last 64KB of a log and resolves the last stamp in it. One seek,
  whatever the file's size.
- `gap::verdict` is the rule, and is pure: `Unknown`, `Live`, `Complete` or `Missing`. `Unknown`
  and `Complete` are kept apart deliberately — "nothing to compare" is not a reassurance.
- The `session_gap` command reads the install, and the timeline draws the notice.

It reports the loss and cannot undo it. What is lost is lost; the point is that the window
stops presenting a stale file as a complete history.
