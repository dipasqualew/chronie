//! Handing one machine's history to another across the room.
//!
//! Chronie keeps everything it has ever collected in one SQLite file, and that file only
//! exists on the machine that did the collecting. Somebody who plays on a desktop and a
//! laptop has two halves of a history and no way to put them together; somebody whose disk
//! dies has nothing. This is the answer to both: the whole database, over the local network,
//! from one running Chronie to another.
//!
//! It replaces rather than merges, and says so at every step. Merging two histories that
//! both hold the same segments under different row ids is a genuinely hard problem, and
//! guessing at it quietly is worse than not doing it — so the receiving side is told exactly
//! what it is about to lose and what it is getting, and nothing moves until a person on that
//! machine says yes. What gets displaced is renamed aside rather than deleted, which is what
//! makes an accepted transfer recoverable from.
//!
//! ## The protocol
//!
//! Two sockets on one port, both spoken only while somebody is waiting for a database:
//!
//! * **UDP**, so a sender can find the receiver without anybody reading an IP address off a
//!   screen. A probe goes out to the broadcast address; a machine that is waiting answers
//!   with its name and the port it is listening on. A machine that is not waiting answers
//!   nothing, which is both the privacy rule and the useful one — the list a sender sees is
//!   exactly the machines ready to receive.
//! * **TCP**, for the transfer: one JSON line describing the database, one JSON line back
//!   carrying the person's answer, then the bytes, then one JSON line saying what became of
//!   them. Lines rather than a framed format because the whole conversation is three
//!   messages and a file, and a protocol somebody can read in a packet capture is a protocol
//!   somebody can debug.
//!
//! Nothing here is encrypted or authenticated, and it should not be mistaken for something
//! that is. What guards it is that the receiver must be waiting, must be shown who is
//! sending and what, and must agree — the same guard a file transfer between two phones in
//! the same room has.

use crate::collector::{self, Summary};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use specta::Type;
use std::{
    fs::File,
    io::{self, BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpListener, TcpStream, ToSocketAddrs, UdpSocket},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

/// Chronie's port, for both the discovery probe and the transfer. Unregistered and high
/// enough to bind without privileges; a machine that cannot have it falls back to whatever
/// the operating system offers and advertises that instead.
pub const PORT: u16 = 51571;

/// The version of the conversation below. A sender and a receiver that disagree say so at
/// the first line rather than halfway through a database.
const PROTOCOL: u32 = 1;

/// What a sender broadcasts to find receivers. Answered only by a machine that is waiting.
const PROBE: &[u8] = b"chronie-discover/1";

/// A database far larger than this is not one of ours, and reading it would be a stranger
/// filling the disk. Chronie's own file is a few megabytes after years of play.
const LARGEST_TRANSFER: u64 = 4 * 1024 * 1024 * 1024;

/// A single line of the conversation is a few hundred bytes. Anything approaching this is a
/// peer that will never send a newline, and reading it forever is the only other option.
const LONGEST_LINE: u64 = 16 * 1024;

/// How long a peer has to say the first thing, and how long an idle transfer may stall.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(20);
const TRANSFER_TIMEOUT: Duration = Duration::from_secs(120);

/// How long a sender waits with its offer on somebody else's screen. Long enough to walk to
/// the other machine, which is exactly what this feature expects a person to do.
const DECISION_TIMEOUT: Duration = Duration::from_secs(300);

/// How long a sender listens for answers to its broadcast.
const DISCOVERY_WAIT: Duration = Duration::from_millis(1200);

/// How often a blocked loop looks up to see whether it has been told to stop.
const POLL: Duration = Duration::from_millis(150);

/// What a sender says about the database it is offering, before sending any of it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Offer {
    pub protocol: u32,
    /// The sending machine, as it calls itself.
    pub device: String,
    pub segment_count: i64,
    pub character_count: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub newest_day: Option<String>,
    pub bytes: u64,
}

/// The receiving person's answer, which is the whole point of the exchange.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub accepted: bool,
    #[serde(default)]
    pub reason: String,
}

/// What became of the bytes, told to the sender so it can report something better than
/// "sent".
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub stored: bool,
    pub reason: String,
    pub segment_count: i64,
}

/// What a waiting machine answers a probe with.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Beacon {
    pub protocol: u32,
    pub device: String,
    pub port: u16,
}

/// A machine found waiting, as the window lists it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Peer {
    pub device: String,
    /// `host:port`, which is also what a person may type in by hand.
    pub address: String,
}

/// An offer sitting on this machine's screen, waiting for somebody to answer it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Waiting {
    pub offer: Offer,
    /// The address it arrived from, which is the only thing tying the name to a machine.
    pub from: String,
    /// True once it has been accepted and the bytes are on their way.
    pub receiving: bool,
}

/// The last thing that happened, kept after the connection has gone so the window can say so.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub stored: bool,
    pub message: String,
}

/// Everything the window draws the receiving half from, answered whole on every poll.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReceiveStatus {
    pub listening: bool,
    /// This machine, as a sender will see it named.
    pub device: String,
    /// Where a sender can reach it, for the case where the broadcast does not arrive.
    pub addresses: Vec<String>,
    /// The port it actually got, which is Chronie's own unless something else held it.
    pub port: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offer: Option<Waiting>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<Outcome>,
}

/* ---------- the wire ---------- */

fn write_line(stream: &mut impl Write, value: &impl Serialize) -> Result<(), String> {
    let mut line = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    line.push(b'\n');
    stream
        .write_all(&line)
        .and_then(|()| stream.flush())
        .map_err(|error| format!("The connection went away: {error}"))
}

/// Reads one JSON line, refusing a peer that sends an endless one.
fn read_line<T: DeserializeOwned>(reader: &mut impl BufRead, what: &str) -> Result<T, String> {
    let mut line = Vec::new();
    let read = reader
        .by_ref()
        .take(LONGEST_LINE)
        .read_until(b'\n', &mut line)
        .map_err(|error| format!("Could not read the {what}: {error}"))?;
    if read == 0 {
        return Err(format!(
            "The other Chronie closed before sending the {what}."
        ));
    }
    if !line.ends_with(b"\n") {
        return Err(format!("The {what} never ended."));
    }
    serde_json::from_slice(&line)
        .map_err(|_| format!("The {what} was not something Chronie sends."))
}

/// The rules an offer has to pass before a person is even shown it.
fn vet(offer: &Offer) -> Result<(), String> {
    if offer.protocol != PROTOCOL {
        return Err(format!(
            "That Chronie speaks version {} and this one speaks {PROTOCOL}. Update them both.",
            offer.protocol
        ));
    }
    if offer.bytes == 0 {
        return Err("That Chronie offered an empty database.".into());
    }
    if offer.bytes > LARGEST_TRANSFER {
        return Err("That database is far too large to be one of Chronie's.".into());
    }
    Ok(())
}

/* ---------- who this machine is, and where ---------- */

/// What this machine calls itself, which is all a person has to tell two of them apart.
///
/// The standard library cannot ask, so this takes the answer from wherever the platform
/// leaves it and falls back to something honest rather than inventing a name.
pub fn device_name() -> String {
    for variable in ["COMPUTERNAME", "HOSTNAME"] {
        if let Some(name) = std::env::var_os(variable) {
            let name = name.to_string_lossy().trim().to_string();
            if !name.is_empty() {
                return name;
            }
        }
    }
    if let Ok(output) = std::process::Command::new("hostname").output() {
        let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !name.is_empty() {
            return name;
        }
    }
    "This computer".to_string()
}

/// The addresses a sender on the same network could reach this machine at.
///
/// There is no way to enumerate interfaces from the standard library, so this asks the
/// routing table instead: a UDP socket that has been pointed at an address off this machine
/// knows which of its own addresses packets would leave from, and pointing one costs nothing
/// because a connected UDP socket sends no packets. Several targets, because a machine with
/// no route to the internet still has one to its own subnet.
pub fn local_addresses(port: u16) -> Vec<String> {
    local_ips()
        .into_iter()
        .map(|ip| format!("{ip}:{port}"))
        .collect()
}

fn local_ips() -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    for target in [
        "8.8.8.8:53",
        "192.168.1.1:53",
        "10.0.0.1:53",
        "172.16.0.1:53",
    ] {
        let Ok(socket) = UdpSocket::bind("0.0.0.0:0") else {
            continue;
        };
        if socket.connect(target).is_err() {
            continue;
        }
        let Ok(SocketAddr::V4(local)) = socket.local_addr() else {
            continue;
        };
        if local.ip().is_loopback() || local.ip().is_unspecified() {
            continue;
        }
        let ip = local.ip().to_string();
        if !found.contains(&ip) {
            found.push(ip);
        }
    }
    found
}

/* ---------- sending ---------- */

/// Reads `address` the way a person types it: a bare host means Chronie's own port.
fn resolve(address: &str) -> Result<SocketAddr, String> {
    let trimmed = address.trim();
    if trimmed.is_empty() {
        return Err("No address to send to.".into());
    }
    let with_port = if trimmed.contains(':') {
        trimmed.to_string()
    } else {
        format!("{trimmed}:{PORT}")
    };
    with_port
        .to_socket_addrs()
        .map_err(|error| format!("Chronie could not make sense of {trimmed}: {error}"))?
        .next()
        .ok_or_else(|| format!("Nothing answers to {trimmed}."))
}

/// Offers this machine's database to a Chronie waiting at `address`, and sends it if the
/// person there agrees.
///
/// The snapshot is taken before the connection is made, because its size is part of what the
/// other side is asked to agree to and because a database read halfway through a background
/// sync is not a database. It lives in `scratch_dir` for the length of the call and is
/// removed whichever way this ends. `database` is held only while the copy is being taken —
/// what follows is a wait on somebody in another room, and blocking the collector for the
/// length of that would be a strange thing to do to a game that is still being played.
pub fn send(
    database_path: &Path,
    scratch_dir: &Path,
    device: &str,
    address: &str,
    database: &Mutex<()>,
) -> Result<Receipt, String> {
    let destination = resolve(address)?;
    let outgoing = scratch_dir.join(".chronie-outgoing.sqlite3");
    let result = send_snapshot(database_path, &outgoing, device, destination, database);
    let _ = std::fs::remove_file(&outgoing);
    result
}

fn send_snapshot(
    database_path: &Path,
    outgoing: &Path,
    device: &str,
    destination: SocketAddr,
    database: &Mutex<()>,
) -> Result<Receipt, String> {
    {
        let _held = database.lock().map_err(|_| "Database lock failed.")?;
        collector::snapshot(database_path, outgoing)?;
    }
    let summary = collector::summarize(outgoing)?;
    let bytes = std::fs::metadata(outgoing)
        .map_err(|error| error.to_string())?
        .len();
    let offer = Offer {
        protocol: PROTOCOL,
        device: device.to_string(),
        segment_count: summary.segment_count,
        character_count: summary.character_count,
        newest_day: summary.newest_day,
        bytes,
    };

    let mut stream = TcpStream::connect_timeout(&destination, HANDSHAKE_TIMEOUT)
        .map_err(|error| format!("Chronie could not reach {destination}: {error}"))?;
    stream
        .set_write_timeout(Some(TRANSFER_TIMEOUT))
        .map_err(|error| error.to_string())?;
    // The offer sits on somebody else's screen until they answer it, so the read that waits
    // for their answer is the one read here that is allowed to take minutes.
    stream
        .set_read_timeout(Some(DECISION_TIMEOUT))
        .map_err(|error| error.to_string())?;
    let mut reader = BufReader::new(stream.try_clone().map_err(|error| error.to_string())?);

    write_line(&mut stream, &offer)?;
    let decision: Decision = read_line(&mut reader, "answer")?;
    if !decision.accepted {
        return Ok(Receipt {
            stored: false,
            reason: if decision.reason.is_empty() {
                format!("{} turned the database down.", offer.device)
            } else {
                decision.reason
            },
            segment_count: 0,
        });
    }

    let mut file = File::open(outgoing).map_err(|error| error.to_string())?;
    let sent = io::copy(&mut file, &mut stream)
        .map_err(|error| format!("The transfer stopped early: {error}"))?;
    if sent != bytes {
        return Err(format!(
            "Chronie sent {sent} bytes of a {bytes}-byte database."
        ));
    }
    stream.flush().map_err(|error| error.to_string())?;
    stream
        .set_read_timeout(Some(TRANSFER_TIMEOUT))
        .map_err(|error| error.to_string())?;
    read_line(&mut reader, "receipt")
}

/// Finds the Chronies on this network that are waiting for a database.
///
/// A broadcast rather than a scan: asking every address on a subnet in turn takes minutes and
/// looks like a port scan to anything watching, while one datagram to the broadcast address
/// reaches all of them at once. Only machines that are waiting answer, so the list is short
/// and every entry in it is actionable.
pub fn discover() -> Result<Vec<Peer>, String> {
    let socket = UdpSocket::bind("0.0.0.0:0")
        .map_err(|error| format!("Chronie could not open a socket to look with: {error}"))?;
    socket
        .set_broadcast(true)
        .map_err(|error| format!("This machine does not allow broadcasts: {error}"))?;
    socket
        .set_read_timeout(Some(POLL))
        .map_err(|error| error.to_string())?;
    socket
        .send_to(PROBE, ("255.255.255.255", PORT))
        .map_err(|error| format!("Chronie could not ask the network: {error}"))?;

    // A broadcast comes back to the machine that sent it, so a Chronie that is itself
    // waiting would otherwise find itself and offer to replace its own history.
    let mine = local_ips();
    let mut peers: Vec<Peer> = Vec::new();
    let deadline = Instant::now() + DISCOVERY_WAIT;
    let mut buffer = [0_u8; 2048];
    while Instant::now() < deadline {
        let Ok((read, from)) = socket.recv_from(&mut buffer) else {
            continue;
        };
        if mine.contains(&from.ip().to_string()) {
            continue;
        }
        let Ok(beacon) = serde_json::from_slice::<Beacon>(&buffer[..read]) else {
            continue;
        };
        if beacon.protocol != PROTOCOL {
            continue;
        }
        let address = format!("{}:{}", from.ip(), beacon.port);
        if peers.iter().any(|peer| peer.address == address) {
            continue;
        }
        peers.push(Peer {
            device: beacon.device,
            address,
        });
    }
    peers.sort_by(|left, right| left.device.cmp(&right.device));
    Ok(peers)
}

/* ---------- receiving ---------- */

#[derive(Default)]
struct Inbox {
    listening: bool,
    addresses: Vec<String>,
    port: u16,
    offer: Option<Waiting>,
    /// What the person answered, once they have. `None` while the offer is on screen.
    answer: Option<bool>,
    outcome: Option<Outcome>,
}

struct Shared {
    inbox: Mutex<Inbox>,
    /// Woken when an offer is answered, so the thread holding the connection open stops
    /// waiting the moment somebody clicks rather than at the end of its next nap.
    answered: Condvar,
    running: AtomicBool,
}

impl Shared {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Inbox>, String> {
        self.inbox.lock().map_err(|_| "Receive lock failed.".into())
    }

    fn finish(&self, outcome: Outcome) {
        if let Ok(mut inbox) = self.inbox.lock() {
            inbox.offer = None;
            inbox.answer = None;
            inbox.outcome = Some(outcome);
        }
    }
}

/// The half of this that waits: a listening socket, a beacon answering probes, and one
/// offer at a time held open until somebody on this machine answers it.
pub struct Station {
    shared: Arc<Shared>,
    database_path: PathBuf,
    data_dir: PathBuf,
    device: String,
    /// Held while the database is being replaced, so a background sync cannot be writing
    /// into the file that is about to be renamed out from under it.
    database: Arc<Mutex<()>>,
    threads: Mutex<Vec<JoinHandle<()>>>,
}

impl Station {
    pub fn new(
        database_path: PathBuf,
        data_dir: PathBuf,
        device: String,
        database: Arc<Mutex<()>>,
    ) -> Self {
        Self {
            shared: Arc::new(Shared {
                inbox: Mutex::new(Inbox::default()),
                answered: Condvar::new(),
                running: AtomicBool::new(false),
            }),
            database_path,
            data_dir,
            device,
            database,
            threads: Mutex::new(Vec::new()),
        }
    }

    /// Starts waiting, and says where. Restarting an already-running station is a no-op
    /// rather than an error: the window's button is the same button either way.
    ///
    /// The port is asked for and not insisted on. Another Chronie on the same machine, or
    /// anything else that got there first, would otherwise make this fail for a reason
    /// nobody can act on — so a taken port becomes whichever one the operating system
    /// offers, and the beacon carries it. The one thing that does fail is having no TCP
    /// socket at all, because then there is nothing to receive with. A missing beacon is
    /// survivable: the addresses below are what a sender types in when discovery is blocked,
    /// which on a network with client isolation it will be.
    pub fn start(&self) -> Result<ReceiveStatus, String> {
        self.start_on(PORT)
    }

    /// The above, on a port the caller names. Only the tests name one: they run alongside
    /// each other and cannot all have Chronie's.
    fn start_on(&self, wanted: u16) -> Result<ReceiveStatus, String> {
        if self.shared.running.load(Ordering::SeqCst) {
            return self.status();
        }
        let listener = TcpListener::bind(("0.0.0.0", wanted))
            .or_else(|_| TcpListener::bind(("0.0.0.0", 0)))
            .map_err(|error| format!("Chronie could not listen for a database: {error}"))?;
        let port = listener
            .local_addr()
            .map_err(|error| error.to_string())?
            .port();
        listener
            .set_nonblocking(true)
            .map_err(|error| error.to_string())?;
        // The beacon answers on whatever port the transfer got, so the two halves of a
        // station are always reachable as a pair.
        let beacon = UdpSocket::bind(("0.0.0.0", port)).ok();
        if let Some(socket) = &beacon {
            let _ = socket.set_read_timeout(Some(POLL));
        }

        self.shared.running.store(true, Ordering::SeqCst);
        {
            let mut inbox = self.shared.lock()?;
            inbox.listening = true;
            inbox.addresses = local_addresses(port);
            inbox.port = port;
            inbox.offer = None;
            inbox.answer = None;
            inbox.outcome = None;
        }

        let mut threads = self.threads.lock().map_err(|_| "Receive lock failed.")?;
        threads.push(self.spawn_accepting(listener));
        if let Some(socket) = beacon {
            threads.push(self.spawn_beacon(socket, port));
        }
        drop(threads);
        self.status()
    }

    fn spawn_accepting(&self, listener: TcpListener) -> JoinHandle<()> {
        let shared = Arc::clone(&self.shared);
        let database_path = self.database_path.clone();
        let data_dir = self.data_dir.clone();
        let database = Arc::clone(&self.database);
        thread::spawn(move || {
            while shared.running.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((stream, from)) => {
                        let _ = stream.set_nonblocking(false);
                        // Served on a thread of its own, because the one holding an offer
                        // open is waiting on a person and everything behind it in the queue
                        // would wait too — including the second sender that ought to be told
                        // straight away that this machine is busy.
                        let shared = Arc::clone(&shared);
                        let database_path = database_path.clone();
                        let data_dir = data_dir.clone();
                        let database = Arc::clone(&database);
                        thread::spawn(move || {
                            serve(
                                Desk {
                                    shared,
                                    database_path,
                                    data_dir,
                                    database,
                                },
                                stream,
                                from,
                            );
                        });
                    }
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => thread::sleep(POLL),
                    Err(_) => break,
                }
            }
        })
    }

    fn spawn_beacon(&self, socket: UdpSocket, port: u16) -> JoinHandle<()> {
        let shared = Arc::clone(&self.shared);
        let device = self.device.clone();
        thread::spawn(move || {
            let mut buffer = [0_u8; 512];
            while shared.running.load(Ordering::SeqCst) {
                let Ok((read, from)) = socket.recv_from(&mut buffer) else {
                    continue;
                };
                if &buffer[..read] != PROBE {
                    continue;
                }
                let beacon = Beacon {
                    protocol: PROTOCOL,
                    device: device.clone(),
                    port,
                };
                if let Ok(reply) = serde_json::to_vec(&beacon) {
                    let _ = socket.send_to(&reply, from);
                }
            }
        })
    }

    /// Stops waiting, and waits for the threads to notice.
    ///
    /// Joining rather than letting them wind down on their own, because the sockets they hold
    /// are the ones [`start`](Self::start) would want to bind again — a station that could be
    /// stopped and started twice in a second and fail the second time would be a button that
    /// works intermittently.
    pub fn stop(&self) -> Result<ReceiveStatus, String> {
        self.shared.running.store(false, Ordering::SeqCst);
        {
            let mut inbox = self.shared.lock()?;
            inbox.listening = false;
            // Anything mid-handshake is turned down rather than left hanging on a station
            // that is no longer there.
            inbox.answer = Some(false);
        }
        self.shared.answered.notify_all();
        let handles: Vec<JoinHandle<()>> = self
            .threads
            .lock()
            .map_err(|_| "Receive lock failed.")?
            .drain(..)
            .collect();
        for handle in handles {
            let _ = handle.join();
        }
        let mut inbox = self.shared.lock()?;
        inbox.offer = None;
        inbox.answer = None;
        inbox.addresses.clear();
        drop(inbox);
        self.status()
    }

    /// Answers the offer on the table. Anything else is a click on a stale screen.
    pub fn answer(&self, accepted: bool) -> Result<ReceiveStatus, String> {
        {
            let mut inbox = self.shared.lock()?;
            if inbox.offer.is_none() {
                return Err("There is no database waiting to be accepted.".into());
            }
            inbox.answer = Some(accepted);
            if let Some(offer) = inbox.offer.as_mut() {
                offer.receiving = accepted;
            }
        }
        self.shared.answered.notify_all();
        self.status()
    }

    pub fn status(&self) -> Result<ReceiveStatus, String> {
        let inbox = self.shared.lock()?;
        Ok(ReceiveStatus {
            listening: inbox.listening,
            device: self.device.clone(),
            addresses: inbox.addresses.clone(),
            port: inbox.port,
            offer: inbox.offer.clone(),
            outcome: inbox.outcome.clone(),
        })
    }
}

/// Handles one sender: read the offer, hold the line while somebody decides, take the bytes.
///
/// Nothing here is reported upwards, because there is nothing above a connection thread to
/// report to. What the window is told is what lands in the inbox — and only the connection
/// whose offer is the one on screen writes there, so a stranger's malformed line cannot
/// clear an offer somebody is in the middle of reading.
fn serve(desk: Desk, mut stream: TcpStream, from: SocketAddr) {
    let shared = &desk.shared;
    if stream.set_read_timeout(Some(HANDSHAKE_TIMEOUT)).is_err()
        || stream.set_write_timeout(Some(TRANSFER_TIMEOUT)).is_err()
    {
        return;
    }
    let Ok(mut reader) = stream.try_clone().map(BufReader::new) else {
        return refuse(&mut stream, "The connection could not be read.".into());
    };
    let offer: Offer = match read_line(&mut reader, "offer").and_then(|offer: Offer| {
        vet(&offer)?;
        Ok(offer)
    }) {
        Ok(offer) => offer,
        Err(reason) => return refuse(&mut stream, reason),
    };

    // One at a time. A second sender is turned away with a reason rather than queued behind
    // a decision that may take minutes.
    {
        let Ok(mut inbox) = shared.inbox.lock() else {
            return refuse(&mut stream, "This Chronie cannot receive right now.".into());
        };
        if !inbox.listening {
            return refuse(&mut stream, "That Chronie has stopped waiting.".into());
        }
        if inbox.offer.is_some() {
            return refuse(
                &mut stream,
                "That Chronie is already deciding on another database.".into(),
            );
        }
        inbox.offer = Some(Waiting {
            offer: offer.clone(),
            from: from.ip().to_string(),
            receiving: false,
        });
        inbox.answer = None;
        inbox.outcome = None;
    }
    // From here on this connection owns the offer on screen, and owes the inbox an outcome
    // however it ends.
    let outcome = decide_and_store(&desk, &mut stream, &mut reader, &offer);
    shared.finish(outcome);
}

/// What one connection needs to do its work: where to write, and what to hold while it does.
struct Desk {
    shared: Arc<Shared>,
    database_path: PathBuf,
    data_dir: PathBuf,
    database: Arc<Mutex<()>>,
}

/// Turns a sender away before its offer ever reaches somebody's screen.
fn refuse(stream: &mut TcpStream, reason: String) {
    let _ = write_line(
        stream,
        &Decision {
            accepted: false,
            reason,
        },
    );
}

fn decide_and_store(
    desk: &Desk,
    stream: &mut TcpStream,
    reader: &mut BufReader<TcpStream>,
    offer: &Offer,
) -> Outcome {
    let accepted = wait_for_answer(&desk.shared);
    let told = write_line(
        stream,
        &Decision {
            accepted,
            reason: if accepted {
                String::new()
            } else {
                "The database was turned down.".to_string()
            },
        },
    );
    if let Err(error) = told {
        return Outcome {
            stored: false,
            message: error,
        };
    }
    if !accepted {
        return Outcome {
            stored: false,
            message: format!("Turned down the database from {}.", offer.device),
        };
    }
    if stream.set_read_timeout(Some(TRANSFER_TIMEOUT)).is_err() {
        return Outcome {
            stored: false,
            message: "This Chronie could not settle in to read the database.".into(),
        };
    }

    // Nothing else may be writing to the database while it is being replaced — the
    // background sync runs on its own clock and would otherwise be doing exactly that.
    let stored = match desk.database.lock() {
        Ok(_held) => store(reader, &desk.database_path, &desk.data_dir, offer),
        Err(_) => Err("This Chronie could not get at its own database.".to_string()),
    };
    let receipt = match &stored {
        Ok(summary) => Receipt {
            stored: true,
            reason: String::new(),
            segment_count: summary.segment_count,
        },
        Err(error) => Receipt {
            stored: false,
            reason: error.clone(),
            segment_count: 0,
        },
    };
    let _ = write_line(stream, &receipt);
    match stored {
        Ok(summary) => Outcome {
            stored: true,
            message: format!(
                "Replaced this history with {}'s: {} segments across {} characters.",
                offer.device, summary.segment_count, summary.character_count
            ),
        },
        Err(error) => Outcome {
            stored: false,
            message: error,
        },
    }
}

/// Blocks the connection's thread until somebody answers, the station stops, or the offer
/// has been on screen long enough that nobody is coming.
fn wait_for_answer(shared: &Arc<Shared>) -> bool {
    let Ok(mut inbox) = shared.inbox.lock() else {
        return false;
    };
    let since = Instant::now();
    loop {
        if let Some(answer) = inbox.answer {
            return answer;
        }
        if !inbox.listening || since.elapsed() >= DECISION_TIMEOUT {
            return false;
        }
        let Ok((next, _)) = shared.answered.wait_timeout(inbox, POLL) else {
            return false;
        };
        inbox = next;
    }
}

/// Takes the bytes into a file beside the database and, if they turn out to be a database,
/// puts them in its place.
///
/// The landing file is a sibling of the real one so that putting it in place is a rename
/// within one filesystem — the only kind that is atomic, and the difference between a
/// history replaced and a history destroyed by a power cut.
fn store(
    reader: &mut impl BufRead,
    database_path: &Path,
    data_dir: &Path,
    offer: &Offer,
) -> Result<Summary, String> {
    std::fs::create_dir_all(data_dir).map_err(|error| error.to_string())?;
    let incoming = data_dir.join(".chronie-incoming.sqlite3");
    let result = receive_into(&incoming, reader, offer)
        .and_then(|()| collector::install_database(&incoming, database_path));
    let _ = std::fs::remove_file(&incoming);
    result
}

fn receive_into(incoming: &Path, reader: &mut impl BufRead, offer: &Offer) -> Result<(), String> {
    let mut file = File::create(incoming).map_err(|error| error.to_string())?;
    let read = io::copy(&mut reader.take(offer.bytes), &mut file)
        .map_err(|error| format!("The transfer stopped early: {error}"))?;
    file.flush().map_err(|error| error.to_string())?;
    drop(file);
    if read != offer.bytes {
        return Err(format!(
            "Only {read} of the {} bytes offered arrived.",
            offer.bytes
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use std::io::Cursor;

    /// A Chronie database holding one segment per name given, collected out of a synthetic
    /// SavedVariables file rather than written by hand.
    ///
    /// Through the collector on purpose: what travels here is whatever the collector
    /// produces, and a fixture assembled with its own INSERTs would keep passing after the
    /// schema it is imitating had moved on.
    fn database(directory: &Path, characters: &[&str]) -> PathBuf {
        let wow = directory.join("_retail_");
        let saved = wow.join("WTF/Account/TEST/SavedVariables");
        std::fs::create_dir_all(&saved).unwrap();
        let segments: Vec<String> = characters
            .iter()
            .enumerate()
            .map(|(index, character)| {
                let ended = 2_000_000_000_i64 + (index as i64) * 86_400;
                format!(
                    r#"{{ ["id"] = "segment-{index}", ["character"] = "{character}",
                          ["instance"] = "Ulduar", ["instanceType"] = "raid",
                          ["startedAt"] = {}, ["endedAt"] = {ended}, ["seconds"] = 600 }}"#,
                    ended - 600
                )
            })
            .collect();
        std::fs::write(
            saved.join("chronie.lua"),
            format!(
                r#"ChronieDB = {{ ["segments"] = {{ {} }} }}"#,
                segments.join(",\n")
            ),
        )
        .unwrap();
        let path = directory.join("chronie.sqlite3");
        collector::collect(&wow, &path, 2_000_000_000, collector::Options::default()).unwrap();
        path
    }

    fn segment_count(path: &Path) -> i64 {
        Connection::open(path)
            .unwrap()
            .query_row("SELECT COUNT(*) FROM segments", [], |row| row.get(0))
            .unwrap()
    }

    /// A station waiting on a port of its own, and the address a sender reaches it at.
    ///
    /// Port 0 rather than Chronie's: these tests run alongside each other, and a station is
    /// reached by the port it reports rather than the one it hoped for anyway.
    fn station(directory: &Path) -> (Station, PathBuf, String) {
        let database_path = database(directory, &["Aster-Vale"]);
        let station = Station::new(
            database_path.clone(),
            directory.to_path_buf(),
            "Laptop".to_string(),
            Arc::default(),
        );
        let status = station.start_on(0).unwrap();
        (station, database_path, format!("127.0.0.1:{}", status.port))
    }

    /// Waits for something the receiving threads do on their own time, so a test never
    /// depends on how fast a socket happens to be.
    fn until(mut ready: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if ready() {
                return true;
            }
            thread::sleep(Duration::from_millis(20));
        }
        false
    }

    #[test]
    fn a_line_that_never_ends_is_refused_rather_than_read_forever() {
        let endless = vec![b'x'; (LONGEST_LINE + 1024) as usize];
        let mut reader = Cursor::new(endless);

        let error = read_line::<Offer>(&mut reader, "offer").unwrap_err();

        assert!(error.contains("never ended"), "unhelpful error: {error}");
    }

    #[test]
    fn an_offer_is_read_back_exactly_as_it_was_written() {
        let offer = Offer {
            protocol: PROTOCOL,
            device: "Desktop".into(),
            segment_count: 12,
            character_count: 3,
            newest_day: Some("2026-07-26".into()),
            bytes: 4096,
        };
        let mut wire = Vec::new();

        write_line(&mut wire, &offer).unwrap();

        assert_eq!(read_line::<Offer>(&mut &wire[..], "offer").unwrap(), offer);
    }

    #[test]
    fn refuses_an_offer_this_build_cannot_honour() {
        let sound = Offer {
            protocol: PROTOCOL,
            device: "Desktop".into(),
            segment_count: 1,
            character_count: 1,
            newest_day: None,
            bytes: 4096,
        };
        assert!(vet(&sound).is_ok());
        for (offer, expected) in [
            (
                Offer {
                    protocol: 2,
                    ..sound.clone()
                },
                "version 2",
            ),
            (
                Offer {
                    bytes: 0,
                    ..sound.clone()
                },
                "empty",
            ),
            (
                Offer {
                    bytes: LARGEST_TRANSFER + 1,
                    ..sound.clone()
                },
                "too large",
            ),
        ] {
            let error = vet(&offer).unwrap_err();
            assert!(error.contains(expected), "unhelpful error: {error}");
        }
    }

    #[test]
    fn a_bare_host_means_chronies_own_port() {
        assert_eq!(resolve("127.0.0.1").unwrap().port(), PORT);
        assert_eq!(resolve("127.0.0.1:9000").unwrap().port(), 9000);
        assert!(resolve("  ").is_err());
    }

    #[test]
    fn an_accepted_database_replaces_the_receivers_and_keeps_the_old_one() {
        let temp = tempfile::tempdir().unwrap();
        let sending = temp.path().join("sender");
        let receiving = temp.path().join("receiver");
        std::fs::create_dir_all(&sending).unwrap();
        std::fs::create_dir_all(&receiving).unwrap();
        let (station, received_into, address) = station(&receiving);
        let mine = database(&sending, &["Brin-Hearth", "Brin-Hearth", "Aster-Vale"]);

        // The person on the receiving machine is not at the keyboard yet, so the send has to
        // be in flight while the offer sits there being looked at.
        let sender =
            thread::spawn(move || send(&mine, &sending, "Desktop", &address, &Mutex::default()));
        assert!(
            until(|| station.status().unwrap().offer.is_some()),
            "no offer arrived"
        );
        let waiting = station.status().unwrap().offer.unwrap();
        assert_eq!(waiting.offer.device, "Desktop");
        assert_eq!(waiting.offer.segment_count, 3);
        assert_eq!(waiting.offer.character_count, 2);
        assert!(waiting.offer.newest_day.is_some());

        station.answer(true).unwrap();
        let receipt = sender.join().unwrap().unwrap();

        assert!(receipt.stored, "{}", receipt.reason);
        assert_eq!(receipt.segment_count, 3);
        assert_eq!(segment_count(&received_into), 3);
        // The history it had is beside it rather than gone, which is what makes accepting
        // the wrong database survivable.
        let replaced = received_into.with_extension("replaced.sqlite3");
        assert_eq!(segment_count(&replaced), 1);
        assert!(until(|| station.status().unwrap().offer.is_none()));
        let outcome = station.status().unwrap().outcome.unwrap();
        assert!(outcome.stored);
        assert!(
            outcome.message.contains("3 segments"),
            "{}",
            outcome.message
        );
        station.stop().unwrap();
    }

    #[test]
    fn a_refused_database_leaves_the_receiver_exactly_as_it_was() {
        let temp = tempfile::tempdir().unwrap();
        let sending = temp.path().join("sender");
        let receiving = temp.path().join("receiver");
        std::fs::create_dir_all(&sending).unwrap();
        std::fs::create_dir_all(&receiving).unwrap();
        let (station, received_into, address) = station(&receiving);
        let mine = database(&sending, &["Brin-Hearth"]);

        let sender =
            thread::spawn(move || send(&mine, &sending, "Desktop", &address, &Mutex::default()));
        assert!(
            until(|| station.status().unwrap().offer.is_some()),
            "no offer arrived"
        );
        station.answer(false).unwrap();
        let receipt = sender.join().unwrap().unwrap();

        assert!(!receipt.stored);
        assert!(receipt.reason.contains("turned down"), "{}", receipt.reason);
        assert_eq!(segment_count(&received_into), 1);
        assert!(!received_into.with_extension("replaced.sqlite3").exists());
        station.stop().unwrap();
    }

    #[test]
    fn nothing_arrives_at_a_station_that_is_not_waiting() {
        let temp = tempfile::tempdir().unwrap();
        let receiving = temp.path().join("receiver");
        std::fs::create_dir_all(&receiving).unwrap();
        let (station, _, address) = station(&receiving);
        let stopped = station.stop().unwrap();
        assert!(!stopped.listening);
        assert!(stopped.addresses.is_empty());
        let port = address.rsplit(':').next().unwrap().parse().unwrap();

        let sending = temp.path().join("sender");
        std::fs::create_dir_all(&sending).unwrap();
        let mine = database(&sending, &["Brin-Hearth"]);

        let error = send(&mine, &sending, "Desktop", &address, &Mutex::default()).unwrap_err();

        assert!(
            error.contains("could not reach"),
            "unhelpful error: {error}"
        );
        // A station that has been stopped can be started again on the same socket, which a
        // thread left holding it would prevent.
        assert!(station.start_on(port).unwrap().listening);
        station.stop().unwrap();
    }

    #[test]
    fn a_second_sender_is_turned_away_while_a_decision_is_pending() {
        let temp = tempfile::tempdir().unwrap();
        let receiving = temp.path().join("receiver");
        std::fs::create_dir_all(&receiving).unwrap();
        let (station, received_into, address) = station(&receiving);
        let first_dir = temp.path().join("first");
        let second_dir = temp.path().join("second");
        std::fs::create_dir_all(&first_dir).unwrap();
        std::fs::create_dir_all(&second_dir).unwrap();
        let first = database(&first_dir, &["Brin-Hearth"]);
        let second = database(&second_dir, &["Aster-Vale"]);

        let held = {
            let address = address.clone();
            thread::spawn(move || send(&first, &first_dir, "Desktop", &address, &Mutex::default()))
        };
        assert!(
            until(|| station.status().unwrap().offer.is_some()),
            "no offer arrived"
        );

        let refused = send(&second, &second_dir, "Laptop", &address, &Mutex::default()).unwrap();

        assert!(!refused.stored);
        assert!(
            refused.reason.contains("already deciding"),
            "{}",
            refused.reason
        );
        station.answer(true).unwrap();
        assert!(held.join().unwrap().unwrap().stored);
        assert_eq!(segment_count(&received_into), 1);
        station.stop().unwrap();
    }

    #[test]
    fn a_database_that_is_not_one_is_refused_before_anything_is_replaced() {
        let temp = tempfile::tempdir().unwrap();
        let receiving = temp.path().join("receiver");
        std::fs::create_dir_all(&receiving).unwrap();
        let (station, received_into, address) = station(&receiving);
        let rubbish = vec![b'!'; 4096];

        let sender = {
            let address = address.clone();
            thread::spawn(move || -> Result<Receipt, String> {
                let destination = resolve(&address)?;
                let mut stream = TcpStream::connect(destination).map_err(|e| e.to_string())?;
                let mut reader =
                    BufReader::new(stream.try_clone().map_err(|error| error.to_string())?);
                write_line(
                    &mut stream,
                    &Offer {
                        protocol: PROTOCOL,
                        device: "Impostor".into(),
                        segment_count: 900,
                        character_count: 9,
                        newest_day: None,
                        bytes: rubbish.len() as u64,
                    },
                )?;
                let decision: Decision = read_line(&mut reader, "answer")?;
                assert!(decision.accepted);
                stream.write_all(&rubbish).map_err(|e| e.to_string())?;
                read_line(&mut reader, "receipt")
            })
        };
        assert!(
            until(|| station.status().unwrap().offer.is_some()),
            "no offer arrived"
        );
        station.answer(true).unwrap();
        let receipt = sender.join().unwrap().unwrap();

        assert!(!receipt.stored);
        assert!(
            receipt.reason.contains("not a Chronie database"),
            "{}",
            receipt.reason
        );
        assert_eq!(segment_count(&received_into), 1);
        assert!(!received_into.with_extension("replaced.sqlite3").exists());
        station.stop().unwrap();
    }

    #[test]
    fn a_probe_is_answered_only_while_the_station_waits() {
        // Probed over loopback rather than broadcast: what is under test is the beacon's rule
        // about when it answers, and a test that broadcasts would depend on the network the
        // machine running it happens to be on.
        let temp = tempfile::tempdir().unwrap();
        let receiving = temp.path().join("receiver");
        std::fs::create_dir_all(&receiving).unwrap();
        let database_path = database(&receiving, &["Aster-Vale"]);
        let station = Station::new(
            database_path,
            receiving.clone(),
            "Laptop".into(),
            Arc::default(),
        );
        let port = station.start_on(0).unwrap().port;

        let asking = UdpSocket::bind("127.0.0.1:0").unwrap();
        // Generous while an answer is expected, because a loaded runner is allowed to be slow;
        // short below, where the assertion is that nothing comes back at all and every
        // millisecond of the wait is spent proving a negative that a loopback datagram would
        // have settled immediately.
        asking
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut buffer = [0_u8; 512];
        asking.send_to(PROBE, ("127.0.0.1", port)).unwrap();
        let (read, _) = asking
            .recv_from(&mut buffer)
            .expect("a waiting station said nothing");
        let beacon: Beacon = serde_json::from_slice(&buffer[..read]).unwrap();
        assert_eq!(beacon.protocol, PROTOCOL);
        assert_eq!(beacon.device, "Laptop");
        // The port it answers with is the one a transfer has to be sent to, which is not
        // necessarily the one it was asked for.
        assert_eq!(beacon.port, port);

        asking
            .set_read_timeout(Some(Duration::from_millis(250)))
            .unwrap();

        // Something other than a probe is not an invitation to announce anything.
        asking
            .send_to(b"who is there?", ("127.0.0.1", port))
            .unwrap();
        assert!(
            asking.recv_from(&mut buffer).is_err(),
            "the beacon answered a stranger"
        );

        station.stop().unwrap();
        asking.send_to(PROBE, ("127.0.0.1", port)).unwrap();
        assert!(
            asking.recv_from(&mut buffer).is_err(),
            "a stopped station is still announcing itself"
        );
    }

    #[test]
    fn answering_nothing_is_an_error_rather_than_a_silent_no_op() {
        let temp = tempfile::tempdir().unwrap();
        let database_path = database(temp.path(), &["Aster-Vale"]);
        let station = Station::new(
            database_path,
            temp.path().to_path_buf(),
            "Laptop".into(),
            Arc::default(),
        );

        let error = station.answer(true).unwrap_err();

        assert!(
            error.contains("no database waiting"),
            "unhelpful error: {error}"
        );
    }
}
