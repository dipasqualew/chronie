# Reading the game's own files

How the desktop app gets from "a transmog set" to the bytes of a model and a texture.

This exists so that nobody has to go and look. `CLAUDE.md` puts the local World of
Warcraft install off limits for ordinary work, and these notes are the reason that
rule costs nothing: everything below was read off a real install once, deliberately,
and written down.

**Provenance.** Verified against build `12.0.5.67` (Midnight) on 2026-07-26. Column
indices and file ids are stated as *verified* only where they were read out of that
install and cross-checked against the data they resolve to. Everything else is marked
as coming from [WoWDBDefs](https://github.com/wowdev/WoWDBDefs) or
[wowdev.wiki](https://wowdev.wiki), which lag or lead a given build.

A game patch can invalidate any column index here. None of it is guesswork, but none
of it is guaranteed either — which is why `transmog.rs` checks the row count it ends
up with against the count the file declares, and why anything new should do the same.

## The layers

```
CASC storage  ──▶  GameFiles::read(fdid) -> Vec<u8>      casc.rs
DB2 tables    ──▶  Db2::parse(bytes) -> rows, columns    db2.rs
the join      ──▶  a set, its items, their assets        transmog.rs
```

`casc.rs` is indifferent to what it is reading. It resolves a FileDataID through
`.build.info` → build config → root → encoding → the `.idx` buckets, then BLTE-decodes
the payload. It already returns M2 and BLP bytes correctly; nothing about the 3D work
needs to touch it.

## WDC5 quirks that actually bite

The format packs hard, and four of its habits have caused real trouble:

**Rows are not always fixed-size.** A table with `flags & 0x1` stores variable-length
records and an offset map instead of `record_size × rows`. `db2.rs` currently skips the
offset map and assumes fixed records, so **it cannot read such a table at all**.
`ItemSparse` is the one that matters — see the table below.

**A foreign key can live outside the row.** The community definitions mark these
`$noninline,relation$`. They are not a column; they sit in a relationship block beside
the records, as pairs of the key and the index of the record it belongs to *within its
section*. `Row::foreign_id()` reads it. Without it, `ItemDisplayInfoMaterialRes` is 221k
rows that cannot be attributed to anything.

Note the distinction, because it is easy to misread: `$relation$` *without* `noninline`
is duplicated into the record and reads as an ordinary column. `TransmogSetItem`'s set
id is that kind, which is why `row.number(0)` works for it.

**A column can hold a fixed-size array.** `Row::number()` returns element zero — usually
the interesting one, so it stays the default. `Row::element(column, index, element_bits)`
reads the rest. The file records only the *total* width of a plainly stored array, so the
caller supplies the element width; that is the `<32>` in the community's definitions.

**Encrypted sections arrive as zeroes.** Blizzard encrypts content it has not shipped and
nobody outside it holds the key. BLTE fills those chunks with zeroes of the right length,
which keeps every following chunk where the file says it is. A relationship block in such
a section is still *reserved at full size* but reads as a count of zero — ordinary, not a
file worth rejecting. `Db2::rows()` skips these rows; `declared_rows()` still counts them,
which is how the transmog view can say how many sets it could not show.

## Tables

FileDataIDs from the [community listfile](https://github.com/wowdev/wow-listfile). All
of these were confirmed readable on 12.0.5.67 except where noted.

| Table | FileDataID | Records | Readable |
|---|---|---|---|
| `TransmogSet` | 1376213 | fixed | yes |
| `TransmogSetItem` | 1376212 | fixed | yes |
| `TransmogSetGroup` | 1576116 | fixed | yes |
| `ItemModifiedAppearance` | 982457 | fixed | yes |
| `ItemAppearance` | 982462 | fixed | yes |
| `ItemDisplayInfo` | 1266429 | fixed | yes |
| `ItemDisplayInfoMaterialRes` | 1280614 | fixed | yes, needs `foreign_id()` |
| `ModelFileData` | 1337833 | fixed | yes |
| `TextureFileData` | 982459 | fixed | yes |
| `ComponentTextureFileData` | 1278239 | fixed | yes |
| `ComponentModelFileData` | 1349053 | fixed | yes |
| `CharComponentTextureSections` | 1360263 | fixed | yes |
| `CharComponentTextureLayouts` | 1360262 | fixed | yes |
| `ChrModelMaterial` | 3566562 | fixed | yes |
| `ChrModelTextureLayer` | 3548976 | fixed | yes |
| `ChrModel` | 3384313 | fixed | yes |
| `HelmetGeosetData` | 2821752 | fixed | yes |
| **`ItemSparse`** | **1572924** | **offset map** | **no — see below** |

### ItemSparse

Item *names* live here and nowhere smaller. Measured on 12.0.5.67: 63 MB decompressed,
171,964 rows, `flags = 5`, 171,964 offset-map entries, 24 sections.

`flags = 5` is bit 0 (offset map) and bit 2 (id list). `db2.rs` cannot read it until it
grows variable-length record support. This is a format feature, not merely a large read —
worth knowing before promising item names.

## The chain, verified

Every hop below was resolved on a real install with **zero unresolved lookups**.

```
TransmogSetItem
  col0 = TransmogSetID            (inline $relation$)
  col1 = ItemModifiedAppearanceID
     │
     ▼
ItemModifiedAppearance            (id inline)
  col1 = ItemID
  col3 = ItemAppearanceID
     │
     ▼
ItemAppearance                    (id in the id list — $noninline,id$)
  col0 = DisplayType
  col1 = ItemDisplayInfoID
  col2 = DefaultIconFileDataID  ──▶ a BLP icon
     │
     ▼
ItemDisplayInfo                   (id in the id list)
  col10 = ModelResourcesID[2]         ← an array; use element()
  col11 = ModelMaterialResourcesID[2] ← an array; use element()
     │                    │
     │                    └──▶ TextureFileData.col2 = MaterialResourcesID
     │                            row.id() = FileDataID ──▶ BLP2
     │
     └──▶ ModelFileData.col4 = ModelResourcesID
             row.id() = FileDataID ──▶ MD21
```

Confirmed by reading the resulting files and checking their magic bytes: model
lookups produce `MD21`, texture lookups produce `BLP2`. All 12,918 distinct texture
keys present in transmog sets resolve.

**`col10` and `col11` are arrays, and this is the trap.** The community layout lists
`ModelResourcesID<u32>[2]` and `ModelMaterialResourcesID<32>[2]` as separate entries, so
reading `number(10)` and `number(11)` appears to give two unrelated scalars — and it
*works*, because element zero of each is the value you want. It hides that a further
element exists. 12,656 rows use both model slots; shoulders are the reason (a left and a
right). Use `element()`.

For body-component textures — which is how armour is drawn — the path is different and
does **not** go through `col11`:

```
ItemDisplayInfoMaterialRes        (id in the id list)
  foreign_id() = ItemDisplayInfoID   ← relationship block, nowhere else
  col0 = ComponentSection (0..=8)
  col1 = MaterialResourcesID  ──▶ TextureFileData ──▶ BLP2
```

Verified: 221,170 readable rows, **every one** attributed to a display, 93,179 distinct
displays, component sections spanning exactly `0..=8`.

Per-region texture columns (`ArmUpperTexture`, `TorsoUpperTexture`, …) **left
`ItemDisplayInfo` in Legion**. They are historical; do not look for them.

## What actually has geometry

The single most consequential finding, measured across real transmog sets:

| `DisplayType` | Slot (per community definitions) | `ModelResourcesID` | Geometry |
|---|---|---|---|
| 0 | head | non-zero | an M2 of its own |
| 1 | shoulder | non-zero | an M2 of its own |
| **2–10** | **chest, waist, legs, feet, wrist, hands, back, tabard, shirt** | **0** | **none at all** |
| 11, 12, 13, 15 | weapons and shields | non-zero | an M2 of its own |

Most armour has no model. It is texture painted onto the character's body, plus geoset
toggles that swap which parts of the body mesh are drawn. On a twelve-piece armour set,
rendering item models alone draws **two** pieces.

This is why `ItemDisplayInfoMaterialRes` and the relationship block are load-bearing
rather than incidental, and why showing armour at all requires the character-rendering
work in [character-rendering.md](character-rendering.md).

The `DisplayType` → slot naming above is from community definitions and was not
independently verified; which values carry a model *was* verified.

## Regenerating the fixtures

Tests never read the game. `scripts/make-transmog-fixtures.ts` writes real WDC5 files
with entirely invented contents — same columns, same storage per column, same bit
offsets as the game's own, so the awkward halves of the reader stay exercised:

```sh
bun run scripts/make-transmog-fixtures.ts
```

Every fixture table carries an encrypted section, because that is where the edge cases
live. Nothing in `apps/desktop/fixtures/` is derived from game assets, which is what
keeps the committed tests distributable.

## Sources

- [wowdev.wiki/DB2](https://wowdev.wiki/DB2) — WDC5 header, storage types, relationship map
- [WoWDBDefs](https://github.com/wowdev/WoWDBDefs) — per-build column layouts
- [wow-listfile](https://github.com/wowdev/wow-listfile) — FileDataID ↔ filename
- [wago.tools](https://wago.tools/) — live DB2 exports, useful for cross-checking a build
