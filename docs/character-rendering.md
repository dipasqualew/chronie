# Showing an appearance on a character

How to render a transmog set on a fixed character model, and what the two subsystems that
only an assembled outfit reaches actually do.

Read [game-files.md](game-files.md) first — it covers how to get the bytes at all, and
the finding this document exists because of: **most armour has no model of its own.**
Chest, legs, hands, feet, wrists, waist, back and tabard are textures painted onto the
character's body. There is no mesh to show in isolation.

**Provenance.** Constants marked *verified* were read from build `12.0.5.67` on
2026-07-26; the attachments, the geoset groups the body actually holds, and the cape on
2026-07-27; the hands, the shield, and the bone chains that place them on 2026-07-27 as
well. The rest is from [wowdev.wiki](https://wowdev.wiki) and
[wow.export](https://github.com/Kruithne/wow.export) (MIT), and is marked as such.

## One item, and then a set of them

Rendering **one item at a time on an otherwise bare model** was where this started, and it
was dramatically cheaper, because two of the three fiddly subsystems exist purely to
arbitrate between items and one item cannot argue with itself. Both have since landed, and
both are in `worn.rs` rather than anywhere further down: the model parse, the compositor,
the atlas and the viewer never changed, which is what "a strict subset, not a dead end"
turned out to mean.

- **Geoset priority.** Sleeves are claimed by gloves, chest and shirt; the robe group by
  chest and legs; boots fight pants. Blizzard resolves this with a hardcoded table: per
  contested group, an ordered list of slots, and the first slot that drives the group at
  all wins outright. It is `worn::GEOSET_PRIORITY`, and it runs **before** geoset
  selection, so what `character::dressed` is handed is still at most one value per group.
- **Slot draw order.** Item textures composite in a fixed per-slot order so bracers land
  over sleeves and gauntlets over bracers. It is `worn::SLOT_LAYER`, and it runs **before**
  compositing, so `Atlas::wear` still paints a list in the order it is given.

Both tables are wow.export's, re-keyed. Its `GEOSET_PRIORITY` in
`src/js/db/caches/DBItemGeosets.js` and its `SLOT_LAYER` in `src/js/wow/EquipmentSlots.js`
are keyed by the game's **equipment slots** — a helm is 1, a cloak 15, a tabard 19 — and
this app carries `DisplayType`, where a helm is 0, a cloak 9 and a tabard 10. Each list is
therefore written out in `DisplayType` numbering rather than translated at the point of
use. Read on 2026-07-27.

**Most of the priority table is inert against the slot → group table below**, and it is
kept whole anyway. Sleeves name gloves first and no gloves drive sleeves; the chest group
names the shirt and the shirt drives nothing at all. The one contest that fires is group
13, where a robe worn on the chest beats a pair of legs — which is what "a set with a robe
in it puts the robe over the legs rather than beside them" comes to.

**A set is renderable from an install without the app running**, which is the only way to
put either table in front of real data — nothing in the test suite may read one. `set/<id>`
walks a `TransmogSet` the same way the window does and hands the whole outfit over:

```sh
bun run render set/5570 augur.png --install "/Applications/World of Warcraft" --view right
cargo run --example dump_model -- "/Applications/World of Warcraft" set/5613 plate.glb
```

Sets 5570 and 5613 on build 12.0.5.67 are what this was checked against on 2026-07-27: a
Silvermoon cloth set whose robe hangs over its legs, and a Thalassian plate set of 59
appearances, which is every contest the table can stage at once. Both come out with one part
per geoset group.

**Priority never leaves a group unowned.** The floor below — a group is only taken over
when the body holds the geoset asked for — is what keeps an unverified column from costing
a limb, and resolution must not become a second way to lose one. A winner whose value this
body has nothing for leaves the group where a bare body had it; it does not fall through to
the piece that lost, because the game's answer to "who owns this group" is one item and not
a queue.

## The base model

Human Female. Gear is authored to look right on human proportions, and Dracthyr, Worgen
and Mechagnome carry extra geoset groups and limb handling worth avoiding.

| What | Value | Status |
|---|---|---|
| `ChrModel.ID` | 2 | community |
| `CharComponentTextureLayoutID` | **104** | **verified** |
| Model FileDataID | 1000764 (`humanfemale_hd.m2`) | community, **rendered** |
| Composite atlas size | **2048 × 1024** | **verified** |

`humanfemale.m2` (119563) is the *vanilla* model. Retail uses the `_hd` one.

**The two community values have now been rendered, which is not the same as read.** Nothing
here has opened `ChrModel` — but 1000764 parses as a Human Female body, and a leg appearance
composited into layout 104's sections 5 and 6 comes out painted on that body's legs and
nowhere else (`scripts/render-model.ts`, display 712245, build 12.0.5.67). Three guesses in a
row landing armour on the right limb is not proof of the ids, and it does rule out the failure
they were suspected of. `dump_paint` prints the arithmetic behind it: which of the body's parts
survive geoset selection, and which of the layout's rectangles those parts' UVs actually read.

The atlas size comes from `ChrModelMaterial` where the layout is 104 and
`TextureType == 1`; observed on this build as `[layout 104, texType 1, 2048, 1024]`.
Types 6 (hair, 256×256), 19 (eyes, 256×128) and 20 (jewelry, 512×512) exist and are not
needed for armour.

## The composite layout, verified

`CharComponentTextureSections` for layout 104, read directly off the install. These are
the rectangles an item's textures are blitted into:

| `SectionType` | Region | X | Y | W | H |
|---|---|---|---|---|---|
| 0 | arms upper | 0 | 0 | 512 | 256 |
| 1 | arms lower | 0 | 256 | 512 | 256 |
| 2 | hands | 0 | 512 | 512 | 128 |
| 3 | torso upper | 512 | 0 | 512 | 256 |
| 4 | torso lower | 512 | 256 | 512 | 128 |
| 5 | legs upper | 512 | 384 | 512 | 256 |
| 6 | legs lower | 512 | 640 | 512 | 256 |
| 7 | feet | 512 | 896 | 512 | 128 |
| 9 | scalp upper | 1024 | 0 | 1024 | 1024 |
| 10 | scalp lower | 1024 | 0 | 1024 | 1024 |

Note the asymmetry: the body occupies only the **left 1024×1024**; the right half is the
face and scalp region.

**There is no ACCESSORY (section 8) rectangle in layout 104.** `ItemDisplayInfoMaterialRes`
does contain section-8 rows, and on this model they have nowhere to land — drop them
rather than treating the absence as an error.

These numbers were independently produced by wago.tools and by reading the install, and
agree exactly.

## Compositing

1. Allocate `2048 × 1024` RGBA.
2. Blit the base skin BLP over the whole buffer, then blend the rest of what the character's
   own customization paints — her underwear — into the section rectangles it names. Which
   pictures those are is
   [game-files.md](game-files.md#the-characters-own-skin-verified); `skin.rs` is the reading
   and `Atlas::base` is the blit.
3. For each item, **lowest `SLOT_LAYER` first**, and for each `ComponentSection` it supplies
   (via `ItemDisplayInfoMaterialRes`, joined by `foreign_id()`): resolve the material to the
   one file painted for *this* body, decode its BLP, scale to fill the section rectangle
   exactly, and **alpha-blend** it. Two items can supply the same section — a robe's lower
   legs and a pair of boots' both land in section 6 — and the layer order is the whole of
   what decides which one the reader sees.
4. Bind the result as M2 texture **type 1** on the character model.

Step 3's first hop is a trap of its own: a material resource names a file per body, and only
`ComponentTextureFileData` says which is which. It is written down in
[game-files.md](game-files.md#componenttexturefiledata), because it is a table rather than a
rendering decision. `character::atlas` is all three steps, out of `Atlas::base` and
`Atlas::wear`; `skin.rs` and `worn.rs` are the reading behind steps 2 and 3.

Three things to get right, the last two from wow.export:

**The base is a copy and everything else is a blend.** `ChrModelTextureLayer` says which is
which, and on layout 104 exactly one layer of the body atlas is a copy: the skin, at the bottom
of the stack with nothing under it to blend against. Every layer above it — the underwear the
same choice paints, and then the item — is blended into its own rectangles. Turning the base
into a blend against transparency, or a layer above it into a copy, are the two ways to get
this backwards; the second is the next paragraph.

**Always alpha-blend item layers.** The layer data nominally says "blit" (a straight
copy) for some layers. A straight copy erases the body wherever the item texture is
transparent, so every sleeveless chestpiece punches a hole in the arm. Force alpha
compositing for item layers.

**Use linear filtering.** Armour textures are authored small — 128×64 upward — and get
scaled up into their ~512×256 destination. Nearest-neighbour looks visibly wrong against
a 2048-wide base.

Nothing about the character's UVs changes. The atlas layout *is* the UV layout.

## Geosets

Geosets select which submeshes of the body mesh are drawn — which is how a robe replaces
the legs, and how boots replace the feet.

**Geoset ID = group × 100 + value.** `M2SkinSection.skinSectionId` in the `.skin` file
holds these. Group 0 value 0 (bare `0`, the skin) is the exception; every other group
starts at `…01`.

Armour-relevant groups (from
[Character_Customization](https://wowdev.wiki/Character_Customization#Geosets)):

```
04 gloves    05 boots     08 sleeves   09 kneepads  10 chest/doublet
11 pants     12 tabard    13 robe      15 cape      18 belt
20 toes/feet 21 skull     22 torso     23 hand attach  26 shoulders
27 helm      28 arm upper
```

`ItemDisplayInfo.GeosetGroup[6]` says which values the item sets, out of **column 13** —
verified on 12.0.5.67, along with the `DisplayType` numbering below; see
[game-files.md](game-files.md#the-chain-verified) for the run and the three things that
settled it. Column 12 is `ModelType[2]`, which is what this used to be read out of, and the
symptom was the quiet one: an appearance that changes nothing on the body rather than an
error. The slot → group mapping, with the display type each slot is:

| `DisplayType` | Slot | `[0]` | `[1]` | `[2]` | `[3]` | `[4]` |
|---|---|---|---|---|---|---|
| 0 | head | 27 helm | 21 skull | | | |
| 1 | shoulder | 26 shoulders | | | | |
| 2 | shirt | *(none)* | | | | |
| 3 | **chest** | 8 sleeves | 10 chest | 13 robe | 22 torso | 28 arm upper |
| 4 | waist | 18 belt | | | | |
| 5 | legs | 11 pants | 9 kneepads | 13 robe | | |
| 6 | feet | 5 boots | 20 feet | | | |
| 7 | wrist | *(none)* | | | | |
| 8 | hands | 4 gloves | 23 hand attach | | | |
| 9 | back | 15 cape | | | | |
| 10 | tabard | 12 tabard | | | | |

The last column is `SLOT_LAYER`, the order the slot's textures go into the atlas — lowest
first, ties keeping the order the set named them in. It is wow.export's, re-keyed, and it is
what decides which of two items painting one section rectangle the reader ends up seeing:

| `DisplayType` | Slot | Layer |
|---|---|---|
| 2 | shirt | 10 |
| 5 | legs | 10 |
| 0 | head | 11 |
| 6 | feet | 11 |
| 1 | shoulder | 13 |
| 3 | chest | 13 |
| 10 | tabard | 17 |
| 4 | waist | 18 |
| 7 | wrist | 19 |
| 8 | hands | 20 |
| 9 | back | 23 |

Everything above 10 is a weapon, which paints no part of the body and so shares a rectangle
with nothing; wow.export's default of 10 is what it lands on and it never comes up.

The groups are the community's; which display type names which slot is the install's, and the
two lists disagree — the community's puts the shirt last and every slot from the chest down
one lower. Reading a chestpiece as a waist is as quiet a way to be wrong as reading the wrong
column, and has the same floor under it.

One item can drive several groups at once — a chestpiece drives five — and since they all
come from the same item there is no conflict between them. Show all of them. Where two *items*
drive one group, the priority table above decides, and it decides once per group rather than
once per item.

**Value formula:** `geosetID = group × 100 + (1 + GeosetGroup[i])`, with two exceptions:

- **Feet (group 20):** no boots → `2001`. Boots with `GeosetGroup[1] == 0` → `2002`.
  Boots with a non-zero value → `2000 + value`. Note `2000`, not `2001`.
- **Helm (group 27):** no helm → `2701`. Helm with `GeosetGroup[0] == 0` → `2702`.
  Helm with a non-zero value → `2700 + value`. Some rows carry `-1`, meaning no geoset.

**Application:**

```
for each group any item drives:
    award it to the first slot in GEOSET_PRIORITY[group] that drives it
hide everything (0..3000)
show geoset 0 (the skin)
show the default customization geosets
for each group awarded:
    hide  group*100 .. group*100+99
    show  group*100 + the winner's resolved value
```

The first two lines are `character::bare`, which is `geoset == 0 || geoset % 100 == 1`: value
1 is every group's "nothing here" — bare arms, bare legs, bare feet, no helm, no cape, no
belt — and geoset 0 is the skin, the one id with no group of its own. The file holds every
variant of every group at once, so drawing them all is what puts two pairs of legs in the
same trousers. All three ways of getting this wrong show up as geometry rather than as an
error: too much and limbs double and z-fight, too little and they go missing.

One more rule, which is this repository's rather than the game's: **a group is only taken over
when the body actually holds the geoset the value resolves to.** Otherwise the default stays.
That is the floor under everything above — of the three ways to get geosets wrong, hiding a
group and then showing nothing in it is the one that takes a limb with it, and this turns it
into a body that looks unchanged. It is what kept a wrong column from ever looking like
anything, which is a mixed blessing: it also kept it from being noticed.

The table itself is at
[GeosRenderPrep](https://wowdev.wiki/DB/ItemDisplayInfo/GeosRenderPrep) and, more
readably, in wow.export's `src/js/db/caches/DBItemGeosets.js`; what this app carries and how
it is keyed is the scope note above.

### What the body actually holds, verified

Every geoset on `humanfemale_hd`, by group, with the M2 texture type each part asks for. This
is what the rules above are being applied *to*, and two lines of it are load-bearing:

| Group | Geosets | Texture type | What |
|---|---|---|---|
| **0** | **1–33** | **6** | **hairstyles** |
| — | **0** | **1** | **the body itself** |
| 4 | 401–404 | 1 | gloves |
| 5 | 501–510 | 1 | boots |
| 7 | 702–703 | 1 | ears |
| 8 | 802–803 | 1 | sleeves |
| 9 | 902–905 | 1 | kneepads |
| 10 | 1002 | 1 | chest |
| 11 | 1102–1105 | 1 | pants |
| 12 | 1202–1204 | 1 | tabard |
| 13 | 1301–1303 | 1 | robe |
| **15** | **1502–1510** | **2** | **cloaks** |
| 17 | 1701–1705 | a file of its own | eye glow |
| 18 | 1801–1804 | 1 | belt |
| 20 | 2001–2008 | 1 | feet |
| 22 | 2201–2202 | 1 | torso |
| 32, 33, 35, 36, 51 | 32xx, 3301, 35xx, 36xx, 51xx | 1, 6, 19, files | face, eyes, and the rest of a modern head |

**Hair is group 0, and geoset 0 is the body.** They are in the same hundred, which matters
exactly once — when a helm hides "group 0" and the rule is "hide the whole hundred". Hide geoset
0 with it and the character goes with her hairstyle. `character::dressed` excepts it, and it is
the one exception in that function.

Note also that several groups have no `…01`: there is no 701, no 801, no 1501. A bare body
therefore draws *nothing* from those groups rather than a default, and the bare arms and bare
back are part of geoset 0. `bare()` handles this without knowing about it — a group with no
value 1 simply contributes no part.

### What a helm hides, verified

`ItemDisplayInfo.HelmetGeosetVis[2]` → `HelmetGeosetData`, which is a table rather than a
rendering decision and is written down in
[game-files.md](game-files.md#helmetgeosetdata-verified). What it hands back is a list of
*groups*, and applying it is one line beyond the rules above:

```
for each group the helm hides:
    hide  group*100 .. group*100+99      but never geoset 0
```

The commonest entry for a Human is `{0, 7}` — hair and ears. A closed helm is `{0, 1, 7, 31,
34, 35}`. 210 of the game's 5,698 helms hide nothing at all, which is what an open helm is.

This is not cosmetic after all: a full helm with a hairstyle through it is the most obviously
wrong thing this pipeline can draw, and it costs one filter.

### What a cape is

The one slot with geometry and no model. A back display keeps both `ModelResourcesID` slots at
zero, switches on geoset group 15 — the cloak the body already carries — and supplies the
picture that goes on it through `ModelMaterialResourcesID[0]`.

That picture binds as **M2 texture type 2**, and on this body nothing but geosets 1502–1510 asks
for that type. So a cape needs no attachment and no file of its own: a geoset switched on, and
one texture bound.

## Attachments: where a helm goes

An item's model is authored around the point it hangs off, so a helm's vertices sit around the
origin and mean nothing until the head's position is added to them. That position is an
**attachment**, and the first thing to know is that a retail character does not keep its
attachments in its model.

**`humanfemale_hd.m2`'s own bone and attachment arrays are both empty.** The `SKID` chunk names
a `.skel` file — 2137789, 16 MB of it — and that is where they are. A reader that looked at the
header's `0xf0` would find a body nothing can be hung off, and no error to explain it.

A `.skel` is chunked the same way an M2 is, offsets and all:

```
SKL1  a name
SKS1  sequences
SKB1  M2Array<M2CompBone> bones, then the key-bone lookup
SKA1  M2Array<M2Attachment> attachments, then the attachment lookup
AFID, BFID
```

**`SKA1`'s offsets count from the chunk's own data**, exactly as `MD21`'s do. One
`M2Attachment` is 40 bytes: a `uint32` id, a `uint16` bone, two bytes nothing has named, a
`C3Vector` position, and then a 20-byte `M2Track` a still picture has no use for.

**The position is already in model space.** The format calls it "relative to the bone", and a
bone's translation track holds one run of keyframes *per animation* — so with none playing there
is nothing to add. Read off this build, every attachment that states a position states one
*exactly equal to its bone's pivot*, which is the same conclusion arriving twice.

**Find an attachment by the id in its record**, not by where it sits in the array: the body's
43 records are not in id order and the ids run to 74.

The ids are the community's numbering, and the positions this build states for them are what
say they are right. `examples/dump_attachments` prints the whole list:

| Id | What | Position, game axes (X forward, Y left, Z up) |
|---|---|---|
| 0 | shield | *none stated* — the left forearm, `(-0.059, +0.372, 1.365)` |
| 1 | hand, right | *none stated* — the right wrist, `(-0.010, -0.566, 1.149)` |
| 2 | hand, left | *none stated* — the left wrist, `(-0.010, +0.566, 1.149)` |
| 5 | shoulder, right | `(-0.050, -0.096, 1.631)` |
| 6 | shoulder, left | `(-0.050, +0.096, 1.631)` |
| 11 | helm | `(-0.033, 0.000, 1.712)` |
| 12 | back | `(-0.145, 0.000, 1.540)` |

A mirrored pair at shoulder height, one at the top of the head, one behind the chest, and a
mirrored pair at the ends of the arms — on a body whose feet are at Z 0 and whose crown is at
Z 1.99.

### Ten attachments state no position, and three of them are the ones a weapon needs

The three above are the exception to the paragraph before them, and it is not a small one.
**The shield, the right hand and the left hold the origin in their records** — as do the two
spell hands, the base, and four others — **and so do the bones they name.** They are helper
bones the game *animates* into the hand: with an animation playing, the chain of rotations above
them carries a point at the origin out to where the fist is, and per-animation translation
tracks adjust it. A still picture has none of that, so reading the record and stopping puts a
sword, a shield and everything else a hand holds in a heap between her feet.

What the file still says is where that chain hangs from. **A bone's pivot is in model space and
in the bind pose it is simply where that bone is** — no parent composition, nothing to
accumulate — so the first ancestor that states a pivot is the place on the body the attachment
belongs to:

```
attachment 1 → bone 193 (origin) → 102 (origin) → 49  = the right wrist
attachment 2 → bone 198 (origin) → 95  (origin) → 43  = the left wrist
attachment 0 → bone 188 (origin) → 46  (origin) → 37  = the left forearm, at the elbow joint
```

**The origin is a sentinel to be generous about.** Bone 102 states `(0, +0.0011, 0)` — a
rounding of zero rather than a place on a person — and a reader that stopped at "not exactly
zero" would hang a sword a millimetre off the floor. `m2.rs` treats anything within a centimetre
of the origin as unstated, which is well under the height of anything real on a body.

**What this does not give is the rotation.** A hand's bone carries no global sequence — the
table below is the whole of what does — so a weapon is drawn in the axes it was modelled in,
which is the game's own X forward. On a bind pose whose arms hang at her sides that reads as a
blade held out level, and it is what the files say without an animation to say otherwise: a
one-hander and a two-hander in the right hand, a shield across the left forearm. Where it would
go wrong is subtler than being wrong about a position, and looks like a blade held hilt-first.

### The bone is not always identity, verified

The paragraph above is the whole of what a *helm* needs, and it is why the first version of this
work drew a helm and a cloak correctly and a pair of pauldrons half again too large and lying
flat. The position is not the whole of an attachment.

**A track bound to a global sequence runs whether or not an animation does.** An ordinary track
is one run of keyframes per animation and contributes nothing to a still picture, which is the
reasoning that makes bones skippable — but `M2Track.global_sequence` names a loop on the world's
clock, outside the animation system, and those apply always. On `humanfemale_hd`, **35 of 203
bones carry one**, and every one of them is an attachment's own bone; no ancestor of an
attachment carries any, so composing the attachment's own bone is enough on this body.

What the four this app uses hold:

| Bone | Attachment | Scale | Rotation |
|---|---|---|---|
| 176 | 5, shoulder right | `0.62` uniform | `(-0.3042, 0, 0.0222, 0.9523)` — 35.5° about ≈ −X |
| 172 | 6, shoulder left | `0.62` uniform | the mirror of it |
| 181 | 11, helm | *no track* | *no track* |
| 161 | 12, back | *no track* | *no track* |

Both shoulder values are constant across all 593 keys of the sequence, and identical between the
two sides, which is what "a pauldron is worn at 62% and rolled outward" looks like written down.
A still picture takes the first key.

So the transform for something hanging off a body is `T(position) · R · S`, which is exactly a
glTF node's `translation`, `rotation` and `scale` — no matrix composition anywhere. It is
`T(p)·R·S·T(−p)` composed with `T(p)`, and the two `T(−p)`/`T(p)` cancel precisely because the
attachment sits at its bone's pivot.

**`M2CompQuat` wraps rather than scales.** Four `int16`s, and the mapping is
`(v < 0 ? v + 32768 : v - 32767) / 32767` — so a *non-negative* number is the bottom half of the
range and a negative one the top. `22800` is `-0.304` and `-9599` is `+0.707`. Read as a plain
fraction of 32767 the sign comes out right about half the time, which is a pauldron rotated into
her neck rather than an error.

## M2 and SKIN, the static subset

Retail files start with **`MD21`**, not `MD20`. Chunk names in M2 are **not**
byte-reversed, unlike every other chunked WoW format.

Chunks that matter:

- **`MD21`** — the whole pre-Legion M2 blob. **Offsets inside are relative to the chunk's
  data start, not the file.** Getting this wrong yields garbage.
- **`SFID`** — skin profile FileDataIDs. Take index 0 for LOD 0. The chunk can be shorter
  than the header implies; bound by its actual length.
- **`TXID`** — texture FileDataIDs, parallel to the header's texture array. Replaces
  filenames since 8.0.1. The in-file filename is a single `\0` and must be ignored.

- **`SKID`** — the `.skel` holding the skeleton, which is where a retail character's
  attachments are and the only reason this list is not four chunks long. See
  [Attachments](#attachments-where-a-helm-goes).

`PFID`, `AFID`, `BFID`, `EXP2`, `LDV1` are all irrelevant to a static render.

**Bone weights are not needed.** For a bind-pose render, ignore `bone_weights` and
`bone_indices` — the vertex position is already the bind pose. Sequences, `.anim` files and
per-animation `M2Track` decoding are all skippable. **Bones are not**, quite: see
[the bone is not always identity](#the-bone-is-not-always-identity-verified).

**Coordinate system:** M2 is Z-up with X forward. To Y-up: `(X, Y, Z) → (X, Z, -Y)`, which
is what wow.export's `M2Loader.js` does and what `m2.rs` follows. Both this and its mirror
`(X, -Z, Y)` are proper rotations, so neither turns a model inside out — but the mirror puts
the model's up axis at `-Y` and hangs it upside down. *(This line said `(X, -Z, Y)` until
2026-07-26; the version above is the one that has been rendered and looked at.)*

**The `Level` gotcha.** In `M2SkinSection`, the real first index is
`(Level << 16) | indexStart`. Character models routinely exceed 65,535 indices; miss this
and geometry past the first 64k silently draws wrong. Note that wow.export applies the level
to `indexStart` **only**, not to `vertexStart`, and `m2.rs` does the same — it never reads
`vertexStart`, because the triangle list already names the vertices a submesh uses.

**Texture indirection:** `batch.textureComboIndex` → `textureCombos[i]` → `textures[j]`.
If `textures[j].type == 0` the texture is a file (`TXID[j]`); otherwise the caller supplies
it. **Type 1 is the composited body atlas** — that is where the work above gets bound.

Materials: flag `0x04` means two-sided (disable backface culling). Blend mode 0 is opaque,
1 is alpha-test at 0.5, 2 is alpha blend; treat anything else as blend.

## The trap between a correct `.glb` and a picture

A `.glb` carries its textures inside its own binary chunk, and three.js does not read them
out of it. It wraps each one in a `Blob`, takes a `blob:` URL for it, and loads that back
through the browser — with `fetch` where `createImageBitmap` exists and with an `<img>` where
it does not, which is `connect-src` on Chromium and `img-src` on WebKit older than Safari 17.
So a Content Security Policy naming neither `blob:` nor a wildcard refuses every picture in
every model, and the platform decides which of the two directives does the refusing.

**It costs a console warning and nothing else.** `GLTFLoader` does not fail the parse over a
texture it could not fetch; it drops the map and carries on, so the model loads, every part
draws, and the whole thing is glTF's default colour. That is what "the armour has no colour"
was: a bare body in flat white, indistinguishable by eye from the flat tan an unpainted atlas
gives, with a correct atlas and correct UVs behind it the entire time.

Both directives carry `blob:` now, in `tauri.conf.json` and in the dev/preview server's copy
in `vite.config.ts`. `scripts/render-model.ts` is the instrument that found it and is what to
reach for next time — it draws a model to a PNG offscreen, through the app's own viewer and
under the app's own policy, from an install or from the committed fixtures.

## BLP

Modern retail is BLP2 only. Header is 148 bytes plus a 1024-byte palette region.

| Encoding | Meaning | Frequency |
|---|---|---|
| 1 | palettized, 256 × BGRX, 1 byte/px | common |
| 2 | DXT — `AlphaType` 0 → BC1, 1 → BC2, 7 → BC3 | common |
| 3 | uncompressed BGRA | occasional |

Gotchas: palette entries are **BGRX**, not RGBA. Mipmap sizes in the header are wrong for
small levels — compute them (`ceil(w/4) × ceil(h/4)` blocks, 8 bytes for BC1, 16 for
BC2/BC3). Compositing only ever needs level 0, which sidesteps most of this. `BC5` (format
11) is used for normal maps and is not needed; fail cleanly rather than guessing.

**`wow-blp` 0.3 reads the palette red-first**, so red and blue come back swapped — and only
for encoding 1, since its uncompressed path reads the same bytes blue-first correctly.
`src-tauri/src/icons.rs` puts them back and is the only place that should: everything that
decodes a texture goes through `png_of`. Verified against the synthetic textures
`scripts/db2-fixtures.ts` writes, which paint each quadrant a colour whose three channels
all differ so that a swap cannot pass unnoticed.

## Crates

| Crate | Licence | Use |
|---|---|---|
| [`wow-blp`](https://crates.io/crates/wow-blp) | MIT/Apache-2.0 | BLP decode. Handles every encoding above. |
| [`gltf-json`](https://crates.io/crates/gltf-json) | MIT/Apache-2.0 | Writing `.glb` for three.js. |
| ~~[`wow-m2`](https://crates.io/crates/wow-m2)~~ | MIT/Apache-2.0 | **Not used.** See below. |
| [`texture2ddecoder`](https://crates.io/crates/texture2ddecoder) | MIT/Apache-2.0 | Fallback BC1–BC7 decoder. |

### Why the M2 parser is hand-rolled

`wow-m2` was the plan, on condition of prototyping it against a real `humanfemale_hd.m2`
first — and at the time that prototype was against the rules, so it could not be done. What
could be checked pointed the other way anyway: at 0.7.0 it loads from a *path* rather than
from the bytes `GameFiles` hands over, it depends on `wow-blp ^0.7` against the `0.3.2`
already in the tree, and its parent crate claims 1.12–5.4.8.

So `apps/desktop/src-tauri/src/m2.rs` reads the static subset directly — around 370 lines
for chunks, vertices, textures, materials, texture combos, submeshes and batches. It is
written against this document and cross-read against wow.export's `M2Loader.js` and
`Skin.js`. The rule has since gone, so a real file *can* now be put in front of a candidate
crate — and the module is small enough that doing so would be a fair comparison rather than
a sunk cost.

## Reference implementations

[wow.export](https://github.com/Kruithne/wow.export) (**MIT**, actively maintained) does
exactly this and is the one to read:

```
src/js/db/caches/DBItemCharTextures.js       the texture resolution chain
src/js/db/caches/DBItemGeosets.js            geoset groups and the priority table
src/js/wow/EquipmentSlots.js                 per-slot draw order
src/js/3D/renderers/CharMaterialRenderer.js  the compositor
```

Reference only, not reusable: [WMVx](https://github.com/Frostshake/WMVx) (GPL-3.0),
[wowmodelviewer](https://github.com/wowmodelviewer/wowmodelviewer) (no licence),
[WebWowViewerCpp](https://github.com/Deamon87/WebWowViewerCpp) (no licence).

The npm package `wow-model-viewer` is **not applicable** — it wraps Blizzard's hosted
viewer and does compositing server-side, with no local path.
