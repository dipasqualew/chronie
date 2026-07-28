//! Prints every attachment a character's skeleton states, in the axes the viewer uses.
//!
//! The attachment ids are the community's, at <https://wowdev.wiki/M2#Attachments>, and this is
//! what holds them to account against a real body: 11 has to be at the top of the head, 5 and 6
//! a mirrored pair at shoulder height, and 1 and 2 a mirrored pair at the ends of the arms. An
//! id that lands somewhere else is an id this app should not be hanging anything off.
//!
//! ```sh
//! cargo run --example dump_attachments -- "/Applications/World of Warcraft"
//! cargo run --example dump_attachments -- "/Applications/World of Warcraft" 1000764
//! ```
//!
//! Pass `--fixtures <dir>` instead to read a directory of `<fdid>.m2` files.
//!
//! The `bone says` column is the other half of it, and the one that is easy to assume away: a
//! bone bound to a global sequence applies with nothing playing, which is where the game keeps
//! the fact that a pauldron is worn at 62% of the size it was modelled. Blank means the bone
//! says nothing and the thing hanging there is left where it was authored.

use chronie_desktop_lib::casc;
use chronie_desktop_lib::body;
use chronie_desktop_lib::m2::{self, Model};

/// What the community calls each of the attachments this app might hang something off.
fn named(id: u32) -> &'static str {
    match id {
        0 => "shield / mount main",
        1 => "hand right",
        2 => "hand left",
        3 => "elbow right",
        4 => "elbow left",
        5 => "shoulder right",
        6 => "shoulder left",
        11 => "helm",
        12 => "back",
        13 => "shoulder flap right",
        14 => "shoulder flap left",
        20 => "head",
        25 => "sheath main hand",
        26 => "sheath off hand",
        27 => "sheath shield",
        _ => "",
    }
}

fn main() {
    let mut args = std::env::args().skip(1);
    let first = args.next().unwrap_or_else(|| {
        eprintln!("usage: dump_attachments <wow install> | --fixtures <dir> [model fdid]");
        std::process::exit(2);
    });

    let files: Box<dyn casc::GameFiles> = if first == "--fixtures" {
        let dir = args.next().unwrap_or_else(|| {
            eprintln!("--fixtures needs a directory");
            std::process::exit(2);
        });
        Box::new(casc::DirFiles::new(dir))
    } else {
        match casc::CascFiles::open(std::path::Path::new(&first)) {
            Ok(storage) => Box::new(storage),
            Err(error) => {
                eprintln!("Could not open {first}: {error}");
                std::process::exit(1);
            }
        }
    };

    // A model FileDataID, or the body this app opens on — which is a read now rather than a
    // constant, because there is more than one body and each has a mesh of its own.
    let body = match args.next().and_then(|id| id.parse().ok()) {
        Some(model) => model,
        None => match body::of(files.as_ref(), body::DEFAULT) {
            Ok(body) => body.model,
            Err(error) => {
                eprintln!("Could not read the body to hang things off: {error}");
                std::process::exit(1);
            }
        },
    };
    let read = |fdid: u32| -> std::sync::Arc<Vec<u8>> {
        files.read(fdid).unwrap_or_else(|error| {
            eprintln!("Could not read {fdid}: {error}");
            std::process::exit(1);
        })
    };

    let model = Model::parse(&read(body)).unwrap_or_else(|error| {
        eprintln!("Could not read model {body}: {error}");
        std::process::exit(1);
    });
    let skeleton = model.skeleton_file_data_id().unwrap_or_else(|| {
        eprintln!("Model {body} names no skeleton, so nothing says where anything hangs.");
        std::process::exit(1);
    });
    println!("model {body}, skeleton {skeleton}");

    let attachments = m2::attachments(&read(skeleton)).unwrap_or_else(|error| {
        eprintln!("Could not read the skeleton: {error}");
        std::process::exit(1);
    });
    let mut attachments = attachments;
    attachments.sort_by_key(|attachment| attachment.id);
    println!("{} attachments\n", attachments.len());
    println!("  id  position (viewer axes)              bone says");
    for attachment in &attachments {
        let [x, y, z] = attachment.position;
        let says = match (attachment.rotation, attachment.scale) {
            ([0.0, 0.0, 0.0, 1.0], [1.0, 1.0, 1.0]) => String::new(),
            (rotation, scale) => format!("rotation {rotation:?} scale {scale:?}"),
        };
        println!(
            "  {:>3}  {x:>8.4} {y:>8.4} {z:>8.4}   {:<22} {says}",
            attachment.id,
            named(attachment.id)
        );
    }
}
