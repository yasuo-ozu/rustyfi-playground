//! WebAssembly entry point for rustyfi: compile a SATySFi document to PDF
//! bytes with no filesystem, no network, and no host runtime beyond `wasm32`.
//!
//! # `@require:` really resolves
//!
//! The interesting part is that this is not a cut-down pipeline. It runs the
//! same `rustyfi_loader::load` -> merge -> `rustyfi_lang::compile_document_*`
//! -> `rustyfi_pdf::render_pdf_with` sequence the CLI drives, over the real
//! bundled 0.0.6 corpus (`lib-rustyfi/dist/packages/`, baked in by
//! `build.rs`). A document may `@require: stdjabook` and get the actual
//! package, resolved through the loader's own candidate search and dependency
//! toposort.
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
/// joining onto [`VIRTUAL_ROOT`]), so canonicalization is identity — see
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
                .map(|(name, text)| (packages.join(name), *text))
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
        if path == self.entry.0 {
            return Some(&self.entry.1);
        }
        self.files.get(path).copied()
    }
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

    /// Identity, for present paths only.
    ///
    /// Erroring on an absent path is what `std::fs::canonicalize` does, and
    /// the loader relies on it: a resolution candidate that does not exist
    /// must not become a graph node. Identity is a sound canonical form here
    /// because every path in this map was built by joining literal components
    /// onto [`VIRTUAL_ROOT`] — none contains `.`, `..`, a symlink, or a
    /// duplicate spelling, so two headers naming the same file already
    /// produce the same `PathBuf`.
    fn canonicalize(&self, path: &Path) -> std::io::Result<PathBuf> {
        if self.is_file(path) {
            return Ok(path.to_path_buf());
        }
        Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("{} is not in the bundled corpus", path.display()),
        ))
    }
}

/// The names a document may `@require:`, sorted — the bundled corpus with its
/// extensions stripped.
pub fn package_names() -> Vec<&'static str> {
    CORPUS
        .iter()
        .map(|(name, _)| {
            name.rsplit_once('.')
                .map(|(stem, _ext)| stem)
                .unwrap_or(name)
        })
        .collect()
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

impl Output {
    fn from_result(result: Result<Vec<u8>, String>) -> Self {
        match result {
            Ok(bytes) => Output { ok: true, bytes },
            Err(message) => Output {
                ok: false,
                bytes: message.into_bytes(),
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
