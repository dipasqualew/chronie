//! Turning a parsed model into a `.glb` the window can load.
//!
//! glTF is the one 3D format a browser engine reads without being taught how, and `.glb` is
//! its single-file form: a JSON document describing the scene, then one binary blob holding
//! the vertices, the indices and the pictures. Nothing about the game's own formats survives
//! into it, which is the point — the window gets geometry and PNGs and needs to know nothing
//! about M2, skin profiles or BLP.
//!
//! The pictures are asked for rather than passed in, because several parts of a model share
//! one texture and decoding a BLP twice is the expensive half of the work.
//!
//! This is also where the geometry stops being the game's and becomes a download. A body holds
//! every variant of every geoset at once and draws about 2% of them, so [`Kept`] carries the
//! vertices something points at and renumbers the indices to match — 10.36MB of `.glb` for a
//! dressed character became 2.83MB.
//!
//! A scene holds several [`Piece`]s rather than one mesh, because a dressed character is a body
//! and the helm hanging off it — different files, different textures, and a translation between
//! them. Keeping them apart rather than welding them into one vertex list is what lets each ask
//! for its own pictures: `Paint::Supplied(2)` means the body's cape to the character and the
//! item's only texture to a shoulder pad, and a merged mesh would have nowhere to put that.

use std::collections::HashMap;

use gltf_json::validation::Checked::Valid;
use gltf_json::validation::USize64;
use serde_json::json;

use crate::m2::{Blend, Mesh, Paint};

/// The container's own numbers: the magic a `.glb` starts with, the version it declares, and
/// the two chunk kinds it holds.
const GLB_MAGIC: u32 = 0x4654_6c67;
const GLB_VERSION: u32 = 2;
const CHUNK_JSON: u32 = 0x4e4f_534a;
const CHUNK_BIN: u32 = 0x004e_4942;

/// One mesh in a scene, and where it sits.
///
/// `picture` answers with the PNG bytes for a paint, or nothing when this install cannot show
/// it — a texture the game withholds, or one in an encoding the decoder does not read. A part
/// whose picture is missing keeps its geometry and loses its colour, which is worth far more
/// than refusing to show the model at all. It belongs to the piece rather than to the scene
/// because a paint means different things to a body and to the helm on it.
pub struct Piece<'a> {
    pub mesh: &'a Mesh,
    /// Where the mesh's own origin goes, in the viewer's axes. `[0.0; 3]` for a model that is
    /// the whole of what is being shown; an attachment's position for one hanging off a body.
    pub at: [f32; 3],
    /// How it sits there: a quaternion `[x, y, z, w]` and three lengths. An attachment can
    /// carry both — a pauldron sits at 62% and rolled outward — and a model shown on its own
    /// carries neither.
    pub rotation: [f32; 4],
    pub scale: [f32; 3],
    pub picture: &'a dyn Fn(Paint) -> Option<Vec<u8>>,
}

/// What a piece with nothing to say about how it sits carries. glTF's own defaults, so both are
/// left out of the file entirely rather than written as the identity.
const AT_REST: [f32; 4] = [0.0, 0.0, 0.0, 1.0];
const FULL_SIZE: [f32; 3] = [1.0, 1.0, 1.0];

impl<'a> Piece<'a> {
    /// The one piece a model shown on its own is.
    pub fn only(mesh: &'a Mesh, picture: &'a dyn Fn(Paint) -> Option<Vec<u8>>) -> Self {
        Self {
            mesh,
            at: [0.0; 3],
            rotation: AT_REST,
            scale: FULL_SIZE,
            picture,
        }
    }
}

/// A `.glb` for a scene, with every texture every piece of it uses embedded in it.
#[tracing::instrument(name = "glb.write", skip_all, fields(pieces = pieces.len()))]
pub fn write(pieces: &[Piece<'_>]) -> Result<Vec<u8>, String> {
    if pieces
        .iter()
        .any(|piece| piece.mesh.vertices.is_empty() || piece.mesh.parts.is_empty())
    {
        return Err("the model holds no geometry".into());
    }
    if pieces.is_empty() {
        return Err("the model holds no geometry".into());
    }

    let mut bin = Binary::default();
    let mut root = gltf_json::Root {
        asset: gltf_json::Asset {
            generator: Some("chronie".into()),
            version: "2.0".into(),
            ..Default::default()
        },
        ..Default::default()
    };

    // Shared by every piece: item textures are authored small and shown large, and
    // nearest-neighbour would show the reader the texels rather than the armour.
    let sampler = root.push(gltf_json::texture::Sampler {
        mag_filter: Some(Valid(gltf_json::texture::MagFilter::Linear)),
        min_filter: Some(Valid(gltf_json::texture::MinFilter::LinearMipmapLinear)),
        wrap_s: Valid(gltf_json::texture::WrappingMode::Repeat),
        wrap_t: Valid(gltf_json::texture::WrappingMode::Repeat),
        ..Default::default()
    });

    let mut nodes = Vec::with_capacity(pieces.len());
    for piece in pieces {
        let node = write_piece(&mut root, &mut bin, sampler, piece)?;
        nodes.push(node);
    }

    let scene = root.push(gltf_json::Scene {
        nodes,
        extensions: None,
        extras: Default::default(),
    });
    root.scene = Some(scene);

    let bytes = bin.finish();
    root.buffers.push(gltf_json::Buffer {
        byte_length: USize64::from(bytes.len()),
        // No URI at all is what says "the binary chunk of this very file".
        uri: None,
        extensions: None,
        extras: Default::default(),
    });

    let json = root
        .to_string()
        .map_err(|error| format!("the model would not serialise: {error}"))?;
    Ok(container(json.into_bytes(), bytes))
}

/// One piece as a node of its own, holding a mesh of its own.
///
/// A node rather than vertices moved into place: the translation is stated once for the whole
/// mesh, which is what glTF is for, and the positions stay the ones the game wrote.
fn write_piece(
    root: &mut gltf_json::Root,
    bin: &mut Binary,
    sampler: gltf_json::Index<gltf_json::texture::Sampler>,
    piece: &Piece<'_>,
) -> Result<gltf_json::Index<gltf_json::Node>, String> {
    let mesh = piece.mesh;
    let kept = Kept::of(mesh)?;

    /* The vertices, as three lists the parts all share — and only the ones the parts below
    actually point at. */
    let vertices = || {
        kept.order
            .iter()
            .map(|index| &mesh.vertices[*index as usize])
    };
    let positions: Vec<[f32; 3]> = vertices().map(|vertex| vertex.position).collect();
    let normals: Vec<[f32; 3]> = vertices().map(|vertex| vertex.normal).collect();
    let uvs: Vec<[f32; 2]> = vertices().map(|vertex| vertex.uv).collect();

    let count = kept.order.len();
    let position_view = bin.view(root, floats(&positions), Some(ARRAY_BUFFER));
    let normal_view = bin.view(root, floats(&normals), Some(ARRAY_BUFFER));
    let uv_view = bin.view(root, floats(&uvs), Some(ARRAY_BUFFER));

    let (low, high) = extent(&positions);
    let position = root.push(accessor(
        position_view,
        count,
        gltf_json::accessor::Type::Vec3,
        gltf_json::accessor::ComponentType::F32,
        Some((json!(low), json!(high))),
    ));
    let normal = root.push(accessor(
        normal_view,
        count,
        gltf_json::accessor::Type::Vec3,
        gltf_json::accessor::ComponentType::F32,
        None,
    ));
    let uv = root.push(accessor(
        uv_view,
        count,
        gltf_json::accessor::Type::Vec2,
        gltf_json::accessor::ComponentType::F32,
        None,
    ));

    /* One primitive per part, each with the material and picture it asked for — except the
    parts glTF has no compositing for at all. [`Blend::Glow`] is the additive and modulating
    family, and the format's `alphaMode` cannot say either; written out as source-over, a
    character's eye glow stops being a glint and becomes a solid cyan slab across both eyes.
    Leaving it out is the nearer of the two answers, and it is the whole of what it costs: what
    these parts add to a still picture is light, and there is none here to add. */
    let mut painted: HashMap<Paint, Option<gltf_json::Index<gltf_json::Texture>>> = HashMap::new();
    let mut primitives = Vec::with_capacity(mesh.parts.len());
    for part in drawn_parts(mesh) {
        let texture = match painted.get(&part.paint) {
            Some(known) => *known,
            None => {
                let made = (piece.picture)(part.paint).map(|png| {
                    let view = bin.view(root, png, None);
                    let image = root.push(gltf_json::Image {
                        buffer_view: Some(view),
                        mime_type: Some(gltf_json::image::MimeType("image/png".into())),
                        uri: None,
                        extensions: None,
                        extras: Default::default(),
                    });
                    root.push(gltf_json::Texture {
                        sampler: Some(sampler),
                        source: image,
                        extensions: None,
                        extras: Default::default(),
                    })
                });
                painted.insert(part.paint, made);
                made
            }
        };

        let indices = bin.view(
            root,
            part.indices
                .iter()
                .flat_map(|index| kept.at(*index).to_le_bytes())
                .collect(),
            Some(ELEMENT_ARRAY_BUFFER),
        );
        let indices = root.push(accessor(
            indices,
            part.indices.len(),
            gltf_json::accessor::Type::Scalar,
            gltf_json::accessor::ComponentType::U32,
            None,
        ));

        let material = root.push(gltf_json::Material {
            alpha_cutoff: match part.blend {
                Blend::Mask => Some(gltf_json::material::AlphaCutoff(0.5)),
                _ => None,
            },
            alpha_mode: Valid(match part.blend {
                Blend::Opaque => gltf_json::material::AlphaMode::Opaque,
                Blend::Mask => gltf_json::material::AlphaMode::Mask,
                Blend::Blend => gltf_json::material::AlphaMode::Blend,
                // Filtered out above: glTF has no additive compositing to write here.
                Blend::Glow => gltf_json::material::AlphaMode::Blend,
            }),
            double_sided: part.two_sided,
            pbr_metallic_roughness: gltf_json::material::PbrMetallicRoughness {
                base_color_texture: texture.map(|index| gltf_json::texture::Info {
                    index,
                    tex_coord: 0,
                    extensions: None,
                    extras: Default::default(),
                }),
                // The game's own shading is baked into its textures, so anything the renderer
                // adds on top is a second lighting model over the first. Fully rough and not
                // at all metallic is the closest a physical material gets to staying out of
                // the way.
                metallic_factor: gltf_json::material::StrengthFactor(0.0),
                roughness_factor: gltf_json::material::StrengthFactor(1.0),
                ..Default::default()
            },
            ..Default::default()
        });

        primitives.push(gltf_json::mesh::Primitive {
            attributes: [
                (Valid(gltf_json::mesh::Semantic::Positions), position),
                (Valid(gltf_json::mesh::Semantic::Normals), normal),
                (Valid(gltf_json::mesh::Semantic::TexCoords(0)), uv),
            ]
            .into_iter()
            .collect(),
            indices: Some(indices),
            material: Some(material),
            mode: Valid(gltf_json::mesh::Mode::Triangles),
            extensions: None,
            extras: Default::default(),
            targets: None,
        });
    }

    let drawn = root.push(gltf_json::Mesh {
        primitives,
        extensions: None,
        extras: Default::default(),
        weights: None,
    });
    Ok(root.push(gltf_json::Node {
        mesh: Some(drawn),
        // Each left out entirely where it is the default, so that a model shown on its own
        // writes exactly the file it always did.
        translation: (piece.at != [0.0; 3]).then_some(piece.at),
        rotation: (piece.rotation != AT_REST)
            .then_some(gltf_json::scene::UnitQuaternion(piece.rotation)),
        scale: (piece.scale != FULL_SIZE).then_some(piece.scale),
        ..Default::default()
    }))
}

/// The parts of a mesh that become primitives, which is every part the format can composite.
///
/// One iterator rather than the filter written twice, because [`Kept`] and the loop that
/// writes the primitives have to agree exactly: a vertex kept for a part that is then left out
/// is a vertex nothing points at, and a part written against a vertex that was not kept names
/// an index the file does not hold.
fn drawn_parts(mesh: &Mesh) -> impl Iterator<Item = &crate::m2::Part> {
    mesh.parts.iter().filter(|part| part.blend != Blend::Glow)
}

/// Which of a mesh's vertices the file carries, and what each one is called in it.
///
/// A body holds every variant of every geoset at once — a quarter of a million vertices for
/// `humanfemale_hd` — and a dressed character draws about 2% of them: hiding a geoset drops
/// its triangles and leaves its vertices behind, pointed at by nothing. Writing them out
/// anyway cost 8MB of a 10.4MB `.glb`, and that 8MB was paid for a second time in the window,
/// where the data URL carrying it has to be base64-decoded on the main thread before three.js
/// sees a byte of it.
///
/// So the file carries a vertex when some primitive points at it, and the indices are
/// renumbered to match. Nothing about the geometry changes — the same triangles, the same
/// positions, the same UVs — which is what makes this safe to do here, at the very edge, rather
/// than in [`crate::character::dressed`] where the mesh is still the game's own and the
/// vertex ids still mean what the game meant by them.
struct Kept {
    /// The mesh's own vertex ids, in the order the file writes them out.
    order: Vec<u32>,
    /// What each of the mesh's vertices is called in the file. [`NOWHERE`] for one no part
    /// points at, which by construction no index in the file can name.
    at: Vec<u32>,
}

/// What [`Kept::at`] holds for a vertex the file does not carry.
const NOWHERE: u32 = u32::MAX;

impl Kept {
    fn of(mesh: &Mesh) -> Result<Self, String> {
        let mut kept = Self {
            order: Vec::new(),
            at: vec![NOWHERE; mesh.vertices.len()],
        };
        for part in drawn_parts(mesh) {
            for index in &part.indices {
                let slot = kept
                    .at
                    .get_mut(*index as usize)
                    .ok_or("a part points past the end of the vertex list")?;
                if *slot == NOWHERE {
                    *slot = u32::try_from(kept.order.len())
                        .map_err(|_| "the mesh draws more vertices than an index can name")?;
                    kept.order.push(*index);
                }
            }
        }
        Ok(kept)
    }

    /// What the file calls one of the mesh's vertices.
    fn at(&self, index: u32) -> u32 {
        self.at[index as usize]
    }
}

/// The two `target` values a buffer view can declare, which tell a loader what the bytes are
/// for. glTF spells them as the OpenGL constants.
const ARRAY_BUFFER: gltf_json::buffer::Target = gltf_json::buffer::Target::ArrayBuffer;
const ELEMENT_ARRAY_BUFFER: gltf_json::buffer::Target =
    gltf_json::buffer::Target::ElementArrayBuffer;

/// The one binary blob a `.glb` carries, grown a view at a time.
#[derive(Default)]
struct Binary {
    bytes: Vec<u8>,
}

impl Binary {
    /// Appends some bytes and declares the view over them.
    ///
    /// Every view starts on a four-byte boundary: the format requires it of anything holding
    /// numbers, and a loader is entitled to read a run of floats as a run of floats.
    fn view(
        &mut self,
        root: &mut gltf_json::Root,
        bytes: Vec<u8>,
        target: Option<gltf_json::buffer::Target>,
    ) -> gltf_json::Index<gltf_json::buffer::View> {
        while !self.bytes.len().is_multiple_of(4) {
            self.bytes.push(0);
        }
        let offset = self.bytes.len();
        let length = bytes.len();
        self.bytes.extend(bytes);
        root.push(gltf_json::buffer::View {
            // The buffer is pushed last, once its length is known, and it is the only one.
            buffer: gltf_json::Index::new(0),
            byte_length: USize64::from(length),
            byte_offset: Some(USize64::from(offset)),
            byte_stride: None,
            target: target.map(Valid),
            extensions: None,
            extras: Default::default(),
        })
    }

    fn finish(self) -> Vec<u8> {
        self.bytes
    }
}

fn accessor(
    view: gltf_json::Index<gltf_json::buffer::View>,
    count: usize,
    kind: gltf_json::accessor::Type,
    component: gltf_json::accessor::ComponentType,
    bounds: Option<(serde_json::Value, serde_json::Value)>,
) -> gltf_json::Accessor {
    let (min, max) = match bounds {
        Some((low, high)) => (Some(low), Some(high)),
        None => (None, None),
    };
    gltf_json::Accessor {
        buffer_view: Some(view),
        byte_offset: Some(USize64(0)),
        count: USize64::from(count),
        component_type: Valid(gltf_json::accessor::GenericComponentType(component)),
        type_: Valid(kind),
        min,
        max,
        normalized: false,
        sparse: None,
        extensions: None,
        extras: Default::default(),
    }
}

/// The corners of the box a set of positions occupies, which glTF requires of the position
/// accessor and every viewer uses to frame what it is about to show.
fn extent(positions: &[[f32; 3]]) -> ([f32; 3], [f32; 3]) {
    let mut low = [f32::INFINITY; 3];
    let mut high = [f32::NEG_INFINITY; 3];
    for position in positions {
        for axis in 0..3 {
            low[axis] = low[axis].min(position[axis]);
            high[axis] = high[axis].max(position[axis]);
        }
    }
    (low, high)
}

/// A list of small float arrays, flattened into the little-endian bytes glTF stores.
fn floats<const N: usize>(values: &[[f32; N]]) -> Vec<u8> {
    values
        .iter()
        .flat_map(|value| value.iter().flat_map(|number| number.to_le_bytes()))
        .collect()
}

/// The `.glb` wrapper: a twelve-byte header, then the JSON chunk, then the binary one.
///
/// Both chunks are padded to a multiple of four — the JSON with spaces so it stays parseable,
/// the binary with zeroes.
fn container(mut json: Vec<u8>, mut bin: Vec<u8>) -> Vec<u8> {
    while !json.len().is_multiple_of(4) {
        json.push(b' ');
    }
    while !bin.len().is_multiple_of(4) {
        bin.push(0);
    }

    let length = 12 + 8 + json.len() + 8 + bin.len();
    let mut out = Vec::with_capacity(length);
    out.extend(GLB_MAGIC.to_le_bytes());
    out.extend(GLB_VERSION.to_le_bytes());
    out.extend((length as u32).to_le_bytes());
    out.extend((json.len() as u32).to_le_bytes());
    out.extend(CHUNK_JSON.to_le_bytes());
    out.extend(json);
    out.extend((bin.len() as u32).to_le_bytes());
    out.extend(CHUNK_BIN.to_le_bytes());
    out.extend(bin);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::casc::{fixture_files, GameFiles};
    use crate::m2::Model;
    use serde_json::Value;

    const HELM: u32 = 140001;
    const HELM_SKIN: u32 = 141001;
    /// A model whose three parts are opaque, alpha tested and blended in turn.
    const CLOAK: u32 = 140003;
    const CLOAK_SKIN: u32 = 141003;

    fn mesh(model: u32, skin: u32) -> Mesh {
        Model::parse(&fixture_files().read(model).unwrap())
            .unwrap()
            .with_skin(&fixture_files().read(skin).unwrap())
            .unwrap()
    }

    /// A picture for every paint, so the texture path is exercised. The bytes only have to be
    /// carried through; nothing here decodes them.
    fn always(png: &'static [u8]) -> impl Fn(Paint) -> Option<Vec<u8>> {
        move |_| Some(png.to_vec())
    }

    /// The three parts of a `.glb`, taken apart the way a loader does.
    struct Parsed {
        json: Value,
        bin: Vec<u8>,
    }

    impl Parsed {
        /// The bytes an accessor's view covers.
        fn bytes_of(&self, accessor: usize) -> &[u8] {
            let accessor = &self.json["accessors"][accessor];
            let view = &self.json["bufferViews"][accessor["bufferView"].as_u64().unwrap() as usize];
            let at = view["byteOffset"].as_u64().unwrap() as usize;
            let length = view["byteLength"].as_u64().unwrap() as usize;
            &self.bin[at..at + length]
        }
    }

    /// The positions an accessor names, as a loader would read them back.
    fn positions(parsed: &Parsed, accessor: usize) -> Vec<[f32; 3]> {
        parsed
            .bytes_of(accessor)
            .chunks_exact(12)
            .map(|chunk| {
                let number = |index: usize| {
                    f32::from_le_bytes(chunk[index * 4..index * 4 + 4].try_into().unwrap())
                };
                [number(0), number(1), number(2)]
            })
            .collect()
    }

    /// The indices a primitive draws with, which are what the renumbering has to get right.
    fn indices(parsed: &Parsed, primitive: &Value) -> Vec<u32> {
        parsed
            .bytes_of(primitive["indices"].as_u64().unwrap() as usize)
            .chunks_exact(4)
            .map(|chunk| u32::from_le_bytes(chunk.try_into().unwrap()))
            .collect()
    }

    fn parse(bytes: &[u8]) -> Parsed {
        assert_eq!(&bytes[0..4], b"glTF");
        assert_eq!(u32::from_le_bytes(bytes[4..8].try_into().unwrap()), 2);
        assert_eq!(
            u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize,
            bytes.len(),
            "the header's length is the whole file"
        );

        let json_length = u32::from_le_bytes(bytes[12..16].try_into().unwrap()) as usize;
        assert_eq!(&bytes[16..20], b"JSON");
        let json: Value = serde_json::from_slice(&bytes[20..20 + json_length]).unwrap();

        let at = 20 + json_length;
        let bin_length = u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap()) as usize;
        assert_eq!(&bytes[at + 4..at + 8], b"BIN\0");
        Parsed {
            json,
            bin: bytes[at + 8..at + 8 + bin_length].to_vec(),
        }
    }

    // The whole job of the module, checked the way a loader reads it: a scene holding a mesh
    // whose vertices are where the accessors say they are.
    #[test]
    fn writes_a_glb_a_loader_can_read() {
        let mesh = mesh(HELM, HELM_SKIN);
        let glb = write(&[Piece::only(&mesh, &always(b"a picture"))]).unwrap();
        let Parsed { json, bin } = parse(&glb);

        assert_eq!(json["asset"]["version"], "2.0");
        assert_eq!(json["scene"], 0);
        assert_eq!(json["scenes"][0]["nodes"], serde_json::json!([0]));
        assert_eq!(json["nodes"][0]["mesh"], 0);
        assert_eq!(json["meshes"][0]["primitives"].as_array().unwrap().len(), 1);

        // The one buffer is the binary chunk itself, which is what "no uri" means.
        assert_eq!(json["buffers"].as_array().unwrap().len(), 1);
        assert_eq!(json["buffers"][0]["uri"], Value::Null);
        assert_eq!(
            json["buffers"][0]["byteLength"].as_u64().unwrap() as usize,
            bin.len()
        );
    }

    // The positions have to arrive intact, in the axes the parser turned them into, and the
    // accessor has to say where they are. Reading them back out of the blob is the only thing
    // that says both together.
    //
    // Read through the indices rather than straight down the list, because the file carries
    // the vertices in the order the parts reach them rather than the order the game held them:
    // what has to survive is the corner each triangle is drawn at, not the number it had.
    #[test]
    fn puts_the_vertices_where_the_accessors_say_they_are() {
        let mesh = mesh(HELM, HELM_SKIN);
        let glb = write(&[Piece::only(&mesh, &always(b"a picture"))]).unwrap();
        let parsed = parse(&glb);

        let accessor = &parsed.json["accessors"][0];
        assert_eq!(accessor["type"], "VEC3");
        assert_eq!(accessor["componentType"], 5126);

        let carried = positions(&parsed, 0);
        assert_eq!(accessor["count"].as_u64().unwrap() as usize, carried.len());
        let drawn: Vec<[f32; 3]> = indices(&parsed, &parsed.json["meshes"][0]["primitives"][0])
            .into_iter()
            .map(|index| carried[index as usize])
            .collect();
        let expected: Vec<[f32; 3]> = mesh.parts[0]
            .indices
            .iter()
            .map(|index| mesh.vertices[*index as usize].position)
            .collect();
        assert_eq!(drawn, expected);
    }

    // And the reason to read it that way: the file carries a vertex because something points
    // at it. A body holds every variant of every geoset at once and a dressed one draws about
    // a fortieth of them, so on a real character this is 248,958 vertices shipped becoming
    // 4,894 — 8MB of a 10.4MB `.glb`, paid for again in the window where the data URL carrying
    // them is base64-decoded on the main thread.
    #[test]
    fn carries_no_vertex_nothing_points_at() {
        let whole = mesh(HELM, HELM_SKIN);
        let mut one_triangle = whole.clone();
        one_triangle.parts.truncate(1);
        one_triangle.parts[0].indices.truncate(3);
        assert!(
            whole.vertices.len() > 3,
            "the fixture helm has a mesh to cut down"
        );

        let glb = write(&[Piece::only(&one_triangle, &always(b"a picture"))]).unwrap();
        let parsed = parse(&glb);
        let carried = positions(&parsed, 0);
        assert_eq!(
            carried.len(),
            3,
            "the file carries {} vertices for one triangle",
            carried.len()
        );

        // Renumbered to match, in the order the part reaches them, and drawn at the same three
        // corners the game named.
        let primitive = &parsed.json["meshes"][0]["primitives"][0];
        assert_eq!(indices(&parsed, primitive), vec![0, 1, 2]);
        let expected: Vec<[f32; 3]> = one_triangle.parts[0]
            .indices
            .iter()
            .map(|index| whole.vertices[*index as usize].position)
            .collect();
        assert_eq!(carried, expected);
    }

    // A part that names a vertex the mesh does not hold is a file this app has misread, and it
    // used to become a `.glb` with an index past the end of its own accessor — geometry that
    // fails in the window rather than here.
    #[test]
    fn refuses_a_part_that_points_past_the_end_of_the_vertex_list() {
        let mut mesh = mesh(HELM, HELM_SKIN);
        mesh.parts[0].indices[0] = mesh.vertices.len() as u32;
        assert!(write(&[Piece::only(&mesh, &always(b"a picture"))]).is_err());
    }

    // Every viewer frames what it is about to show from the position accessor's bounds, and
    // glTF requires them for that reason. Without them a model opens somewhere off screen.
    #[test]
    fn states_the_box_the_model_occupies() {
        let mesh = mesh(HELM, HELM_SKIN);
        let glb = write(&[Piece::only(&mesh, &always(b"a picture"))]).unwrap();
        let json = parse(&glb).json;
        assert_eq!(
            json["accessors"][0]["min"],
            serde_json::json!([-1.0, -1.0, -1.0])
        );
        assert_eq!(
            json["accessors"][0]["max"],
            serde_json::json!([1.0, 1.0, 1.0])
        );
    }

    // The picture travels inside the file, because the window has no origin to load one from.
    #[test]
    fn embeds_every_texture_in_the_file_itself() {
        let mesh = mesh(HELM, HELM_SKIN);
        let glb = write(&[Piece::only(&mesh, &always(b"a picture"))]).unwrap();
        let Parsed { json, bin } = parse(&glb);
        assert_eq!(json["images"][0]["mimeType"], "image/png");
        assert_eq!(json["images"][0]["uri"], Value::Null);

        let view = &json["bufferViews"][json["images"][0]["bufferView"].as_u64().unwrap() as usize];
        let at = view["byteOffset"].as_u64().unwrap() as usize;
        let length = view["byteLength"].as_u64().unwrap() as usize;
        assert_eq!(&bin[at..at + length], b"a picture");
        assert_eq!(
            json["materials"][0]["pbrMetallicRoughness"]["baseColorTexture"]["index"],
            0
        );
    }

    // Several parts of a model share one texture, and a BLP decoded twice costs more than
    // everything else here put together.
    #[test]
    fn decodes_a_texture_once_however_many_parts_want_it() {
        let mesh = mesh(CLOAK, CLOAK_SKIN);
        let asked = std::cell::RefCell::new(Vec::new());
        let glb = write(&[Piece::only(&mesh, &|paint| {
            asked.borrow_mut().push(paint);
            Some(b"a picture".to_vec())
        })])
        .unwrap();

        assert_eq!(mesh.parts.len(), 3);
        assert_eq!(asked.into_inner(), vec![Paint::Supplied(2)]);
        assert_eq!(parse(&glb).json["images"].as_array().unwrap().len(), 1);
    }

    // How a part is composited is the difference between a plume with holes in it and a plume
    // with a grey rectangle behind it, so the material has to carry it across.
    #[test]
    fn carries_each_part_s_blending_into_its_material() {
        let mesh = mesh(CLOAK, CLOAK_SKIN);
        let glb = write(&[Piece::only(&mesh, &always(b"a picture"))]).unwrap();
        let materials = parse(&glb).json["materials"].clone();
        let modes: Vec<(&str, bool)> = materials
            .as_array()
            .unwrap()
            .iter()
            // glTF leaves out the default, and the default is OPAQUE.
            .map(|material| {
                (
                    material["alphaMode"].as_str().unwrap_or("OPAQUE"),
                    material["doubleSided"].as_bool().unwrap_or(false),
                )
            })
            .collect();
        assert_eq!(
            modes,
            vec![("OPAQUE", false), ("MASK", true), ("BLEND", false)]
        );
    }

    // And the one it cannot carry: glTF's `alphaMode` runs to opaque, mask and source-over, and
    // the game's additive family is none of the three. Written out as source-over, a character's
    // eye glow — a faint cyan wisp *added* to an opaque head — becomes a solid slab across both
    // eyes, so the part is left out of the picture instead. What it contributes is light, and a
    // still render has none to contribute.
    #[test]
    fn leaves_out_a_part_glt_f_has_no_compositing_for() {
        let mut mesh = mesh(CLOAK, CLOAK_SKIN);
        let glow = crate::m2::Part {
            blend: Blend::Glow,
            ..mesh.parts[0].clone()
        };
        mesh.parts.push(glow);

        let glb = write(&[Piece::only(&mesh, &always(b"a picture"))]).unwrap();
        let scene = parse(&glb).json;
        assert_eq!(
            scene["meshes"][0]["primitives"].as_array().unwrap().len(),
            3
        );
        // And the three that are drawn are untouched: leaving one out is not renumbering.
        assert_eq!(scene["materials"].as_array().unwrap().len(), 3);
        assert_eq!(scene["materials"][1]["alphaCutoff"], 0.5);
    }

    // A scene of several pieces, which is what a dressed character is. Each gets a node with
    // its own mesh and its own translation, and — the reason they are pieces rather than one
    // welded vertex list — its own answer to the same paint. A shared picture callback would
    // paint the helm with the body's atlas, which is geometry that looks right and a picture
    // that is nonsense.
    #[test]
    fn puts_each_piece_in_a_node_of_its_own_with_its_own_pictures() {
        let body = mesh(CLOAK, CLOAK_SKIN);
        let hung = mesh(HELM, HELM_SKIN);
        let glb = write(&[
            Piece::only(&body, &always(b"the body")),
            Piece {
                mesh: &hung,
                at: [0.0, 4.0, -2.0],
                rotation: [0.0, 0.0, 0.5f32.sqrt(), 0.5f32.sqrt()],
                scale: [0.62, 0.62, 0.62],
                picture: &always(b"the helm"),
            },
        ])
        .unwrap();
        let Parsed { json, bin } = parse(&glb);

        assert_eq!(json["scenes"][0]["nodes"], serde_json::json!([0, 1]));
        // No translation at all on the piece that has none, so a model shown on its own still
        // writes the file it always did.
        assert_eq!(json["nodes"][0], serde_json::json!({ "mesh": 0 }));
        assert_eq!(json["nodes"][1]["mesh"], 1);
        assert_eq!(
            json["nodes"][1]["translation"],
            serde_json::json!([0.0, 4.0, -2.0])
        );
        // How it sits there as well as where, because a pauldron is worn smaller than it was
        // modelled and rolled outward, and both come off the body's own skeleton.
        assert_eq!(
            json["nodes"][1]["scale"],
            serde_json::json!([0.62, 0.62, 0.62])
        );
        let turned = json["nodes"][1]["rotation"].as_array().unwrap().clone();
        assert_eq!(turned[0], 0.0);
        assert!(
            (turned[2].as_f64().unwrap() - 0.5f64.sqrt()).abs() < 1e-6,
            "{turned:?}"
        );

        // Two meshes, two sets of vertices, and two pictures — one per piece rather than one
        // shared between them.
        assert_eq!(json["meshes"].as_array().unwrap().len(), 2);
        assert_eq!(json["images"].as_array().unwrap().len(), 2);
        let picture = |at: usize| {
            let view =
                &json["bufferViews"][json["images"][at]["bufferView"].as_u64().unwrap() as usize];
            let from = view["byteOffset"].as_u64().unwrap() as usize;
            bin[from..from + view["byteLength"].as_u64().unwrap() as usize].to_vec()
        };
        assert_eq!(picture(0), b"the body");
        assert_eq!(picture(1), b"the helm");
    }

    // A texture the install cannot show is not a reason to withhold the geometry: an
    // untextured helm still says what shape the helm is.
    #[test]
    fn writes_a_part_whose_picture_could_not_be_decoded() {
        let mesh = mesh(HELM, HELM_SKIN);
        let glb = write(&[Piece::only(&mesh, &|_| None)]).unwrap();
        let json = parse(&glb).json;
        assert_eq!(json["images"], Value::Null);
        assert_eq!(
            json["materials"][0]["pbrMetallicRoughness"]["baseColorTexture"],
            Value::Null
        );
        assert_eq!(json["meshes"][0]["primitives"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn says_so_when_there_is_nothing_to_draw() {
        let empty = Mesh {
            vertices: Vec::new(),
            parts: Vec::new(),
        };
        let error = write(&[Piece::only(&empty, &always(b""))]).unwrap_err();
        assert!(error.contains("no geometry"), "{error}");
        assert!(write(&[]).unwrap_err().contains("no geometry"));
    }
}
