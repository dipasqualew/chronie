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
- `keystone` and `experience` remain absent when the wire record omitted them.

Every event list is deserialized entry by entry. A malformed optional event is discarded while
the rest of the list and its segment survive. An event that lacks the identifier its SQL row
requires is malformed for this purpose. Unknown event fields are ignored.

The synthetic Lua files under `apps/desktop/src-tauri/fixtures/savedvariables` are written
independently of the Rust types. They cover an unversioned, partially populated historical
record, the current version, malformed optional data, and a newer record with unknown fields.
