//! Bakes the bundled package corpus into the binary as a
//! `(file name, contents)` table.
//!
//! Two source trees, both inside the `rustyfi/` SUBMODULE, so which packages
//! the playground offers is decided by the gitlink — bumping the submodule is
//! what ships a new or changed package:
//!
//! * `lib-rustyfi/dist/packages/`, the frozen SATySFi 0.0.6 standard library,
//!   published flat (`@require: stdjabook`);
//! * a hand-cleared subset of `layout-tests/corpus/`, the third-party packages
//!   the typesetter's own layout tests are built against, each published under
//!   the prefix Satyrographos gives it (`@require: easytable/easytable`).
//!
//! Generated rather than hand-listed so a file added to either tree is picked
//! up by the next build instead of silently missing from the playground. The
//! contents go through `include_str!`, so the files stay compile-time
//! constants and the build script itself does no I/O beyond listing
//! directories.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

/// A third-party package tree bundled out of `layout-tests/corpus/`, as
/// `(published prefix, directory under the corpus, licence file)`.
///
/// **This list is gated by licensing, not by usefulness.** These are
/// third-party packages vendored into the typesetter for layout testing, which
/// is a very different thing from redistributing them from a public website.
/// Every entry below has had its upstream licence established and its licence
/// text committed under `playground/licenses/`, and the build FAILS if that
/// text is missing — so a package cannot be added here without also clearing
/// it. Two corpus projects are deliberately absent: `fss` (its upstream repo
/// ships no licence text) and `gakushin` (same, and it depends on `fss`).
///
/// The prefix is the name Satyrographos publishes the package under, which is
/// what `@require:` spells and is NOT always the directory name: `slydifi` is
/// published as `class-slydifi`, and `satysfi-base` as `base`.
static CORPUS_PACKAGES: &[(&str, &str, &str)] = &[
    ("base", "satysfi-base/src", "LICENSE-base-MIT.txt"),
    ("class-slydifi", "slydifi/src", "LICENSE-slydifi-MIT.txt"),
    ("easytable", "easytable/src", "LICENSE-easytable-MIT.txt"),
    ("enumitem", "enumitem/src", "LICENSE-enumitem-MIT.txt"),
    ("figbox", "figbox/src", "LICENSE-figbox-MIT.txt"),
    (
        "latexcmds",
        "latexcmds/src",
        "LICENSE-latexcmds-LGPL-3.0.txt",
    ),
    ("railway", "railway/src", "LICENSE-railway-MIT.txt"),
    ("xpath", "xpath/xpath", "LICENSE-xpath-LGPL-3.0.txt"),
];

/// The two library extensions `@require:` resolves, in
/// `v006::resolve::CANDIDATE_EXTS`.
fn is_library(path: &Path) -> bool {
    path.is_file()
        && matches!(
            path.extension().and_then(|e| e.to_str()),
            Some("satyh" | "satyg")
        )
}

/// Collect every library file under `dir` into `out` as
/// `(name relative to dir, absolute path)`, recursing into subdirectories.
///
/// Names always use `/`, because they are `@require:` paths rather than host
/// paths — `base/typeset/base` is spelled that way in a document on every
/// platform.
fn collect(dir: &Path, prefix: &str, out: &mut Vec<(String, PathBuf)>) {
    // A file ADDED or REMOVED changes its directory's mtime; a file EDITED
    // changes only its own, hence a watch on every directory AND every file.
    println!("cargo:rerun-if-changed={}", dir.display());

    let entries = std::fs::read_dir(dir).unwrap_or_else(|e| {
        // Overwhelmingly the un-initialized submodule, which otherwise
        // surfaces as a bare ENOENT on a path the reader has never seen.
        panic!(
            "cannot read the bundled corpus at {}: {e}\n\
             (if `rustyfi/` is empty, run `git submodule update --init`)",
            dir.display()
        )
    });
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_else(|| panic!("corpus file name is not UTF-8: {}", path.display()))
            .to_string();
        let name = if prefix.is_empty() {
            name
        } else {
            format!("{prefix}/{name}")
        };
        if path.is_dir() {
            collect(&path, &name, out);
        } else if is_library(&path) {
            println!("cargo:rerun-if-changed={}", path.display());
            out.push((name, path));
        }
    }
}

fn main() {
    let manifest = std::env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR");
    let repo = Path::new(&manifest).join("..").join("..");
    let submodule = repo.join("rustyfi");

    let mut files = Vec::new();
    collect(
        &submodule.join("lib-rustyfi").join("dist").join("packages"),
        "",
        &mut files,
    );

    let corpus = submodule.join("layout-tests").join("corpus");
    let licenses = repo.join("playground").join("licenses");
    for (published, dir, license) in CORPUS_PACKAGES {
        // The licence text is not decoration: it is what makes redistributing
        // the package legal, and it is served beside the module. Refuse to
        // bake in a package whose licence would not travel with it.
        let license = licenses.join(license);
        println!("cargo:rerun-if-changed={}", license.display());
        assert!(
            license.is_file(),
            "`{published}` is bundled but {} is missing — every bundled \
             package must ship its upstream licence text",
            license.display()
        );
        collect(&corpus.join(dir), published, &mut files);
    }

    // Sorted so the generated table — and therefore the packages list the
    // playground shows — is deterministic rather than directory order.
    files.sort();
    let duplicate = files.windows(2).find(|w| w[0].0 == w[1].0);
    assert!(
        duplicate.is_none(),
        "two bundled files claim the same `@require:` name: {duplicate:?}"
    );

    let mut out = String::from(
        "/// Every bundled package file, as `(@require: path, source text)`, sorted\n\
         /// by name. Nested names use `/` on every platform.\n\
         pub(crate) static CORPUS: &[(&str, &str)] = &[\n",
    );
    for (name, path) in &files {
        let full = path
            .to_str()
            .unwrap_or_else(|| panic!("corpus path is not UTF-8: {}", path.display()));
        writeln!(out, "    ({name:?}, include_str!({full:?})),").expect("writing to a String");
    }
    out.push_str("];\n");

    let dest = Path::new(&std::env::var("OUT_DIR").expect("cargo sets OUT_DIR")).join("corpus.rs");
    std::fs::write(&dest, out).unwrap_or_else(|e| panic!("cannot write {}: {e}", dest.display()));
}
