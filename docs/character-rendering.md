# Showing an appearance on a character

How to render one transmog item on a fixed character model, and why that is much less
work than rendering a whole outfit.

Read [game-files.md](game-files.md) first — it covers how to get the bytes at all, and
the finding this document exists because of: **most armour has no model of its own.**
Chest, legs, hands, feet, wrists, waist, back and tabard are textures painted onto the
character's body. There is no mesh to show in isolation.

**Provenance.** Constants marked *verified* were read from build `12.0.5.67` on
2026-07-26. The rest is from [wowdev.wiki](https://wowdev.wiki) and
[wow.export](https://github.com/Kruithne/wow.export) (MIT), and is marked as such.

## The scope decision, and why it matters

Rendering **one item at a time on an otherwise bare model** is dramatically cheaper than
rendering an assembled outfit, because two of the three fiddly subsystems exist purely to
arbitrate between items:

- **Geoset priority.** Sleeves are claimed by gloves, chest and shirt; trousers by chest
  and legs; boots fight pants. Blizzard resolves this with a hardcoded priority table.
  One item cannot conflict with itself, so the table is unreachable.
- **Slot draw order.** Item textures composite in a fixed per-slot order so bracers land
  over sleeves and gauntlets over bracers. With one item over a fixed base there is one
  item layer, and the ordering question does not arise.

What remains is the same either way: parse the model, decode the textures, blit them into
the body atlas, and pick the right geosets for that one item.

**This is a strict subset, not a dead end.** Priority slots in as one resolution step
before geoset selection. The model parse, compositor, atlas and viewer are identical.
Assembled outfits can be added later without rework.

## The base model

Human Female. Gear is authored to look right on human proportions, and Dracthyr, Worgen
and Mechagnome carry extra geoset groups and limb handling worth avoiding.

| What | Value | Status |
|---|---|---|
| `ChrModel.ID` | 2 | community |
| `CharComponentTextureLayoutID` | **104** | **verified** |
| Model FileDataID | 1000764 (`humanfemale_hd.m2`) | community |
| Composite atlas size | **2048 × 1024** | **verified** |

`humanfemale.m2` (119563) is the *vanilla* model. Retail uses the `_hd` one.

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
2. Blit the base skin BLP over the whole buffer.
3. For the one item being shown, for each `ComponentSection` it supplies (via
   `ItemDisplayInfoMaterialRes`, joined by `foreign_id()`): decode its BLP, scale to fill
   the section rectangle exactly, and **alpha-blend** it.
4. Bind the result as M2 texture **type 1** on the character model.

Two things to get right, both from wow.export:

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

`ItemDisplayInfo.GeosetGroup[6]` says which values the item sets — **but which column of
that table holds it has not been verified**, unlike the model and material slots beside it.
See the note in [game-files.md](game-files.md#the-chain-verified); that is the first thing
to settle before any of this can be read off a real install. The slot → group mapping
(community):

| Slot | `[0]` | `[1]` | `[2]` | `[3]` | `[4]` |
|---|---|---|---|---|---|
| head | 27 helm | 21 skull | | | |
| shoulder | 26 shoulders | | | | |
| **chest** | 8 sleeves | 10 chest | 13 robe | 22 torso | 28 arm upper |
| waist | 18 belt | | | | |
| legs | 11 pants | 9 kneepads | 13 robe | | |
| feet | 5 boots | 20 feet | | | |
| hands | 4 gloves | 23 hand attach | | | |
| back | 15 cape | | | | |
| tabard | 12 tabard | | | | |
| wrist | *(none)* | | | | |

One item can drive several groups at once — a chestpiece drives five — and since they all
come from the same item there is no conflict. Show all of them.

**Value formula:** `geosetID = group × 100 + (1 + GeosetGroup[i])`, with two exceptions:

- **Feet (group 20):** no boots → `2001`. Boots with `GeosetGroup[1] == 0` → `2002`.
  Boots with a non-zero value → `2000 + value`. Note `2000`, not `2001`.
- **Helm (group 27):** no helm → `2701`. Helm with `GeosetGroup[0] == 0` → `2702`.
  Helm with a non-zero value → `2700 + value`. Some rows carry `-1`, meaning no geoset.

**Application:**

```
hide everything (0..3000)
show geoset 0 (the skin)
show the default customization geosets
for each group the item drives:
    hide  group*100 .. group*100+99
    show  group*100 + resolved value
```

**Priority is not needed for single-item rendering** — see the scope note above. When
assembled outfits arrive, the table is at
[GeosRenderPrep](https://wowdev.wiki/DB/ItemDisplayInfo/GeosRenderPrep) and, more
readably, in wow.export's `src/js/db/caches/DBItemGeosets.js`.

Helmets also hide hair and ears via `HelmetGeosetVis[2]` → `HelmetGeosetData`. Worth
deferring: hair through a helm is cosmetic, not broken.

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

`SKID`, `PFID`, `AFID`, `BFID`, `EXP2`, `LDV1` are all irrelevant to a static render.

**Bone weights are not needed.** For a bind-pose render, ignore `bone_weights` and
`bone_indices` — the vertex position is already the bind pose. Bones, sequences, `.anim`
files and `M2Track` decoding are all skippable.

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
`scripts/make-transmog-fixtures.ts` writes, which paint each quadrant a colour whose three
channels all differ so that a swap cannot pass unnoticed.

## Crates

| Crate | Licence | Use |
|---|---|---|
| [`wow-blp`](https://crates.io/crates/wow-blp) | MIT/Apache-2.0 | BLP decode. Handles every encoding above. |
| [`gltf-json`](https://crates.io/crates/gltf-json) | MIT/Apache-2.0 | Writing `.glb` for three.js. |
| ~~[`wow-m2`](https://crates.io/crates/wow-m2)~~ | MIT/Apache-2.0 | **Not used.** See below. |
| [`texture2ddecoder`](https://crates.io/crates/texture2ddecoder) | MIT/Apache-2.0 | Fallback BC1–BC7 decoder. |

### Why the M2 parser is hand-rolled

`wow-m2` was the plan, on condition of prototyping it against a real `humanfemale_hd.m2`
first — and that prototype is exactly what `CLAUDE.md` forbids, so it could not be done. What
could be checked pointed the other way anyway: at 0.7.0 it loads from a *path* rather than
from the bytes `GameFiles` hands over, it depends on `wow-blp ^0.7` against the `0.3.2`
already in the tree, and its parent crate claims 1.12–5.4.8.

So `apps/desktop/src-tauri/src/m2.rs` reads the static subset directly — around 370 lines
for chunks, vertices, textures, materials, texture combos, submeshes and batches. It is
written against this document and cross-read against wow.export's `M2Loader.js` and
`Skin.js`. If the day comes that a real file can be put in front of a candidate crate, the
module is small enough to be a fair comparison rather than a sunk cost.

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
