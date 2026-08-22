//! Bakes the bundled 0.0.6 package corpus into the binary as a
//! `(file name, contents)` table.
//!
//! Generated rather than hand-listed so a package added to
//! `rustyfi/lib-rustyfi/dist/packages/` is picked up by the next build instead
//! of silently missing from the playground.
//!
//! The corpus lives in the `rustyfi/` SUBMODULE, so which packages the
//! playground offers is decided by the gitlink — bumping the submodule is what
//! ships a new or changed package, and nothing here has to be edited for it.
//!
//! The contents go through `include_str!`, so the files stay compile-time
//! constants and the build script itself does no I/O beyond listing the
//! directory.

use std::fmt::Write as _;
use std::path::Path;

fn main() {
    let manifest = std::env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR");
    let corpus = Path::new(&manifest)
        .join("..")
        .join("..")
        .join("rustyfi")
        .join("lib-rustyfi")
        .join("dist")
        .join("packages");

    // A file ADDED or REMOVED changes the directory's mtime; a file EDITED
    // changes only its own, hence both kinds of watch below.
    println!("cargo:rerun-if-changed={}", corpus.display());

    let mut files: Vec<std::path::PathBuf> = std::fs::read_dir(&corpus)
        .unwrap_or_else(|e| {
            // Overwhelmingly the un-initialized submodule, which otherwise
            // surfaces as a bare ENOENT on a path the reader has never seen.
            panic!(
                "cannot read the bundled corpus at {}: {e}\n\
                 (if `rustyfi/` is empty, run `git submodule update --init`)",
                corpus.display()
            )
        })
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && matches!(
                    path.extension().and_then(|e| e.to_str()),
                    // The two library extensions `@require:` resolves, in
                    // `v006::resolve::CANDIDATE_EXTS`.
                    Some("satyh" | "satyg")
                )
        })
        .collect();
    // Sorted so the generated table — and therefore the packages list the
    // playground shows — is deterministic rather than directory order.
    files.sort();

    let mut out = String::from(
        "/// Every bundled package, as `(file name, source text)`, sorted by name.\n\
         pub(crate) static CORPUS: &[(&str, &str)] = &[\n",
    );
    for path in &files {
        println!("cargo:rerun-if-changed={}", path.display());
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_else(|| panic!("corpus file name is not UTF-8: {}", path.display()));
        let full = path
            .to_str()
            .unwrap_or_else(|| panic!("corpus path is not UTF-8: {}", path.display()));
        writeln!(out, "    ({name:?}, include_str!({full:?})),").expect("writing to a String");
    }
    out.push_str("];\n");

    let dest = Path::new(&std::env::var("OUT_DIR").expect("cargo sets OUT_DIR")).join("corpus.rs");
    std::fs::write(&dest, out).unwrap_or_else(|e| panic!("cannot write {}: {e}", dest.display()));
}
