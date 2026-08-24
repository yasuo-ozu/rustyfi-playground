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
//! - **Fonts.** There is no filesystem, so there is no `fonts.satysfi-hash`
//!   to build a `rustyfi_pdf::FontRegistry` from: every face has to arrive as
//!   BYTES from the caller. With none, rendering falls back to
//!   `rustyfi_pdf::Base14Metrics`, the 14 standard PDF fonts, which are
//!   WinAnsi Latin. [`compile_with_fonts_lang`] takes a Latin face and a CJK
//!   face separately, and the second one is not a convenience: a document
//!   asks for a CJK face BY NAME — `stdja` writes `set-font HanIdeographic`
//!   with the abbrev `ipaexm` — and a store with no abbrev map resolves every
//!   such name onto the Latin face and typesets `.notdef` without failing.
//!   The playground fetches the CJK face only for documents that contain CJK,
//!   so the megabytes are paid by the pages that need them.
//! - **`load-image` / `load-pdf-image` / `read-file`** take filesystem paths
//!   and have nothing to read. `load-pdf-image` is compiled out entirely (the
//!   `pdf-image` feature is off — see `rustyfi-lang`'s `Cargo.toml`) and says
//!   so when called.
//! - **`@require:`ing anything outside the bundled corpus.** There is no
//!   package manager here; [`package_names_for`] over both generations is the
//!   exhaustive list.
//!
//! # Both generations, on one root
//!
//! [`EmbeddedCorpus`] mounts the 0.0.6 corpus under `dist/packages/` and the
//! 0.1 corpus under `dist-v01/packages/` **at the same time**, which is how a
//! real library root carries them. [`Lang`] therefore says which generation
//! the ENTRY is read as, not which tree exists.
//!
//! That is what makes CROSS-VERSION IMPORT reachable: a 0.1 document may
//! `@require:` a 0.0.6 package (and the reverse), because
//! `v006::resolve::resolve_require` searches the asking generation first and
//! falls back to the other. A name in both corpora still resolves to the
//! caller's own generation, so nothing is ambiguous — the fallback only ever
//! adds resolutions.
//!
//! Not every crossing is possible, and the refusals are loud rather than
//! silent: a package whose type text names a REPRESENTATION-forked builtin
//! (`page`, `font`) is refused with the reason. See the typesetter's own
//! `CLAUDE.md` for the full account, and the playground's last example for
//! what a refusal looks like.
//!
//! # ABI
//!
//! Plain C, not `wasm-bindgen`: nothing has to run at build time beyond
//! `cargo build --target wasm32-unknown-unknown`, the module imports no
//! `__wbindgen_*` glue a host would have to satisfy, and — since no
//! wasm-only dependency is involved — this crate is an ordinary workspace
//! member that host `cargo test` keeps honest. See [`rustyfi_compile`].
//!
//! # Editor diagnostics
//!
//! [`rustyfi_diagnostics`] answers "what is wrong with this document, and
//! where", as positioned JSON an editor can place. It is a separate entry
//! point from [`rustyfi_compile`] because it does strictly less work — no
//! rendering, no font — which is what makes it cheap enough to run on a pause
//! in typing.
//!
//! Two tiers stand behind it: `rustyfi_lsp::analyze`, the typesetter's own
//! language server's protocol-free half, which lexes and parses; and, only
//! when that is silent, the whole-program check below. See the
//! [`diagnostics`] module for why both are here — the short version is that
//! the LSP crate's own second tier resolves a dependency graph off a disk,
//! and [`EmbeddedCorpus`] is what a browser has instead.
//!
//! # Editor navigation
//!
//! [`interactive`] is the same trade one step further: hover, go to
//! definition, completion and the outline, out of `rustyfi_lsp`'s
//! cursor-driven half, with the names a *detached* buffer cannot resolve
//! looked up in the `@require:` graph that [`EmbeddedCorpus`] makes
//! resolvable. Its entry points are [`rustyfi_hover`],
//! [`rustyfi_definition`], [`rustyfi_completions`] and [`rustyfi_symbols`].

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use rustyfi_loader::{LoadOptions, SourceProvider};

pub mod diagnostics;
pub mod interactive;

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
/// Which SATySFi generation the ENTRY DOCUMENT is written in.
///
/// Not which corpus is available: both are mounted at once (see
/// [`EmbeddedCorpus::for_lang`]), so this chooses the grammar the entry is
/// parsed with and the generation its `@require:`s are searched for FIRST.
/// A dependency is read as its own generation regardless.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Lang {
    /// SATySFi 0.0.6, the default.
    #[default]
    V0_0,
    /// SATySFi 0.1 (`dev-0-1-0`).
    V0_1,
}

impl Lang {
    /// `0` is 0.0.6 and `1` is 0.1; anything else is 0.0.6, so a caller that
    /// passes rubbish gets the default rather than a trap.
    pub fn from_u32(v: u32) -> Self {
        if v == 1 {
            Lang::V0_1
        } else {
            Lang::V0_0
        }
    }

    fn to_version(self) -> rustyfi_syntax::RustyfiVersion {
        match self {
            Lang::V0_0 => rustyfi_syntax::RustyfiVersion::V0_0,
            Lang::V0_1 => rustyfi_syntax::RustyfiVersion::V0_1,
        }
    }
}

pub struct EmbeddedCorpus {
    files: BTreeMap<PathBuf, &'static str>,
    /// The entry document. Owned rather than `&'static` because it arrives at
    /// runtime, which is also why this is not simply a static map.
    entry: (PathBuf, String),
}

impl EmbeddedCorpus {
    /// The corpus, with `source` mounted as the entry document.
    pub fn new(source: &str) -> Self {
        Self::for_lang(source, Lang::V0_0)
    }

    /// The corpus, with `source` mounted as the entry document of generation
    /// `lang`.
    ///
    /// **Both generations are mounted, side by side, exactly as a real library
    /// root carries them** — the 0.0.6 corpus under `dist/packages/` and the
    /// 0.1 corpus under `dist-v01/packages/`. `lang` therefore does not select
    /// a tree; it selects the generation the ENTRY is read as, which the
    /// loader takes from [`LoadOptions::version`].
    ///
    /// This once mounted one tree only, on the reasoning that names like
    /// `itemize`, `list` and `code` exist in both with different APIs and a
    /// 0.1 document must not silently get the 0.0.6 one. That risk is real and
    /// it is already handled, one layer down and better:
    /// `v006::resolve::resolve_require` searches the load's OWN generation
    /// FIRST and the other only as a fallback, so a name present in both
    /// resolves to the caller's generation and a name present in neither still
    /// fails. Withholding the other tree did not add safety on top of that; it
    /// only removed the fallback — and that fallback IS the cross-version
    /// bridge, which is how a 0.1 document reaches a 0.0.6-only package like
    /// `easytable`. Doing it here also means resolution order stays the
    /// loader's one rule rather than becoming two that can disagree.
    ///
    /// Nothing is duplicated in the module: both tables are compiled in
    /// already, because the packages panel lists either generation's on demand.
    pub fn for_lang(source: &str, _lang: Lang) -> Self {
        let root = Path::new(VIRTUAL_ROOT);
        let mount = |dist: &str, table: &'static [(&'static str, &'static str)]| {
            let packages = root.join(dist).join("packages");
            table.iter().map(move |(name, text)| {
                // `build.rs` spells a nested package `easytable/matrix.satyg`
                // because that is the `@require:` path; joining the whole
                // string would keep the `/` verbatim on a host whose
                // separator is `\`, and then never match what the loader
                // builds component by component.
                let path = name.split('/').fold(packages.clone(), |p, part| p.join(part));
                (path, *text)
            })
        };
        EmbeddedCorpus {
            files: mount("dist", CORPUS)
                .chain(mount("dist-v01", CORPUS_V01))
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
    package_names_for(Lang::V0_0)
}

/// [`package_names`], for one generation.
///
/// What that generation PUBLISHES, which is what the page's packages panel
/// lists. It is not the whole set a document of that generation can reach:
/// both corpora are mounted, so a name absent here may still resolve through
/// the loader's cross-generation fallback — that is exactly how the
/// playground's cross-version examples work.
pub fn package_names_for(lang: Lang) -> Vec<&'static str> {
    let table = match lang {
        Lang::V0_0 => CORPUS,
        Lang::V0_1 => CORPUS_V01,
    };
    let mut names: Vec<&'static str> = table
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
    compile_with_font_lang(source, font, Lang::V0_0)
}

/// [`compile_with_font`], for a chosen generation.
pub fn compile_with_font_lang(
    source: &str,
    font: Option<Vec<u8>>,
    lang: Lang,
) -> Result<Vec<u8>, String> {
    compile_with_fonts_lang(source, font, None, None, lang)
}

/// The CJK abbrevs the bundled document classes actually ask for.
///
/// Read off `lib-rustyfi/dist/packages/` rather than assumed: `stdja`,
/// `stdjabook`, `stdjareport` and `mdja` all name exactly these two —
/// `ipaexm` (Mincho) in body text, `ipaexg` (Gothic) in section headings and
/// `\emph`. A browser build fetches ONE CJK face, so both names are
/// registered onto it; `TtfFontStore::from_bytes_with_abbrevs` dedups on the
/// bytes, so that is one copy in memory and one embedded font in the PDF.
///
/// The alternative — fetching both real faces — is 13.9 MB of font against a
/// page that otherwise weighs 8.8 MB, for a difference visible only in
/// section headings.
const CJK_ABBREVS: [&str; 2] = ["ipaexm", "ipaexg"];

/// The abbrev the math face is registered under. Matches the name the bundled
/// `default-font.satysfi-hash` uses, so a document that says
/// `set-math-font `lmmath`` resolves the same way here as it does under the
/// CLI.
const MATH_ABBREV: &str = "lmmath";

/// How an equation is written into HTML or Markdown, as a small integer over
/// the ABI — the same shape `lang` already uses, and for the same reason: the
/// boundary is C, so an enum crosses as a number.
///
/// `rustyfi_html::MathMode` deliberately has no `Default`, because the right
/// answer differs per FORMAT (the CLI decides it while parsing `--format`).
/// The two defaults are reproduced here rather than invented: outlines for
/// HTML, which reproduce the PDF exactly, and text for Markdown, which is
/// compact and readable.
fn math_mode(mode: u32, html: bool) -> rustyfi_html::MathMode {
    use rustyfi_html::MathMode as M;
    match mode {
        1 => M::SvgOutline,
        2 => M::SvgText,
        3 => M::Unicode,
        4 => M::Katex,
        // 0, and anything unrecognised: the format's own default. An unknown
        // value is a caller a version out of step, and the default is a better
        // answer for it than an error the page cannot act on.
        _ if html => M::SvgOutline,
        _ => M::SvgText,
    }
}

/// The size ratio the bundled `default-font.satysfi-hash` gives CJK, and the
/// figure upstream SATySFi's own configuration uses: an IPAex em box is drawn
/// to fill the full body, so it is set slightly smaller than the Latin face
/// beside it.
const CJK_RATIO: f64 = 0.88;

/// Build the metric provider a compile runs against.
///
/// `None` for both faces means base-14. A Latin face alone is
/// [`rustyfi_pdf::TtfFontStore::from_bytes`]'s three style slots, as before.
/// A CJK face additionally registers [`CJK_ABBREVS`], so a `set-font` naming
/// one resolves to it, AND sets it as the default for the two CJK scripts, so
/// a document that never calls `set-font` at all — `stdja-mini`, or no class —
/// still typesets Japanese.
///
/// A CJK face with no Latin face is accepted and makes the CJK face the Latin
/// one too. It is a strange thing to ask for, but refusing it would be worse:
/// IPAex covers Latin perfectly well, and the alternative is base-14, which
/// covers no CJK at all.
fn font_store(
    font: Option<Vec<u8>>,
    cjk: Option<Vec<u8>>,
    math: Option<Vec<u8>>,
) -> Result<Option<rustyfi_pdf::TtfFontStore>, String> {
    // A math face ALONE does not make a store: it is registered as an abbrev
    // beside the text faces, and with no text face there is nothing to set it
    // beside. Base-14 has no MATH table either, so this is base-14 as before.
    let (regular, cjk) = match (font, cjk) {
        (None, None) => return Ok(None),
        (Some(regular), cjk) => (regular, cjk),
        (None, Some(cjk)) => (cjk.clone(), Some(cjk)),
    };
    let mut named: Vec<(String, Vec<u8>)> = match &cjk {
        Some(bytes) => CJK_ABBREVS
            .iter()
            .map(|abbrev| ((*abbrev).to_string(), bytes.clone()))
            .collect(),
        None => Vec::new(),
    };
    if let Some(bytes) = &math {
        named.push((MATH_ABBREV.to_string(), bytes.clone()));
    }
    let store = rustyfi_pdf::TtfFontStore::from_bytes_with_abbrevs(
        regular,
        None,
        None,
        named,
        "the supplied font",
    )
    .map_err(|e| e.to_string())?;

    // The math face, if one was given. A store built from a FONT ROOT gets
    // this from `default-font.satysfi-hash`'s `"math"` abbrev; a byte-built
    // store has no hash file, so without this `Context::math_font` stays at
    // its seed — the LATIN face, which has no `MATH` table. Every constant
    // math layout reads then falls back to a guess and an equation collapses:
    // limits land on their operator, fraction bars vanish, nested fractions
    // flatten, fences stop stretching. It renders; it is simply wrong.
    let store = match store.abbrev_key(MATH_ABBREV) {
        Some(key) => store.with_math_default(key),
        None => store,
    };

    // Only when a CJK face was actually registered: `abbrev_key` would be
    // `None` otherwise, and pointing a script default at the Latin face is
    // what the base-14 path already does implicitly.
    let Some(key) = store.abbrev_key(CJK_ABBREVS[0]) else {
        return Ok(Some(store));
    };
    Ok(Some(
        store
            .with_script_default(rustyfi_backend::Script::HanIdeographic, key, CJK_RATIO, 0.0)
            .with_script_default(rustyfi_backend::Script::Kana, key, CJK_RATIO, 0.0),
    ))
}

/// [`compile_with_font_lang`], additionally taking a CJK face.
///
/// The two are separate arguments rather than a list because they are not
/// interchangeable: the Latin one fills the three STYLE slots
/// (`FontKey(0/1/2)`, what `set-font-key` and the base-14 convention address),
/// the CJK one is registered under the ABBREVS a document names. Handing the
/// same face to both is what a single-file upload does and is fine; handing a
/// Latin face as the CJK one would satisfy the name lookup and still draw
/// `.notdef`, which is the bug this argument exists to make impossible to
/// reach by accident.
pub fn compile_with_fonts_lang(
    source: &str,
    font: Option<Vec<u8>>,
    cjk: Option<Vec<u8>>,
    math: Option<Vec<u8>>,
    lang: Lang,
) -> Result<Vec<u8>, String> {
    let store = font_store(font, cjk, math)?;
    let base14 = rustyfi_pdf::Base14Metrics;
    let metrics: &dyn rustyfi_backend::FontMetrics = match &store {
        Some(store) => store,
        None => &base14,
    };

    let doc = build_document(source, metrics, lang)?;

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

/// Compile a document to a self-contained HTML page.
///
/// The same [`build_document`] the PDF path runs — only the serialization
/// differs, so this adds a writer to the module and not a second compiler.
///
/// A font still matters even though the reflowable backend NAMES faces rather
/// than embedding them: the family name is what tells the page which stack to
/// ask for, and it is also the only signal that separates a `+code` block from
/// a wrapped paragraph (a fixed-pitch face means the line breaks are the
/// author's and survive as `<br>`). Without a store every run falls back to
/// the document's default serif and code blocks read as prose.
pub fn compile_html_with_font_lang(
    source: &str,
    font: Option<Vec<u8>>,
    lang: Lang,
) -> Result<String, String> {
    compile_html_with_fonts_lang(source, font, None, None, 0, lang)
}

/// Markdown: the same recovered structure the reflowable HTML backend walks,
/// written as GitHub-flavoured Markdown.
///
/// Takes the same two faces for the same reason as
/// [`compile_html_with_fonts_lang`], and the store matters MORE here than the
/// name does: Markdown names no fonts at all, but the backend reads the
/// FAMILY name off the store to decide which runs are fixed-pitch, and a
/// fenced code block is the difference between a listing and a paragraph.
pub fn compile_markdown_with_fonts_lang(
    source: &str,
    font: Option<Vec<u8>>,
    cjk: Option<Vec<u8>>,
    math: Option<Vec<u8>>,
    math_mode_id: u32,
    lang: Lang,
) -> Result<String, String> {
    let store = font_store(font, cjk, math)?;
    let base14 = rustyfi_pdf::Base14Metrics;
    let metrics: &dyn rustyfi_backend::FontMetrics = match &store {
        Some(store) => store,
        None => &base14,
    };

    let doc = build_document(source, metrics, lang)?;

    match &store {
        Some(store) => rustyfi_html::render_markdown_ttf_with(
            doc.reflow_source.as_deref(),
            store,
            &doc.images,
            &doc.extras,
            &doc.reflow_links,
            &doc.reflow_dests,
            math_mode(math_mode_id, false),
        ),
        None => rustyfi_html::render_markdown(
            doc.reflow_source.as_deref(),
            &doc.images,
            &doc.extras,
            &doc.reflow_links,
            &doc.reflow_dests,
            math_mode(math_mode_id, false),
        ),
    }
    .map_err(|e| e.to_string())
}

/// [`compile_html_with_font_lang`], additionally taking a CJK face.
///
/// The reflowable backend NAMES faces rather than embedding them, so what a
/// CJK face buys here is the FAMILY NAME — `IPAexGothic` at the head of the
/// stack, ahead of the reader's own default serif, which is what makes a
/// Japanese run render as the document meant it rather than as whatever the
/// browser picks. Metrics matter too: layout still runs, and a run measured
/// against a Latin face that has no CJK glyph at all is measured against
/// `.notdef`.
pub fn compile_html_with_fonts_lang(
    source: &str,
    font: Option<Vec<u8>>,
    cjk: Option<Vec<u8>>,
    math: Option<Vec<u8>>,
    math_mode_id: u32,
    lang: Lang,
) -> Result<String, String> {
    let store = font_store(font, cjk, math)?;
    let base14 = rustyfi_pdf::Base14Metrics;
    let metrics: &dyn rustyfi_backend::FontMetrics = match &store {
        Some(store) => store,
        None => &base14,
    };

    let doc = build_document(source, metrics, lang)?;

    match &store {
        Some(store) => rustyfi_html::render_html_reflow_ttf_with_decos(
            doc.reflow_source.as_deref(),
            &doc.geometry,
            store,
            &doc.images,
            &doc.extras,
            &doc.reflow_links,
            &doc.reflow_dests,
            &doc.reflow_frame_decos,
            math_mode(math_mode_id, true),
        ),
        None => rustyfi_html::render_html_reflow_with_decos(
            doc.reflow_source.as_deref(),
            &doc.geometry,
            &doc.images,
            &doc.extras,
            &doc.reflow_links,
            &doc.reflow_dests,
            &doc.reflow_frame_decos,
            math_mode(math_mode_id, true),
        ),
    }
    .map_err(|e| e.to_string())
}

/// Everything up to and including layout: load `@require:`s out of the
/// bundled corpus, then run the generation's own compile entry point.
///
/// Split out of [`compile_with_font_lang`] so that [`check_lang`] can stop
/// here. The `Err` is the compiler's message VERBATIM — including the virtual
/// paths [`for_a_reader`] later strips — because those paths are what say
/// which file a reported position belongs to.
fn build_document(
    source: &str,
    metrics: &dyn rustyfi_backend::FontMetrics,
    lang: Lang,
) -> Result<std::rc::Rc<rustyfi_lang::value::DocumentValue>, String> {
    let corpus = EmbeddedCorpus::for_lang(source, lang);
    let entry = corpus.entry_path().to_path_buf();

    let program = rustyfi_loader::load(
        &entry,
        &LoadOptions {
            lib_root: Some(PathBuf::from(VIRTUAL_ROOT)),
            sources: Some(Box::new(corpus)),
            version: lang.to_version(),
            ..Default::default()
        },
    )
    .map_err(|e| e.to_string())?;

    let mut aux = rustyfi_lang::crossref::AuxTable::new();
    // The CLI's own dispatch, all three arms of it.
    //
    // 0.1 libraries are modules, not prelude-concatenable flat binding lists,
    // so they never go through `merge_program`; a 0.0.6 dependency spliced
    // into a 0.1 program arrives at `compile_document_v1_with_aux` as a
    // `LoadedCst::V0_0` and is handled there.
    //
    // The third arm is the reverse crossing — a 0.0.6 entry that reached a 0.1
    // package — and it is not hypothetical here now that both corpora are
    // mounted. `merge_program` cannot take it (its files are `FileV1`s, not
    // preludes), so the presence of one routes the whole load through the
    // cross-version entry point, exactly as `main.rs` does and only when such
    // a dependency is actually present, so a pure 0.0.6 load is unchanged.
    Ok(match lang {
        Lang::V0_1 => rustyfi_lang::compile_document_v1_with_aux(&program.files, metrics, &mut aux)
            .map_err(|e| e.to_string())?
            .0,
        Lang::V0_0
            if program
                .files
                .iter()
                .any(|f| matches!(f.cst, rustyfi_loader::LoadedCst::V0_1(_))) =>
        {
            rustyfi_lang::compile_document_v006_xver_with_aux(&program.files, metrics, &mut aux)
                .map_err(|e| e.to_string())?
                .0
        }
        Lang::V0_0 => {
            let (merged, stages) = merge_program(program)?;
            rustyfi_lang::compile_document_cst_with_stages(&merged, metrics, &mut aux, &stages)
                .map_err(|e| e.to_string())?
                .0
        }
    })
}

/// Compile `source` far enough to know whether it is correct, and throw the
/// document away.
///
/// What [`diagnostics::analyze`] runs. Two deliberate differences from
/// [`compile_with_font_lang`], both of which make this the right thing to run
/// on a pause in typing rather than on a button press:
///
/// * **no PDF is written.** Rendering is the only phase that can fail for a
///   reason that is not a mistake in the document — a glyph the chosen font
///   cannot encode — and an editor that underlines an em dash because the
///   base-14 fonts are Latin would be worse than no editor support at all.
/// * **no font is taken.** Layout needs metrics, so base-14's are used; a
///   supplied face would otherwise have to be copied across the ABI on every
///   keystroke pause, a megabyte at a time, to change nothing this reports.
///   Line breaking does differ between the two, but no *diagnostic* does.
pub fn check_lang(source: &str, lang: Lang) -> Result<(), String> {
    build_document(source, &rustyfi_pdf::Base14Metrics, lang).map(|_| ())
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

/// [`rustyfi_compile_with_font`], additionally choosing the SATySFi
/// generation: `lang == 1` is 0.1, anything else is 0.0.6.
///
/// # Safety
/// As [`rustyfi_compile_with_font`].
#[no_mangle]
pub unsafe extern "C" fn rustyfi_compile_with_font_lang(
    src: *const u8,
    len: usize,
    font: *const u8,
    font_len: usize,
    lang: u32,
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
        Ok(source) => compile_with_font_lang(source, font, Lang::from_u32(lang)),
        Err(e) => Err(format!("document source is not valid UTF-8: {e}")),
    };
    Output::from_result(result).into_raw()
}

/// [`rustyfi_compile_with_font_lang`], additionally taking a CJK face in
/// `cjk[..cjk_len]`.
///
/// Additive rather than a wider `rustyfi_compile_with_font_lang`: the older
/// entry point is a documented C ABI and still means what it meant, which is
/// "no CJK face" — and a caller that passes a Latin face here would get the
/// silent `.notdef` render this argument exists to prevent, so making the
/// distinction visible in the symbol name is worth one more export.
///
/// A null `cjk` (or `cjk_len == 0`) is exactly
/// [`rustyfi_compile_with_font_lang`].
///
/// # Safety
/// As [`rustyfi_compile_with_font`], for all three buffers.
#[no_mangle]
pub unsafe extern "C" fn rustyfi_compile_with_fonts_lang(
    src: *const u8,
    len: usize,
    font: *const u8,
    font_len: usize,
    cjk: *const u8,
    cjk_len: usize,
    math: *const u8,
    math_len: usize,
    lang: u32,
) -> *mut Output {
    let bytes: &[u8] = if src.is_null() || len == 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(src, len) }
    };
    let font = unsafe { borrowed_font(font, font_len) };
    let cjk = unsafe { borrowed_font(cjk, cjk_len) };
    let math = unsafe { borrowed_font(math, math_len) };
    let result = match std::str::from_utf8(bytes) {
        Ok(source) => compile_with_fonts_lang(source, font, cjk, math, Lang::from_u32(lang)),
        Err(e) => Err(format!("document source is not valid UTF-8: {e}")),
    };
    Output::from_result(result).into_raw()
}

/// Copy an optional borrowed font buffer out of the caller's memory.
///
/// # Safety
/// `ptr` must point to `len` readable bytes, or be null when `len` is 0.
unsafe fn borrowed_font(ptr: *const u8, len: usize) -> Option<Vec<u8>> {
    if ptr.is_null() || len == 0 {
        None
    } else {
        Some(unsafe { std::slice::from_raw_parts(ptr, len) }.to_vec())
    }
}

/// [`rustyfi_compile_with_font_lang`], but the successful [`Output`] carries
/// UTF-8 HTML instead of PDF bytes.
///
/// # Safety
/// As [`rustyfi_compile_with_font`].
#[no_mangle]
pub unsafe extern "C" fn rustyfi_compile_html(
    src: *const u8,
    len: usize,
    font: *const u8,
    font_len: usize,
    lang: u32,
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
        Ok(source) => compile_html_with_font_lang(source, font, Lang::from_u32(lang))
            .map(String::into_bytes),
        Err(e) => Err(format!("document source is not valid UTF-8: {e}")),
    };
    Output::from_result(result).into_raw()
}

/// [`rustyfi_compile_html`], additionally taking a CJK face — the HTML
/// counterpart of [`rustyfi_compile_with_fonts_lang`], and additive for the
/// same reason.
///
/// # Safety
/// As [`rustyfi_compile_with_font`], for all three buffers.
#[no_mangle]
pub unsafe extern "C" fn rustyfi_compile_html_fonts(
    src: *const u8,
    len: usize,
    font: *const u8,
    font_len: usize,
    cjk: *const u8,
    cjk_len: usize,
    math: *const u8,
    math_len: usize,
    math_mode_id: u32,
    lang: u32,
) -> *mut Output {
    let bytes: &[u8] = if src.is_null() || len == 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(src, len) }
    };
    let font = unsafe { borrowed_font(font, font_len) };
    let cjk = unsafe { borrowed_font(cjk, cjk_len) };
    let math = unsafe { borrowed_font(math, math_len) };
    let result = match std::str::from_utf8(bytes) {
        Ok(source) => compile_html_with_fonts_lang(source, font, cjk, math, math_mode_id, Lang::from_u32(lang))
            .map(String::into_bytes),
        Err(e) => Err(format!("document source is not valid UTF-8: {e}")),
    };
    Output::from_result(result).into_raw()
}

/// [`rustyfi_compile_html_fonts`]'s Markdown counterpart. Same arguments,
/// same ownership rules; the successful payload is UTF-8 Markdown.
///
/// # Safety
/// As [`rustyfi_compile_with_font`], for all three buffers.
#[no_mangle]
pub unsafe extern "C" fn rustyfi_compile_markdown_fonts(
    src: *const u8,
    len: usize,
    font: *const u8,
    font_len: usize,
    cjk: *const u8,
    cjk_len: usize,
    math: *const u8,
    math_len: usize,
    math_mode_id: u32,
    lang: u32,
) -> *mut Output {
    let bytes: &[u8] = if src.is_null() || len == 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(src, len) }
    };
    let font = unsafe { borrowed_font(font, font_len) };
    let cjk = unsafe { borrowed_font(cjk, cjk_len) };
    let math = unsafe { borrowed_font(math, math_len) };
    let result = match std::str::from_utf8(bytes) {
        Ok(source) => compile_markdown_with_fonts_lang(source, font, cjk, math, math_mode_id, Lang::from_u32(lang))
            .map(String::into_bytes),
        Err(e) => Err(format!("document source is not valid UTF-8: {e}")),
    };
    Output::from_result(result).into_raw()
}

/// Analyse the UTF-8 document in `src[..len]` and return its diagnostics as a
/// **JSON array**, in a successful [`Output`]:
///
/// ```json
/// [{"line":1,"character":8,"endLine":1,"endCharacter":22,
///   "severity":"error","message":"unbound variable 'nosuchvariable'"}]
/// ```
///
/// Positions are zero-based and columns count UTF-16 code units, so they can
/// be handed straight to a `textarea`'s `setSelectionRange`. A clean document
/// yields `[]`. `lang == 1` is 0.1, anything else 0.0.6 — analysing 0.1 source
/// under 0.0.6's grammar reports a parse error on its first 0.1-only
/// construct, which is correct but useless, so the caller must pass what the
/// user selected.
///
/// A FAILED [`Output`] means the analysis itself could not run (the source was
/// not UTF-8); it never means "the document has errors", which is a successful
/// `Output` carrying a non-empty array.
///
/// At most one diagnostic comes back, because both tiers behind
/// [`diagnostics::analyze`] stop at the first thing they cannot get past. The
/// array is the shape `rustyfi_lsp` chose so that adding error recovery would
/// not be a breaking change, and the page says as much under its problems
/// list.
///
/// # Safety
/// `src` must point to at least `len` readable bytes for the duration of the
/// call. A null `src` is only valid with `len == 0`.
#[no_mangle]
pub unsafe extern "C" fn rustyfi_diagnostics(src: *const u8, len: usize, lang: u32) -> *mut Output {
    let bytes: &[u8] = if src.is_null() || len == 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(src, len) }
    };
    match std::str::from_utf8(bytes) {
        Ok(source) => Output {
            ok: true,
            bytes: diagnostics::analyze_json(source, Lang::from_u32(lang)).into_bytes(),
        },
        Err(e) => Output::from_result(Err(format!("document source is not valid UTF-8: {e}"))),
    }
    .into_raw()
}

/// Read a borrowed UTF-8 buffer, or `None` when it is null, empty or not
/// UTF-8.
///
/// The four cursor entry points below all answer "nothing here" rather than
/// failing for a buffer they cannot read: they run unattended, on mouseover
/// and on keystrokes, and an error channel nobody checks is worse than a
/// silence the caller already has to handle.
///
/// # Safety
/// `src` must point to `len` readable bytes for the duration of the call.
unsafe fn borrow_str<'a>(src: *const u8, len: usize) -> Option<&'a str> {
    if src.is_null() || len == 0 {
        return None;
    }
    std::str::from_utf8(unsafe { std::slice::from_raw_parts(src, len) }).ok()
}

/// Describe what is at a cursor, as a JSON object — or the four bytes `null`.
///
/// ```json
/// {"line":3,"character":8,"endLine":3,"endCharacter":13,"markdown":"…"}
/// ```
///
/// The range is the word the answer is about, positioned exactly as
/// [`rustyfi_diagnostics`] positions a diagnostic: zero-based lines,
/// characters in UTF-16 code units. `line`/`character` in the REQUEST are in
/// those same units, so an editor hands over what it already has.
///
/// # Safety
/// `src` must point to at least `len` readable bytes for the duration of the
/// call. A null `src` is only valid with `len == 0`.
#[no_mangle]
pub unsafe extern "C" fn rustyfi_hover(
    src: *const u8,
    len: usize,
    lang: u32,
    line: u32,
    character: u32,
) -> *mut Output {
    let json = match unsafe { borrow_str(src, len) } {
        Some(source) => interactive::hover_json(source, Lang::from_u32(lang), line, character),
        None => "null".to_string(),
    };
    Output {
        ok: true,
        bytes: json.into_bytes(),
    }
    .into_raw()
}

/// Where the name at a cursor is defined, as JSON — see
/// [`interactive::definition_json`] for the three shapes.
///
/// # Safety
/// As [`rustyfi_hover`].
#[no_mangle]
pub unsafe extern "C" fn rustyfi_definition(
    src: *const u8,
    len: usize,
    lang: u32,
    line: u32,
    character: u32,
) -> *mut Output {
    let json = match unsafe { borrow_str(src, len) } {
        Some(source) => interactive::definition_json(source, Lang::from_u32(lang), line, character),
        None => "null".to_string(),
    };
    Output {
        ok: true,
        bytes: json.into_bytes(),
    }
    .into_raw()
}

/// Completion candidates for a cursor, as a JSON array. Empty is an ordinary
/// answer — see [`interactive::completions_json`].
///
/// # Safety
/// As [`rustyfi_hover`].
#[no_mangle]
pub unsafe extern "C" fn rustyfi_completions(
    src: *const u8,
    len: usize,
    lang: u32,
    line: u32,
    character: u32,
) -> *mut Output {
    let json = match unsafe { borrow_str(src, len) } {
        Some(source) => {
            interactive::completions_json(source, Lang::from_u32(lang), line, character)
        }
        None => "[]".to_string(),
    };
    Output {
        ok: true,
        bytes: json.into_bytes(),
    }
    .into_raw()
}

/// The document's outline, as a JSON array of nested nodes.
///
/// # Safety
/// As [`rustyfi_hover`].
#[no_mangle]
pub unsafe extern "C" fn rustyfi_symbols(src: *const u8, len: usize, lang: u32) -> *mut Output {
    let json = match unsafe { borrow_str(src, len) } {
        Some(source) => interactive::symbols_json(source, Lang::from_u32(lang)),
        None => "[]".to_string(),
    };
    Output {
        ok: true,
        bytes: json.into_bytes(),
    }
    .into_raw()
}

/// Build the document's `@require:` index and report what is in it, as JSON.
///
/// The page calls this on an idle callback so that the first hover does not
/// have to wait for the index — see [`interactive::index_json`].
///
/// # Safety
/// As [`rustyfi_hover`].
#[no_mangle]
pub unsafe extern "C" fn rustyfi_index(src: *const u8, len: usize, lang: u32) -> *mut Output {
    let json = match unsafe { borrow_str(src, len) } {
        Some(source) => interactive::index_json(source, Lang::from_u32(lang)),
        None => "{\"files\":0,\"names\":0,\"packages\":[],\"unresolved\":[]}".to_string(),
    };
    Output {
        ok: true,
        bytes: json.into_bytes(),
    }
    .into_raw()
}

/// The bundled package names for one generation, newline-separated.
///
/// `lang == 1` is 0.1, anything else 0.0.6.
#[no_mangle]
pub extern "C" fn rustyfi_packages_lang(lang: u32) -> *mut Output {
    let names = package_names_for(Lang::from_u32(lang));
    Output::from_result(Ok(names.join("\n").into_bytes())).into_raw()
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
    /// A 0.1 document `@require:`-ing a package that exists ONLY in the 0.0.6
    /// corpus.
    ///
    /// The check that makes this non-vacuous is the second assertion: if
    /// `table` also existed under `dist-v01/packages/`, the loader would hand
    /// a 0.1 document that one, nothing would cross, and this test would pass
    /// while proving nothing. That is the standing trap with cross-version
    /// tests, and it is why the name is asserted absent rather than assumed to
    /// be.
    #[test]
    fn a_v01_document_reaches_a_v006_only_package() {
        use super::*;
        assert!(package_names_for(Lang::V0_0).contains(&"table"));
        assert!(
            !package_names_for(Lang::V0_1).contains(&"table"),
            "`table` must be absent from the 0.1 corpus, or this test is vacuous"
        );
        let src = "@require: v01-mini\n@require: table\n\n\
                   let rows cs = [[cs#l({a}), cs#l({b})]] in\n\
                   let open V01Mini in\n\
                   document (| title = `x` |) '<\n  \
                     +p { \\tabular(rows)(fun xs ys -> []); }\n\
                   >\n";
        let pdf = compile_with_font_lang(src, None, Lang::V0_1)
            .unwrap_or_else(|e| panic!("a 0.0.6 package should cross into a 0.1 document: {e}"));
        assert!(pdf.starts_with(b"%PDF-"));
    }

    /// And the reverse, which needs `build_document`'s THIRD arm — a 0.0.6
    /// entry whose dependency graph contains a 0.1 file cannot go through
    /// `merge_program`, whose input is a prelude rather than a `FileV1`.
    #[test]
    fn a_v006_document_reaches_a_v01_only_package() {
        use super::*;
        assert!(
            package_names_for(Lang::V0_1).contains(&"int")
                && !package_names_for(Lang::V0_0).contains(&"int"),
            "`int` must be 0.1-only, or this test is vacuous"
        );
        let src = "@require: stdja-mini\n@require: int\n\
                   let n = Int.max 3 9 in\n\
                   let s = embed-string (arabic n) in\n\
                   document (|title = {t}; author = {a};|) '<\n  \
                     +p { The larger is #s; . }\n\
                   >\n";
        let pdf = compile_with_font_lang(src, None, Lang::V0_0)
            .unwrap_or_else(|e| panic!("a 0.1 package should cross into a 0.0.6 document: {e}"));
        assert!(pdf.starts_with(b"%PDF-"));
    }

    /// A crossing the bridge refuses says WHY, and names the type that forked.
    /// The playground ships an example whose whole content is that message.
    #[test]
    fn an_unbridgeable_crossing_is_refused_with_its_reason() {
        use super::*;
        let src = "@require: stdjabook\n\
                   document (| title = {t}, author = {a}, show-title = true, show-toc = false |) '<\n  \
                     +p { x }\n\
                   >\n";
        let err = compile_with_font_lang(src, None, Lang::V0_1)
            .expect_err("`page` is a representation fork and cannot cross");
        assert!(err.contains("cross-version import"), "{err}");
        assert!(err.contains("`page`"), "{err}");
    }

    /// Mounting both corpora must not change which package a document of
    /// either generation gets for a name that exists in BOTH. The loader
    /// searches the asking generation first; this pins that the playground
    /// still relies on it rather than on only one tree being present.
    #[test]
    fn a_shared_name_still_resolves_to_the_asking_generation() {
        use super::*;
        assert!(
            package_names_for(Lang::V0_0).contains(&"itemize")
                && package_names_for(Lang::V0_1).contains(&"itemize"),
            "the fixture name must exist in both corpora"
        );
        // 0.1's `Itemize.listing` takes `?(break = ..)`; 0.0.6's `itemize` has
        // no such member at all, so getting the wrong one fails here.
        let v01 = "@require: v01-mini\n@require: itemize\n\nlet open V01Mini in\n\
                   document (| title = `x` |) '<\n  \
                     +Itemize.listing?(break = true)(Item({}, [Item({a}, [])]));\n\
                   >\n";
        assert!(compile_with_font_lang(v01, None, Lang::V0_1).is_ok());
        // …and 0.0.6's own `+listing`, which the 0.1 package does not provide.
        let v006 = "@require: stdja-mini\n@require: itemize\n\
                    document (|title = {t}; author = {a};|) '<\n  \
                      +listing{ * a\n * b }\n\
                    >\n";
        assert!(compile_with_font_lang(v006, None, Lang::V0_0).is_ok());
    }

    /// The 0.1 corpus is mounted and compiles. Without this the `Lang` switch
    /// is untested plumbing: the 0.0.6 path would keep passing while selecting
    /// 0.1 failed for everyone.
    #[test]
    fn a_v01_document_compiles_against_the_bundled_v01_corpus() {
        let src = "@require: v01-mini\n\nlet open V01Mini in\ndocument (| title = `v01` |) '<\n  +p { Hello from 0.1. }\n>\n";
        let pdf = compile_with_font_lang(src, None, Lang::V0_1)
            .unwrap_or_else(|e| panic!("a 0.1 document should compile: {e}"));
        assert!(pdf.starts_with(b"%PDF-"), "not a PDF");
    }

    /// The two corpora are genuinely different sets, not one table read twice.
    #[test]
    fn each_generation_lists_its_own_packages() {
        let v0 = package_names_for(Lang::V0_0);
        let v1 = package_names_for(Lang::V0_1);
        assert!(!v0.is_empty() && !v1.is_empty());
        assert_ne!(v0, v1, "the two generations must not list the same set");
        assert!(
            v1.contains(&"v01-mini"),
            "the 0.1 list should carry a 0.1-only package: {v1:?}"
        );
    }

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

    /// The whole point of the CJK argument: a document names a face by
    /// ABBREV, and a store with no abbrev map answers `None` to the name and
    /// lets `rustyfi-lang`'s spelling heuristic pick the Latin face — which
    /// cannot fail, so nothing is reported and `.notdef` is drawn.
    ///
    /// Run against the submodule's own bundled faces where `download-fonts.sh`
    /// has put them, which makes the LAST assertion the real one: the abbrev
    /// resolves to a face that actually has a 日, and the Latin face does not.
    /// Falls back to two system faces, which still separate "resolved to the
    /// CJK slot" from "fell through to the Latin one" but cannot speak about
    /// coverage. Skips when neither is available — and `selftest.mjs`, which
    /// CI does run, checks the same thing against the very file the site
    /// serves and FAILS rather than skipping when it is missing.
    #[test]
    fn a_cjk_face_is_reachable_by_the_abbrevs_the_bundled_classes_name() {
        use super::*;
        let bundled = bundled_faces();
        let real_cjk = bundled.is_some();
        let Some((latin, cjk)) = bundled.or_else(|| Some((system_face(0)?, system_face(1)?)))
        else {
            return;
        };

        let none = font_store(Some(latin.clone()), None, None)
            .expect("the face should parse")
            .expect("a face was given");
        assert_eq!(
            rustyfi_backend::FontMetrics::resolve_font_abbrev(&none, "ipaexm"),
            None,
            "without a CJK face there is no abbrev to resolve, and the \
             heuristic silently picks the Latin one",
        );

        let store = font_store(Some(latin), Some(cjk), None)
            .expect("both faces should parse")
            .expect("faces were given");
        let mincho = store.abbrev_key("ipaexm").expect("ipaexm must resolve");
        let gothic = store.abbrev_key("ipaexg").expect("ipaexg must resolve");
        // `stdja` sets body text in the first and headings in the second; one
        // fetched face serves both, as one embedded copy.
        assert_eq!(store.file_index(mincho), store.file_index(gothic));
        assert_ne!(
            store.file_index(mincho),
            store.file_index(rustyfi_backend::FontKey(0)),
            "the CJK abbrevs must not land on the Latin face — that IS the bug",
        );
        // And a document that never calls `set-font` (stdja-mini, or none at
        // all) still gets it, through `get-initial-context`'s overlay.
        for script in [
            rustyfi_backend::Script::HanIdeographic,
            rustyfi_backend::Script::Kana,
        ] {
            assert_eq!(
                rustyfi_backend::FontMetrics::default_script_font(&store, script),
                Some((mincho, CJK_RATIO, 0.0)),
            );
        }

        if real_cjk {
            let size = rustyfi_backend::Length::pt(12.0);
            let advance = |key| rustyfi_backend::FontMetrics::advance(&store, key, '日', size);
            assert!(
                advance(mincho).is_some(),
                "the CJK abbrev must reach a face that has the glyph",
            );
            assert!(
                advance(rustyfi_backend::FontKey(0)).is_none(),
                "the Latin face must NOT have it, or this proves nothing",
            );
        }
    }

    /// The typesetter submodule's own Latin and CJK faces, once
    /// `download-fonts.sh` has installed them. `None` before that — they are
    /// gitignored build inputs, not committed files.
    fn bundled_faces() -> Option<(Vec<u8>, Vec<u8>)> {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../rustyfi/lib-rustyfi/dist/fonts");
        let latin = std::fs::read(dir.join("Junicode.ttf")).ok()?;
        let cjk = std::fs::read(dir.join("ipaexg.ttf")).ok()?;
        Some((latin, cjk))
    }

    /// Two distinct real faces from the system, by index. `None` rather than a
    /// failure: which faces exist varies by machine, the same bargain
    /// `rustyfi-pdf`'s own font tests make.
    fn system_face(nth: usize) -> Option<Vec<u8>> {
        [
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "/usr/share/fonts/dejavu/DejaVuSans.ttf",
            "/usr/share/fonts/TTF/DejaVuSans.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
            "/usr/share/fonts/dejavu/DejaVuSerif.ttf",
            "/usr/share/fonts/TTF/DejaVuSerif.ttf",
            "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
            "/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf",
        ]
        .iter()
        .filter_map(|path| std::fs::read(path).ok())
        .nth(nth)
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
