//! WebAssembly entry point for rustyfi: compile a SATySFi document to PDF
//! bytes with no filesystem, no network, and no host runtime beyond `wasm32`.
//!
//! # `@require:` really resolves
//!
//! The interesting part is that this is not a cut-down pipeline. It runs the
//! same `rustyfi_loader::load` -> merge -> `rustyfi_lang::compile_document_*`
//! -> `rustyfi_pdf::render_pdf_with` sequence the CLI drives, over the real
//! bundled corpus — the frozen 0.0.6 standard library
//! (`lib-rustyfi/dist/packages/`) plus the licence-cleared third-party
//! packages of `layout-tests/corpus/`, both baked in by `build.rs`. A document
//! may `@require: stdjabook` or `@require: easytable/easytable` and get the
//! actual package, resolved through the loader's own candidate search and
//! dependency toposort.
//!
//! What makes that possible is [`rustyfi_loader::SourceProvider`]: the
//! loader's whole filesystem surface on the `@require:`/`@import:` path is
//! three operations, and [`EmbeddedCorpus`] serves all three out of a
//! `BTreeMap`. Paths are virtual ([`VIRTUAL_ROOT`]) but shaped exactly like a
//! real install, because the loader reads the shape: its per-file version
//! detector keys on a `dist/packages` path segment.
//!
//! # What a browser build cannot do
//!
//! - **Fonts.** Rendering uses `rustyfi_pdf::Base14Metrics`, the 14 standard
//!   PDF fonts, so no font file is embedded or fetched. Those fonts are
//!   WinAnsi Latin: **CJK text will not render**, which for a typesetter whose
//!   own manual is in Japanese is a real limitation, not a footnote. Embedding
//!   a CJK face would add megabytes to a page load, so the playground states
//!   the limit instead of paying that cost silently.
//! - **`load-image` / `load-pdf-image` / `read-file`** take filesystem paths
//!   and have nothing to read. `load-pdf-image` is compiled out entirely (the
//!   `pdf-image` feature is off — see `rustyfi-lang`'s `Cargo.toml`) and says
//!   so when called.
//! - **`@require:`ing anything outside the bundled corpus.** There is no
//!   package manager here; [`package_names`] is the exhaustive list.
//! - **0.1 (`saphe-split`) documents.** `LoadMode::Envelopes` reads its deps
//!   and envelope configs through `std::fs` directly, which is why
//!   `LoadOptions::sources` is refused there rather than half-applied. This
//!   entry point is 0.0.6 only.
//!
//! # ABI
//!
//! Plain C, not `wasm-bindgen`: nothing has to run at build time beyond
//! `cargo build --target wasm32-unknown-unknown`, the module imports no
//! `__wbindgen_*` glue a host would have to satisfy, and — since no
//! wasm-only dependency is involved — this crate is an ordinary workspace
//! member that host `cargo test` keeps honest. See [`rustyfi_compile`].

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use rustyfi_loader::{LoadOptions, SourceProvider};

include!(concat!(env!("OUT_DIR"), "/corpus.rs"));

/// The virtual library root the bundled corpus is served under.
///
/// Absolute and Unix-shaped so path joins behave predictably on any host the
/// unit tests run on. The `dist/packages` tail is load-bearing rather than
/// decorative: `rustyfi_loader`'s `resolve_require` searches
/// `<root>/dist/packages/<name>.{satyh,satyg}` first, and its per-file version
/// detector recognises the frozen 0.0.6 corpus by exactly those two
/// consecutive path components.
pub const VIRTUAL_ROOT: &str = "/rustyfi";

/// Where the user's own document is placed in the virtual tree.
///
/// Under its own directory rather than beside the corpus, so an `@import:` in
/// the entry — which resolves relative to the importing file's directory —
/// cannot accidentally pick up a bundled package and pass it off as a local
/// file.
const ENTRY_PATH: &str = "/rustyfi/doc/main.saty";

/// The bundled corpus plus the one document being compiled, as a read-only
/// filesystem.
///
/// Every path is absolute and unique by construction (they are all built by
/// joining onto [`VIRTUAL_ROOT`]), so canonicalization is LEXICAL — see
/// [`SourceProvider::canonicalize`] for why that is enough.
pub struct EmbeddedCorpus {
    files: BTreeMap<PathBuf, &'static str>,
    /// The entry document. Owned rather than `&'static` because it arrives at
    /// runtime, which is also why this is not simply a static map.
    entry: (PathBuf, String),
}

impl EmbeddedCorpus {
    /// The corpus, with `source` mounted as the entry document.
    pub fn new(source: &str) -> Self {
        let packages = Path::new(VIRTUAL_ROOT).join("dist").join("packages");
        EmbeddedCorpus {
            files: CORPUS
                .iter()
                .map(|(name, text)| {
                    // `build.rs` spells a nested package `easytable/matrix.satyg`
                    // because that is the `@require:` path; joining the whole
                    // string would keep the `/` verbatim on a host whose
                    // separator is `\`, and then never match what the loader
                    // builds component by component.
                    let path = name.split('/').fold(packages.clone(), |p, part| p.join(part));
                    (path, *text)
                })
                .collect(),
            entry: (PathBuf::from(ENTRY_PATH), source.to_string()),
        }
    }

    /// The path the entry document is mounted at — what to hand
    /// `rustyfi_loader::load`.
    pub fn entry_path(&self) -> &Path {
        &self.entry.0
    }

    fn get(&self, path: &Path) -> Option<&str> {
        let path = normalize(path);
        if path == self.entry.0 {
            return Some(&self.entry.1);
        }
        self.files.get(&path).copied()
    }
}

/// Resolve `.` and `..` textually.
///
/// A nested package `@import:`s its siblings by relative path — SlyDIFi's
/// themes say `@import: ../slydifi` — and the loader joins that onto the
/// importing file's directory without normalizing, so the candidate arrives
/// here as `.../class-slydifi/theme/../slydifi.satyh`. On a real filesystem
/// `canonicalize` would collapse that; this map has to do it itself, and can,
/// because the tree is entirely synthetic: every path is absolute, there are
/// no symlinks, and so no `..` can mean anything other than "drop the previous
/// component".
fn normalize(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

impl SourceProvider for EmbeddedCorpus {
    fn read(&self, path: &Path) -> std::io::Result<String> {
        self.get(path).map(str::to_string).ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("{} is not in the bundled corpus", path.display()),
            )
        })
    }

    fn is_file(&self, path: &Path) -> bool {
        self.get(path).is_some()
    }

    /// [`normalize`], for present paths only.
    ///
    /// Erroring on an absent path is what `std::fs::canonicalize` does, and
    /// the loader relies on it: a resolution candidate that does not exist
    /// must not become a graph node. Lexical normalization is a sound
    /// canonical form here because every path in this map was built by joining
    /// literal components onto [`VIRTUAL_ROOT`] — there are no symlinks and no
    /// duplicate spellings, so once `.` and `..` are folded away two headers
    /// naming the same file produce the same `PathBuf`. Returning the
    /// normalized form matters as well as accepting it: the loader keys its
    /// dependency graph on what comes back, and a package reached once
    /// directly and once through a `..` must be one node.
    fn canonicalize(&self, path: &Path) -> std::io::Result<PathBuf> {
        if self.is_file(path) {
            return Ok(normalize(path));
        }
        Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("{} is not in the bundled corpus", path.display()),
        ))
    }
}

/// The names a document may `@require:`, sorted — the bundled corpus with its
/// extensions stripped.
///
/// A nested package keeps its prefix, because that prefix is part of the name:
/// `easytable/easytable`, `base/typeset/base`.
pub fn package_names() -> Vec<&'static str> {
    let mut names: Vec<&'static str> = CORPUS
        .iter()
        .map(|(name, _)| {
            name.rsplit_once('.')
                .map(|(stem, _ext)| stem)
                .unwrap_or(name)
        })
        .collect();
    // One name, two candidate extensions: `base/__sub__/base-sub` exists as
    // both `.satyg` and `.satyh`, and a document spells it once either way.
    // `CORPUS` is sorted, so the pair is adjacent.
    names.dedup();
    names
}

/// Compile a 0.0.6 SATySFi document to PDF bytes with the base-14 fonts.
///
/// Latin only — see [`compile_with_font`] to typeset anything else.
pub fn compile(source: &str) -> Result<Vec<u8>, String> {
    compile_with_font(source, None)
}

/// Compile a 0.0.6 SATySFi document to PDF bytes.
///
/// The plain-Rust core: no `wasm32` assumption, no C ABI, so the host-target
/// tests below exercise exactly what the browser runs. Every failure — parse,
/// load, elaborate, typecheck, eval, render — comes back as the diagnostic
/// text the CLI would have printed, so the playground can show the real
/// message rather than "compilation failed".
///
/// `font` is an optional TrueType/OpenType file, used as the regular, bold and
/// oblique face alike. Without one, rendering uses the 14 standard PDF fonts,
/// which are WinAnsi Latin: the flagship `stdja`/`stdjabook` classes do not
/// even typeset their own page furniture under them (an em dash is enough to
/// stop it), and CJK is out of reach entirely. Supplying a font is therefore
/// not a refinement, it is what makes most real documents work — and doing it
/// from the caller's own file keeps a multi-megabyte face out of the page load.
pub fn compile_with_font(source: &str, font: Option<Vec<u8>>) -> Result<Vec<u8>, String> {
    let corpus = EmbeddedCorpus::new(source);
    let entry = corpus.entry_path().to_path_buf();

    let program = rustyfi_loader::load(
        &entry,
        &LoadOptions {
            lib_root: Some(PathBuf::from(VIRTUAL_ROOT)),
            sources: Some(Box::new(corpus)),
            ..Default::default()
        },
    )
    .map_err(|e| e.to_string())?;

    // The 0.0.6 flat-prelude merge, mirroring the CLI's own `merge_program`
    // (`crates/rustyfi/src/main.rs`). The cross-version and 0.1 arms it also
    // carries are unreachable here: the bundled corpus is 0.0.6 only, so no
    // file can come back as `LoadedCst::V0_1`.
    let (merged, stages) = merge_program(program)?;

    let store = font
        .map(|bytes| {
            rustyfi_pdf::TtfFontStore::from_bytes(bytes, None, None, "the uploaded font")
                .map_err(|e| e.to_string())
        })
        .transpose()?;
    let base14 = rustyfi_pdf::Base14Metrics;
    let metrics: &dyn rustyfi_backend::FontMetrics = match &store {
        Some(store) => store,
        None => &base14,
    };

    let mut aux = rustyfi_lang::crossref::AuxTable::new();
    let doc = rustyfi_lang::compile_document_cst_with_stages(&merged, metrics, &mut aux, &stages)
        .map_err(|e| e.to_string())?
        .0;

    match &store {
        // A real face means CID/TrueType embedding, which is also the only
        // path that can emit a glyph outside WinAnsi.
        Some(store) => rustyfi_pdf::render_pdf_ttf_with(
            &doc.geometry,
            &doc.pages,
            store,
            &doc.images,
            &doc.extras,
        ),
        None => rustyfi_pdf::render_pdf_with(&doc.geometry, &doc.pages, &doc.images, &doc.extras),
    }
    .map_err(|e| e.to_string())
}

/// Concatenate every library's prelude ahead of the entry's, recording the
/// `@stage:` each block was declared under.
///
/// A transcription of the CLI's `merge_program`, which is private to its
/// binary. The one difference is the `LoadedCst::V0_1` arm: the CLI can
/// `unreachable!()` there because it has already dispatched on the load's
/// version, whereas here it is an ordinary error — a bundled package that
/// sniffed as 0.1 would be a corpus bug, and trapping the whole wasm module
/// for it would tell the user nothing.
fn merge_program(
    program: rustyfi_loader::LoadedProgram,
) -> Result<
    (
        rustyfi_syntax::cst::File,
        std::collections::HashMap<usize, rustyfi_lang::types::Stage>,
    ),
    String,
> {
    fn as_v006(cst: rustyfi_loader::LoadedCst) -> Result<rustyfi_syntax::cst::File, String> {
        match cst {
            rustyfi_loader::LoadedCst::V0_0(file) => Ok(file),
            rustyfi_loader::LoadedCst::V0_1(_) => Err(
                "this playground compiles SATySFi 0.0.6 only, and a loaded file \
                 parsed as 0.1"
                    .to_string(),
            ),
        }
    }

    let mut files = program.files;
    let entry = files
        .pop()
        .ok_or_else(|| "the loader returned no files".to_string())?;
    let entry_cst = as_v006(entry.cst)?;

    let mut prelude = Vec::new();
    let mut stages = std::collections::HashMap::new();
    for lib in files {
        let cst = as_v006(lib.cst)?;
        let stage = rustyfi_lang::declared_stage(&cst);
        let start = prelude.len();
        prelude.extend(cst.prelude);
        if let Some(stage) = stage.filter(|s| *s != rustyfi_lang::types::Stage::default()) {
            stages.extend((start..prelude.len()).map(|i| (i, stage)));
        }
    }
    prelude.extend(entry_cst.prelude);

    Ok((
        rustyfi_syntax::cst::File {
            headers: Vec::new(),
            prelude,
            in_kw: entry_cst.in_kw,
            body: entry_cst.body,
            eoi: entry_cst.eoi,
        },
        stages,
    ))
}

// ---------------------------------------------------------------------------
// The C ABI.
//
// Ownership contract, in one place so the JS side can be read against it:
//
//   * `rustyfi_alloc(n)` hands out `n` bytes the CALLER owns. Write the UTF-8
//     source into them, pass them to `rustyfi_compile`, then release them with
//     `rustyfi_dealloc(ptr, n)` — `rustyfi_compile` borrows, it does not take.
//   * every function returning `*mut Output` transfers ownership to the
//     caller, who must release it with exactly one `rustyfi_output_free`.
//   * an `Output`'s bytes stay valid until that free, and not after.
// ---------------------------------------------------------------------------

/// A result handed across the ABI: PDF bytes when [`rustyfi_output_ok`] says
/// so, otherwise a UTF-8 diagnostic.
///
/// Opaque to the caller — its layout is never read from JS, only the four
/// accessors below — so it needs no `#[repr(C)]`.
pub struct Output {
    ok: bool,
    bytes: Vec<u8>,
}

/// Rewrite a diagnostic for someone typing into a textarea.
///
/// The typesetter's messages name real paths because it normally has a real
/// filesystem. Here there is none: [`VIRTUAL_ROOT`] and [`ENTRY_PATH`] are
/// inventions of this shim, so quoting them at a browser user names files that
/// exist nowhere and cannot be inspected. Two rewrites, both purely
/// presentational — the underlying error is unchanged:
///
/// * the entry path is dropped as a prefix, because there is only one document
///   and the reader is looking straight at it;
/// * a `@require:` failure's `searched:` list — ten virtual paths, one per
///   layout the loader tries — collapses to the fact that actually helps,
///   which is that the corpus is fixed and browsable via `rustyfi_packages`.
fn for_a_reader(message: &str) -> String {
    let message = message
        .strip_prefix(&format!("{ENTRY_PATH}: "))
        .unwrap_or(message);
    match message.split_once("; searched: ") {
        Some((head, _paths)) if head.contains("cannot resolve `@require:") => {
            format!(
                "{head} — the playground serves a fixed package set; \
                 see “Packages” in the header"
            )
        }
        _ => message.replace(VIRTUAL_ROOT, ""),
    }
}

impl Output {
    fn from_result(result: Result<Vec<u8>, String>) -> Self {
        match result {
            Ok(bytes) => Output { ok: true, bytes },
            Err(message) => Output {
                ok: false,
                bytes: for_a_reader(&message).into_bytes(),
            },
        }
    }

    fn into_raw(self) -> *mut Output {
        Box::into_raw(Box::new(self))
    }
}

/// Reserve `len` bytes in the module's memory for the caller to write into.
///
/// Returns null when `len` is 0 or the allocation fails, which the caller must
/// check — there is no other error channel.
///
/// # Safety
/// The returned pointer must be released with [`rustyfi_dealloc`] and the same
/// `len`, and must not be used afterwards.
#[no_mangle]
pub extern "C" fn rustyfi_alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return std::ptr::null_mut();
    }
    let mut buf = Vec::<u8>::new();
    if buf.try_reserve_exact(len).is_err() {
        return std::ptr::null_mut();
    }
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

/// Release a buffer from [`rustyfi_alloc`].
///
/// # Safety
/// `ptr` must have come from [`rustyfi_alloc`] with this exact `len`, and must
/// not have been freed already.
#[no_mangle]
pub unsafe extern "C" fn rustyfi_dealloc(ptr: *mut u8, len: usize) {
    if ptr.is_null() || len == 0 {
        return;
    }
    // Capacity is `len`, not more: `rustyfi_alloc` used `try_reserve_exact`.
    drop(unsafe { Vec::from_raw_parts(ptr, 0, len) });
}

/// Compile the UTF-8 document in `src[..len]`.
///
/// The returned [`Output`] carries PDF bytes on success and the compiler's own
/// diagnostic text on failure; interrogate it with [`rustyfi_output_ok`],
/// [`rustyfi_output_ptr`] and [`rustyfi_output_len`], then release it with
/// [`rustyfi_output_free`]. Invalid UTF-8 is reported through that same error
/// path rather than trapping.
///
/// # Safety
/// `src` must point to at least `len` readable bytes for the duration of the
/// call. A null `src` is only valid with `len == 0`.
#[no_mangle]
pub unsafe extern "C" fn rustyfi_compile(src: *const u8, len: usize) -> *mut Output {
    unsafe { rustyfi_compile_with_font(src, len, std::ptr::null(), 0) }
}

/// [`rustyfi_compile`], additionally taking a TrueType/OpenType file in
/// `font[..font_len]` to typeset with. A null `font` (or `font_len == 0`) means
/// the base-14 fonts, i.e. exactly [`rustyfi_compile`].
///
/// Both buffers are BORROWED for the call; the caller still owns and must
/// release them.
///
/// # Safety
/// `src` must point to `len` readable bytes and `font` to `font_len` readable
/// bytes for the duration of the call. Either may be null when its length is 0.
#[no_mangle]
pub unsafe extern "C" fn rustyfi_compile_with_font(
    src: *const u8,
    len: usize,
    font: *const u8,
    font_len: usize,
) -> *mut Output {
    let bytes: &[u8] = if src.is_null() || len == 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(src, len) }
    };
    let font: Option<Vec<u8>> = if font.is_null() || font_len == 0 {
        None
    } else {
        Some(unsafe { std::slice::from_raw_parts(font, font_len) }.to_vec())
    };
    let result = match std::str::from_utf8(bytes) {
        Ok(source) => compile_with_font(source, font),
        Err(e) => Err(format!("document source is not valid UTF-8: {e}")),
    };
    Output::from_result(result).into_raw()
}

/// The bundled package names, newline-separated, as a successful [`Output`] —
/// what a document may `@require:`.
#[no_mangle]
pub extern "C" fn rustyfi_packages() -> *mut Output {
    Output::from_result(Ok(package_names().join("\n").into_bytes())).into_raw()
}

/// This crate's version string, as a successful [`Output`].
#[no_mangle]
pub extern "C" fn rustyfi_version() -> *mut Output {
    Output::from_result(Ok(env!("CARGO_PKG_VERSION").as_bytes().to_vec())).into_raw()
}

/// `1` when the [`Output`] holds PDF bytes, `0` when it holds a diagnostic.
/// `0` for a null pointer, so a failed allocation reads as an error rather
/// than a success with no bytes.
///
/// # Safety
/// `out` must be null, or a live pointer from a function that returns
/// `*mut Output`.
#[no_mangle]
pub unsafe extern "C" fn rustyfi_output_ok(out: *const Output) -> u32 {
    match unsafe { out.as_ref() } {
        Some(output) => u32::from(output.ok),
        None => 0,
    }
}

/// The [`Output`]'s bytes. Valid until [`rustyfi_output_free`].
///
/// # Safety
/// As [`rustyfi_output_ok`].
#[no_mangle]
pub unsafe extern "C" fn rustyfi_output_ptr(out: *const Output) -> *const u8 {
    match unsafe { out.as_ref() } {
        Some(output) => output.bytes.as_ptr(),
        None => std::ptr::null(),
    }
}

/// The [`Output`]'s length in bytes.
///
/// # Safety
/// As [`rustyfi_output_ok`].
#[no_mangle]
pub unsafe extern "C" fn rustyfi_output_len(out: *const Output) -> usize {
    match unsafe { out.as_ref() } {
        Some(output) => output.bytes.len(),
        None => 0,
    }
}

/// Release an [`Output`]. A null pointer is a no-op.
///
/// # Safety
/// `out` must have come from a function returning `*mut Output` and must not
/// have been freed already.
#[no_mangle]
pub unsafe extern "C" fn rustyfi_output_free(out: *mut Output) {
    if out.is_null() {
        return;
    }
    drop(unsafe { Box::from_raw(out) });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Uses only `stdja-mini`, the smallest bundled document class.
    const HELLO: &str = "@require: stdja-mini\n\
                         document (|title = {t}; author = {a};|) '<\n  \
                           +p { Hello from the playground. }\n\
                         >\n";

    #[test]
    fn the_corpus_is_bundled_and_addressable() {
        let names = package_names();
        assert!(names.contains(&"stdja-mini"), "{names:?}");
        assert!(names.contains(&"stdjabook"), "{names:?}");
        // Extensions are stripped, so these are `@require:`-ready names.
        assert!(!names.iter().any(|n| n.contains('.')), "{names:?}");
    }

    #[test]
    fn a_require_resolves_out_of_memory() {
        // The whole point of the SourceProvider seam: no filesystem is
        // touched, and `@require: stdja-mini` still finds the real package.
        let corpus = EmbeddedCorpus::new(HELLO);
        let packages = Path::new(VIRTUAL_ROOT).join("dist").join("packages");
        assert!(corpus.is_file(&packages.join("stdja-mini.satyh")));
        assert!(corpus.is_file(corpus.entry_path()));
        assert!(!corpus.is_file(&packages.join("no-such-package.satyh")));
        // Canonicalization is identity for a present path, and an error for an
        // absent one — a candidate that does not exist must not become a node.
        assert_eq!(
            corpus
                .canonicalize(&packages.join("stdja-mini.satyh"))
                .unwrap(),
            packages.join("stdja-mini.satyh")
        );
        assert!(corpus.canonicalize(&packages.join("nope.satyh")).is_err());
    }

    #[test]
    fn a_document_requiring_a_bundled_package_renders() {
        let pdf = compile(HELLO).unwrap_or_else(|e| panic!("should compile: {e}"));
        assert!(
            pdf.starts_with(b"%PDF-"),
            "not a PDF: {:?}",
            &pdf[..8.min(pdf.len())]
        );
        assert!(
            pdf.len() > 500,
            "suspiciously small PDF: {} bytes",
            pdf.len()
        );
    }

    #[test]
    fn a_nested_package_keeps_its_prefix_and_mounts_under_it() {
        // A third-party package is published under a directory, and that
        // directory is part of the `@require:` name.
        let names = package_names();
        assert!(names.contains(&"easytable/easytable"), "{names:?}");
        assert!(names.contains(&"base/typeset/base"), "{names:?}");

        let corpus = EmbeddedCorpus::new("");
        let packages = Path::new(VIRTUAL_ROOT).join("dist").join("packages");
        assert!(corpus.is_file(&packages.join("easytable").join("easytable.satyh")));
        assert!(corpus.is_file(&packages.join("base").join("typeset").join("base.satyh")));
    }

    #[test]
    fn a_relative_import_out_of_a_subdirectory_resolves() {
        // SlyDIFi's themes `@import: ../slydifi`, and the loader hands that to
        // us with the `..` still in it — on a real filesystem `canonicalize`
        // would fold it away. Both the lookup AND the returned canonical form
        // matter: the loader keys its dependency graph on what comes back.
        let corpus = EmbeddedCorpus::new("");
        let unfolded = Path::new(VIRTUAL_ROOT)
            .join("dist/packages/class-slydifi/theme/../slydifi.satyh");
        let folded = Path::new(VIRTUAL_ROOT).join("dist/packages/class-slydifi/slydifi.satyh");
        assert!(corpus.is_file(&unfolded));
        assert_eq!(corpus.canonicalize(&unfolded).unwrap(), folded);
        assert_eq!(corpus.canonicalize(&folded).unwrap(), folded);
    }

    #[test]
    fn a_document_requiring_a_nested_third_party_package_renders() {
        let pdf = compile(
            "@require: stdja-mini\n\
             @require: easytable/easytable\n\
             open EasyTableAlias\n\
             document (|title = {t}; author = {a};|) '<\n  \
               +easytable[l; r]{| a | b || c | d |}\n\
             >\n",
        )
        .unwrap_or_else(|e| panic!("should compile: {e}"));
        assert!(pdf.starts_with(b"%PDF-"));
    }

    #[test]
    fn an_unresolvable_require_reports_the_name() {
        // The entry parses cleanly, so this fails in header RESOLUTION rather
        // than in the parser — which is the path being pinned.
        let err = compile(&HELLO.replace("stdja-mini", "no-such-package"))
            .expect_err("should not resolve");
        assert!(err.contains("no-such-package"), "{err}");
    }

    #[test]
    fn a_parse_error_comes_back_as_text_not_a_panic() {
        let err = compile("@require: stdja-mini\nthis is not a document").expect_err("bad syntax");
        assert!(!err.is_empty(), "an empty diagnostic helps nobody");
    }

    #[test]
    fn load_pdf_image_is_absent_from_this_build_and_says_so() {
        // Compiled out with the `pdf-image` feature; the name stays bound, so
        // this is a runtime message rather than "unbound".
        let err = compile(
            "@require: stdja-mini\n\
             let _ = load-pdf-image `x.pdf` 1 in\n\
             document (|title = {t}; author = {a};|) '< +p { x } >\n",
        )
        .expect_err("no PDF reader in this build");
        assert!(err.contains("load-pdf-image"), "{err}");
    }
}
