//! The static half of an M2 model: enough geometry to look at, and nothing that moves.
//!
//! An item's model is a chunked file whose first chunk, `MD21`, is the whole pre-Legion M2
//! laid out as it always was. Everything a bind-pose render needs is in there — the vertices,
//! which textures the model wants and how they are blended — plus two chunks beside it that
//! replace what used to be filenames: `SFID` names the `.skin` files and `TXID` the textures.
//!
//! What is deliberately not read: sequences, `M2Track`s, `.anim` files, particles, ribbons,
//! cameras and lights. A vertex position in an M2 is already the bind pose, so a still picture
//! of an item needs none of it.
//!
//! What *is* read beyond the geometry is where a piece of gear hangs off a body — see
//! [`attachments`], and the `.skel` file it takes rather than the model.
//!
//! Two traps, both written down in `docs/character-rendering.md` and both silent:
//!
//! - **`MD21` offsets are relative to the chunk's data, not to the file.** Every offset in
//!   the header below is resolved against [`Md21::at`] for that reason.
//! - **`M2SkinSection::level`.** A submesh's real first index is `(level << 16) | index_start`,
//!   because the field is 16 bits wide and a model can hold more than 65,535 indices. Miss it
//!   and everything past the first 64k draws from the wrong place.
//!
//! The layout is the community's, at <https://wowdev.wiki/M2>, cross-read against
//! wow.export's `M2Loader.js` and `Skin.js` (MIT) — which is also where the coordinate
//! conversion comes from.

/// The chunks worth opening. M2 is the one chunked format the game does not byte-reverse.
const MD21: &[u8; 4] = b"MD21";
const SFID: &[u8; 4] = b"SFID";
const TXID: &[u8; 4] = b"TXID";
/// The `.skel` file this model keeps its skeleton in, when it keeps one there at all.
const SKID: &[u8; 4] = b"SKID";

/// What the `MD21` payload starts with, which is the pre-Legion file's own magic.
const MD20: &[u8; 4] = b"MD20";

/// Where each list this module reads sits in the M2 header, as a byte offset into `MD21`.
///
/// The header is a fixed run of count-and-offset pairs, so a field's position is a constant
/// rather than something to seek to. The gaps are the lists a static render has no use for:
/// bones, sequences, colours, texture weights and transforms.
mod field {
    pub const VERTICES: usize = 0x3c;
    pub const TEXTURES: usize = 0x50;
    pub const MATERIALS: usize = 0x70;
    pub const TEXTURE_COMBOS: usize = 0x80;
}

/// Where the fields this module reads sit inside one `M2SkinSection`, in bytes.
mod section_field {
    pub const GEOSET: usize = 0;
    pub const LEVEL: usize = 2;
    pub const INDEX_START: usize = 8;
    pub const INDEX_COUNT: usize = 10;
}

/// The same for one `M2Batch`, which is what the format calls a texture unit.
mod batch_field {
    pub const SECTION: usize = 4;
    pub const MATERIAL: usize = 10;
    pub const LAYER: usize = 12;
    pub const TEXTURE_COMBO: usize = 16;
}

/// The one chunk of a `.skel` this reads, and where the attachment list sits inside it.
///
/// A `.skel` is chunked the same way an M2 is, and `SKA1` holds the two arrays the game's own
/// `M2Attachment` block used to: the attachments themselves, then a lookup table from
/// attachment id to index which nothing here needs, because the id travels in the record.
///
/// Its offsets, like `MD21`'s, count from the chunk's own data rather than from the file.
const SKA1: &[u8; 4] = b"SKA1";
const ATTACHMENTS: usize = 0;

/// Where the two fields of one `M2Attachment` this reads sit, in bytes.
mod attachment_field {
    pub const ID: usize = 0;
    pub const POSITION: usize = 8;
}

/// Sizes of the records those lists hold, in bytes.
const ATTACHMENT_SIZE: usize = 40;
const VERTEX_SIZE: usize = 48;
const TEXTURE_SIZE: usize = 16;
const MATERIAL_SIZE: usize = 4;
const SECTION_SIZE: usize = 48;
const BATCH_SIZE: usize = 24;

/// The `.skin` file's own magic. Its offsets are ordinary, counted from the start of the file.
const SKIN: &[u8; 4] = b"SKIN";

/// A vertex, already turned the way a renderer wants it.
///
/// M2 is Z-up with X forward; glTF is Y-up. The conversion is `(x, y, z) → (x, z, -y)`, which
/// is a rotation rather than a mirror, so winding order and normals both survive it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Vertex {
    pub position: [f32; 3],
    pub normal: [f32; 3],
    /// The first of the two texture coordinate sets. The second drives effects this does not
    /// render.
    pub uv: [f32; 2],
}

/// Where a part's texture comes from.
///
/// A model names the textures it owns and leaves the rest to whoever is drawing it: a helm's
/// mesh says "the item's own texture goes here" without knowing which item it is on. Those
/// are the entries with a non-zero type, and `ItemDisplayInfo` is what answers them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Paint {
    /// A texture of the model's own, as a FileDataID out of `TXID`.
    File(u32),
    /// Whatever the caller supplies, carrying the texture type that asked for it.
    ///
    /// An item's model only ever asks for the one thing, so its callers can ignore the type.
    /// A character's cannot: **type 1 is the composited body atlas**, and 6, 19 and 20 are the
    /// hair, the eyes and the jewellery, each with a texture of its own. Painting hair with the
    /// body atlas is exactly as wrong as painting it with nothing and far harder to notice, so
    /// the type travels with the part rather than being flattened away here.
    Supplied(u32),
}

/// How a part is composited, which is the one material property a still render needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Blend {
    Opaque,
    /// Alpha tested at 0.5: the cutouts in a plume or a tabard fringe.
    Mask,
    Blend,
}

/// One draw of the model: a run of triangles sharing a texture and a material.
#[derive(Debug, Clone, PartialEq)]
pub struct Part {
    /// Indices into [`Mesh::vertices`], three to a triangle.
    pub indices: Vec<u32>,
    /// Which geoset the part belongs to, as `group × 100 + value`.
    ///
    /// Zero on every part of an item's own model, which is drawn whole. On a character it is
    /// what says whether the part is drawn at all — the body holds every variant of every
    /// group at once, and all but one of each group is somebody else's trousers.
    pub geoset: u16,
    pub paint: Paint,
    pub blend: Blend,
    /// Set by material flag `0x04`. Cloaks and plumes are single-sided sheets and vanish from
    /// half the angles a reader will drag them to if this is ignored.
    pub two_sided: bool,
}

/// A place on a body where a piece of gear hangs, and where that place is.
///
/// The position is the attachment's own, in the viewer's axes, and it is the whole of what a
/// bind-pose render needs. The format states it as "relative to the bone", and a bone in bind
/// pose carries no transform at all — no keyframes, so no translation, rotation or scale — so
/// the bone contributes an identity matrix and the position is already in model space.
///
/// Read off build 12.0.5.67 on 2026-07-27: on `humanfemale_hd`'s skeleton all 43 attachments
/// state a position exactly equal to their bone's pivot, which is the reading above arriving
/// twice. That is why nothing here opens the bone array — see `docs/character-rendering.md`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Attachment {
    /// The community's numbering: 5 and 6 are the shoulders, 11 the helm, 12 the back.
    pub id: u32,
    pub position: [f32; 3],
}

/// A model and one of its skin profiles, resolved into something drawable.
#[derive(Debug, Clone, PartialEq)]
pub struct Mesh {
    /// Every vertex the model has, shared by the parts rather than copied into each.
    pub vertices: Vec<Vertex>,
    pub parts: Vec<Part>,
}

/// An item's model, parsed as far as it can be without its skin profile.
///
/// The skin is a second file, and which one it is comes out of this one — so reading a model
/// is two hops, and the caller does the reading in between.
#[derive(Debug, Clone)]
pub struct Model {
    vertices: Vec<Vertex>,
    /// The type of each texture the model declares: zero for a file of its own, anything else
    /// for one the caller supplies.
    texture_kinds: Vec<u32>,
    /// `TXID`, parallel to the texture list. Shorter than it when the model supplies none.
    texture_files: Vec<u32>,
    /// A batch names a texture through here rather than directly.
    texture_combos: Vec<u16>,
    materials: Vec<(u16, u16)>,
    /// `SFID`: the skin profiles, most detailed first.
    skins: Vec<u32>,
    /// `SKID`: the `.skel` this model's bones and attachments were moved out into.
    skeleton: Option<u32>,
}

impl Model {
    /// Reads the chunks of an item's `.m2`.
    pub fn parse(bytes: &[u8]) -> Result<Self, String> {
        let mut md21: Option<&[u8]> = None;
        let mut skins: Vec<u32> = Vec::new();
        let mut texture_files: Vec<u32> = Vec::new();
        let mut skeleton: Option<u32> = None;

        let mut at = 0usize;
        while at + 8 <= bytes.len() {
            let magic: [u8; 4] = bytes[at..at + 4].try_into().expect("four bytes are four bytes");
            let size = read_u32(bytes, at + 4)? as usize;
            let start = at + 8;
            // A chunk that runs past the end of the file is a truncated download rather than
            // a chunk, and the ones before it are still worth having.
            let end = start.saturating_add(size).min(bytes.len());
            let payload = &bytes[start.min(bytes.len())..end];
            match &magic {
                MD21 => md21 = Some(payload),
                // Both of these are declared by the header as well, and the chunk can be
                // shorter than it says. Its own length is what bounds the read.
                SFID => skins = read_u32s(payload),
                TXID => texture_files = read_u32s(payload),
                SKID => skeleton = read_u32s(payload).first().copied().filter(|id| *id != 0),
                _ => {}
            }
            at = start.saturating_add(size);
        }

        let md21 = md21.ok_or(
            "not a model this build can read: it has no MD21 chunk, so it predates Legion",
        )?;
        if md21.get(0..4) != Some(MD20) {
            return Err("not a model this build can read: its MD21 chunk holds no M2".into());
        }

        let vertices = read_vertices(md21)?;
        let (texture_kinds, materials, texture_combos) = read_surfaces(md21)?;
        Ok(Self {
            vertices,
            texture_kinds,
            texture_files,
            texture_combos,
            materials,
            skins,
            skeleton,
        })
    }

    /// The skin profile to draw, which is the most detailed one.
    ///
    /// `SFID` lists a profile per level of detail, finest first, followed by the extra
    /// low-detail ones. A model shown on its own in a window is only ever worth the first.
    pub fn skin_file_data_id(&self) -> Option<u32> {
        self.skins.first().copied().filter(|id| *id != 0)
    }

    /// The `.skel` holding this model's skeleton, which is where its attachments are.
    ///
    /// A character's are not in the model at all: `humanfemale_hd`'s own bone and attachment
    /// arrays are both empty and its `SKID` names a 16 MB file that holds them, along with
    /// every animation. That is the only shape this app has to read — an item's model has
    /// nothing to attach anything to — so [`attachments`] takes a skeleton and not a model.
    pub fn skeleton_file_data_id(&self) -> Option<u32> {
        self.skeleton
    }

    /// The textures the model owns, as FileDataIDs, without the slots it leaves to the item.
    pub fn texture_file_data_ids(&self) -> Vec<u32> {
        self.texture_kinds
            .iter()
            .enumerate()
            .filter(|(_, kind)| **kind == 0)
            .filter_map(|(index, _)| self.texture_files.get(index).copied())
            .filter(|id| *id != 0)
            .collect()
    }

    /// The model joined to one of its skin profiles: the triangles, in drawing order.
    pub fn with_skin(&self, skin: &[u8]) -> Result<Mesh, String> {
        if skin.get(0..4) != Some(SKIN) {
            return Err("not a skin profile: it does not start with SKIN".into());
        }
        let lookup = read_u16s(skin, array_at(skin, 0x04)?)?;
        let triangles = read_u16s(skin, array_at(skin, 0x0c)?)?;
        let sections = array_at(skin, 0x1c)?;
        let batches = array_at(skin, 0x24)?;

        let mut parts: Vec<Part> = Vec::new();
        for index in 0..batches.count {
            let batch = batches.record(skin, index, BATCH_SIZE)?;
            // Layers past the first are the glows and overlays a shader composites on top of
            // the base one. They draw the same triangles again, so keeping them without the
            // shader that separates them just doubles the geometry.
            if read_u16(batch, batch_field::LAYER)? != 0 {
                continue;
            }
            let section = sections.record(
                skin,
                read_u16(batch, batch_field::SECTION)? as usize,
                SECTION_SIZE,
            )?;

            // The trap: a submesh's real first index carries the level in its high bits.
            let level = read_u16(section, section_field::LEVEL)? as usize;
            let first = (level << 16) | read_u16(section, section_field::INDEX_START)? as usize;
            let count = read_u16(section, section_field::INDEX_COUNT)? as usize;
            let mut indices = Vec::with_capacity(count);
            for at in first..first + count {
                let looked_up = *triangles
                    .get(at)
                    .ok_or("a submesh points past the end of the triangle list")?;
                let vertex = *lookup
                    .get(looked_up as usize)
                    .ok_or("a triangle points past the end of the vertex list")?;
                indices.push(vertex as u32);
            }
            if indices.is_empty() {
                continue;
            }

            let (flags, blending) = self
                .materials
                .get(read_u16(batch, batch_field::MATERIAL)? as usize)
                .copied()
                .unwrap_or((0, 0));
            parts.push(Part {
                indices,
                geoset: read_u16(section, section_field::GEOSET)?,
                paint: self.paint(read_u16(batch, batch_field::TEXTURE_COMBO)? as usize),
                blend: match blending {
                    0 => Blend::Opaque,
                    1 => Blend::Mask,
                    _ => Blend::Blend,
                },
                two_sided: flags & 0x04 != 0,
            });
        }

        Ok(Mesh {
            vertices: self.vertices.clone(),
            parts,
        })
    }

    /// What paints the batch that names this entry of the texture combo list.
    ///
    /// Two indirections rather than one: the batch names a slot in `textureCombos`, which
    /// names the model's texture. A texture type of zero is a file of the model's own and
    /// everything else is the caller's business, carried across as the type that asked.
    ///
    /// A combo the model does not declare, and a type-zero texture with no `TXID` behind it,
    /// are both a model saying nothing this can resolve. Both come back as type zero, which is
    /// a type no caller supplies — an item's model has one texture and hands it over whatever
    /// was asked for, and a character's paints only the types it actually composited.
    fn paint(&self, combo: usize) -> Paint {
        let texture = match self.texture_combos.get(combo) {
            Some(index) => *index as usize,
            None => return Paint::Supplied(0),
        };
        match self.texture_kinds.get(texture) {
            Some(0) => self
                .texture_files
                .get(texture)
                .copied()
                .filter(|id| *id != 0)
                .map_or(Paint::Supplied(0), Paint::File),
            Some(kind) => Paint::Supplied(*kind),
            None => Paint::Supplied(0),
        }
    }
}

/// Where each piece of gear hangs off a body, out of that body's `.skel`.
///
/// The `SKA1` chunk holds what the pre-Legion header held at offset `0xf0`: a count-and-offset
/// pair naming a run of 40-byte records, each an attachment id, the bone it hangs off, and a
/// position. Only the first and the last are read — see [`Attachment`] for why the bone is not.
///
/// A skeleton with no `SKA1` is not an error. Every character body has one; this is what says
/// so for the file that turns out not to.
pub fn attachments(skeleton: &[u8]) -> Result<Vec<Attachment>, String> {
    let Some(ska1) = chunk_named(skeleton, SKA1) else {
        return Ok(Vec::new());
    };
    let array = array_at(ska1, ATTACHMENTS)?;
    let mut found = Vec::with_capacity(array.count);
    for index in 0..array.count {
        let record = array.record(ska1, index, ATTACHMENT_SIZE)?;
        found.push(Attachment {
            id: read_u32(record, attachment_field::ID)?,
            position: y_up(read_vector(record, attachment_field::POSITION)?),
        });
    }
    Ok(found)
}

/* ---------- reading the pieces ---------- */

/// The payload of the first chunk with this magic, bounded by the file's own length.
fn chunk_named<'a>(bytes: &'a [u8], magic: &[u8; 4]) -> Option<&'a [u8]> {
    let mut at = 0usize;
    while at + 8 <= bytes.len() {
        let size = read_u32(bytes, at + 4).ok()? as usize;
        let start = at + 8;
        // A chunk that runs past the end of the file is a truncated download rather than a
        // chunk, and what is there of it is still worth reading.
        let end = start.saturating_add(size).min(bytes.len());
        if &bytes[at..at + 4] == magic {
            return bytes.get(start.min(bytes.len())..end);
        }
        at = start.saturating_add(size);
    }
    None
}

/// A count-and-offset pair, which is how every list in an M2 or a skin is written.
struct Md21Array {
    count: usize,
    offset: usize,
}

impl Md21Array {
    /// One record of the array, bounds checked against the file it was read from.
    fn record<'a>(&self, bytes: &'a [u8], index: usize, size: usize) -> Result<&'a [u8], String> {
        if index >= self.count {
            return Err("a model points at a record its own header does not declare".into());
        }
        let at = self.offset + index * size;
        bytes
            .get(at..at + size)
            .ok_or_else(|| "a model's records run past the end of the file".into())
    }
}

/// The array declared at `at`, whose offset is already relative to the right thing: the
/// `MD21` payload for a model, the file itself for a skin.
fn array_at(bytes: &[u8], at: usize) -> Result<Md21Array, String> {
    Ok(Md21Array {
        count: read_u32(bytes, at)? as usize,
        offset: read_u32(bytes, at + 4)? as usize,
    })
}

fn read_vertices(md21: &[u8]) -> Result<Vec<Vertex>, String> {
    let array = array_at(md21, field::VERTICES)?;
    let mut vertices = Vec::with_capacity(array.count);
    for index in 0..array.count {
        let record = array.record(md21, index, VERTEX_SIZE)?;
        // Bytes 12 to 19 are the bone weights and indices, which a bind pose does not need.
        vertices.push(Vertex {
            position: y_up(read_vector(record, 0)?),
            normal: y_up(read_vector(record, 20)?),
            uv: [read_f32(record, 32)?, read_f32(record, 36)?],
        });
    }
    Ok(vertices)
}

/// The three lists that say how the model is painted: its textures, its materials, and the
/// lookup a batch reaches its texture through.
type Surfaces = (Vec<u32>, Vec<(u16, u16)>, Vec<u16>);

fn read_surfaces(md21: &[u8]) -> Result<Surfaces, String> {
    let textures = array_at(md21, field::TEXTURES)?;
    let mut kinds = Vec::with_capacity(textures.count);
    for index in 0..textures.count {
        // The filename that follows the type and flags is a single `\0` on every retail
        // model; `TXID` replaced it in 8.0.1.
        kinds.push(read_u32(textures.record(md21, index, TEXTURE_SIZE)?, 0)?);
    }

    let materials = array_at(md21, field::MATERIALS)?;
    let mut blending = Vec::with_capacity(materials.count);
    for index in 0..materials.count {
        let record = materials.record(md21, index, MATERIAL_SIZE)?;
        blending.push((read_u16(record, 0)?, read_u16(record, 2)?));
    }

    let combos = array_at(md21, field::TEXTURE_COMBOS)?;
    Ok((kinds, blending, read_u16s(md21, combos)?))
}

/// M2 keeps Z up and X forward; glTF keeps Y up. This is the rotation between them.
fn y_up([x, y, z]: [f32; 3]) -> [f32; 3] {
    [x, z, -y]
}

fn read_vector(bytes: &[u8], at: usize) -> Result<[f32; 3], String> {
    Ok([
        read_f32(bytes, at)?,
        read_f32(bytes, at + 4)?,
        read_f32(bytes, at + 8)?,
    ])
}

fn read_f32(bytes: &[u8], at: usize) -> Result<f32, String> {
    Ok(f32::from_bits(read_u32(bytes, at)?))
}

fn read_u32(bytes: &[u8], at: usize) -> Result<u32, String> {
    bytes
        .get(at..at + 4)
        .map(|slice| u32::from_le_bytes(slice.try_into().expect("four bytes are four bytes")))
        .ok_or_else(|| "a model ends in the middle of a number".into())
}

fn read_u16(bytes: &[u8], at: usize) -> Result<u16, String> {
    bytes
        .get(at..at + 2)
        .map(|slice| u16::from_le_bytes(slice.try_into().expect("two bytes are two bytes")))
        .ok_or_else(|| "a model ends in the middle of a number".into())
}

/// A whole chunk read as file ids, bounded by the chunk's own length.
fn read_u32s(payload: &[u8]) -> Vec<u32> {
    payload
        .chunks_exact(4)
        .map(|slice| u32::from_le_bytes(slice.try_into().expect("four bytes are four bytes")))
        .collect()
}

fn read_u16s(bytes: &[u8], array: Md21Array) -> Result<Vec<u16>, String> {
    let end = array.offset + array.count * 2;
    let slice = bytes
        .get(array.offset..end)
        .ok_or("a model's index list runs past the end of the file")?;
    Ok(slice
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes(pair.try_into().expect("two bytes are two bytes")))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::casc::{fixture_files, GameFiles};

    /// The invented models, by the FileDataID `ModelFileData` names them under.
    const HELM: u32 = 140001;
    const HELM_SKIN: u32 = 141001;
    /// A weapon whose second submesh sits past the first 64k indices, which is the only way
    /// to hold the `level` field to account.
    const WEAPON: u32 = 140004;
    const WEAPON_SKIN: u32 = 141004;
    /// The character body, which is the only fixture with geosets and several texture types.
    const CHARACTER: u32 = 1_000_764;
    const CHARACTER_SKIN: u32 = 1_000_765;
    /// And the skeleton beside it, which is the only fixture with attachments.
    const SKELETON: u32 = 1_000_766;

    /// The attachments this app asks for, as the community numbers them.
    const RIGHT_SHOULDER: u32 = 5;
    const LEFT_SHOULDER: u32 = 6;
    const HELM_ATTACHMENT: u32 = 11;
    const BACK: u32 = 12;

    fn model(fdid: u32) -> Model {
        Model::parse(&fixture_files().read(fdid).unwrap()).unwrap()
    }

    fn mesh(model_id: u32, skin_id: u32) -> Mesh {
        let model = model(model_id);
        assert_eq!(model.skin_file_data_id(), Some(skin_id));
        model
            .with_skin(&fixture_files().read(skin_id).unwrap())
            .unwrap()
    }

    // The whole point of the module: a chunked retail model, read down to triangles.
    #[test]
    fn reads_a_model_and_its_skin_into_triangles() {
        let mesh = mesh(HELM, HELM_SKIN);
        assert_eq!(mesh.vertices.len(), 8);
        assert_eq!(mesh.parts.len(), 1);
        let part = &mesh.parts[0];
        assert_eq!(part.indices.len(), 36);
        assert!(part.indices.iter().all(|index| (*index as usize) < mesh.vertices.len()));
        assert_eq!(part.paint, Paint::File(150001));
        assert_eq!(part.blend, Blend::Opaque);
        assert!(!part.two_sided);
    }

    // `MD21` offsets count from the chunk's own data, not from the file. Reading them against
    // the file lands eight bytes early in every list at once, which is garbage rather than an
    // error — so what says it was done right is the vertex positions coming out as written.
    #[test]
    fn resolves_offsets_against_the_chunk_rather_than_the_file() {
        let mesh = mesh(HELM, HELM_SKIN);
        // The generator writes a unit cube around the origin, in the game's own Z-up axes.
        let positions: Vec<[f32; 3]> = mesh.vertices.iter().map(|vertex| vertex.position).collect();
        assert!(positions.contains(&[-1.0, -1.0, 1.0]), "{positions:?}");
        assert!(positions.contains(&[1.0, 1.0, -1.0]), "{positions:?}");
        assert!(positions.iter().all(|[x, y, z]| x.abs() == 1.0 && y.abs() == 1.0 && z.abs() == 1.0));
    }

    // M2 is Z-up and glTF is Y-up, and the conversion has to be a rotation: a mirror would
    // turn every model inside out and leave its normals pointing into it.
    #[test]
    fn turns_the_game_s_axes_into_the_ones_a_viewer_uses() {
        // The generator writes the cube's top face pointing up the game's Z, so its normal
        // has to come out pointing up the viewer's Y.
        let mesh = mesh(HELM, HELM_SKIN);
        let up = mesh
            .vertices
            .iter()
            .find(|vertex| vertex.position[1] > 0.0)
            .expect("the cube has vertices above the origin");
        assert_eq!(up.normal, [0.0, 1.0, 0.0]);
    }

    // A submesh's first index is only 16 bits wide, and the level makes up the rest. The
    // weapon's second submesh starts past 65,535, so a reader that ignores the level draws it
    // from the very beginning of the triangle list instead — geometry, but the wrong
    // geometry, which is why this checks the vertices it lands on rather than a count.
    #[test]
    fn adds_the_level_to_a_submesh_that_starts_past_the_first_64k_indices() {
        let mesh = mesh(WEAPON, WEAPON_SKIN);
        assert_eq!(mesh.parts.len(), 2);
        // The generator paints the far submesh onto the last eight vertices of the model and
        // fills everything before it with the first eight, so the two are told apart by which
        // end of the model they use.
        let blade = &mesh.parts[0];
        let far = &mesh.parts[1];
        assert!(blade.indices.iter().all(|index| *index < 8));
        assert!(far.indices.iter().all(|index| *index >= 8), "{:?}", &far.indices[..6]);
    }

    // A model says which of its textures it owns and which the item supplies; the second kind
    // is what makes one helm mesh serve every recolour of it.
    #[test]
    fn tells_a_texture_of_its_own_from_one_the_item_supplies() {
        let helm = model(HELM);
        assert_eq!(helm.texture_file_data_ids(), vec![150001]);

        // The shoulder's mesh leaves its texture to the item, so it names no file at all.
        let shoulder = mesh(140002, 141002);
        assert_eq!(shoulder.parts[0].paint, Paint::Supplied(2));
        assert_eq!(model(140002).texture_file_data_ids(), Vec::<u32>::new());
    }

    // Which *type* asked is the difference between a body and its hair. An item's model has
    // one texture and any type does for it; a character declares several, and a reader that
    // flattened them all to "the caller's problem" would have no way to tell the atlas it
    // composited from the two it did not.
    #[test]
    fn says_which_texture_type_a_supplied_paint_was_asked_for_by() {
        let body = mesh(CHARACTER, CHARACTER_SKIN);
        let types: Vec<Paint> = body.parts.iter().map(|part| part.paint).collect();
        // Every part but the hair is the composited body atlas, which is type 1.
        assert_eq!(types.iter().filter(|paint| **paint == Paint::Supplied(1)).count(), 16);
        assert_eq!(types.iter().filter(|paint| **paint == Paint::Supplied(6)).count(), 2);
        // And the cape, which is the third: a body wears one item picture out of its own
        // geometry, and it is neither the atlas nor the hair.
        assert_eq!(types.iter().filter(|paint| **paint == Paint::Supplied(2)).count(), 1);
    }

    // The geoset is what says whether a part of a body is drawn at all, and it is the one
    // field of a skin section an item's model has no use for.
    #[test]
    fn reads_the_geoset_each_part_of_a_body_belongs_to() {
        let body = mesh(CHARACTER, CHARACTER_SKIN);
        let geosets: Vec<u16> = body.parts.iter().map(|part| part.geoset).collect();
        assert_eq!(
            geosets,
            vec![
                0, 801, 802, 1101, 1104, 2001, 2002, 2701, 2702, 1, 2, 1001, 1002, 1301, 1302,
                501, 502, 1502, 2101,
            ]
        );
        // An item is drawn whole, and says so by belonging to no geoset.
        assert!(mesh(HELM, HELM_SKIN).parts.iter().all(|part| part.geoset == 0));
    }

    // Blend mode and two-sidedness are the two material properties a still picture needs: one
    // decides whether a cutout is a hole, the other whether a sheet exists from behind.
    #[test]
    fn reads_how_each_part_is_composited() {
        let mesh = mesh(140003, 141003);
        let blends: Vec<(Blend, bool)> = mesh
            .parts
            .iter()
            .map(|part| (part.blend, part.two_sided))
            .collect();
        assert_eq!(
            blends,
            vec![(Blend::Opaque, false), (Blend::Mask, true), (Blend::Blend, false)]
        );
    }

    // Layers past the first are overlays a shader composites onto the base one. Kept, they
    // draw the same triangles a second time and z-fight with themselves.
    #[test]
    fn draws_the_base_layer_of_a_part_and_not_its_overlays() {
        // The cloak's batch list holds a second layer over its only submesh.
        let mesh = mesh(140003, 141003);
        assert_eq!(mesh.parts.len(), 3);
    }

    // Where a helm goes, which is the one thing beyond geometry this reads — and it does not
    // read it out of the model at all. A retail character's own attachment array is empty and
    // its `SKID` names the file that holds them, so the fixture body is built the same way and
    // a reader that looked only at the header would find a body nothing can be hung off.
    #[test]
    fn reads_where_gear_hangs_off_a_body_out_of_its_skeleton() {
        let body = model(CHARACTER);
        let skeleton = body
            .skeleton_file_data_id()
            .expect("the body names a skeleton");
        assert_eq!(skeleton, SKELETON);
        let attachments = attachments(&fixture_files().read(skeleton).unwrap()).unwrap();

        let at = |id: u32| {
            attachments
                .iter()
                .find(|attachment| attachment.id == id)
                .map(|attachment| attachment.position)
        };
        // The helm is highest, the two shoulders are a mirrored pair either side of her, and
        // the back is behind — all in the viewer's axes, which is the turn `y_up` makes.
        assert_eq!(at(HELM_ATTACHMENT), Some([0.0, 4.0, 0.0]));
        assert_eq!(at(LEFT_SHOULDER), Some([0.0, 3.0, -2.0]));
        assert_eq!(at(RIGHT_SHOULDER), Some([0.0, 3.0, 2.0]));
        assert_eq!(at(BACK), Some([-1.0, 2.0, 0.0]));
    }

    // An attachment is found by the id in its record and not by where it sits in the array.
    // The fixture disagrees about the two deliberately: the helm is id 11 and the third
    // record, so a reader that indexed by id would run off the end of a five-entry list — and
    // one that indexed by position would hang the helm off her back.
    #[test]
    fn finds_an_attachment_by_its_id_rather_than_by_its_place_in_the_list() {
        let attachments = attachments(&fixture_files().read(SKELETON).unwrap()).unwrap();
        let ids: Vec<u32> = attachments.iter().map(|attachment| attachment.id).collect();
        assert_eq!(ids, vec![BACK, LEFT_SHOULDER, HELM_ATTACHMENT, 1, RIGHT_SHOULDER]);
    }

    // An item's model hangs things off nothing and says so, and a file with no attachments in
    // it is a fact about the file rather than a failure — a body is the only model here that
    // has any.
    #[test]
    fn says_nothing_about_attachments_for_a_model_that_has_none() {
        assert_eq!(model(HELM).skeleton_file_data_id(), None);
        assert_eq!(attachments(b"").unwrap(), Vec::new());
        // A skeleton whose chunks are none this reader knows, which is the same answer.
        let mut chunked = b"SKL1".to_vec();
        chunked.extend_from_slice(&4u32.to_le_bytes());
        chunked.extend_from_slice(b"junk");
        assert_eq!(attachments(&chunked).unwrap(), Vec::new());
    }

    #[test]
    fn says_what_was_wrong_with_a_file_it_could_not_read() {
        assert!(Model::parse(&[]).unwrap_err().contains("no MD21 chunk"));
        let mut headerless = b"MD21".to_vec();
        headerless.extend_from_slice(&4u32.to_le_bytes());
        headerless.extend_from_slice(b"junk");
        assert!(Model::parse(&headerless).unwrap_err().contains("holds no M2"));

        let helm = model(HELM);
        assert!(helm.with_skin(&[]).unwrap_err().contains("does not start with SKIN"));
    }
}
