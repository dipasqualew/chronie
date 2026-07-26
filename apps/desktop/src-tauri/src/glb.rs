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

use std::collections::HashMap;

use gltf_json::validation::Checked::Valid;
use gltf_json::validation::USize64;
use serde_json::json;

use crate::m2::{Blend, Mesh, Paint};

/// The container's own numbers: the magic a `.glb` starts with, the version it declares, and
/// the two chunk kinds it holds.
const GLB_MAGIC: u32 = 0x4674_6c67;
const GLB_VERSION: u32 = 2;
const CHUNK_JSON: u32 = 0x4e4f_534a;
const CHUNK_BIN: u32 = 0x004e_4942;

/// A `.glb` for one mesh, with every texture it uses embedded in it.
///
/// `picture` answers with the PNG bytes for a paint, or nothing when this install cannot show
/// it — a texture the game withholds, or one in an encoding the decoder does not read. A part
/// whose picture is missing keeps its geometry and loses its colour, which is worth far more
/// than refusing to show the model at all.
pub fn write(mesh: &Mesh, picture: &dyn Fn(Paint) -> Option<Vec<u8>>) -> Result<Vec<u8>, String> {
    if mesh.vertices.is_empty() || mesh.parts.is_empty() {
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

    /* The vertices, as three lists the parts all share. */
    let positions: Vec<[f32; 3]> = mesh.vertices.iter().map(|vertex| vertex.position).collect();
    let normals: Vec<[f32; 3]> = mesh.vertices.iter().map(|vertex| vertex.normal).collect();
    let uvs: Vec<[f32; 2]> = mesh.vertices.iter().map(|vertex| vertex.uv).collect();

    let count = mesh.vertices.len();
    let position_view = bin.view(&mut root, floats(&positions), Some(ARRAY_BUFFER));
    let normal_view = bin.view(&mut root, floats(&normals), Some(ARRAY_BUFFER));
    let uv_view = bin.view(&mut root, floats(&uvs), Some(ARRAY_BUFFER));

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

    /* One primitive per part, each with the material and picture it asked for. */
    let sampler = root.push(gltf_json::texture::Sampler {
        // Item textures are authored small and shown large; nearest-neighbour would show the
        // reader the texels rather than the armour.
        mag_filter: Some(Valid(gltf_json::texture::MagFilter::Linear)),
        min_filter: Some(Valid(gltf_json::texture::MinFilter::LinearMipmapLinear)),
        wrap_s: Valid(gltf_json::texture::WrappingMode::Repeat),
        wrap_t: Valid(gltf_json::texture::WrappingMode::Repeat),
        ..Default::default()
    });

    let mut painted: HashMap<Paint, Option<gltf_json::Index<gltf_json::Texture>>> = HashMap::new();
    let mut primitives = Vec::with_capacity(mesh.parts.len());
    for part in &mesh.parts {
        let texture = match painted.get(&part.paint) {
            Some(known) => *known,
            None => {
                let made = picture(part.paint).map(|png| {
                    let view = bin.view(&mut root, png, None);
                    let image = root.push(gltf_json::Image {
                        buffer_view: Some(view),
                        mime_type: Some(gltf_json::image::MimeType("image/png".into())),
                        uri: None,
                        extensions: None,
                        extras: Default::default(),
                        name: None,
                    });
                    root.push(gltf_json::Texture {
                        sampler: Some(sampler),
                        source: image,
                        extensions: None,
                        extras: Default::default(),
                        name: None,
                    })
                });
                painted.insert(part.paint, made);
                made
            }
        };

        let indices = bin.view(
            &mut root,
            part.indices.iter().flat_map(|index| index.to_le_bytes()).collect(),
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
        name: None,
        weights: None,
    });
    let node = root.push(gltf_json::Node {
        mesh: Some(drawn),
        ..Default::default()
    });
    let scene = root.push(gltf_json::Scene {
        nodes: vec![node],
        extensions: None,
        extras: Default::default(),
        name: None,
    });
    root.scene = Some(scene);

    let bytes = bin.finish();
    root.buffers.push(gltf_json::Buffer {
        byte_length: USize64::from(bytes.len()),
        // No URI at all is what says "the binary chunk of this very file".
        uri: None,
        extensions: None,
        extras: Default::default(),
        name: None,
    });

    let json = root
        .to_string()
        .map_err(|error| format!("the model would not serialise: {error}"))?;
    Ok(container(json.into_bytes(), bytes))
}

/// The two `target` values a buffer view can declare, which tell a loader what the bytes are
/// for. glTF spells them as the OpenGL constants.
const ARRAY_BUFFER: gltf_json::buffer::Target = gltf_json::buffer::Target::ArrayBuffer;
const ELEMENT_ARRAY_BUFFER: gltf_json::buffer::Target = gltf_json::buffer::Target::ElementArrayBuffer;

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
        while self.bytes.len() % 4 != 0 {
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
            name: None,
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
        name: None,
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
    while json.len() % 4 != 0 {
        json.push(b' ');
    }
    while bin.len() % 4 != 0 {
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
        let glb = write(&mesh, &always(b"a picture")).unwrap();
        let Parsed { json, bin } = parse(&glb);

        assert_eq!(json["asset"]["version"], "2.0");
        assert_eq!(json["scene"], 0);
        assert_eq!(json["scenes"][0]["nodes"], serde_json::json!([0]));
        assert_eq!(json["nodes"][0]["mesh"], 0);
        assert_eq!(json["meshes"][0]["primitives"].as_array().unwrap().len(), 1);

        // The one buffer is the binary chunk itself, which is what "no uri" means.
        assert_eq!(json["buffers"].as_array().unwrap().len(), 1);
        assert_eq!(json["buffers"][0]["uri"], Value::Null);
        assert_eq!(json["buffers"][0]["byteLength"].as_u64().unwrap() as usize, bin.len());
    }

    // The positions have to arrive intact, in the axes the parser turned them into, and the
    // accessor has to say where they are. Reading them back out of the blob is the only thing
    // that says both together.
    #[test]
    fn puts_the_vertices_where_the_accessors_say_they_are() {
        let mesh = mesh(HELM, HELM_SKIN);
        let glb = write(&mesh, &always(b"a picture")).unwrap();
        let Parsed { json, bin } = parse(&glb);

        let accessor = &json["accessors"][0];
        assert_eq!(accessor["type"], "VEC3");
        assert_eq!(accessor["componentType"], 5126);
        assert_eq!(accessor["count"].as_u64().unwrap() as usize, mesh.vertices.len());

        let view = &json["bufferViews"][accessor["bufferView"].as_u64().unwrap() as usize];
        let at = view["byteOffset"].as_u64().unwrap() as usize;
        let read: Vec<[f32; 3]> = bin[at..at + mesh.vertices.len() * 12]
            .chunks_exact(12)
            .map(|chunk| {
                let number = |index: usize| {
                    f32::from_le_bytes(chunk[index * 4..index * 4 + 4].try_into().unwrap())
                };
                [number(0), number(1), number(2)]
            })
            .collect();
        let expected: Vec<[f32; 3]> = mesh.vertices.iter().map(|vertex| vertex.position).collect();
        assert_eq!(read, expected);
    }

    // Every viewer frames what it is about to show from the position accessor's bounds, and
    // glTF requires them for that reason. Without them a model opens somewhere off screen.
    #[test]
    fn states_the_box_the_model_occupies() {
        let glb = write(&mesh(HELM, HELM_SKIN), &always(b"a picture")).unwrap();
        let json = parse(&glb).json;
        assert_eq!(json["accessors"][0]["min"], serde_json::json!([-1.0, -1.0, -1.0]));
        assert_eq!(json["accessors"][0]["max"], serde_json::json!([1.0, 1.0, 1.0]));
    }

    // The picture travels inside the file, because the window has no origin to load one from.
    #[test]
    fn embeds_every_texture_in_the_file_itself() {
        let glb = write(&mesh(HELM, HELM_SKIN), &always(b"a picture")).unwrap();
        let Parsed { json, bin } = parse(&glb);
        assert_eq!(json["images"][0]["mimeType"], "image/png");
        assert_eq!(json["images"][0]["uri"], Value::Null);

        let view = &json["bufferViews"][json["images"][0]["bufferView"].as_u64().unwrap() as usize];
        let at = view["byteOffset"].as_u64().unwrap() as usize;
        let length = view["byteLength"].as_u64().unwrap() as usize;
        assert_eq!(&bin[at..at + length], b"a picture");
        assert_eq!(json["materials"][0]["pbrMetallicRoughness"]["baseColorTexture"]["index"], 0);
    }

    // Several parts of a model share one texture, and a BLP decoded twice costs more than
    // everything else here put together.
    #[test]
    fn decodes_a_texture_once_however_many_parts_want_it() {
        let mesh = mesh(CLOAK, CLOAK_SKIN);
        let asked = std::cell::RefCell::new(Vec::new());
        let glb = write(&mesh, &|paint| {
            asked.borrow_mut().push(paint);
            Some(b"a picture".to_vec())
        })
        .unwrap();

        assert_eq!(mesh.parts.len(), 3);
        assert_eq!(asked.into_inner(), vec![Paint::Item]);
        assert_eq!(parse(&glb).json["images"].as_array().unwrap().len(), 1);
    }

    // How a part is composited is the difference between a plume with holes in it and a plume
    // with a grey rectangle behind it, so the material has to carry it across.
    #[test]
    fn carries_each_part_s_blending_into_its_material() {
        let glb = write(&mesh(CLOAK, CLOAK_SKIN), &always(b"a picture")).unwrap();
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
        assert_eq!(modes, vec![("OPAQUE", false), ("MASK", true), ("BLEND", false)]);
        assert_eq!(materials[1]["alphaCutoff"], 0.5);
    }

    // A texture the install cannot show is not a reason to withhold the geometry: an
    // untextured helm still says what shape the helm is.
    #[test]
    fn writes_a_part_whose_picture_could_not_be_decoded() {
        let glb = write(&mesh(HELM, HELM_SKIN), &|_| None).unwrap();
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
        assert!(write(&empty, &always(b"")).unwrap_err().contains("no geometry"));
    }
}
