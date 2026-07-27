//! Times the whole of "put this outfit on the character", a span at a time.
//!
//! `dump_model` answers *what* the pipeline draws. This answers *where the two seconds went*,
//! which is a question no picture and no wall clock around the whole run can settle: the work
//! is a dozen table parses, a hundred file reads out of CASC and a pile of image resizes, and
//! any of them could be all of it.
//!
//! It runs the same calls the window's `worn_set` command runs, against a real install, and
//! reports the spans underneath them. The default report is a self-time breakdown on stdout —
//! how long each kind of work took with its children subtracted, which is the only column that
//! adds up to the total. Set `OTEL_EXPORTER_OTLP_ENDPOINT` and the same spans also go to a
//! collector, so a run can be looked at as a flame graph rather than a table.
//!
//! ```sh
//! cargo run --release --example trace_render -- "/Applications/World of Warcraft" set/5570
//! cargo run --release --example trace_render -- --fixtures apps/desktop/fixtures/transmog \
//!     worn/900012/3 --runs 5
//! OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 cargo run --release \
//!     --example trace_render -- "/Applications/World of Warcraft" set/5570
//! ```
//!
//! **Release, always.** The image crate's resizes and flate2's inflate are ten to thirty times
//! slower without optimisation, and a debug profile does not measure the product — it measures
//! `cargo tauri dev`.
//!
//! Each run is timed separately and the runs are reported separately, because the first one and
//! the fifth are different questions: the first pays for the operating system's page cache being
//! cold on a 123GB install, and the ones after it are what a reader clicking through a wardrobe
//! actually waits for.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chronie_desktop_lib::{casc, character, transmog, worn};
use opentelemetry::trace::TracerProvider as _;
use opentelemetry::KeyValue;
use opentelemetry_sdk::trace::SdkTracerProvider;
use opentelemetry_sdk::Resource;
use tracing::span;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::registry::LookupSpan;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::Layer;

fn main() {
    let mut args = std::env::args().skip(1).collect::<Vec<String>>();
    let runs = take_number(&mut args, "--runs").unwrap_or(3);
    // The counterfactual: what a run costs when the storage is already open. Nothing in the
    // app does this today — `read_game_files` opens CASC per command — which is exactly why
    // it is worth being able to measure.
    let reuse = take_flag(&mut args, "--reuse");
    let mut args = args.into_iter();

    let first = args.next().unwrap_or_else(|| usage());
    let install = (first != "--fixtures").then(|| first.clone());
    let root = if install.is_some() { first } else { args.next().unwrap_or_else(|| usage()) };
    let what = args.next().unwrap_or_else(|| usage());

    let totals = Arc::new(Mutex::new(Totals::default()));
    let provider = otlp_provider();
    let subscriber = tracing_subscriber::registry().with(SelfTime::new(Arc::clone(&totals)));
    let _guard = match provider.as_ref() {
        Some(provider) => {
            let layer = tracing_opentelemetry::layer().with_tracer(provider.tracer("chronie"));
            subscriber.with(layer).set_default()
        }
        None => subscriber.set_default(),
    };

    let held = reuse.then(|| open(&install, &root));
    for run in 1..=runs {
        totals.lock().unwrap().clear();
        let started = Instant::now();

        // Opening the storage is inside the timed region on purpose when it is not reused: the
        // window's `read_game_files` opens it afresh for every command, so whatever it costs is
        // part of what a reader waits for.
        let opened_here = held.is_none().then(|| open(&install, &root));
        let files = held.as_ref().or(opened_here.as_ref()).expect("one of the two");

        let opened = started.elapsed();
        let drawn = match draw(files.as_ref(), &what) {
            Ok(bytes) => bytes,
            Err(error) => {
                eprintln!("Could not draw {what}: {error}");
                std::process::exit(1);
            }
        };
        let whole = started.elapsed();

        println!(
            "\n=== run {run}/{runs}  {what}  {whole:?} total, {opened:?} of it opening CASC, \
             {drawn} bytes of glb data url"
        );
        let totals = totals.lock().unwrap();
        report(&totals.self_time, whole);
        by_file(&totals.by_file);
        drop(totals);
    }

    if let Some(provider) = provider {
        let _ = provider.force_flush();
        let _ = provider.shutdown();
    }
}

/// The work one click makes, which is the two commands the window sends between them.
///
/// A reader opening a set gets `transmog_set_items` and then `worn_set`, and the second is the
/// one that draws — but both read the game's tables and both are inside the wait, so both are
/// inside the span.
fn draw(files: &dyn casc::GameFiles, what: &str) -> Result<usize, String> {
    let _held = span!(tracing::Level::INFO, "apply_transmog").entered();
    let pieces = match what.split('/').collect::<Vec<&str>>()[..] {
        ["set", set] => set_pieces(files, set.parse().map_err(|_| "not a set id")?)?,
        ["worn", display, slot] | ["worn", display, slot, _] => vec![worn::Piece {
            display_info_id: display.parse().map_err(|_| "not a display id")?,
            display_type: slot.parse().map_err(|_| "not a display type")?,
            inventory_type: what.split('/').nth(3).and_then(|it| it.parse().ok()).unwrap_or(0),
        }],
        ["character"] => Vec::new(),
        _ => return Err(format!("`{what}` is not something to draw")),
    };
    let payload = character::worn_set_of(files, &pieces)?;
    Ok(payload["model"].as_str().map_or(0, str::len))
}

/// The pieces of one set, the way `dump_model` reads them and the window sends them.
fn set_pieces(files: &dyn casc::GameFiles, set_id: u32) -> Result<Vec<worn::Piece>, String> {
    let payload = transmog::set_items(files, set_id)?;
    let appearances = payload["appearances"].as_array().ok_or("the set holds no appearances")?;
    Ok(appearances
        .iter()
        .filter_map(|appearance| {
            let number = |key: &str| appearance[key].as_u64().unwrap_or(0) as u32;
            let display_info_id = number("displayInfoId");
            (display_info_id != 0).then_some(worn::Piece {
                display_info_id,
                display_type: number("displayType"),
                inventory_type: number("inventoryType"),
            })
        })
        .collect())
}

/// What the whole run cost, by kind of work, with children subtracted.
///
/// Self time rather than wall time per span, because the spans nest four deep — a `casc.read`
/// contains a `casc.fetch` contains a `casc.blte`, and adding those up would count the same
/// microsecond three times. Sorted by cost, because the point of the table is the top of it.
fn report(self_time: &HashMap<&'static str, (Duration, u64)>, whole: Duration) {
    let mut rows: Vec<(&str, Duration, u64)> =
        self_time.iter().map(|(name, (took, count))| (*name, *took, *count)).collect();
    rows.sort_by_key(|(_, took, _)| std::cmp::Reverse(*took));

    println!("{:<24} {:>10} {:>7} {:>9}", "span", "self", "share", "calls");
    for (name, took, count) in rows.iter().filter(|(_, took, _)| took.as_micros() > 0) {
        let share = 100.0 * took.as_secs_f64() / whole.as_secs_f64();
        println!("{name:<24} {:>9.1?} {share:>6.1}% {count:>9}", took);
    }
    let counted: Duration = rows.iter().map(|(_, took, _)| *took).sum();
    println!(
        "{:<24} {:>9.1?} {:>6.1}%",
        "(uninstrumented)",
        whole.saturating_sub(counted),
        100.0 * whole.saturating_sub(counted).as_secs_f64() / whole.as_secs_f64(),
    );
}

/// A collector, when one is configured, and nothing when there is not.
///
/// The endpoint is read from `OTEL_EXPORTER_OTLP_ENDPOINT` the way every other OpenTelemetry
/// program reads it, so pointing this at a Jaeger or a collector is a variable rather than a
/// flag. Without one the run still measures everything — the table below is built by this
/// file's own layer and does not go through the SDK at all.
fn otlp_provider() -> Option<SdkTracerProvider> {
    std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT").ok()?;
    let exporter = opentelemetry_otlp::SpanExporter::builder()
        .with_http()
        .build()
        .map_err(|error| eprintln!("No OTLP exporter: {error}"))
        .ok()?;
    Some(
        SdkTracerProvider::builder()
            .with_simple_exporter(exporter)
            .with_resource(
                Resource::builder()
                    .with_attributes([KeyValue::new("service.name", "chronie-render")])
                    .build(),
            )
            .build(),
    )
}

/// How long each kind of span took with its children's time taken out of it.
#[derive(Default)]
struct Totals {
    self_time: HashMap<&'static str, (Duration, u64)>,
    /// The other cut of the same data: whole time per file the game was asked for. A `casc.read`
    /// is mostly its own BLTE inflate, and which *file* was inflated is what says whether the
    /// answer is a cache, a smaller read, or nothing.
    by_file: HashMap<u32, (Duration, u64)>,
}

impl Totals {
    fn clear(&mut self) {
        self.self_time.clear();
        self.by_file.clear();
    }
}

/// The files a run spent the longest reading, whole time rather than self.
fn by_file(files: &HashMap<u32, (Duration, u64)>) {
    let mut rows: Vec<(u32, Duration, u64)> =
        files.iter().map(|(fdid, (took, count))| (*fdid, *took, *count)).collect();
    rows.sort_by_key(|(_, took, _)| std::cmp::Reverse(*took));
    println!("\n{:<12} {:>10} {:>9}", "file", "read", "reads");
    for (fdid, took, count) in rows.iter().take(12) {
        println!("{fdid:<12} {:>9.1?} {count:>9}", took);
    }
}

/// Picks the `fdid` field off a `casc.read` span, which is the only field this reads.
#[derive(Default)]
struct Fdid(Option<u32>);

impl tracing::field::Visit for Fdid {
    fn record_u64(&mut self, field: &tracing::field::Field, value: u64) {
        if field.name() == "fdid" {
            self.0 = u32::try_from(value).ok();
        }
    }
    fn record_debug(&mut self, _: &tracing::field::Field, _: &dyn std::fmt::Debug) {}
}

/// The layer that measures. One clock reading on enter, one on exit, and a running subtraction
/// so that a parent is charged only for the time none of its children were running.
///
/// `tracing` gives a span's *own* enter and exit, and a child's enter arrives while the parent
/// is still open — so the parent's elapsed time includes the child's. Each frame therefore
/// carries what its children have already taken, and the parent subtracts it on the way out.
struct SelfTime {
    totals: Arc<Mutex<Totals>>,
    stack: Mutex<Vec<Frame>>,
}

struct Frame {
    id: span::Id,
    entered: Instant,
    children: Duration,
}

/// The file a `casc.read` span was opened for, kept in the span so its exit can find it.
struct ReadOf(u32);

impl SelfTime {
    fn new(totals: Arc<Mutex<Totals>>) -> Self {
        Self { totals, stack: Mutex::new(Vec::new()) }
    }
}

impl<S> Layer<S> for SelfTime
where
    S: tracing::Subscriber + for<'a> LookupSpan<'a>,
{
    fn on_new_span(
        &self,
        attributes: &span::Attributes<'_>,
        id: &span::Id,
        context: tracing_subscriber::layer::Context<'_, S>,
    ) {
        if attributes.metadata().name() != "casc.read" {
            return;
        }
        let mut fdid = Fdid::default();
        attributes.record(&mut fdid);
        if let (Some(fdid), Some(span)) = (fdid.0, context.span(id)) {
            span.extensions_mut().insert(ReadOf(fdid));
        }
    }

    fn on_enter(&self, id: &span::Id, _context: tracing_subscriber::layer::Context<'_, S>) {
        self.stack.lock().unwrap().push(Frame {
            id: id.clone(),
            entered: Instant::now(),
            children: Duration::ZERO,
        });
    }

    fn on_exit(&self, id: &span::Id, context: tracing_subscriber::layer::Context<'_, S>) {
        let mut stack = self.stack.lock().unwrap();
        // A span can be entered and left more than once; the frame to close is the innermost
        // one that belongs to this id.
        let Some(at) = stack.iter().rposition(|frame| frame.id == *id) else {
            return;
        };
        let frame = stack.remove(at);
        let whole = frame.entered.elapsed();
        if let Some(parent) = stack.last_mut() {
            parent.children += whole;
        }
        let Some(span) = context.span(id) else {
            return;
        };
        let mut totals = self.totals.lock().unwrap();
        let entry = totals.self_time.entry(span.name()).or_insert((Duration::ZERO, 0));
        entry.0 += whole.saturating_sub(frame.children);
        entry.1 += 1;
        let read_of = span.extensions().get::<ReadOf>().map(|ReadOf(fdid)| *fdid);
        if let Some(fdid) = read_of {
            let entry = totals.by_file.entry(fdid).or_insert((Duration::ZERO, 0));
            entry.0 += whole;
            entry.1 += 1;
        }
    }
}

/// The storage, out of an install or out of a directory of fixtures.
fn open(install: &Option<String>, root: &str) -> Box<dyn casc::GameFiles> {
    match install {
        Some(_) => match casc::CascFiles::open(std::path::Path::new(root)) {
            Ok(storage) => Box::new(storage),
            Err(error) => {
                eprintln!("Could not open {root}: {error}");
                std::process::exit(1);
            }
        },
        None => Box::new(casc::DirFiles::new(root)),
    }
}

fn take_flag(args: &mut Vec<String>, flag: &str) -> bool {
    match args.iter().position(|argument| argument == flag) {
        Some(at) => {
            args.remove(at);
            true
        }
        None => false,
    }
}

fn take_number(args: &mut Vec<String>, flag: &str) -> Option<usize> {
    let at = args.iter().position(|argument| argument == flag)?;
    let value = args.get(at + 1)?.parse().ok();
    args.drain(at..=at + 1);
    value
}

fn usage() -> ! {
    eprintln!(
        "usage: trace_render <wow install> | --fixtures <dir>  \
         set/<id> | worn/<display>/<slot> | character  [--runs N] [--reuse]"
    );
    std::process::exit(2)
}
