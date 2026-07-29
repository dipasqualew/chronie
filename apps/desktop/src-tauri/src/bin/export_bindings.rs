fn main() {
    let check = std::env::args().any(|argument| argument == "--check");
    if let Err(error) = chronie_desktop_lib::export_bindings(check) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
