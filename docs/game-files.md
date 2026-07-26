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
| `Achievement` | 1260179 | fixed | yes |
| `Achievement_Category` | 1324299 | fixed | yes |
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

**Only 10 and 11 are verified positions in that table.** `GeosetGroup[6]` is read from
column 12 and `ModelType[2]` from column 13 *in the fixtures*, which is where those two were
put so that something exercises them; neither index was read off an install. Nothing outside
a test may rely on them until they have been checked the way 10 and 11 were — which is work
the character rendering needs done before it can pick geosets.

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
independently verified; which values carry a model *was* verified. The set detail view names
0 through 10 from that list and calls 11, 12, 13 and 15 a "weapon or shield" between them,
because the definitions do not say which of those is the main hand and which the off hand
and four labelled guesses would read as fact.

## Achievements

Two tables, no chain: `Achievement` is the achievements and `Achievement_Category` is the
tree they are filed in. `achievements.rs` reads them for the ids a window is showing.

```
Achievement                       (id inline, in column 3)
  col0  = Description_lang         "Reach level 10."
  col1  = Title_lang               "Level 10"
  col2  = Reward_lang              "Reward: Title & Loremaster's Colors", usually empty
  col4  = InstanceID               a map id, or -1
  col5  = Faction                  sparse, default -1 ──▶ 0 Horde, 1 Alliance, -1 both
  col6  = Supercedes               the achievement this one is earned on top of
  col7  = Category               ──▶ Achievement_Category.ID
  col9  = Points                   packed — see below
  col12 = IconFileID             ──▶ a BLP icon
     │
     ▼
Achievement_Category              (id inline, in column 1)
  col0 = Name_lang
  col2 = Parent                    -1 at a root; walk it up for the path
  col3 = UiOrder
```

**Points are not stored as points.** Column 9 is a palette of ten values, and every one of
them is `0x3C00` with the points in its low byte: `0x3C0A` is ten points, `0x3C64` is a
hundred. All 13,732 readable rows carry that shape — not one deviates — and the low bytes
are exactly the set the game awards: 0, 5, 10, 15, 20, 25, 30, 40, 50, 100. A reader that
takes the column whole reports every achievement as being worth fifteen thousand. The
fixture stores it the same way so that stays caught.

**What each column was checked against**, since a reordered table shows wrong values rather
than failing:

| Column | Checked against |
|---|---|
| `InstanceID` | "Heroic: The Nexus" reads 576, which is The Nexus |
| `Faction` | the level-60 Horde rank titles (High Warlord, Centurion) read 0; the Silverwing flag-room achievements read 1 |
| `Category` | "Level 10" reads 92, which the other table names "Characters" |
| `Points` | feats of strength and the whole legacy tree come out at nothing; "Level 10", "Heroic: The Nexus" and "The Loremaster" come out at ten |
| `IconFileID` | 400 sampled ids all decode, 399 of them 64×64 |
| `Supercedes` | "Level 20" names "Level 10" |
| the tree | the roots come out as the game's own list: Statistics, Feats of Strength, Characters, Player vs. Player, Quests, Exploration, World Events, Dungeons & Raids, Professions, Reputation, Guild, Pet Battles, Legacy, Collections, Expansion Features, Delves, Housing |

Measured on 12.0.5.67: 13,736 declared rows, 13,732 readable, 3,846 distinct icons, 243
categories. `cargo run --example dump_achievements -- "<install>"` prints the lot for a
handful of ids and is what to run after a patch.

## Regenerating the fixtures

Tests never read the game. One script per area writes real WDC5 tables and real BLP2
textures with entirely invented contents — same columns, same storage per column, same bit
offsets, same encodings as the game's own, so the awkward halves of the reader stay
exercised. `scripts/db2-fixtures.ts` is the machinery they share and is where the formats
themselves are explained.

```sh
bun run scripts/make-transmog-fixtures.ts
bun run scripts/make-achievement-fixtures.ts
```

Every table on the chains above has a fixture, and between them they hold each way a hop can
fail: an appearance stored as a copy of another, an `ItemModifiedAppearance` row the game
encrypts, an `ItemAppearance` whose display info is encrypted, one with no icon at all, a
display whose only model sits in the second slot, an achievement filed under a category
whose parent is encrypted, one filed under a category that is not in the tree at all, and
one the game withholds entirely.

Every fixture table carries an encrypted section, because that is where the edge cases
live. Nothing in `apps/desktop/fixtures/` is derived from game assets, which is what
keeps the committed tests distributable.

## Sources

- [wowdev.wiki/DB2](https://wowdev.wiki/DB2) — WDC5 header, storage types, relationship map
- [WoWDBDefs](https://github.com/wowdev/WoWDBDefs) — per-build column layouts
- [wow-listfile](https://github.com/wowdev/wow-listfile) — FileDataID ↔ filename
- [wago.tools](https://wago.tools/) — live DB2 exports, useful for cross-checking a build
