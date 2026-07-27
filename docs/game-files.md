# Reading the game's own files

How the desktop app gets from "a transmog set" to the bytes of a model and a texture.

This exists so that nobody has to go and look twice. Everything below was read off a
real install once, deliberately, and written down; going back to the install is for
the questions it does not answer, and an answer found that way belongs here
afterwards, marked with the build it came from.

**Provenance.** Verified against build `12.0.5.67` (Midnight) on 2026-07-26, and the array
columns of `ItemDisplayInfo` and the `DisplayType` slot numbering against the same build on
2026-07-27 — the two things this file used to carry on the community's say-so. Column
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
records and an offset map instead of `record_size × rows`, and writes its strings *into* the
record rather than into a block of its own. Nothing in the file says which columns hold those
strings, and a reader that does not know cannot find any column behind the first of them — so
the caller says: `Db2::parse_with_text_columns(bytes, &[…])`. Plain `Db2::parse` still reads
such a table, but only as far as its first string. `ItemSparse` is the one that matters — see
the table below.

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
| `ItemSparse` | 1572924 | offset map | yes, needs `parse_with_text_columns()` |

### ItemSparse

Item *names* live here and nowhere smaller. Measured on 12.0.5.67: 63 MB decompressed,
171,964 rows, `flags = 5`, 171,964 offset-map entries, 24 sections.

`flags = 5` is bit 0 (offset map) and bit 2 (id list): variable-length records addressed
through a map beside them, with the ids kept in a list of their own. Reading it needed the
whole feature described above rather than merely a bigger read.

**Its column positions are the community's and were not read off an install**, unlike the
chains below. The table opens with `AllowableRace<64>` and then five strings —
`Description_lang`, `Display3_lang`, `Display2_lang`, `Display1_lang`, `Display_lang` — so
the name is column 5 and columns 1 through 5 are the ones the reader has to be told about. A
patch that reorders them shows *empty* names rather than wrong ones, because the detail view
falls back to the item's id; that is the symptom to look for.

Which is what this prints, all five columns side by side, and is what settles it:

```sh
cargo run --example dump_items -- "<install>" 19019 6948
```

Column 5 should read "Thunderfury, Blessed Blade of the Windseeker" and "Hearthstone".

It is also the largest thing this app reads. `transmog.rs` keeps nothing from it: the rows
are walked once per set opened and only the dozen names that set needs become strings, so the
63 MB is transient and no cache has to be invalidated when the player patches the game.

## The chain, verified

Every hop below was resolved on a real install with **zero unresolved lookups** — except the
one into `ItemSparse`, which was added afterwards and whose column positions are the
community's rather than this repository's, as its own section above says.

```
TransmogSetItem
  col0 = TransmogSetID            (inline $relation$)
  col1 = ItemModifiedAppearanceID
     │
     ▼
ItemModifiedAppearance            (id inline)
  col1 = ItemID  ────────────────▶ ItemSparse.col5 = Display_lang, the item's name
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
  col12 = ModelType[2]                ← nothing reads it; see below
  col13 = GeosetGroup[6]              ← which geoset variant the item switches on
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

**The table ends in six array columns, and 12 and 13 are the pair worth reading twice.** All
six were read off 12.0.5.67 on 2026-07-27 with `examples/dump_display_columns`, which is what
to run again after a patch:

| Column | Field | Elements |
|---|---|---|
| 10 | `ModelResourcesID` | 2 |
| 11 | `ModelMaterialResourcesID` | 2 |
| 12 | `ModelType` | 2 |
| 13 | `GeosetGroup` | 6 |
| 14 | `AttachmentGeosetGroup` | 6 |
| 15 | `HelmetGeosetVis` | 2 |

`GeosetGroup` is column **13**, not 12 — the community's definitions were read here as putting
it before `ModelType` and it comes after. Three things say so, and the install stores every one
of these as a palette of runs, which is what makes the first of them readable at all:

- **How many values one entry holds.** 12 holds two and 13 holds six, which is the shape of
  `ModelType[2]` and `GeosetGroup[6]` and of nothing else in the run.
- **How big the numbers are.** A geoset value is 0 to 98, and -1 where a row drives no geoset.
  10 and 11 fail that on half the table; 12 reads `-1` on every piece of armour, which is
  `ModelType` saying the item has no model of its own.
- **A robe against a breastplate.** Both are the chest slot, whose six values drive sleeves,
  chest, robe, torso and arm upper in that order. Every robe read leaves the chest group at 0
  and puts a 1 in the robe group — `[1, 0, 1, 0, 0, 0]` for Acolyte's Robe — and every
  breastplate has neither. No other column in the table looks like that.

Getting it wrong is quiet rather than loud, which is the reason it went unchecked for so long
and the reason it is bounded anyway: `character.rs` takes a group over only when the body
actually holds the geoset the value resolves to, so a column that moves reads as an appearance
that changes nothing rather than as a character with a limb missing.

For body-component textures — which is how armour is drawn — the path is different and
does **not** go through `col11`:

```
ItemDisplayInfoMaterialRes        (id in the id list)
  foreign_id() = ItemDisplayInfoID   ← relationship block, nowhere else
  col0 = ComponentSection (0..=8)
  col1 = MaterialResourcesID  ──▶ TextureFileData ──▶ one or more BLP2
                                     └──▶ ComponentTextureFileData, below
```

Verified: 221,170 readable rows, **every one** attributed to a display, 93,179 distinct
displays, component sections spanning exactly `0..=8`.

### ComponentTextureFileData

**A material resource can name several files**, one per body the game painted it for, and
`TextureFileData` does not say which is which. This table does, keyed by the FileDataID itself:

```
ComponentTextureFileData          (id in the id list — the texture's own FileDataID)
  col0 = GenderIndex               0 male, 1 female, 2 none, 3 any
  col1 = ClassID                   0 is every class
  col2 = RaceID
```

Its column positions are the community's, like `ItemSparse`'s and unlike the chain above. The
matching rule is wow.export's `DBComponentTextureFileData`: keep the candidates whose gender is
the one being drawn or "any" and whose class is generic, prefer the more specific, and break
ties by race.

**Silence is not exclusion.** Most of the game's armour has no row here at all, and a reader
that read the absence as "not for this body" would leave the character bare. An untagged file
is the fallback, and taking the first or the lowest-numbered file instead is what dresses a
Human Female in a Human Male's chest.

Per-region texture columns (`ArmUpperTexture`, `TorsoUpperTexture`, …) **left
`ItemDisplayInfo` in Legion**. They are historical; do not look for them.

## What actually has geometry

The single most consequential finding, measured across real transmog sets:

| `DisplayType` | Slot | `ModelResourcesID` | Geometry |
|---|---|---|---|
| 0 | head | non-zero | an M2 of its own |
| 1 | shoulder | non-zero | an M2 of its own |
| **2–10** | **shirt, chest, waist, legs, feet, wrist, hands, back, tabard** | **0** | **none at all** |
| 11, 12, 13, 15 | weapons and shields | non-zero | an M2 of its own |

Most armour has no model. It is texture painted onto the character's body, plus geoset
toggles that swap which parts of the body mesh are drawn. On a twelve-piece armour set,
rendering item models alone draws **two** pieces.

This is why `ItemDisplayInfoMaterialRes` and the relationship block are load-bearing
rather than incidental, and why showing armour at all requires the character-rendering
work in [character-rendering.md](character-rendering.md).

The `DisplayType` → slot naming above was read off 12.0.5.67 on 2026-07-27, an item at a
time, with `examples/dump_display_columns`: a Blackrock Pauldrons is 1, a Recruit's Shirt 2,
a Robe of the Magi 3, a Support Girdle 4, a Lambent Scale Legguards 5, a Recruit's Boots 6,
an Ice-Covered Bracers 7, a Thick Cloth Gloves 8, an Overseer's Cloak 9, a Guild Tabard 10.
Swords, staves and daggers are 11, bows and wands 12, shields 13.

**This is not what the community's definitions say**, which put the chest at 2 and the shirt
last at 10. Every slot from the chest down sits one higher than that list, because the shirt
is 2 rather than 10. The set detail view and `worn.rs`'s slot → geoset-group table both follow
what the install says. 11 upward are still named "weapon or shield" between them rather than
one by one, because nothing says which of them is the main hand and which the off hand and
four labelled guesses would read as fact.

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
handful of ids and is what to run after a patch — as `dump_items` is for `ItemSparse` and
`dump_transmog` for the chain above.

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
display whose only model sits in the second slot, an item `ItemSparse` holds a row for and no
name in, an achievement filed under a category whose parent is encrypted, one filed under a
category that is not in the tree at all, and one the game withholds entirely.

The `ItemSparse` fixture is the only one with variable-length records, and it is where that
half of the reader is exercised: strings written into the record, records addressed through
the offset map, numeric columns *behind* the strings that only a reader which walked them
finds, and an encrypted section whose offset map arrives as zeroes along with its rows.

The transmog script also writes the models: invented `.m2` files with the chunk layout the retail
client uses, their `.skin` profiles, and the `.blp`s they are painted with. Between them they
hold both of the traps in [character-rendering.md](character-rendering.md) — offsets counted
from inside the `MD21` chunk, and a submesh that starts past the first 64k of the index list,
which is why `141004.skin` is 131 KB of mostly padding.

It also writes the character body, under the FileDataID the retail client keeps
`humanfemale_hd.m2` at: seventeen cubes carrying the geoset groups the fixture's own items
drive — sleeves, chest, robe, trousers, boot, feet and helm, each as a bare default beside the
variant an item switches on — a hair part on M2 texture type 6 beside a body on type 1, and a
skull past the first 64k of the index list. Those are the three things an item's model never
exercises, and all three fail as geometry rather than as an error — see
[character-rendering.md](character-rendering.md).

The body textures beside them are the other half: one picture per row of
`ItemDisplayInfoMaterialRes` that resolves to a file, each painted in colours of its own so that
a test can say which rectangle of the atlas it landed in, and two of them banded so that a layer
copied rather than blended, or scaled without a filter, shows up as a colour rather than as a
judgement call.

`helm.glb`, `character.glb` and `robe.glb` are the derived fixtures: the converters' own output,
which the browser tests load into three.js to prove that what this app writes is glTF a loader
will take. Tests in `models.rs` and `character.rs` fail if any of them has drifted from what the
converters now produce:

```sh
cargo run --manifest-path apps/desktop/src-tauri/Cargo.toml --example dump_model -- \
    --fixtures apps/desktop/fixtures/transmog 900001 apps/desktop/fixtures/transmog/helm.glb
cargo run --manifest-path apps/desktop/src-tauri/Cargo.toml --example dump_model -- \
    --fixtures apps/desktop/fixtures/transmog character apps/desktop/fixtures/transmog/character.glb
cargo run --manifest-path apps/desktop/src-tauri/Cargo.toml --example dump_model -- \
    --fixtures apps/desktop/fixtures/transmog worn/900012/2 apps/desktop/fixtures/transmog/robe.glb
```

Every fixture table carries an encrypted section, because that is where the edge cases
live. Nothing in `apps/desktop/fixtures/` is derived from game assets, which is what
keeps the committed tests distributable.

## Sources

- [wowdev.wiki/DB2](https://wowdev.wiki/DB2) — WDC5 header, storage types, relationship map
- [WoWDBDefs](https://github.com/wowdev/WoWDBDefs) — per-build column layouts
- [wow-listfile](https://github.com/wowdev/wow-listfile) — FileDataID ↔ filename
- [wago.tools](https://wago.tools/) — live DB2 exports, useful for cross-checking a build
