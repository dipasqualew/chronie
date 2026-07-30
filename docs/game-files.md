# Reading the game's own files

How the desktop app gets from "a transmog set" to the bytes of a model and a texture.

This exists so that nobody has to go and look twice. Everything below was read off a
real install once, deliberately, and written down; going back to the install is for
the questions it does not answer, and an answer found that way belongs here
afterwards, marked with the build it came from.

**Provenance.** Verified against build `12.0.5.67` (Midnight) on 2026-07-26; `Item` and the
four `ItemSparse` columns beside the name against the same build on 2026-07-27; the array
columns of `ItemDisplayInfo` and the `DisplayType` slot numbering against the same build on
2026-07-27 — the two things this file used to carry on the community's say-so; the
customization chain below against `12.0.5.67823` on 2026-07-27; `ComponentModelFileData`,
`HelmetGeosetData` and the cape chain against `12.0.5.67` on 2026-07-27; and the customization
options, their swatches and the geosets those drive, and what a body is — `ChrModel`,
`CharComponentTextureSections`, `ChrModelMaterial` — against `12.0.5.67` on 2026-07-28; and
`CurrencyTypes` against `12.0.5.67823` on 2026-07-29. Column
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

### What an open handle holds, and what it costs

Opening the storage is a quarter of a second and a couple of hundred megabytes, so the
app opens one and keeps it — `casc::OpenStorage`, reopened when the install path changes
or when the launcher moves onto another build. That only works because of how the three
tables underneath are stored, and each of them was something else first. Read off
**build 12.0.5.67823**, EU, macOS, by `cargo run --release --example weigh_casc`:

| | what it is | held | was |
|---|---|---|---|
| `.idx` index | 1,526,119 entries, 9-byte key prefix → archive/offset/size | 50 MB | 143 MB |
| encoding | 195,148,023 bytes decoded; content-key half is 26,321 pages × 4KB | 104 MB | 468 MB |
| root | 1,884,024 file ids, 3,191,148 variants, 149,614 path hashes | 61 MB | 794 MB |

Three traps, all paid for once:

**Root is not worth a general-purpose parser.** `tact_parser`'s `WowRoot` is a
`BTreeMap<u32, BTreeMap<LocaleContentFlags, Md5>>` — an inner map allocated per file id,
and there are 1.88 million of them — and it collects the Jenkins path hashes as well.
Chronie addresses everything by FileDataID and never asks for a path, so `Root` parses
the blocks itself, keeps one flat `(file id, content key)` per variant, and steps over
the hashes. That is 61MB against 794MB, and it was the single largest thing an open
handle carried. The dependency existed for this and nothing else.

**Half the encoding file answers a question nobody asks.** Its layout is header, ESpec
block, content-key page table, content-key pages, then a second page table and pages
keyed by *encoding* key. Only the content-key half is ever searched; on this build the
ESpec block and the encoding-key tables are 86MB of the 186. `Encoding::parse` keeps the
span from the content-key page table to the end of its pages and drops the rest.

**BLTE payloads must be allocated at their decoded size.** The chunk table declares it up
front. Growing the output by doubling means the largest payload in the install — the
encoding file — is resident twice over while it is being moved, which on its own was
worth more than a hundred megabytes.

The count that matters when any of this is touched: the `.glb` for `set/5570` is
**14,490,442 bytes**, built from around fifty files pulled through both root and
encoding. A change that resolves the same bytes produces the same number.

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

FileDataIDs from the [community listfile](https://github.com/wowdev/wow-listfile). The build
in the last column is the one the table was last confirmed readable on; `community` means the
number is the listfile's and this repository has not held it against an install.

The table below and the FileDataID constants in `apps/desktop/src-tauri/src/tables.rs` are both
written out of `docs/game-tables.json` — see [Verifying a patch](#verifying-a-patch). Editing it
here does nothing.

<!-- generated from docs/game-tables.json: tables -->

| Table | FileDataID | Records | Readable | Verified |
|---|---|---|---|---|
| `TransmogSet` | 1376213 | fixed | yes | 12.0.5.67 |
| `TransmogSetItem` | 1376212 | fixed | yes | 12.0.5.67 |
| `TransmogSetGroup` | 1576116 | fixed | yes | 12.0.5.67 |
| `ItemModifiedAppearance` | 982457 | fixed | yes | 12.0.5.67 |
| `ItemAppearance` | 982462 | fixed | yes | 12.0.5.67 |
| `ItemDisplayInfo` | 1266429 | fixed | yes | 12.0.5.67, `examples/dump_display_columns` |
| `ItemDisplayInfoMaterialRes` | 1280614 | fixed | yes, needs `foreign_id()` | 12.0.5.67 |
| `ModelFileData` | 1337833 | fixed | yes | 12.0.5.67 |
| `TextureFileData` | 982459 | fixed | yes | 12.0.5.67 |
| `ComponentTextureFileData` | 1278239 | fixed | yes | 12.0.5.67 |
| `ComponentModelFileData` | 1349053 | fixed | yes | 12.0.5.67 |
| `HelmetGeosetData` | 2821752 | fixed | yes, needs `foreign_id()` | 12.0.5.67 |
| `CharComponentTextureSections` | 1360263 | fixed | yes | 12.0.5.67 |
| `CharComponentTextureLayouts` | 1360262 | fixed | yes | 12.0.5.67 |
| `ChrModelMaterial` | 3566562 | fixed | yes | 12.0.5.67 |
| `ChrModelTextureLayer` | 3548976 | fixed | yes | 12.0.5.67 |
| `ChrModel` | 3384313 | fixed | yes, **columns read** | 12.0.5.67, `examples/dump_bodies` |
| `ChrRaces` | 1305311 | fixed | yes, **columns read** | 12.0.5.67, `examples/dump_bodies` |
| `ChrRaceXChrModel` | 3490304 | fixed | yes | 12.0.5.67 |
| `CreatureDisplayInfo` | 1108759 | fixed | yes, 119,028 rows | 12.0.5.67, `examples/dump_bodies` |
| `CreatureModelData` | 1365368 | fixed | yes, id beside the rows | 12.0.5.67, `examples/dump_bodies` |
| `ChrCustomizationOption` | 3384247 | fixed | yes | 12.0.5.67, `examples/dump_customization` |
| `ChrCustomizationChoice` | 3450554 | fixed | yes | 12.0.5.67, `examples/dump_customization` |
| `ChrCustomizationElement` | 3512765 | fixed | yes | 12.0.5.67, `examples/dump_customization` |
| `ChrCustomizationMaterial` | 3459652 | fixed | yes | 12.0.5.67, `examples/dump_customization` |
| `ChrCustomizationGeoset` | 3456171 | fixed | yes | 12.0.5.67, `examples/dump_customization` |
| `Achievement` | 1260179 | fixed | yes | 12.0.5.67, `examples/dump_achievements` |
| `Achievement_Category` | 1324299 | fixed | yes | 12.0.5.67, `examples/dump_achievements` |
| `Faction` | 1361972 | fixed | yes, **columns read**, name in col1 | 12.0.5.67823, `examples/dump_achievements` |
| `Criteria` | 1263817 | fixed | yes, **columns read**, id in col0 | 12.0.5.67823, `examples/dump_achievements` |
| `CriteriaTree` | 1263818 | fixed | yes, **columns read** | 12.0.5.67823, `examples/dump_achievements` |
| `Item` | 841626 | fixed | yes | 12.0.5.67, `examples/dump_item_facts` |
| `ItemSparse` | 1572924 | offset map | yes, needs `parse_with_text_columns()` | 12.0.5.67, `examples/dump_items` |
| `JournalInstance` | 1237438 | fixed | yes, **columns read** | 12.0.5.67823, `examples/dump_journal` |
| `LFGDungeons` | 1361033 | fixed | yes, **columns read**, only through col8 | 12.0.5.67823, `examples/dump_journal` |
| `JournalEncounter` | 1240336 | fixed | yes, **columns read**, id in col3 | 12.0.5.67823, `examples/dump_journal` |
| `JournalEncounterCreature` | 1301155 | fixed | yes, **columns read**, id in col2 | 12.0.5.67823, `examples/dump_journal` |
| `CurrencyTypes` | 1095531 | fixed | yes, **columns read** | 12.0.5.67823, `examples/dump_currencies` |
| `UiMap` | 1957206 | fixed | yes, **columns read** | 12.0.5.67823, `examples/dump_maps` |
| `UiMapXMapArt` | 1957217 | fixed | yes, **columns read** | 12.0.5.67823, `examples/dump_maps` |
| `UiMapArt` | 1957202 | fixed | yes, **columns read** | 12.0.5.67823, `examples/dump_maps` |
| `UiMapArtStyleLayer` | 1957208 | fixed | yes, **columns read** | 12.0.5.67823, `examples/dump_maps` |
| `UiMapArtTile` | 1957210 | fixed | yes, **columns read** | 12.0.5.67823, `examples/dump_maps` |
| `WorldMapOverlay` | 1134579 | fixed | yes, **columns read** | 12.0.5.67823, `examples/dump_maps` |
| `WorldMapOverlayTile` | 1957212 | fixed | yes, **columns read** | 12.0.5.67823, `examples/dump_maps` |

<!-- /generated -->

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

### Item, verified

The small table beside `ItemSparse`, and the one that answers what a thing actually *is*.
Measured on 12.0.5.67: 2 MB, 209,804 rows readable, 15 columns, ids kept in a list of their own
rather than in a column. Every column below was read off that install with
`examples/dump_item_facts`, which is what to run again after a patch:

```sh
cargo run --release --example dump_item_facts -- "<install>"
```

```
Item                              (id in the id list)
  col0 = ClassID                   2 weapon, 4 armour, and a dozen kinds nothing is worn from
  col1 = SubclassID                for armour: 1 cloth, 2 leather, 3 mail, 4 plate, 5 cosmetic
  col3 = InventoryType             the same number ItemSparse keeps, in the two-megabyte table
  col6 = IconFileDataID  ─────────▶ a BLP icon, decoded through `icons`
```

Three checks, each of which a wrong column could not pass:

- **`col3` agrees with `ItemSparse.InventoryType` on 100.00% of the 171,898 items both tables
  hold.** That column was itself found rather than trusted (see below), so the two of them
  agreeing is two independent readings of the same fact.
- **94.91% of worn armour is filed under an armour subclass.** The remainder are the necks and
  shirts, which the game files as miscellaneous — subclass 0 — and which the app deliberately
  says nothing about rather than drawing a "Miscellaneous" chip on every ring in a history.
- **The icons resolve.** Both the classic range (`134414` is the Hearthstone's) and the modern
  one (`6331355`, on items added in 12.0) decode through `icons.rs`.

### ItemSparse, the four columns beside the name

`transmog.rs` reads the name and where a weapon is held; `items.rs` reads three more, and all of
them were read off 12.0.5.67 with the same tool:

| Column | Field | What says it is right |
|---|---|---|
| 52 | `AllowableClass` | `0xFFFF` on all but 29,455 items, and those are the class sets, the rogue poisons (mask 8) and the warlock grimoires (mask 256) |
| 65 | `RequiredLevel` | 0 for a hearthstone, 17 for a level-22 green, and never above the cap |
| 66 | `InventoryType` | found by `dump_inventory_types`; see below |
| 67 | `OverallQualityID` | spans exactly 0..8, mostly common through epic, with 771 legendaries and 478 heirlooms in the whole game; Thunderfury reads legendary and the Hearthstone common |

The class mask is `1 << (classID - 1)`, and a legacy item can carry bits above the thirteen
classes the game has shipped — so a restriction is built by naming the classes that exist
rather than by naming the bits that are set. A mask covering all thirteen is not a restriction
however many spare bits travel with it.

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

### ComponentModelFileData, verified

The same trap as `ComponentTextureFileData` with meshes behind it, and the same three columns —
plus a fourth that turns out to carry the whole of how a pair of shoulders works:

```
ComponentModelFileData            (id in the id list — the model's own FileDataID)
  col0 = GenderIndex               0 male, 1 female, 2 none, 3 any
  col1 = ClassID                   0 is every class
  col2 = RaceID
  col3 = PositionIndex             which shoulder, and -1 on everything that is not one
```

**A helm uses the first three and a pauldron uses the fourth, and neither uses both.** Counted
across every armour display on 12.0.5.67:

| Slot | What its model resources' files are tagged | Count |
|---|---|---|
| 0 head | `gender [0, 1]`, `position [-1]` | 5,778 |
| 1 shoulder | `gender [2]`, `positions [0, 1]` | 10,449 |
| 11–15 weapons and shields | no row at all | 17,522 |

So a helm is modelled once per race and gender — display 1126's resource names **31 files** —
and picking the wrong one puts a Human Male's helm on a Human Female. A shoulder is modelled
once per *side*: `ModelResourcesID[0]` and `[1]` are two pad designs, each resource holds the
design and its mirror, and `PositionIndex` is the only thing that tells the two apart.
**Position 0 is the character's left**, which the geometry says outright — 143183 has a mean
game-Y of `+0.0837` and its position-1 twin 143486 of `-0.0837`, the same mesh flipped. Element
0 of `ModelResourcesID` goes to position 0 and attachment 6; element 1 to position 1 and
attachment 5.

Two ways to be wrong here, both of them quiet:

- **Taking the lowest id.** Right for a level of detail and right for a texture's second usage,
  wrong for both of these — the male helm and the mirrored pad are numbered below the ones
  wanted about as often as not.
- **Reading gender 2 as "not this body".** It is the game's "none", and every shoulder model in
  the game carries it. Read as an exclusion there is not a pauldron anywhere.

### HelmetGeosetData, verified

What a helm covers up. Not a variant swap — the whole group goes, because there is no variant
of hair that fits under a helm:

```
HelmetGeosetData                  (id in the id list)
  foreign_id() = HelmetGeosetVisDataID   ← the relationship block, and nowhere else
  col0 = RaceID
  col1 = HideGeosetGroup           0 hair, 1–3 facial hair, 7 ears, and the rest
  col2 = zero on all but 5 of 19,150 rows
  col3 = RaceBitSelection          32 or -1 throughout
```

`ItemDisplayInfo.HelmetGeosetVis[2]` (column 15) points into it, one entry per gender, and the
community reads them as male then female. **The rows under one entry cover every race the game
ships**, so the race has to be matched too — 126 distinct vis ids across 19,150 rows.

The gender choice is less load-bearing than it looks: across the 5,698 helm displays on this
build, the two entries hide hair equally often (4,576 each) and facial hair almost equally
(2,069 against 2,061). They differ on the rarer groups.

### A cape has geometry and no model

The back slot is the exception to the table above. Its displays keep **both model slots at
zero** and name a material anyway, because the cloak is the *body's* geometry — geoset group 15
— and what the appearance supplies is only the picture on it, out of
`ModelMaterialResourcesID[0]` and bound as M2 texture type 2. See
[character-rendering.md](character-rendering.md#what-a-cape-is).

## What actually has geometry

The single most consequential finding, measured across real transmog sets:

| `DisplayType` | Slot | `ModelResourcesID` | Geometry |
|---|---|---|---|
| 0 | head | non-zero | an M2 of its own |
| 1 | shoulder | non-zero | an M2 of its own |
| **2–10** | **shirt, chest, waist, legs, feet, wrist, hands, back, tabard** | **0** | **none at all** |
| 11, 12, 13, 14, 15 | weapons, shields, ammunition | non-zero | an M2 of its own |

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
what the install says.

### Which hand: `ItemSparse.InventoryType`, verified

`DisplayType` gets a weapon as far as "a weapon" and no further. 11 is a one-hander and a
two-hander alike, 15 is a tome and an off-hand weapon, and nothing in any of the four says
which hand — which is why they were all shown as "weapon or shield" rather than as four
labelled guesses.

**`ItemSparse.InventoryType` is the way out**, and it costs nothing extra because that table
is already open for the item's name. It is **column 66**, which was *found* rather than
trusted: every armour `DisplayType` has exactly one inventory type it can be — a helm is 1, a
pair of shoulders 3, a cloak 16 — so the right column is the one that agrees with all eleven of
them at once. On 12.0.5.67, column 66 agrees on 99.83% of the game's 77,356 pieces of armour
and nothing else in the 68-column table comes within 13%. That search is
`examples/dump_inventory_types`, and it is what to run again after a patch:

```sh
cargo run --example dump_inventory_types -- "<install>"
```

The cross-tab it prints, on that build, is what the naming and the hands both come from:

| `DisplayType` | `InventoryType` | Count | Hand |
|---|---|---|---|
| 11 | 13 one-hand | 8,280 | right |
| 11 | 17 two-hand | 5,573 | right — **one model on one attachment**, not two |
| 11 | 21 main hand | 220 | right |
| 11 | 22 off hand | 39 | left |
| 11 | 23 held in off hand | 231 | left |
| 11 | 29 profession tool | 151 | right |
| 12 | 15 ranged | 756 | left — a bow, held where a player holds one |
| 12 | 25 thrown | 183 | right |
| 12 | 26 ranged right | 1,851 | right — a gun, a crossbow, a wand |
| 13 | 14 shield | 1,749 | **neither**: the forearm, attachment 0 |
| 14 | 24 ammo | 60 | none — arrows are not held |
| 15 | 23 held in off hand | 1,082 | left |
| 15 | 30 profession accessory | 7 | left |

Two of those hands are named rather than counted, and are the only guesswork left in it: the
game keeps 15 and 26 as separate inventory types and calls the second one *ranged right*, which
is the only thing said anywhere about which hand either goes in. A profession tool and its
accessory follow the main-hand and off-hand pair beside them. Everything else is the game's own
word: a shield is a shield and an off hand is an off hand.

**Sheathed is not read at all.** A weapon has two homes — the hand and the back or the hip —
and `ItemDisplayInfo.SheatheTransformMatrixID` is where the second one's transform lives. The
detail view shows the drawn weapon, so the sheath attachments (25, 26 and 27 on the body) and
that column are all deliberately left alone; the trap they set is showing a sword on her back
while claiming it is in her hand.

### A row with no name and no place, counted

Two symptoms in the transmog view are one fact about the chain: **an appearance whose
`ItemSparse` row cannot be read has no name and no inventory type**, so it draws as
"Item 254538" and — if it is a weapon, where the display type says nothing about which hand —
as "the game gives this appearance no place on a character". Reading the name and reading the
hand are the same lookup, so they fail together and never separately.

Counted on `12.0.5.67823` on 2026-07-27, over all 72,141 rows of `TransmogSetItem`:

| | Rows | What the view shows |
|---|---|---|
| `ItemModifiedAppearance` withheld | 122 | "The game keeps this appearance encrypted" |
| No `ItemSparse` row, so no name | 188 | `Item <id>`, across 24 sets |
| No place on a character | 3 | all in set 2201, items 184919–184921 |

So both are rare, and neither is this app losing something the install holds: 171,898 of the
table's 171,964 rows parse, and the missing items are the ones Blizzard encrypts. Anything
much larger than these numbers is a *reader* fault — the name column having moved under a
patch, or `InventoryType` no longer at 66 — and the two dumps above are what tell the two
apart. The one thing that looks like this and is not is an app built before the reader learned
to read `InventoryType` at all: every weapon in the game then lands under "no place on a
character", because nothing says which hand any of them goes in.

### Every look of a kind, verified

The transmog view browses the same chain **backwards** as well: not "what is in this set" but
"what does the game hold for a head". `wardrobe.rs` walks `ItemAppearance` outward —
`ItemModifiedAppearance` back to the items, `ItemSparse` for the names, `ItemDisplayInfo` for
whether there is geometry — and adds the one table the set chain never needed, `Item`, for what
kind of thing each item is.

**That extra table is the whole difference, and it is not optional.** `DisplayType` files every
axe, sword, staff and dagger in the game under 11, and `InventoryType` separates one hand from
two and stops; a picker built on either could not offer "staves". `Item.SubclassID` is the only
statement anywhere in the game's files of which weapon a weapon is.

Read off 12.0.5.67 on 2026-07-28 with `examples/dump_wardrobe`, which is what to run again
after a patch:

```sh
cargo run --release --example dump_wardrobe -- "<install>"           # every kind, counted
cargo run --release --example dump_wardrobe -- "<install>" 11 12 13 14 15
```

`ItemAppearance` holds 63,090 readable rows of 63,205 declared. What each kind of place comes
to, once the looks no item of this install reaches are set aside:

| Display type | Looks | Unreachable | Display type | Looks | Unreachable |
|---|---|---|---|---|---|
| 0 head | 5,111 | 591 | 8 hands | 4,194 | 359 |
| 1 shoulder | 4,736 | 518 | 9 back | 3,742 | 1,801 |
| 2 shirt | 169 | 16 | 10 tabard | 320 | 45 |
| 3 chest | 5,185 | 807 | 11 held in a hand | 11,322 | 1,640 |
| 4 waist | 4,194 | 457 | 12 ranged | 1,957 | 311 |
| 5 legs | 4,345 | 412 | 13 shield | 1,250 | 97 |
| 6 feet | 4,233 | 385 | 14 ammo | 20 | 21 |
| 7 wrist | 3,603 | 332 | 15 held in off hand | 817 | 100 |

"Unreachable" is an appearance no `ItemModifiedAppearance` row this install can read points at,
which is a look the game will say *nothing* about — no item, no name, no kind. A set keeps such
a row because the count on its card promised it; a catalogue promised nothing, so those are
counted in the payload and left out of the list.

The 15,366 things held in a hand are asked for as one answer and cut up by subclass, which is
what the kind picker in `wardrobe.ts` is built from. On that build:

| Subclass | Looks | Subclass | Looks | Subclass | Looks |
|---|---|---|---|---|---|
| 0 one-handed axe | 899 | 7 one-handed sword | 1,448 | 15 dagger | 1,427 |
| 1 two-handed axe | 603 | 8 two-handed sword | 858 | 16 thrown | 119 |
| 2 bow | 572 | 9 warglaive | 335 | 18 crossbow | 255 |
| 3 gun | 484 | 10 staff | 1,812 | 19 wand | 529 |
| 4 one-handed mace | 1,471 | 13 fist weapon | 649 | armour 6 shield | 1,271 |
| 5 two-handed mace | 663 | 14 miscellaneous | 59 | armour 0 off hand | 902 |
| 6 polearm | 855 | | | | |

Three subclasses the community's definitions name are absent from that install and are not
offered: the two exotic weapon slots, and the spear. Fishing poles are absent too — the game
gives them no transmog appearance at all. What *is* offered beyond this table is a kind that
filters nothing, because a hundred-odd looks belong to kinds no player has a word for
(profession tools, ammunition, an item filed under a class nothing else uses) and a payload the
window fetched and cannot show would be worse than an untidy list.

The whole wardrobe at once is 55,198 looks and 14 MB of payload, which is why the window asks
for one kind at a time. Each such read costs about a second, and 640 ms of that is opening the
game's storage: the tables themselves are 8 ms for `ItemAppearance`, 17 for
`ItemModifiedAppearance`, 17 for `Item` and 193 for `ItemSparse`.

## The character herself, verified

What an item paints is above; what the body already *is* comes from somewhere else entirely.
A character is a set of customizations the player picked, and four hops stand between a swatch
and what it does. All of them were read off `12.0.5.67823` on 2026-07-27 with
`examples/dump_customization`; the options, their swatches and the geosets those drive were
read off `12.0.5.67` on 2026-07-28, as were every question this body can be asked and every
swatch of each. That is what to run again after a patch:

```sh
cargo run --example dump_customization -- "<install>"
```

**Every table on this chain keeps its id beside the rows rather than in them** *except* the two
the reader starts at, so `ID` is not a column and everything sits one place earlier than the
community's field list reads. That is the single thing most likely to go wrong here, and the
column *count* is what says it: two in `ChrCustomizationMaterial` rather than three.

```
ChrCustomizationOption            (id inline, in column 1)
  col0 = Name_lang                 "Skin Color", "Face Shape", "Hair Style", "Ears"…
  col1 = ID
  col4 = ChrModelID                ← 2 is Human Female. Every playable body is in this table.
  col5 = OrderIndex
     │
     ▼
ChrCustomizationChoice            (id inline, in column 1 — the other exception)
  col1 = ID                        85 is Human Female's first skin swatch
  col2 = ChrCustomizationOptionID  14, which ChrCustomizationOption names "Skin Color"
  col5 = OrderIndex                0, which is what makes it the default
     │
     ▼
ChrCustomizationElement           (id in the id list)
  col0 = ChrCustomizationChoiceID   ← an ordinary column, not the relationship block
  col1 = RelatedChrCustomizationChoiceID   0, or a swatch that must be chosen as well
  col2 = ChrCustomizationGeosetID     0 where the element paints instead
  col4 = ChrCustomizationMaterialID   0 where the element drives a geoset and paints nothing
     │                                        │
     ▼                                        ▼
ChrCustomizationGeoset            ChrCustomizationMaterial          (both id in the id list)
  col0 = GeosetType                 col0 = ChrModelTextureTargetID   which layer of the atlas
  col1 = GeosetID                   col1 = MaterialResourcesID
  geoset = type × 100 + id             │
                                       ▼
                                  TextureFileData.col2 = MaterialResourcesID
                                    row.id() = FileDataID ──▶ BLP2
```

**`ChrCustomizationGeoset` is 3456171**, which is not in the table above because nothing had
needed it: it was found by scanning FileDataIDs for a DB2 whose ids covered the values
`ChrCustomizationElement.col2` names, and confirmed by its three columns reading as a group, a
value in it, and a modifier of −1 throughout.

**The option belongs to a body, and the swatch is the first by order index.** Both are
one-line filters and both are quiet when wrong. `ChrCustomizationOption` describes every
playable model at once, so a Dracthyr's face shape is a row of exactly the same shape as a
Human's and dropping `ChrModelID` gives one geoset group two owners. The rows sit in id order
and the ids are historical, so the first *row* of an option is not its first swatch.

**An element can be conditional.** A face is authored once per skin, so choosing Human Female's
first face names sixteen materials — one per skin swatch — and only the one whose
`RelatedChrCustomizationChoiceID` is the chosen skin applies. Taking them all leaves whichever
sits last, which is a face of the wrong colour on a body of the right one.

What Human Female's first swatch of each option comes to, read on 12.0.5.67 — the male body's
questions are ids of their own and include three the female body is never asked, a moustache, a
beard and sideburns:

| Option | Swatch 0 | Drives |
|---|---|---|
| 15 Face | 102 | material on target 5, per skin swatch; a bone set |
| 14 Skin Color | 85 | materials on targets 1, 13, 14 |
| 16 Hair Style | 132 | geoset 45 → **group 0 value 2**; materials on target 12, per hair colour |
| 17 Hair Color | 156 | material on target 10 — the hair atlas |
| 464 Eye Color | 4150 | material on target 25 — the eye atlas |
| 501 Piercings | 4752 | geoset 2058 → **3500**, no piercing |
| 510 Necklace | 4908 | geoset 2068 → **3600**, no necklace |
| 516 Makeup | 4963 | nothing |
| 526 Face Shape | 5059 | geoset 11350 → **3202, the head** |
| 970 Eyebrows | 15672 | material on target 8, per hair colour |
| 6339 Eyesight | 45090 | nothing |
| 8523 Eye Style | 54353 | nothing |
| 8790 Ears | 56653 | geoset 13292 → **702** |

**A value of 0 is the game switching a group off**, which is what "no necklace" is — and it is
a row to apply rather than a row to drop, because the group's own value 1 is a necklace.
`docs/character-rendering.md` has what that costs when it is missed.

### Which body, verified

A body is a `ChrModel`, and three tables say what one *is*. All of them were read off 12.0.5.67
on 2026-07-28 with `examples/dump_bodies`, which is what to run again after a patch:

```
ChrModel                                (id inline, in column 2)
  col3 = Sex                             0 male, 1 female
  col4 = DisplayID                     ──▶ CreatureDisplayInfo, and the mesh — see below
  col5 = CharComponentTextureLayoutID    103 Human Male, 104 Human Female
     │
     ▼
CharComponentTextureSections            (id beside the rows)
  col0 = CharComponentTextureLayoutID
  col1 = SectionType   col2 = X   col3 = Y   col4 = Width   col5 = Height

ChrModelMaterial                        (id inline, in column 0)
  col1 = CharComponentTextureLayoutID
  col2 = TextureType                     1 is the composited body atlas
  col3 = Width   col4 = Height
```

Layout 104's ten sections come out as exactly the table
`docs/character-rendering.md` already carried, which is what says the columns are right; layout
103 states the same ten and the same 2048 × 1024 atlas. `CharComponentTextureLayouts` (1360262)
states a size per layout as well — two columns, width then height — and is not read, because
`ChrModelMaterial` states one per *texture type* and the body's is the one that matters.

### The mesh, and which races there are, verified

`ChrModel.DisplayID` → `CreatureDisplayInfo.ModelID` (col1) → `CreatureModelData.FileDataID`
(col2) is the chain to a body's mesh, and it resolves: 56658 → 7599 → 1000764 for the female
body and 57899 → 7661 → 1011653 for the male. Those two answers used to be constants, because
neither table's own FileDataID was known here and a scan of the storage for a table holding
1000764 found none. They are **1108759** and **1365368**, out of the community listfile, and
following the chain in the install reproduces both constants exactly and resolves all fifty-one
playable bodies besides. `CreatureModelData` keeps its ids **beside** the rows and its own
column 0 is a name hash large enough to read as a plausible anything, which is the pair's trap.

Which bodies those are comes from two more tables. `ChrRaceXChrModel` is a row per race and
body — col0 `ChrRacesID`, col1 `ChrModelID` — and it states a sex of its own that is *not* the
one to read: the Dracthyr's single body is listed twice there, once under each, while `ChrModel`
says it belongs to neither. `ChrRaces` carries the name at col2 and the flags at col15, and
**bit 0 of those flags is set on every race nobody can make**. Clearing it leaves exactly the
thirty-one the character creation screen offers, which is what says the column is right — and it
excludes three that no other column would: the Gilnean a Worgen was, the `ThinHuman` kept for
cutscenes, and the visage a Dracthyr wears.

Read off 12.0.5.67823 on 2026-07-28. `cargo run --example dump_bodies` prints all fifty-one.

### Every swatch, not only the first, verified

The table above is what a body nobody has said anything about comes to. What the reader may say
instead is the same rows without the "swatch 0" filter, and `customization::questions` is that
read; `dump_customization --questions` prints it. On 12.0.5.67, twelve of those thirteen
questions reach a reader:

| Question | Swatches | Named |
|---|---|---|
| 15 Face | 45 | **0** |
| 14 Skin Color | 23 | 1 |
| 16 Hair Style | 34 | 34 |
| 17 Hair Color | 58 | 15 |
| 464 Eye Color | 42 | 5 |
| 501 Piercings | 15 | 15 |
| 510 Necklace | 9 | 9 |
| 516 Makeup | 7 | 7 |
| 526 Face Shape | 3 | 3 |
| 970 Eyebrows | 26 | 26 |
| 6339 Eyesight | 4 | 4 |
| 8790 Ears | 2 | 2 |

**Most swatches have no name**, which is not a gap in the read: the character creation screen
draws a square of colour and `Name_lang` is genuinely empty. A window over this numbers them by
their place in `OrderIndex`, and a question can be half named — Hair Color names fifteen of
fifty-eight.

**8523 Eye Style is the thirteenth and is not offered.** No element names any of its swatches,
so nothing follows from answering it. That is the rule `questions` applies — a question none of
whose swatches drives a geoset or a material is left out — and it is worth applying rather than
showing a control that demonstrably changes nothing.

**Not every swatch of a question does the same kinds of thing.** Skin swatch 85 has three
elements — the skin and the two halves of the underwear — and a face authored against it; skin
swatch 96 has one, the skin, and no element anywhere names it as a related choice. So choosing
that one is a body with no underwear painted on and no face layer over the base skin, which is
the game's own data rather than a hop that went missing. `dump_customization <choice>` now
prints both directions of the relation, which is what says so.

**One choice paints several targets, and only one of them is the skin.** Choice 85 has three
elements: material 823 on target 1, and 824 and 825 on targets 13 and 14. All three resolve to
real BLP2s, so picking wrong is a body painted with something that looks like a skin and is
not. What settles it is `ChrModelTextureLayer`, keyed to the layout by the relationship block:

```
ChrModelTextureLayer              (id in the id list)
  foreign_id() = CharComponentTextureLayoutsID   ← the relationship block, and nowhere else
  col0 = TextureType                1 is the body atlas; 6 hair, 19 eyes, 20 jewelry
  col1 = Layer                      bottom first
  col3 = BlendMode                  1 is a straight copy; everything else blends
  col4 = TextureSectionTypeBitMask  one bit per SectionType; -1 is the whole buffer
  col7 = ChrModelTextureTargetID[2] ──▶ ChrCustomizationMaterial.col0
```

On layout 104 that reads, in full:

| Layer | Type | Blend | Target | What |
|---|---|---|---|---|
| 0 | 1 | **1, a copy** | **1** | **the base skin** |
| 1 | 6 | 1 | 10 | hair, on its own atlas |
| 2–9, 13 | 1 | 15, 6, 7 | 4, 5, 30, 29, 11, 12, 7, 8, 36 | face and item layers |
| 10 | 1 | 15 | 13 | underwear, section mask 32 — the upper legs |
| 11 | 1 | 15 | 14 | underwear, section mask 8 — the upper torso |
| 12, 16 | 19 | 1, 9 | 25, 44 | eyes |
| 14, 15 | 20 | 1 | 27, 28 | jewelry |

**The base skin is the one layer of the body atlas that is copied rather than blended**, which
is what `customization.rs` picks it out by. Blend mode 1 is wow.export's "blit"; it is the only
mode in `CharMaterialRenderer`'s switch that disables blending outright. Note that hair, eyes
and jewelry are copied too — the texture type has to be checked as well, or a hairline lands
across the body.

**The three atlases that are not the body's are one picture each.** Types 6, 19 and 20 have
buffers of their own rather than rectangles of the body's, and every layer of the three is a
copy but one: layer 16, a blend on the eye atlas, which none of the swatches above paints. So
each comes back as the copied layer that resolved, bound whole as the M2 texture type the
body's own parts ask for it under. There is no compositor for them.

Resolved end to end, Human Female's first swatches are:

| Hop | Value |
|---|---|
| element 2917 → material 823 | target 1, resource 128773 → **1002483**, BLP2 1024 × 512 |
| element 2918 → material 824 | target 13, resource 128747 → 1002457, BLP2 256 × 128 |
| element 2919 → material 825 | target 14, resource 128760 → 1002470, BLP2 256 × 128 |
| element 2964 → material 870 | target 5, resource 128587 → the face, per skin swatch 85 |
| element 3277 → material 14968 | target 10 → **3582288**, BLP2 256 × 256, the hair |
| element 18774 → material 14914 | target 25 → **3484643**, BLP2 256 × 128, the eyes |

**The underwear is not part of the skin texture**, which is what it was on the races that
predate the Shadowlands customization system. It is those two 256 × 128 pictures, blended into
one section rectangle each. A reader that took only the base gets a nude body; one that painted
all three over the whole buffer gets underwear for a body.

**Nor is the face.** The base skin's right half already holds one, and the face swatch is a
layer blended over it — which is why the skin resolves and looks complete while the character
still has no head: what the head *is* comes out of the geoset half of this chain and not the
picture half.

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
handful of ids and is what to run after a patch — as `dump_items` is for `ItemSparse`'s
strings, `dump_item_facts` for the rest of what an item is, `dump_transmog` for the chain
above and `dump_customization` for the skin.

## Currencies, verified

One table and one column of it. Everything else this app knows about a currency comes from
the addon — the client tells it the id, the name and the balance — and the one thing an addon
cannot send is the picture, because an addon has a texture *path* and this app draws from
FileDataIDs. `currencies.rs` reads it for the handful of ids a character actually holds.

```
CurrencyTypes                     (id in a list beside the rows)
  col0 = Name_lang                 "Honor", "Valorstones"
  col1 = Description_lang          the sentence the tooltip shows
  col2 = CategoryID
  col3 = InventoryIconFileID     ──▶ a BLP icon, decoded through `icons`
```

An ordinary table of fixed-size records with its strings in a block of their own — reading it
with `Db2::parse` and with `parse_with_text_columns` gives byte-identical answers, which is
how that was settled rather than assumed.

**Column 3 is the only one of the first ten that holds FileDataIDs at all.** Of the 1,490 rows
readable on 12.0.5.67823, 574 hold something in column 3 and every one of those 574 is a
six- or seven-digit id that resolves to a texture this install decodes. No other column in the
run comes near: columns 2, 4, 5, 8 and 9 hold nothing above 100,000 on any row, and the two
that hold a handful — 6 and 7 — hold single- and four-digit numbers on the rest. The other 916
rows carry no icon, which is an answer rather than a gap: most of them are counters the game
never shows a player.

Checked against what the names resolve to, since a reordered table shows wrong values rather
than failing: Honor (1792) at `1455894`, Conquest (1602) at `1523630`, Flightstones (2245) at
`5172976` and Valorstones (3008) at `5868902` — the modern currencies, which sit at the far
end of a table that opens in Burning Crusade — and every icon printed for the first two dozen
rows decodes as a PNG.

`cargo run --example dump_currencies -- "<install>"` prints the lot and is what to run after a
patch; pass names to reach a modern row.

## Places, verified

Two tables and one column of each. A segment arrives from the addon under the name of the place
it happened in and nothing else, because the client reports where a player is standing by its
localised name — so a name is the whole of what there is to key on, and both tables below are
keyed by that same localised name in the same locale the client used. `journal.rs` reads them
for the handful of places a window is showing.

```
JournalInstance                   (id in a list beside the rows)
  col0 = Name_lang                 "Deadmines", "Nerub-ar Palace"
  col1 = Description_lang          the paragraph the Adventure Guide shows
  col2 = MapID
  col3 = BackgroundFileDataID    ──▶ 512×512
  col4 = ButtonFileDataID        ──▶ 256×128, the wide banner
  col5 = ButtonSmallFileDataID   ──▶ 128×128, the icon, decoded through `icons`
  col6 = LoreFileDataID          ──▶ 512×512

LFGDungeons                       (id in a list beside the rows)
  col0 = Name_lang                 "Earthcrawl Mines", "Deadmines"
  col1 = Description_lang
  col2 = TypeID                    1 dungeon, 2 raid, 4 outdoor area, 6 random bucket
  col3 = Subtype                   3 is a delve
  col4 = Faction                   -1 for both
  col5 = IconTextureFileID       ──▶ 128×128 or 64×64, the picture the finder lists it with
  col6 = RewardsBgTextureFileID
  col7 = PopupBgTextureFileID
  col8 = ExpansionLevel
```

**Neither one is the whole answer, which is why there are two.** `JournalInstance` is 211 rows,
209 of which name an icon, and every one of those 209 decodes at 128×128 — it is the picture the
game draws for that dungeon and no other. `LFGDungeons` is 1,825 rows and a far wider net: it is
where the delves are, and where the six hundred names the journal has no row for are. **Delves
are not in the Encounter Journal at all** — of the whole delve roster only Zekvir's Lair has a
`JournalInstance` row, and that row names no icon — so a reader of the journal alone leaves every
delve a player runs blank.

So the journal is read first and the finder fills in behind it. Where both know a place they
agree on the picture 171 names out of 180; where they do not, the journal's is the hand-drawn one
and the finder's is often `136349`, `interface/lfgframe/lfgicon-quest.blp`, which it shows for a
good many entries at once — including every delve, which all share it. Between them the two
tables answer for **805 places** on 12.0.5.67823.

### And the wide banner, which is the segment modal's header

The same two tables one column over: `JournalInstance` col4 and `LFGDungeons` col7 both hold a
**256×128** banner, and the shape is the point — it is the only one of the four files either table
names that is drawn as a header rather than as a square or a portrait. All 209 of the journal's
decode at that size and 1,702 of the finder's 1,824 rows hold one, so between them they answer for
the same 805 places. `journal::heroes_of` is the reader, and it differs from the icon's in two
ways.

**It reads the finder first, which is the opposite order, and the art is what decided it.** The
opaque part of every banner, measured on 12.0.5.67823:

| Place | `JournalInstance` col4 | `LFGDungeons` col7 |
|---|---|---|
| Naxxramas | `1396587`, 166×88 at (4,4) | `340679`, 256×128 full |
| Deadmines | `522352`, 166×88 at (4,4) | `337488`, 256×128 full |
| Shadowfang Keep | `522358`, 166×88 at (4,4) | `340687`, 256×128 full |
| Nerub-ar Palace | `5912550`, 166×88 at (4,4) | `5912523`, 256×128 full |

The journal's is 166×88 of picture inset into a file of twice the area — the Adventure Guide draws
it at that size and composites it — so a header cut from one has a transparent margin down two
sides. The finder's fills its file. So the finder's is preferred and the journal's fills in behind
it for the places the finder has no row for; the trade is the mirror of the icon's, in that the
finder shows one banner for a whole kind of thing here and there (`615222` is every delve's) where
the journal's is always that dungeon's own.

**And every name it is asked about comes back.** A place with no banner and no map of its own is
answered with `337493`, `interface/lfgframe/ui-lfg-background-randomdungeon.blp` — the banner the
finder shows when it will not say which dungeon a player is being sent to, which is the same size
and the same style as the real ones, and fully opaque. The alternative was a modal that opened with
a header for a raid and with a bare line of text for the zone outside it, which reads as two
different modals. What the stand-in was for when it was written was every open-world zone, which is
most places; since "Zone maps, verified" below it is what almost nothing falls through to.

**And the shape is exactly 2:1, which the header is built around.** Every banner either table names
decodes at 2:1 and every assembled zone map at 3:2 — measured, not assumed, and there is no third
shape. The modal's header therefore takes the shape of whatever is in it rather than imposing one
of its own: a band with a shape of its own has to crop, and no single shape is within a fifth of
both of these. See `.detail-hero` in `segmentModal.css`.

**And 256×128 is as sharp as a header can be.** Swept over both columns on 12.0.5.67823, every one
of the journal's 209 and 1,686 of the finder's 1,702 decode at exactly that; the remaining 16 of
the finder's are 512×256, and nothing at all comes back larger. `icons::decode` already asks for
mipmap level 0, which is the largest level a BLP holds, so none of them is refused by its 512 cap
and none of them has a better copy to be had. The modal draws that across 680 pixels, which is an
upscale of somewhere between two and three, and there is no way to improve on it short of art the
game does not ship — issue #230 asked, and this is the answer. An assembled zone map is the
opposite case: it is scaled *down* to 1,024 wide on the way out (`maps::WIDEST_MAP`), so a zone's
header is the one that is drawn at something like its own resolution.
`615222`'s neighbour `337490`,
`ui-lfg-background-genericdungeon.blp`, is worth knowing about as a trap: it decodes at 256×128 and
is **entirely transparent**, so it cannot be the stand-in however much its name suggests it.

Two more of the four files are worth knowing about even though nothing reads them: col3 and col6
are 512×512, framed art with transparent margins of their own — the Adventure Guide composites
them too, so neither crops into a band without a hole in it.

**Everywhere else draws no picture, and most places are everywhere else.** An open-world zone is
a name neither table has heard of. That is not a gap in the reader:

| Named on | Icon column |
|---|---|
| `JournalTier` — the expansions | none |
| `UiMap` — the zones | none, and none is needed: see "Zone maps, verified" |

Two rows have been struck off this list since it was written, and both were wrong in the same
way — the table itself holds no picture, and something one join away does.

- `JournalEncounter` — the bosses. See "Bosses, verified" below.
- `Faction` — the reputations. It genuinely has no icon column, but the achievement for reaching
  Exalted with a faction does, and its icon is per-faction artwork. See "Reputations, verified".

**What each column was checked against**, since a reordered table shows wrong values rather than
failing:

| Column | Checked against |
|---|---|
| `JournalInstance` col0 | reads "Deadmines", "Shadowfang Keep", "Throne of the Tides" in order |
| `JournalInstance` col5 | all 209 icons decode, every one of them 128×128; its neighbours come out 512×512, 256×128 and 512×512 |
| `JournalInstance` col4 | all 209 decode, every one of them 256×128 — Naxxramas reads `1396587` and Deadmines `522352` |
| `LFGDungeons` col7 | 1,702 rows hold a value and the ones checked all decode at 256×128 — Naxxramas `340679`, Deadmines `337488` |
| `LFGDungeons` col0 | reads "Earthcrawl Mines" for 2522, which is a delve |
| `LFGDungeons` col5 | exactly 1,657 rows hold a value, which is the count the community schema gives `IconTextureFileID`, and all 1,657 decode |
| the two together | Deadmines reads `136332` out of both, Nerub-ar Palace `5912511` out of both |

`LFGDungeons` has one trap worth writing down: **the reader and the community schema part
company after column 8.** Column 9 should be `MapID` and reads a seven-digit number instead —
nothing this app reads, but a warning against extending the column list by counting. Columns 0
through 8 line up exactly.

## Zone maps, verified

The two tables above answer for 805 places and the open world is not among them, so the header a
segment's modal opens with for an evening in Durotar comes from somewhere else: **the map the player
opens with M.** The game does not store that as a picture either. It stores it as a grid of
256-pixel fragments, one texture each, and assembles it every time somebody opens the map — seven
tables between a name and a picture. `maps.rs` does the same assembly and `examples/dump_maps` is
what settled it, on 12.0.5.67823. Of the 1,922 maps the game has, 1,895 have art.

**Five of those seven tables give you the map nobody has walked, and that is not the map anybody
means.** The `UiMapArtTile` grid is terrain: hills, coastline, the neighbouring zones' names around
the edge, and nothing else. No Orgrimmar, no Razor Hill, no roads, no labels inside the zone. Every
one of those is a `WorldMapOverlay` — a picture of one named area, pasted at a stated place over the
art — which the game adds as its area is discovered. Assembling the base alone hands over a sheet
of parchment that a reader would not recognise as anywhere, so the overlays are the other half of
the job, and what this draws is the map as somebody who has been everywhere sees it.

```
"Durotar" ─▶ UiMap ─────────▶ 1,922 rows, keyed by the same localised name as the journal
               │  id 1, System 0, Type 3
               ▼
             UiMapXMapArt ──▶ 1,928 rows, the map in the relationship block
               │  art 2, PhaseID 0
               ▼
             UiMapArt ──────▶ 188 rows, almost nothing but a style
               │  style 1
               ├─▶ UiMapArtStyleLayer ─▶ 9 rows: 1002×668 out of 256×256 fragments
               ▼
             ├─▶ UiMapArtTile ──▶ 66,704 rows, the art in the relationship block
             │      12 fragments at (row, column) → 271420, 271436, …   the unexplored map
             ▼
             WorldMapOverlay ──▶ 2,909 rows, the art in column 1
                  13 areas, each at its own offset
                    └─▶ WorldMapOverlayTile ─▶ 20,867 rows, the overlay in the relationship block
                           17 fragments between the 13                  what exploring reveals
```

```
UiMap                             (id in col1, ParentUiMapID in the relationship block)
  col0 = Name_lang                 "Durotar", "Burning Blade Coven", "Tiragarde Keep"
  col1 = ID
  col2 = ParentUiMapID
  col3 = Flags
  col4 = System                    0 world, 1 flight, 2 Adventure Guide
  col5 = Type                      0 cosmic, 1 world, 2 continent, 3 zone, 4 dungeon,
                                   5 micro, 6 orphan

UiMapXMapArt                      (id beside the rows, UiMapID in the relationship block)
  col0 = PhaseID
  col1 = UiMapArtID

UiMapArt                          (id beside the rows)
  col0 = HighlightFileDataID
  col1 = HighlightAtlasID
  col2 = UiMapArtStyleID

UiMapArtStyleLayer                (id beside the rows, UiMapArtStyleID in the relationship block)
  col0 = LayerIndex
  col1 = LayerWidth               ──▶ 1002
  col2 = LayerHeight              ──▶ 668
  col3 = TileWidth                ──▶ 256
  col4 = TileHeight               ──▶ 256
  col5 = MinScale                    a float
  col6 = MaxScale                    a float
  col7 = AdditionalZoomSteps

UiMapArtTile                      (id beside the rows, UiMapArtID in the relationship block)
  col0 = RowIndex
  col1 = ColIndex
  col2 = LayerIndex
  col3 = FileDataID               ──▶ 256×256

WorldMapOverlay                   (id in col0, UiMapArtID in col1 — inline, unlike the rest)
  col0 = ID
  col1 = UiMapArtID
  col2 = TextureWidth             ──▶ 254
  col3 = TextureHeight            ──▶ 258
  col4 = OffsetX                  ──▶ 304, in the pixels of the finished map
  col5 = OffsetY                  ──▶ 312
  col6..col9 = the hit rectangle     what the pointer has to be inside to name the area
  col10 = PlayerConditionID
  col11 = Flags
  col12 = AreaID[4]

WorldMapOverlayTile               (id beside the rows, WorldMapOverlayID in the relationship block)
  col0 = RowIndex
  col1 = ColIndex
  col2 = LayerIndex
  col3 = FileDataID               ──▶ 256×256
```

**The whole game is nine style layers**, which is the surprise in this chain: however many maps
there are, there are four shapes among them.

| Style | Layer | Picture | Fragments | Grid |
|---|---|---|---|---|
| 1 | 0 | 1,002×668 | 256×256 | 4×3 |
| 2 | 0 and 1 | 3,665×2,440 | 256×256 | 15×10 |
| 3 | 0 | 3,665×2,440 | 256×256 | 15×10 |
| 4 | 0 | 512×512 | 512×512 | 1×1 |
| 5 | 0 | 3,840×2,560 | 256×256 | 15×10 |
| 106 | 0 | 3,840×2,560 | 256×256 | 15×10 |
| 107 | 0 and 1 | 3,840×2,560 | 256×256 | 15×10 |

**The picture is smaller than the grid, and that is the measurement the whole thing turns on.** A
classic zone is 1,002×668 painted into 4×3 fragments of 256, which hold 1,024×768: a reader that
handed over the grid's own size would hand over 22 pixels of nothing down one side and 100 along
the bottom. Both sizes are in `UiMapArtStyleLayer` and neither can be worked out from the other end.

**Four of the turns are a choice, and each one is a wrong map rather than a missing one.**

- **A name is on several `UiMap` rows more often than not.** "Karazhan" is 35 floors, "Dalaran" 12,
  "Naxxramas" 7, "Durotar" 3 — a zone, an orphan, and a copy of itself for the Adventure Guide. So
  the rows are ranked: `System` first, so the map a player opens beats the guide's copy of it, then
  the kind, most specific first — zone, dungeon, micro, continent, orphan, world, cosmic — then
  the lowest id. "The Maelstrom" is the case that decided the kinds: it is a continent *and* a
  zone, and an evening spent there was spent in the zone. The ranking is then walked rather than
  resolved, and the first row with fragments answers: a row can name art with no tiles here.
- **Fourteen maps have art for a phase of a campaign** as well as their ordinary art, and nothing on
  this side of the game can tell whether a player has reached that phase. All fourteen have an
  unphased row and that is the one taken.
- **Two of the nine styles have a second layer**, the same size as their first — a second copy of
  the picture for another zoom. Layer 0 is the one a map opens at, and mixing the two would draw a
  map twice over. An overlay's fragments are matched against that same layer, and every one of the
  20,867 is on layer 0 — so nothing has ever been dropped by that check, and it is there because an
  overlay from another layer would be the same ground again at another scale.
- **A hundred of the 2,909 overlays are shown only to a player who has met some condition** the game
  keeps — a campaign reached, a war effort finished — and nothing on this side of the game can
  evaluate one. **All of them are painted anyway**, and the count is what decided it: **78 of the
  hundred cover ground no other overlay covers**, so leaving them out would leave a hole of bare
  terrain in the middle of a zone somebody spent a season in. What it costs is the other 22 — a
  conditional overlay over ground an unconditional one already covers, painted in the order the
  table stores them, which reads as the later one having happened. Silithus is the case to look at,
  and it comes out clean.

**A modern zone has no overlays at all**, and that is worth knowing before it reads as a bug:
Dornogal's art 1895 has none, because the maps drawn from Battle for Azeroth onwards have their
towns and labels painted into the base art. So the overlay half is what the classic zones need and
the modern ones do without — and both come out complete.

**Coverage is the reason this was worth doing.** Thirty names spanning classic zones, capitals, the
modern continents, delves, raids and instanced cities were resolved on 12.0.5.67823 and **every one
of them landed** — Durotar, Elwynn Forest, Orgrimmar, Dornogal, Azj-Kahet, Hallowfall,
Valdrakken, Boralus, Oribos, K'aresh, Tazavesh, Eco-Dome Al'dani, Twisting Nether, Argus, Gilneas.
Between the banner and the map, a place with nothing to draw is now the rare case rather than the
ordinary one.

**What each column was checked against:**

| Column | Checked against |
|---|---|
| `UiMap` col0 | reads "Durotar", "Burning Blade Coven", "Tiragarde Keep", "Skull Rock" in order |
| `UiMap` col1 | agrees with the id the file's own header points at — Durotar is map 1 |
| `UiMap` col4 | 0 for every world row and 2 for the Adventure Guide's copy of Durotar (map 1305) and of Valdrakken (2134) |
| `UiMap` col5 | 3 for Durotar and Elwynn Forest, 4 for the six Naxxramas floors, 2 for The Maelstrom's continent row, 6 for the orphan Durotar (1535) |
| `UiMapXMapArt` col0 | **1,895 unphased rows over 1,895 maps, and 33 phased rows over 14 maps — none of the 14 without an unphased row to fall back on.** That last count is what makes taking the unphased row safe |
| `UiMapXMapArt` col1 | Durotar reaches art 2, whose 12 fragments decode and assemble into the zone's own map |
| `UiMapArt` col2 | a one- to three-digit style `UiMapArtStyleLayer` has a row for — 1 for the classic zones walked and 5 for the modern ones. Its two neighbours are six-digit FileDataIDs and name no style at all, which is what says this is the column |
| `UiMapArtStyleLayer` cols 1–4 | the four shapes tabulated above, and every fragment of every layer walked decodes at exactly the fragment size the row claims |
| `UiMapArtTile` cols 0–1 | the 4×3 grid fills: rows 0–2 and columns 0–3, twelve fragments, no repeats |
| `UiMapArtTile` col3 | 12 fragments for a classic zone and 150 for a modern one, all of them decoding at 256×256 |
| the whole chain | Durotar, Stormwind City, Dornogal and Nerub-ar Palace each assemble **100% painted** — every pixel of the finished picture has art on it |
| the whole chain, again | Durotar's twelve fragments all sit in `interface/worldmap/durotar/` in the community listfile — ten named `durotarN.blp` and two `razorhill1.blp` and `razormanegrounds1.blp`, so the names are no guide to where a fragment goes. That is the art behind the map key, not the minimap's, which lives under `world/minimaps/` and is a different chain entirely |
| `WorldMapOverlay` col1 | Durotar's art 2 has 16 overlay rows and Elwynn Forest's art 41 has 15; a column read wrong here gathers another zone's towns onto this map, which is unmissable |
| `WorldMapOverlay` cols 2–5 | **the whole zone's own art comes out where it belongs.** Durotar's 13 sized overlays land Orgrimmar at the top of the river valley, Razor Hill on the coast and Echo Isles offshore, and the same run puts Stormwind, Goldshire and Northshire where they belong in Elwynn Forest. 2,403 rows state a size and 506 state none; 100 name a player condition and 22 of those cover ground an unconditional overlay already covers |
| `WorldMapOverlayTile` cols 0–3 | 17 fragments across Durotar's 13 overlays, every one decoding at 256×256, and all 20,867 of the table's rows on layer 0 |

That last row is the check worth keeping. **Reading the row and column indices the wrong way round
does not fail**, it transposes the grid: on a 4×3 grid a third of the fragments land outside the
picture, and the percentage painted is what says so.

**The trap in `UiMapArtStyleLayer` is columns 5 and 6.** They are `MinScale` and `MaxScale`, two
floats, and a reader that counted one past the fragment height comes back with `1065353216` — the
bits of the float 1.0 — and lays out a grid of a billion fragments.

**The map goes over as a JPEG, which is the one place in the app that does.** A zone map is a
painting a megapixel across, and PNG cannot compress a painting: Durotar is 1.4 MB as PNG and 213 KB
as JPEG at quality 85, and it crosses the command bridge as base64 inside a JSON string. What
makes that safe is the row above — the maps are opaque to the last pixel, and JPEG has no alpha
channel — so `maps::draw` checks the assembled picture and only encodes a JPEG when nothing in it is
see-through. Anything with a transparent edge stays a PNG. The pictures are also scaled down to
1,024 across on the way out, which leaves a classic zone at its native size and a modern one at a
quarter of its own; the header they are drawn in is 680 pixels wide.

## Bosses, verified

Two more tables, and a join rather than a lookup. A segment carries the fights that ended in it,
and a fight arrives as the id the client handed `ENCOUNTER_END` — a `DungeonEncounterID`, a number
the game assigned rather than a localised name. `JournalEncounter` turns that into its own id and
`JournalEncounterCreature` hangs the portrait off it. `journal.rs` walks it for the fights one
modal is showing.

```
JournalEncounter                  (id in col3, not in a list)
  col0 = Name_lang                 "Glubtok", "Queen Ansurek"
  col1 = Description_lang
  col2 = Map                       float[2], where the guide pins the fight; 64 bits wide
  col3 = ID                      ◀── what JournalEncounterCreature hangs off
  col4 = JournalInstanceID       ──▶ JournalInstance's own id, the same 63 = Deadmines above
  col5 = DungeonEncounterID      ◀── what the client hands ENCOUNTER_END
  col6 = OrderIndex                where the fight sits in the instance
  col7 = FirstSectionID
  col8 = UiMapID
  col9 = MapDisplayConditionID
  col10 = Flags
  col11 = DifficultyMask           sparse

JournalEncounterCreature          (id in col2, not in a list)
  col0 = Name_lang                 the creature's, which is not always the fight's
  col1 = Description_lang          set on 25 rows of 1,906
  col2 = ID
  col3 = JournalEncounterID      ──▶ JournalEncounter col3
  col4 = CreatureDisplayInfoID
  col5 = FileDataID              ──▶ the portrait, 128×64, stored as a palette
  col6 = OrderIndex                where the creature sits among the fight's others
  col7 = (unread)                  sparse
```

So the chain is `encounters[].id → JournalEncounter col5 → its col3 → JournalEncounterCreature
col3 → col5`. It lands on **1,088 of the 1,089** fights `JournalEncounter` gives a
`DungeonEncounterID` to, and every one of the 1,172 files col5 names decodes — all of them at
**128×64**. That size is the check that says the column is right: a square would be an icon and a
512 would be a background, and both of those live in neighbouring tables this chain could have
landed on. It is also why the frontend gives a portrait its own two-to-one frame rather than
reusing the square `.place-icon`.

**Two turns of the chain are a wrong answer rather than a missing one if they are skipped.**

- **A fight can be several creatures, and the rows are not stored in the order the guide shows
  them.** 20 fights have more than one portrait and **11 of those store their rows out of
  `OrderIndex` order** — the Ascendant Council lists Terrastra first and Feludius fourth, Theralion
  and Valiona lists Valiona first. So the lowest order index wins rather than the first row met,
  which is what makes the Omnotron Defense System come back as Magmatron.
- **One `DungeonEncounterID` can be on several `JournalEncounter` rows.** 12 of the 1,072 distinct
  ids are, a fight the guide describes once per difficulty tier, and there is no saying which of
  those rows carries the creatures. So every row naming a wanted id is followed.

Also worth knowing: **58 `JournalEncounter` rows carry no `DungeonEncounterID` at all**, so they
are named in the guide and are not something the client ever reports.

**What each column was checked against:**

| Column | Checked against |
|---|---|
| `JournalEncounter` col0 | reads "Glubtok", "Helix Gearbreaker", "Foe Reaper 5000" in order — the Deadmines, in the order it is fought |
| `JournalEncounter` col4 | Deadmines bosses read 63 and Shadowfang Keep's read 64, the same ids `JournalInstance` files those two under |
| `JournalEncounter` col5 | Glubtok reads 2976 and `DungeonEncounter` row 2976 is named Glubtok, `MapID` 36, `DifficultyID` 1. Its second row, 2624, reads 2981 — `DungeonEncounter` 2981, Glubtok again at `DifficultyID` 2, which is why the boss has two journal rows |
| `JournalEncounterCreature` col3 | creature 358 reads 89, and journal row 89 is Glubtok |
| `JournalEncounterCreature` col5 | all 1,172 decode, every one 128×64. Ulgrax reads 5907286, The Bloodbound Horror 5907281, Queen Ansurek 5907274, Nexus-King Salhadaar 6980557 — so it is not a legacy-only column |
| `JournalEncounterCreature` col6 | never leaves 0–9, and naming the lowest of a council fight's rows gives the creature the fight is named after in all 20 cases |

**A route not taken.** `DungeonEncounter` has a `SpellIconFileID` column of its own, which would be
one table instead of two — but only **88 of its 1,301 rows** hold anything, against 1,088 through
the journal. Not worth reading.

`cargo run --example dump_journal -- "<install>"` prints all four tables — the two place tables
with every icon decoded and their sizes reported, then the column census of these two, the portrait
decode sweep, the fights that store their creatures out of order, and the chain walked end to end
with the instance each fight was filed under. That is what to run after a patch; pass names to
reach a modern row, a delve or a modern boss.

## Reputations, verified

`Faction` has no icon column. What the app draws on a reputation line instead is **borrowed**: the
icon of the achievement for reaching Exalted with that faction, which is real per-faction artwork —
"Hero of the Frostwolf Clan" is a Frostwolf banner, "Knight of Arathor" the League's crest. Four
tables, and the join starts from a name because a name is what a segment carries.

```
Faction                           (id in a list beside the rows)
  col0 = ReputationRaceMask[4]     256 bits wide, which is what puts the name at col1
  col1 = Name_lang               ◀── the string a segment and a standing carry
  col2 = Description_lang
  col3 = ReputationIndex
  col4 = ParentFactionID

Criteria                          (id in col0)
  col0 = ID
  col1 = Type                      46 is "reach reputation with faction"
  col2 = Asset                     for a type-46 row, a Faction id — and something else entirely
                                   on the row beside it

CriteriaTree                      (id in a list beside the rows)
  col0 = Description_lang
  col1 = Parent                  ──▶ another CriteriaTree row, and 0 on a root
  col2 = Amount
  col3 = Operator
  col4 = CriteriaID              ──▶ Criteria col0
  col5 = OrderIndex
  col6 = Flags

Achievement
  col14 = Criteria_tree          ──▶ the root CriteriaTree row this achievement asks for
  col12 = IconFileID               the picture, already read for the achievements themselves
```

The walk goes **up** the tree rather than down. A node names its one parent, so collecting the
parents is one pass and the climb from each of the few thousand nodes that are about a reputation is
short — where walking down would need a list of children per node over a table of 115,826 rows.

**The rule that matters is which achievement a faction is allowed to land on.** 386 criteria are of
type 46, over 223 factions, and 216 of those factions are reachable from some achievement. But most
are reachable only through the *aggregate* achievements — "25 Exalted Reputations", "30 Exalted
Reputations" — whose icon is a generic pile of tabards and says nothing about any one faction.
Letting one through would put the same picture on every reputation line in the app, which is worse
than putting none on any. So: **an achievement answers for a faction only if its criteria name that
faction and no other.** That leaves **138 factions**, every one of whose icons decodes, and every one
of them 64×64.

Two more rules, each of which is a wrong picture rather than a missing one if skipped:

- **A faction can have several achievements of its own; the lowest id wins.** 38 of the 138 do — a
  later hidden per-character copy, an unshipped "[DNT]" tier, a seasonal reissue. The lowest id is
  the original, and where two are both real they share an icon anyway.
- **14 faction names are on more than one `Faction` row.** "Venture Company" is on three; there are
  rows literally called "reuse" and "unused". So every row bearing an asked-for name is followed and
  whichever reaches an achievement answers.

**What this route does not reach is the modern half.** No Dragonflight-or-later renown faction has an
Exalted achievement, because renown has no Exalted tier — the Council of Dornogal, the Assembly of
the Deeps, Hallowfall Arathi, the Valdrakken Accord and Dragonscale Expedition all come back with
nothing. They have real artwork of their own in `interface/majorfactions/majorfactionsicons.blp`
(`4672345`), reachable only through the texture atlas, which `icons.rs` cannot crop. That is the
remaining piece of #213.

**What each column was checked against:**

| Column | Checked against |
|---|---|
| `Faction` col1 | reads "Argent Dawn" for 529, "Frostwolf Clan" for 729, "PLAYER, Human" for 1; all 860 rows hold a string here and col0 holds none |
| `Criteria` col1 = 46 | its assets are 529, 576, 609, 749, 910 — Argent Dawn, Timbermaw Hold, the Cenarion Circle, the Hydraxian Waterlords, the Brood of Nozdormu, five factions with nothing in common but being reputations a player grinds. Reading the two columns the other way round finds 3 rows and none of those factions |
| `CriteriaTree` col1 | every one of the 92,387 rows that names a parent names a row that exists; col2 read as a parent resolves on 17,330 of 75,851 |
| `CriteriaTree` col4 | 6,252 rows name a type-46 criterion; col5 read the same way names none |
| `Achievement` col14 | 11,239 of the 11,259 rows that hold a value hold an existing `CriteriaTree` id; col13 manages 177 of 549 and col15 31 of 37 |
| the whole walk | faction 729 comes out at `133287` through "Hero of the Frostwolf Clan", 730 at `133433`, 509 at `132351` through "Knight of Arathor", 510 at `237568` through "The Defiler" |

**A route not taken.** `Faction` has a `RenownFactionID` and a `FriendshipRepID`, and neither leads
to a picture. `DungeonEncounter`'s `SpellIconFileID` is the equivalent shortcut for bosses and was
rejected for the same kind of reason — see above.

`cargo run --example dump_achievements -- "<install>" --factions` prints all four tables' column
censuses, the type-46 count, the 138 against the 216, the sizes every answered icon decodes to, and
the four spot checks. That is what to run after a patch.

## Regenerating the fixtures

Tests never read the game. One script per area writes real WDC5 tables and real BLP2
textures with entirely invented contents — same columns, same storage per column, same bit
offsets, same encodings as the game's own, so the awkward halves of the reader stay
exercised. `scripts/db2-fixtures.ts` is the machinery they share and is where the formats
themselves are explained.

```sh
bun run scripts/make-transmog-fixtures.ts
bun run scripts/make-achievement-fixtures.ts
bun run scripts/make-item-fixtures.ts
bun run scripts/make-currency-fixtures.ts
bun run scripts/make-journal-fixtures.ts
bun run scripts/make-map-fixtures.ts
```

Every table on the chains above has a fixture, and between them they hold each way a hop can
fail: an appearance stored as a copy of another, an `ItemModifiedAppearance` row the game
encrypts, an `ItemAppearance` whose display info is encrypted, one with no icon at all, a
display whose only model sits in the second slot, an item `ItemSparse` holds a row for and no
name in, an achievement filed under a category whose parent is encrypted, one filed under a
category that is not in the tree at all, and one the game withholds entirely.

The achievement fixtures carry `Faction`, `Criteria` and `CriteriaTree` too, because what those
three are *for* is reaching the achievement table beside them. They hold both of the ways that walk
gives a wrong answer rather than none: an aggregate achievement naming three factions, which must
never lend its icon to any of them, and a faction with two achievements of its own where only the
first counts. And the ways it legitimately reaches nothing — a faction only the aggregate names, one
no criterion mentions at all, a criterion of the wrong type whose asset is a faction id all the same,
a name on two faction rows where only the second reaches an achievement, and a pair of tree nodes
whose parents point at each other so that the climb has to stop rather than run forever. The
sharpest of them is a criteria-tree node in an *encrypted* section: it hangs off the Emberforge
Covenant's own achievement and is about a different faction, so a reader that saw it would decide
that achievement was an aggregate and the Covenant would draw nothing.

The transmog fixtures carry `Item` as well, for the wardrobe's sake: browsing by kind reads
that table and nothing else can say a one-handed sword from a two-handed one. They also hold
the one hop the *backwards* walk can lose a look to, which the set chain has no equivalent of
— appearance 80021, a head belonging to no set whose only `ItemModifiedAppearance` row sits in
an encrypted section, so nothing at all can be said about it.

The item fixtures are a second, smaller pair of the same two tables, written for the question
`items.rs` asks rather than the one `transmog.rs` asks: what a piece of gear *is*. `Item` is
there in the storages the install uses — palettes for the class, the subclass and the slot,
because a game with two hundred thousand items has twenty classes between them, and a signed
24-bit field for the icon — and its ids sit in a list beside the rows. Between the two of them
they hold an item the small table describes and the big one cannot name, an item the game
withholds entirely, one restricted to three classes, one worn nowhere at all, and the
`ItemSparse` columns at the positions the install keeps them at, so a reader that walked a
variable-length record wrongly lands somewhere else.

The customization tables are there too, and their fixture is built around the one way that
chain goes wrong: the default choice paints four targets, every one of them resolves to a real
picture, and only the layer table says which is the skin. Beside them sit the rest of what
makes that reading non-trivial — a second swatch whose skin lands on the same target, an
element that drives a geoset and paints nothing, a copied layer belonging to another atlas, and
another layout's base layer, which has the same shape as this one's and a target that must
never be painted.

The currency fixture is one table and three textures, and it holds each way a currency can fail
to have a picture: one the game names and draws nothing for, one naming an icon this install has
no file for, and one whose whole row is encrypted.

The journal fixture is four tables and eleven textures. The place half holds each way the two
place tables have to be read together: a delve only the group finder lists, a place both tables
draw and draw differently, an instance the journal lists and draws nothing for, a dungeon the
finder repeats once per difficulty, a name on two journal rows, and a row whose section is
encrypted. The backgrounds and banners beside each icon are given plausible FileDataIDs that no
file is written for, so a reader that took the column next to the right one comes back with
nothing rather than with something that happens to decode.

The boss half holds each way the join can go wrong, and the two that produce a *wrong* answer
rather than none are the point of it: a council fight whose three creatures are stored in neither
`OrderIndex` nor id order, so a reader taking the first row it met would draw the wrong member; and
one `DungeonEncounterID` on two journal rows where only the second carries a creature, so a reader
stopping at the first match would draw nothing. Beside them, the ways a fight legitimately reaches
no picture — a journal row with no creature at all, a creature naming no portrait, a creature whose
section is encrypted, a journal row with no `DungeonEncounterID`, a portrait whose file this install
has no bytes for, and a creature belonging to a fight no journal row describes. Unlike the two
place tables, both boss tables keep their ids **in a column** rather than in a list, and every
column is in the storage the real table keeps it in — the portrait as a palette, the order index
bitpacked — so the reader walks the same shape of record it walks in the game.

The map fixture is seven tables and thirty textures, and it is built around the choices assembling
a map involves rather than around the reading of a row. One name is on three
`UiMap` rows — a dungeon stored first, the zone that should win, and an Adventure Guide copy with
the best kind *and* the lowest id of the three — so one place proves both halves of the ranking.
A second name's best row names art with no fragments at all and the row behind it shares another
place's art, which is what says the ranking is walked rather than resolved once. Beside them: a map
whose phased art is stored before its ordinary art, a style with two layers whose second layer
paints a place the first leaves empty, an art drawn in a style no layer row describes, a row naming
a FileDataID of zero, a map with one fragment this install does not hold, and a style declaring a
picture wider than a window is ever handed.

The fragments are flat colours, one per fragment, because what has to be provable about an
assembled map is *which fragment landed where*: the classic fixture is a 4×3 grid of 8-pixel
fragments whose finished picture is 30×20, in the same proportion the real 1,002×668 sits inside
1,024×768, so a reader that handed over the grid's own size or read the two indices the wrong way
round shows the wrong colour in a corner. The two float columns in the middle of
`UiMapArtStyleLayer` are there holding real float bits, so a reader that counted one column too far
lays out a grid of a billion fragments rather than reading a zero.

Seven overlays hang off that grid, which is the other half of a map — the towns and labels a player
only sees once they have been there. Between them they hold each way pasting one on can go wrong: an
area of two fragments cropped to a picture narrower than the two of them hold, one painted on
nothing at all (which a reader that copied rather than blended would stamp as a rectangle of nothing
over the terrain), one with a fragment this install does not hold, one that states no size, one
whose only fragment is on the layer the map is not assembled from, and a pair over the same piece of
ground where the later row is the one that shows. Their colours are far from the twelve the grid is
painted in and far from each other, so one pixel of the finished map names which of them reached it.

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
`humanfemale_hd.m2` at: nineteen cubes carrying the geoset groups the fixture's own items
drive — sleeves, chest, robe, trousers, boot, feet and helm, each as a bare default beside the
variant an item switches on — two hairstyles on M2 texture type 6 and a cloak on type 2 beside a
body on type 1, and a skull past the first 64k of the index list. Those are the things an item's
model never exercises, and all of them fail as geometry rather than as an error — see
[character-rendering.md](character-rendering.md).

The hair sits in **group 0**, where the retail body keeps it, which is what makes a helm's
hiding worth testing: geoset 0 is the body and lives in the same hundred.

Beside the body sits its `.skel`, under a FileDataID of its own, holding the attachments a helm
and a pair of pauldrons hang off — because that is where a retail character keeps them and not
in the model. Its records are deliberately not in id order, so a reader that indexed the array
by attachment id would hang the helm off her back.

The body textures beside them are the other half: one picture per row of
`ItemDisplayInfoMaterialRes` that resolves to a file, each painted in colours of its own so that
a test can say which rectangle of the atlas it landed in, and two of them banded so that a layer
copied rather than blended, or scaled without a filter, shows up as a colour rather than as a
judgement call.

`helm.glb`, `character.glb`, `robe.glb` and `worn-helm.glb` are the derived fixtures: the
converters' own output,
which the browser tests load into three.js to prove that what this app writes is glTF a loader
will take. Tests in `models.rs` and `character.rs` fail if any of them has drifted from what the
converters now produce:

```sh
cargo run --manifest-path apps/desktop/src-tauri/Cargo.toml --example dump_model -- \
    --fixtures apps/desktop/fixtures/transmog 900001 apps/desktop/fixtures/transmog/helm.glb
cargo run --manifest-path apps/desktop/src-tauri/Cargo.toml --example dump_model -- \
    --fixtures apps/desktop/fixtures/transmog character apps/desktop/fixtures/transmog/character.glb
cargo run --manifest-path apps/desktop/src-tauri/Cargo.toml --example dump_model -- \
    --fixtures apps/desktop/fixtures/transmog worn/900012/3 apps/desktop/fixtures/transmog/robe.glb
cargo run --manifest-path apps/desktop/src-tauri/Cargo.toml --example dump_model -- \
    --fixtures apps/desktop/fixtures/transmog worn/900001/0 apps/desktop/fixtures/transmog/worn-helm.glb
```

Every fixture table carries an encrypted section, because that is where the edge cases
live. Nothing in `apps/desktop/fixtures/` is derived from game assets, which is what
keeps the committed tests distributable.

## Verifying a patch

A game patch can invalidate exactly two kinds of fact in this document: which FileDataID a
table is, and which column a field sits in. Both live in **`docs/game-tables.json`** with the
build each was last confirmed on, and both reach the rest of the tree from there:

```
docs/game-tables.json ──▶ apps/desktop/src-tauri/src/tables.rs   ids, columns, array widths
                      ├─▶ scripts/tables.ts                      ids only, for the fixtures
                      └─▶ the Tables section above               ids and provenance
```

```sh
bun run tables:generate      # after editing the registry
bun run test:scripts         # what fails when the registry was edited and this was not
```

So a verified-build update is one change: run the dumper the table's `Verified` column names,
edit the entry it is about — the `build`, the `tool`, an `index` that moved — regenerate, and
if a column really moved, move the fixture that writes those bytes and regenerate that too.
The registry entry, the constants, the document's table and the fixtures then all say the same
thing in one reviewable diff, and `./scripts/check.sh` fails on any of them left behind.

Two things deliberately do **not** come out of the registry, and both are load-bearing.

**The fixture generators take only the FileDataIDs.** Where a column sits inside an invented
table, in which storage and at which bit offset, is decided in the `make-*-fixtures.ts` script
that writes it. If the writer read its positions out of the registry the reader reads, one wrong
index would move both halves together and every test over them would pass — the suite would be
proving that two generated files agree. Identity is bookkeeping and is safe to share; layout is
the thing under test.

**`db2.rs`'s test module keeps its own literals.** It states, in numbers written down nowhere
else, which column of which committed fixture holds which value, and reads the bytes to check.
That is what can still catch a wrong number in the registry now that every reader takes its
columns from one place, and it is why that module must not be refactored to import
`crate::tables`.

The prose in this document is not generated and is where the evidence stays: what a wrong column
looks like when it fails, which run settled a position, what the dumper counted. Only the table
of ids under [Tables](#tables) is written out.

## Sources

- [wowdev.wiki/DB2](https://wowdev.wiki/DB2) — WDC5 header, storage types, relationship map
- [WoWDBDefs](https://github.com/wowdev/WoWDBDefs) — per-build column layouts
- [wow-listfile](https://github.com/wowdev/wow-listfile) — FileDataID ↔ filename
- [wago.tools](https://wago.tools/) — live DB2 exports, useful for cross-checking a build
