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

**The base skin is the one hop of this that is not resolved.** Which BLP a character's skin
is comes out of the player's own customization — `ChrCustomizationChoice` →
`ChrCustomizationElement` → `ChrCustomizationMaterial` → `TextureFileData` — and none of
those four tables' column positions have been read off an install the way the chains in
[game-files.md](game-files.md#the-chain-verified) were. Until they have been,
`character.rs` allocates the atlas and leaves it a flat tone; `Atlas::base` is written and
tested and is the one function that changes when they are. That is the bar `GeosetGroup[6]`
was eventually held to as well, and for the same reason: four guessed indices in a row would
paint the body with whatever the guess landed on and call it a skin.

1. Allocate `2048 × 1024` RGBA.
2. Blit the base skin BLP over the whole buffer.
3. For the one item being shown, for each `ComponentSection` it supplies (via
   `ItemDisplayInfoMaterialRes`, joined by `foreign_id()`): resolve the material to the one
   file painted for *this* body, decode its BLP, scale to fill the section rectangle exactly,
   and **alpha-blend** it.
4. Bind the result as M2 texture **type 1** on the character model.

Step 3's first hop is a trap of its own: a material resource names a file per body, and only
`ComponentTextureFileData` says which is which. It is written down in
[game-files.md](game-files.md#componenttexturefiledata), because it is a table rather than a
rendering decision. `Atlas::wear` in `character.rs` is steps 1 and 3; `worn.rs` is the reading.

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

The groups are the community's; which display type names which slot is the install's, and the
two lists disagree — the community's puts the shirt last and every slot from the chest down
one lower. Reading a chestpiece as a waist is as quiet a way to be wrong as reading the wrong
column, and has the same floor under it.

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
