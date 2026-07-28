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
options, their swatches and the geosets those drive against `12.0.5.67` on 2026-07-28. Column
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
| `ChrCustomizationChoice` | 3450554 | fixed | yes |
| `ChrCustomizationOption` | 3384247 | fixed | yes |
| `ChrCustomizationElement` | 3512765 | fixed | yes |
| `ChrCustomizationMaterial` | 3459652 | fixed | yes |
| `ChrCustomizationGeoset` | 3456171 | fixed | yes |
| `HelmetGeosetData` | 2821752 | fixed | yes, needs `foreign_id()` |
| `Achievement` | 1260179 | fixed | yes |
| `Achievement_Category` | 1324299 | fixed | yes |
| `Item` | 841626 | fixed | yes |
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
read off `12.0.5.67` on 2026-07-28. That is what to run again after a patch:

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

What Human Female's first swatch of each option comes to, read on 12.0.5.67:

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
```

Every table on the chains above has a fixture, and between them they hold each way a hop can
fail: an appearance stored as a copy of another, an `ItemModifiedAppearance` row the game
encrypts, an `ItemAppearance` whose display info is encrypted, one with no icon at all, a
display whose only model sits in the second slot, an item `ItemSparse` holds a row for and no
name in, an achievement filed under a category whose parent is encrypted, one filed under a
category that is not in the tree at all, and one the game withholds entirely.

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

## Sources

- [wowdev.wiki/DB2](https://wowdev.wiki/DB2) — WDC5 header, storage types, relationship map
- [WoWDBDefs](https://github.com/wowdev/WoWDBDefs) — per-build column layouts
- [wow-listfile](https://github.com/wowdev/wow-listfile) — FileDataID ↔ filename
- [wago.tools](https://wago.tools/) — live DB2 exports, useful for cross-checking a build
