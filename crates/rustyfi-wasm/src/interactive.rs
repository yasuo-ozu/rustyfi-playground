//! The cursor-driven editor features — hover, go to definition, completion
//! and the document outline — as positioned JSON.
//!
//! # Where the answers come from
//!
//! `rustyfi_lsp`'s protocol-free half ([`rustyfi_lsp::build_model`] and the
//! four features over it) is the engine, exactly as [`crate::diagnostics`]
//! uses `rustyfi_lsp::analyze` for tier 1. That half is **single-file
//! scoped**, deliberately: a detached buffer has no program behind it, so a
//! name it does not bind is answered with silence rather than invention.
//!
//! That ceiling bites hardest on exactly the documents this page ships: a
//! playground document is almost entirely *package* vocabulary (`document`,
//! `+p`, `\emph`, `List.map`) and none of it is bound in the buffer. Wired up
//! as-is, hover could say no more than "an inline command, from somewhere
//! else", and completion had nothing at all to offer on most of the 24
//! examples.
//!
//! So this module supplies the missing half the same way tier 2 of the
//! diagnostics does, and for the same reason: **the browser has the resolved
//! program and a detached buffer does not.** [`Deps`] walks the entry's
//! `@require:`/`@import:` graph through the loader's own
//! [`rustyfi_loader::resolve_require`] over [`crate::EmbeddedCorpus`], builds
//! a [`rustyfi_lsp::Model`] per dependency file, and indexes what each one
//! declares. A name the buffer cannot resolve is then looked up there, and
//! hover says which package declares it, in which module, with the type its
//! author wrote — all quoted from source that is actually in the module,
//! never inferred and never guessed.
//!
//! What it is still honest about: an index entry proves that a required
//! package declares that spelling, not that the name is in scope at the
//! cursor. The wording says "declared by", never "bound here".
//!
//! Measured over the 154 command sites (`\cmd`, `+cmd`) in those 24 examples,
//! and re-measured by the page's self-test so it cannot rot: **92% get a
//! hover, and 90% of all sites name a package** — that is, nearly every hover
//! that answers does so out of this index — and **86% of command prefixes
//! offer at least one completion**. Over ALL cursor positions rather than
//! command sites the hover figure is about a quarter, and that is the design
//! rather than a shortfall: most positions in a SATySFi document are prose,
//! where the right answer is nothing.
//!
//! # Positions
//!
//! Every position in and out is [`crate::diagnostics`]'s: zero-based lines,
//! characters in **UTF-16 code units**. Requests carry a `(line, character)`
//! pair rather than an offset so that both directions go through
//! `rustyfi_lsp::LineIndex`, which is the one place that conversion is
//! written — a byte offset used as a character index misplaces everything in
//! the Japanese half of this corpus.
//!
//! # Cost
//!
//! Building [`Deps`] costs one parse per dependency file, so it is cached
//! against the entry's header list: typing in the body reuses it, and only
//! editing a `@require:` line rebuilds it. Hover runs on mouseover, which is
//! why the model itself — one parse of the buffer — is what a hover normally
//! costs.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};

use rustyfi_loader::SourceProvider;
use rustyfi_lsp::{
    build_model, ByteRange, HeaderKind, Hit, LineIndex, Model, Ns, Position, RustyfiVersion,
};

use crate::diagnostics::escape_into;
use crate::{EmbeddedCorpus, Lang, ENTRY_PATH, VIRTUAL_ROOT};

// ---------------------------------------------------------------------------
// The dependency index
// ---------------------------------------------------------------------------

/// How many dependency files one index will read.
///
/// A ceiling rather than a budget anyone is expected to hit: the largest graph
/// in the bundled corpus (`stdjabook` with `base`) is well under it. It exists
/// so that a pathological `@require:` cycle in a document someone pastes in
/// cannot make hover take unbounded time on the main thread.
const MAX_FILES: usize = 128;

/// One name a required package declares.
#[derive(Debug, Clone)]
struct Entry {
    ns: Ns,
    /// As written, sigil included — `\emph`, `+p`, `document`.
    name: String,
    /// The module it is declared in, when it is a member of one.
    module: Option<String>,
    /// Whether a document can write it *without* a `Module.` prefix.
    ///
    /// True for a 0.0.6 package's top-level bindings (a package's whole
    /// prelude is spliced into the program, so they are file-level names) and
    /// for a `direct` command in its signature, which is exactly what `direct`
    /// means. A plain `val` member is reachable only as `Module.name`.
    global: bool,
    /// The `@require:`/`@import:` name that brought the file in.
    package: String,
    /// How it was written: `direct`, `val`, `let-inline`, …
    form: &'static str,
    /// The type its author wrote, quoted from the package's own source.
    ty: Option<String>,
}

/// Everything the bundled corpus provides to the document being edited.
#[derive(Default)]
pub struct Deps {
    entries: Vec<Entry>,
    /// `(header name, resolved virtual path)` for each header that resolved.
    resolved: Vec<(String, String)>,
    /// Header names that did not resolve at all — hover on the header says so
    /// rather than staying silent, since that is the commonest mistake a
    /// visitor picking packages out of a panel makes.
    unresolved: Vec<String>,
    files: usize,
}

impl Deps {
    /// The entry a mention names, or nothing.
    ///
    /// A bare mention prefers a globally visible name; a `Module.` qualified
    /// one is matched on its last segment, which is all a 0.0.6 package
    /// nests.
    fn find(&self, ns: Ns, quals: &[String], name: &str) -> Option<&Entry> {
        match quals.last() {
            Some(module) => self
                .entries
                .iter()
                .find(|e| e.ns == ns && e.name == name && e.module.as_deref() == Some(module)),
            None => self
                .entries
                .iter()
                .find(|e| e.ns == ns && e.name == name && e.global)
                .or_else(|| self.entries.iter().find(|e| e.ns == ns && e.name == name)),
        }
    }

    /// Candidates for a completion: everything of namespace `ns` reachable
    /// under this qualification whose name starts with `needle`.
    ///
    /// `opened` is the modules the document has written `open` on. Their
    /// members are offered unqualified because that is precisely what `open`
    /// did — and it is what makes completion work at all for 0.1, where a
    /// package exports through a module and nothing is `direct`.
    fn candidates<'a>(
        &'a self,
        ns: Ns,
        quals: &'a [String],
        opened: &'a [String],
        needle: &'a str,
        bare: bool,
    ) -> impl Iterator<Item = &'a Entry> {
        self.entries.iter().filter(move |e| {
            e.ns == ns
                && sigil_free(&e.name, bare).starts_with(needle)
                && match quals.last() {
                    Some(module) => e.module.as_deref() == Some(module),
                    None => {
                        e.global
                            || e.module
                                .as_deref()
                                .is_some_and(|m| opened.iter().any(|o| o == m))
                    }
                }
        })
    }

    /// What a required package declares, for the hover on its header.
    fn exports_of(&self, package: &str) -> Vec<&Entry> {
        let mut out: Vec<&Entry> = self
            .entries
            .iter()
            .filter(|e| e.package == package && e.global)
            .collect();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        out
    }

    fn path_of(&self, package: &str) -> Option<&str> {
        self.resolved
            .iter()
            .find(|(name, _)| name == package)
            .map(|(_, path)| path.as_str())
    }
}

/// Which generation a dependency file is read as.
///
/// The loader's own rule, in the shape this virtual tree needs it: an explicit
/// signal in the text wins, else the corpus directory the file physically sits
/// in decides, else it inherits from whoever reached it (an `@import:` is a
/// same-package include and can never cross a generation).
fn version_of(path: &Path, src: &str, parent: RustyfiVersion) -> RustyfiVersion {
    if let Some(v) = rustyfi_syntax::sniff_version(src) {
        return v;
    }
    let mut segments = path.components().map(|c| c.as_os_str().to_owned());
    if segments.any(|s| s == "dist-v01") {
        return RustyfiVersion::V0_1;
    }
    if path.components().any(|c| c.as_os_str() == "dist") {
        return RustyfiVersion::V0_0;
    }
    parent
}

/// Read the whole `@require:`/`@import:` graph and index what it declares.
fn build_deps(model: &Model<'_>, lang: Lang) -> Deps {
    let corpus = EmbeddedCorpus::for_lang("", lang);
    let root = PathBuf::from(VIRTUAL_ROOT);
    let roots: Vec<&Path> = vec![root.as_path()];
    let entry_dir = Path::new(ENTRY_PATH)
        .parent()
        .unwrap_or(Path::new(VIRTUAL_ROOT))
        .to_path_buf();

    let mut deps = Deps::default();
    let mut seen: HashSet<PathBuf> = HashSet::new();
    let mut queue: VecDeque<(PathBuf, RustyfiVersion, String)> = VecDeque::new();
    // One entry per (namespace, name, module), so a package that declares a
    // name in its signature and binds it in its `struct` is one candidate.
    let mut slot: HashMap<(Ns, String, Option<String>), usize> = HashMap::new();

    let enqueue = |deps: &mut Deps,
                       queue: &mut VecDeque<_>,
                       kind: HeaderKind,
                       name: &str,
                       dir: &Path,
                       version: RustyfiVersion,
                       package: &str| {
        let found = match kind {
            HeaderKind::Require => {
                rustyfi_loader::resolve_require(&corpus, &roots, name, version).ok()
            }
            HeaderKind::Import => rustyfi_loader::resolve_import(&corpus, dir, name).ok(),
            // 0.1's `use` needs an envelope graph, which a browser has no
            // equivalent of. Recorded as unresolved rather than ignored.
            HeaderKind::Use => None,
        };
        match found {
            Some(path) => {
                deps.resolved
                    .push((name.to_string(), path.to_string_lossy().into_owned()));
                // A `@require:` names a package; an `@import:` is a file
                // inside the package that reached it, and keeps its label.
                let label = match kind {
                    HeaderKind::Require => name.to_string(),
                    _ => package.to_string(),
                };
                queue.push_back((path, version, label));
            }
            None => deps.unresolved.push(name.to_string()),
        }
    };

    for h in &model.headers {
        enqueue(
            &mut deps,
            &mut queue,
            h.kind,
            &h.name,
            &entry_dir,
            lang.to_version(),
            &h.name,
        );
    }

    while let Some((path, parent_version, package)) = queue.pop_front() {
        if deps.files >= MAX_FILES || !seen.insert(path.clone()) {
            continue;
        }
        let Ok(src) = corpus.read(&path) else {
            continue;
        };
        deps.files += 1;
        let version = version_of(&path, &src, parent_version);
        let m = build_model(&src, Some(version));
        harvest(&mut deps, &mut slot, &package, &m, src.len());
        let dir = path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| root.clone());
        for h in &m.headers {
            enqueue(
                &mut deps, &mut queue, h.kind, &h.name, &dir, version, &package,
            );
        }
    }
    deps
}

/// Read one dependency file's declarations out of its model.
///
/// Two kinds of `Def` are kept and the rest — parameters, pattern bindings,
/// names bound inside an expression — are dropped:
///
/// * a **member** of a module (`container` is set), which is either the
///   signature's declaration or the `struct`'s binding of the same name;
/// * a **top-level** binding, recognised by its scope running to the end of
///   the file, which is what `walk006` gives a file-level name and nothing
///   else. (A 0.0.6 package's prelude really is spliced into the program, so
///   these are global names, not private ones.)
fn harvest(
    deps: &mut Deps,
    slot: &mut HashMap<(Ns, String, Option<String>), usize>,
    package: &str,
    m: &Model<'_>,
    len: usize,
) {
    // Record labels, which come from MENTIONS rather than bindings.
    //
    // A label binds nothing anywhere, so no `Def` will ever carry one and the
    // loop below cannot find it. That used to mean the vocabulary had no
    // labels at all — and the one place a playground visitor most needs them
    // is the first line they write: `document (| ti`, whose `title` exists
    // only inside the doc class's own record TYPE, in a package this buffer
    // required but does not contain.
    //
    // Every mention in the package qualifies, including one inside a function
    // body. A label is not scoped and not a member, so there is no narrower
    // truth available; the alternative is the empty list this replaces.
    for r in m.refs.iter().filter(|r| r.ns == Ns::Field) {
        let key = (Ns::Field, r.name.clone(), None);
        if slot.contains_key(&key) {
            continue;
        }
        slot.insert(key, deps.entries.len());
        deps.entries.push(Entry {
            ns: Ns::Field,
            name: r.name.clone(),
            module: None,
            // Unqualified by construction: `(| title = … |)` never writes a
            // module path before a label.
            global: true,
            package: package.to_string(),
            form: "record label",
            ty: None,
        });
    }
    for d in &m.defs {
        // A type variable is not a name anyone writes at a cursor. A record
        // label is not a binding either, and is collected from mentions above.
        if matches!(d.ns, Ns::TypeVar | Ns::Field) {
            continue;
        }
        let module = d.container.map(|i| m.defs[i].name.clone());
        let top_level = d.container.is_none() && d.scope.end >= len;
        if module.is_none() && !top_level {
            continue;
        }
        let entry = Entry {
            ns: d.ns,
            name: d.name.clone(),
            module: module.clone(),
            global: top_level || d.form == "direct",
            package: package.to_string(),
            form: d.form,
            ty: d.ty.map(|r| m.text(r)),
        };
        match slot.get(&(d.ns, d.name.clone(), module.clone())) {
            // Both halves of a sealed member reach here — `direct \href : …`
            // in the signature and `let-inline \href` in the `struct`. The
            // signature is walked first and is the EXPORT, so it wins on a
            // tie; the binding only displaces it when the signature carried
            // no type at all. Visibility is the union: a member declared
            // `direct` is nameable unqualified however its binding was
            // written.
            Some(&i) => {
                deps.entries[i].global |= entry.global;
                if deps.entries[i].ty.is_none() && entry.ty.is_some() {
                    let global = deps.entries[i].global;
                    deps.entries[i] = Entry { global, ..entry };
                }
            }
            None => {
                slot.insert((d.ns, d.name.clone(), module), deps.entries.len());
                deps.entries.push(entry);
            }
        }
    }
}

thread_local! {
    /// The last index built, and the header list it was built from.
    ///
    /// One slot, not a map: the page edits one document, and a second entry
    /// would only ever be the previous state of the same one.
    static DEPS: RefCell<Option<(String, Deps)>> = const { RefCell::new(None) };
}

/// The index for this buffer, built or reused, borrowed for the callback.
fn with_deps<T>(model: &Model<'_>, lang: Lang, f: impl FnOnce(&Deps) -> T) -> T {
    let mut key = format!("{lang:?}");
    for h in &model.headers {
        key.push('\u{1}');
        key.push_str(match h.kind {
            HeaderKind::Require => "r",
            HeaderKind::Import => "i",
            HeaderKind::Use => "u",
        });
        key.push_str(&h.name);
    }
    DEPS.with(|cell| {
        let mut slot = cell.borrow_mut();
        if slot.as_ref().is_none_or(|(k, _)| *k != key) {
            *slot = Some((key, build_deps(model, lang)));
        }
        f(&slot.as_ref().expect("just filled").1)
    })
}

/// Drop the cached index. Only the tests need this — the page holds one
/// document for the life of the tab — but a stale index surviving between two
/// unrelated fixtures would make them order-dependent.
#[cfg(test)]
fn forget_deps() {
    DEPS.with(|cell| *cell.borrow_mut() = None);
}

/// Build the dependency index for this buffer, and report what is in it.
///
/// ```json
/// {"files":13,"names":979,"packages":["stdjabook","annot"],"unresolved":[]}
/// ```
///
/// Nothing needs the numbers to answer a hover — this exists so the page can
/// pay for the index on an IDLE callback rather than on the first mouseover,
/// and so the self-test can measure how much vocabulary a document actually
/// gets. Calling it twice for one set of headers is free: the second call
/// hits the cache.
pub fn index_json(source: &str, lang: Lang) -> String {
    let model = build_model(source, Some(lang.to_version()));
    with_deps(&model, lang, |deps| {
        let mut packages: Vec<&str> = deps.resolved.iter().map(|(n, _)| n.as_str()).collect();
        packages.sort_unstable();
        packages.dedup();
        let list = |names: &[&str]| {
            let mut out = String::from("[");
            for (i, n) in names.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push('"');
                escape_into(&mut out, n);
                out.push('"');
            }
            out.push(']');
            out
        };
        let unresolved: Vec<&str> = deps.unresolved.iter().map(String::as_str).collect();
        format!(
            "{{\"files\":{},\"names\":{},\"packages\":{},\"unresolved\":{}}}",
            deps.files,
            deps.entries.len(),
            list(&packages),
            list(&unresolved)
        )
    })
}

// ---------------------------------------------------------------------------
// Hover
// ---------------------------------------------------------------------------

/// Describe what is at `(line, character)`, as a JSON object or `null`.
pub fn hover_json(source: &str, lang: Lang, line: u32, character: u32) -> String {
    let model = build_model(source, Some(lang.to_version()));
    let index = LineIndex::new(source);
    let byte = index.offset(Position { line, character });
    let Some(hit) = model.hit_at(byte) else {
        return "null".to_string();
    };

    // The crate's own answer, then whatever the corpus can add to it. Only
    // the two cases it answers with "from somewhere else" are rewritten;
    // every other hover is `rustyfi_lsp`'s verbatim.
    let answer: Option<(ByteRange, String)> = match hit {
        Hit::Ref(r) if model.resolve(r).is_none() && r.ns != Ns::Field => {
            with_deps(&model, lang, |deps| {
                deps.find(r.ns, &r.quals, &r.name)
                    .map(|e| (r.span, describe(e)))
            })
        }
        Hit::Header(h) => with_deps(&model, lang, |deps| {
            Some((h.span, describe_header(deps, h.kind, &h.name)))
        }),
        _ => None,
    };
    let (range, markdown) = match answer.or_else(|| {
        rustyfi_lsp::hover(&model, byte).map(|h| (h.range, h.markdown))
    }) {
        Some(pair) => pair,
        None => return "null".to_string(),
    };

    let mut out = String::from("{");
    write_range(&mut out, &index, range);
    out.push_str(",\"markdown\":\"");
    escape_into(&mut out, &markdown);
    out.push_str("\"}");
    out
}

/// The hover for a name the buffer does not bind but a required package does.
fn describe(e: &Entry) -> String {
    let signature = match &e.ty {
        Some(ty) => format!("{} : {}", e.name, ty),
        None => e.name.clone(),
    };
    let where_from = match &e.module {
        Some(m) if e.global => format!(
            "{}, declared `{}` in module `{}` of package `{}`.",
            capitalised(e.ns.noun()),
            e.form,
            m,
            e.package
        ),
        Some(m) => format!(
            "{}, `{}` of module `{}` in package `{}`.",
            capitalised(e.ns.noun()),
            e.form,
            m,
            e.package
        ),
        None => format!(
            "{}, bound by `{}` in package `{}`.",
            capitalised(e.ns.noun()),
            e.form,
            e.package
        ),
    };
    format!(
        "```satysfi\n{signature}\n```\n\n{where_from} Not bound in this \
         document — this is what the bundled corpus provides."
    )
}

/// The hover for a `@require:`/`@import:`/`use` header.
fn describe_header(deps: &Deps, kind: HeaderKind, name: &str) -> String {
    let head = format!("```satysfi\n{}: {name}\n```\n\n", header_word(kind));
    let Some(path) = deps.path_of(name) else {
        return format!(
            "{head}Not in the bundled corpus — this page serves a fixed package \
             set; see “Packages” in the header."
        );
    };
    let exports = deps.exports_of(name);
    let shown: Vec<&str> = exports.iter().take(12).map(|e| e.name.as_str()).collect();
    let listed = match shown.is_empty() {
        true => String::new(),
        false => format!(
            "\n\nDeclares {}{}",
            shown
                .iter()
                .map(|n| format!("`{n}`"))
                .collect::<Vec<_>>()
                .join(", "),
            match exports.len() > shown.len() {
                true => format!(" and {} more.", exports.len() - shown.len()),
                false => ".".to_string(),
            }
        ),
    };
    format!(
        "{head}Resolved to `{}` in the bundled corpus.{listed}",
        path.trim_start_matches(VIRTUAL_ROOT)
    )
}

fn header_word(kind: HeaderKind) -> &'static str {
    match kind {
        HeaderKind::Require => "@require",
        HeaderKind::Import => "@import",
        HeaderKind::Use => "use",
    }
}

fn capitalised(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

// ---------------------------------------------------------------------------
// Go to definition
// ---------------------------------------------------------------------------

/// Where the name at `(line, character)` is defined, as JSON.
///
/// Three shapes, because a single-buffer editor can act on only one of them:
///
/// * `{"kind":"here", …range…}` — a range to select;
/// * `{"kind":"package","name":…,"detail":…}` — it comes from a bundled
///   package, which this page cannot open, so the page says so instead of
///   jumping;
/// * `null`.
pub fn definition_json(source: &str, lang: Lang, line: u32, character: u32) -> String {
    let model = build_model(source, Some(lang.to_version()));
    let index = LineIndex::new(source);
    let byte = index.offset(Position { line, character });

    if let Some(rustyfi_lsp::Definition::Here(range)) = rustyfi_lsp::definition(&model, byte) {
        let mut out = String::from("{\"kind\":\"here\",");
        write_range(&mut out, &index, range);
        out.push('}');
        return out;
    }
    // Not in this buffer. Say where it does come from, which the corpus can
    // answer for a name and for a header alike.
    let Some(hit) = model.hit_at(byte) else {
        return "null".to_string();
    };
    let told = with_deps(&model, lang, |deps| match hit {
        Hit::Ref(r) => deps.find(r.ns, &r.quals, &r.name).map(|e| {
            (
                e.name.clone(),
                format!(
                    "{} of package `{}`{}",
                    e.form,
                    e.package,
                    match &e.module {
                        Some(m) => format!(", module `{m}`"),
                        None => String::new(),
                    }
                ),
            )
        }),
        Hit::Header(h) => deps
            .path_of(&h.name)
            .map(|p| (h.name.clone(), format!("`{}`", p.trim_start_matches(VIRTUAL_ROOT)))),
        Hit::Def(_) => None,
    });
    match told {
        Some((name, detail)) => {
            let mut out = String::from("{\"kind\":\"package\",\"name\":\"");
            escape_into(&mut out, &name);
            out.push_str("\",\"detail\":\"");
            escape_into(&mut out, &detail);
            out.push_str("\"}");
            out
        }
        None => "null".to_string(),
    }
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

/// Candidates for the cursor, as a JSON array.
///
/// Two sources, in this order: the buffer's own bindings (`rustyfi_lsp`'s
/// answer, which is proven in scope) and then the required packages'
/// declarations. Each candidate says which, in `source`, so the popup does not
/// pass a package name off as a local one.
///
/// Empty is a perfectly good answer and the commonest one in prose. The page
/// shows no popup for it rather than an empty one.
pub fn completions_json(source: &str, lang: Lang, line: u32, character: u32) -> String {
    let model = build_model(source, Some(lang.to_version()));
    let index = LineIndex::new(source);
    let byte = index.offset(Position { line, character });

    let mut out = String::from("[");
    let mut count = 0usize;
    let mut seen: HashSet<(u8, String)> = HashSet::new();
    let mut emit = |out: &mut String, label: &str, detail: &str, kind: u8, from: &str, range| {
        if !seen.insert((kind, label.to_string())) || count >= MAX_COMPLETIONS {
            return;
        }
        if count > 0 {
            out.push(',');
        }
        count += 1;
        out.push_str("{\"label\":\"");
        escape_into(out, label);
        out.push_str("\",\"detail\":\"");
        escape_into(out, detail);
        out.push_str("\",\"source\":\"");
        escape_into(out, from);
        out.push_str(&format!("\",\"kind\":{kind},"));
        write_range(out, &index, range);
        out.push('}');
    };

    // The buffer's own names first: they are in scope, which nothing in the
    // corpus index can claim.
    let mine = rustyfi_lsp::completions(&model, byte);
    let range = mine.first().map(|c| c.range);
    for c in &mine {
        emit(&mut out, &c.label, &c.detail, c.kind, "this document", c.range);
    }

    // A PACKAGE NAME after `@require:`. Answered here and nowhere else,
    // because it is the one completion in the language that is not about the
    // document at all: `rustyfi_lsp` is single-buffer and has no library root
    // to enumerate, while this build has all 118 packages compiled in.
    //
    // It is also the completion a visitor needs most and can guess least. The
    // page carries a whole Packages panel for exactly this reason; the panel
    // is a list to read, and this is the same list where the name is typed.
    if let Some((start, needle)) = require_package_position(source, byte) {
        let range = ByteRange::new(start, byte);
        // The asking generation first, then the other, mirroring
        // `resolve_require`'s own search: a name is looked for in the
        // document's own corpus and falls back across the version boundary,
        // so both really are reachable and the preferred one should sort
        // first.
        let other = match lang {
            Lang::V0_0 => Lang::V0_1,
            Lang::V0_1 => Lang::V0_0,
        };
        for (l, from) in [(lang, "bundled"), (other, "bundled, other generation")] {
            let mut names = crate::package_names_for(l);
            names.sort_unstable();
            for name in names {
                if name.starts_with(needle) {
                    // `Module` (9): a package is the closest thing the LSP
                    // vocabulary has to a namespace you name to get its
                    // contents, which is what a `@require:` does.
                    emit(&mut out, name, "package", 9, from, range);
                }
            }
        }
        out.push(']');
        return out;
    }

    // …then the corpus. The word and the namespaces have to be recomputed
    // here, because `rustyfi_lsp::completions` decides both internally and
    // returns only the matches: when it answers nothing — which is most of the
    // time, and the whole reason this exists — there is nothing to read them
    // off.
    let word = word_before(source, byte);
    let range = range.unwrap_or_else(|| ByteRange::new(word.replace_from(), byte));
    if let Some(namespaces) = word.namespaces(source, model.version()) {
        let needle = &source[word.replace_from()..byte];
        let opened = opened_modules(&model);
        with_deps(&model, lang, |deps| {
            let mut found: Vec<&Entry> = Vec::new();
            for ns in namespaces {
                found.extend(deps.candidates(ns, &word.quals, &opened, needle, word.bare()));
            }
            found.sort_by(|a, b| a.name.cmp(&b.name));
            for e in found {
                let detail = match &e.ty {
                    Some(ty) => format!("{} : {}", e.form, ty),
                    None => e.form.to_string(),
                };
                let label = sigil_free(&e.name, word.bare());
                emit(&mut out, label, &detail, completion_kind(e.ns), &e.package, range);
            }
        });
    }
    out.push(']');
    out
}

/// A candidate's label, with the sigil dropped when the cursor's own sigil
/// sits in front of a module path rather than in front of the name.
///
/// `+StdJa.` is one `+`, one module and one member: the sigil the user typed
/// is already on the page, and the member is stored in the index as `+p`
/// because that is how its signature writes it. Inserting that verbatim would
/// produce `+StdJa.+p`.
fn sigil_free(name: &str, bare: bool) -> &str {
    match bare {
        true => name.trim_start_matches(['\\', '+']),
        false => name,
    }
}

/// The modules this document writes `open` on.
///
/// Read off the model's own references — every `open M` records one, in the
/// module namespace — and confirmed against the word before it in the text,
/// which is what tells an `open M` apart from an `M.foo` mention. Only the
/// first opens M's members into the bare namespace; the second says the
/// author is already qualifying them.
fn opened_modules(model: &Model<'_>) -> Vec<String> {
    let source = model.source();
    let mut out: Vec<String> = model
        .refs
        .iter()
        .filter(|r| r.ns == Ns::Module && r.quals.is_empty())
        .filter(|r| source[..r.span.start].trim_end().ends_with("open"))
        .map(|r| r.name.clone())
        .collect();
    out.sort();
    out.dedup();
    out
}

/// A ceiling on one response. A popup nobody can read to the end of is a
/// list, not a completion; the editor filters as more is typed, so the cap
/// only ever bites on the very first keystroke after a sigil.
const MAX_COMPLETIONS: usize = 300;

/// LSP's `CompletionItemKind`, mirroring `rustyfi_lsp`'s own mapping so a
/// corpus candidate and a buffer candidate of the same namespace draw the same
/// icon.
fn completion_kind(ns: Ns) -> u8 {
    match ns {
        Ns::Value => 6,
        Ns::InlineCmd | Ns::BlockCmd | Ns::MathCmd => 3,
        Ns::Type => 7,
        Ns::TypeVar => 25,
        Ns::Ctor => 20,
        Ns::Module => 9,
        Ns::Signature => 8,
        Ns::Field => 5,
    }
}

/// The partial name the cursor is typing.
///
/// Deliberately the same reading `rustyfi_lsp`'s own completion does — a
/// leading `\`, `+` or `#`, a `A.B.` qualification of capitalised segments —
/// because the two answers are merged into one list and a different idea of
/// where the word starts would make the editor replace different text
/// depending on which half a candidate came from. It is re-derived here rather
/// than borrowed because that reading is private to the crate.
struct Word {
    sigil: Option<char>,
    sigil_start: usize,
    name_start: usize,
    quals: Vec<String>,
}

impl Word {
    /// Where the text a candidate replaces begins. A command's own name
    /// carries its sigil, so `\emp` is replaced whole; `#` is not part of a
    /// value's name, so it stays put; and a QUALIFIED command replaces only
    /// its member name, because the sigil and the module path in front of it
    /// are already written.
    fn replace_from(&self) -> usize {
        match self.sigil {
            Some('\\') | Some('+') if self.quals.is_empty() => self.sigil_start,
            _ => self.name_start,
        }
    }

    /// Whether a candidate is inserted without its sigil — see
    /// [`sigil_free`].
    fn bare(&self) -> bool {
        !self.quals.is_empty() && matches!(self.sigil, Some('\\') | Some('+'))
    }

    /// Which namespaces the corpus should be searched in, or `None` for
    /// prose — where a bare word is text and offering names would be noise.
    ///
    /// A math area asks for INLINE commands as well as math ones, and that is
    /// not sloppiness: a 0.0.6 signature spells a math command's export
    /// `direct \\frac : [math; math] math-cmd`, which the grammar reads with
    /// the same `DirectHorzCmd` item an inline command uses, so the whole of
    /// `math.satyh` is indexed as inline. The two ARE distinguishable in 0.1
    /// (`val math \\frac`) and in a 0.0.6 `let-math` binding, and those keep
    /// their own namespace; this only widens the math case, where the
    /// alternative is offering nothing at all.
    fn namespaces(&self, source: &str, version: RustyfiVersion) -> Option<Vec<Ns>> {
        let area = area_at(source, version, self.sigil_start);
        Some(match (self.sigil, area) {
            (Some('\\'), Area::Math) => vec![Ns::MathCmd, Ns::InlineCmd],
            (Some('\\'), Area::Inline) => vec![Ns::InlineCmd],
            (Some('+'), Area::Block) => vec![Ns::BlockCmd],
            (Some('#'), Area::Inline | Area::Block | Area::Math) => vec![Ns::Value],
            // `#` in PROGRAM text is field access, `cfg#title` — a different
            // namespace behind the same character, exactly as `\` already
            // means one thing in inline text and another in math.
            (Some('#'), Area::Program) => vec![Ns::Field],
            // A record LABEL slot takes labels and nothing else. Asked of
            // `rustyfi_lsp` rather than decided here, so that this half and
            // the buffer's own half cannot disagree about where a slot ends —
            // they are merged into one list, and a disagreement would show as
            // the corpus offering labels while the buffer offered values.
            (None, Area::Program)
                if rustyfi_lsp::record_label_slot(source, version, self.sigil_start) =>
            {
                vec![Ns::Field]
            }
            (None, Area::Program) => vec![Ns::Value, Ns::Ctor, Ns::Module],
            _ => return None,
        })
    }
}

/// Is the cursor typing the PACKAGE NAME of a `@require:`, and if so where
/// does that name start and what has been typed of it?
///
/// `@require:` only — deliberately not `@import:`. An import resolves relative
/// to the importing file's own directory, and this page has exactly one file,
/// so there is never anything an import could name. Offering the bundled
/// package list there would be offering names that cannot resolve.
///
/// A package name may hold `/` and `.` (`base/array`, `easytable/easytable`),
/// so the name is everything from after the colon's spacing to the cursor,
/// and any whitespace inside it means the header is already complete and the
/// cursor is past it.
fn require_package_position(source: &str, byte: usize) -> Option<(usize, &str)> {
    let line_start = source[..byte].rfind('\n').map_or(0, |i| i + 1);
    let line = &source[line_start..byte];
    let rest = line.trim_start_matches([' ', '\t']);
    let indent = line.len() - rest.len();
    let after = rest.strip_prefix("@require:")?;
    let name = after.trim_start_matches([' ', '\t']);
    if name.chars().any(char::is_whitespace) {
        return None;
    }
    let start = line_start + indent + "@require:".len() + (after.len() - name.len());
    Some((start, name))
}

fn word_before(source: &str, byte: usize) -> Word {
    let bytes = source.as_bytes();
    let mut name_start = byte;
    while name_start > 0 && is_name_byte(bytes[name_start - 1]) {
        name_start -= 1;
    }
    let mut sigil = match name_start > 0 {
        true => match bytes[name_start - 1] {
            b'\\' => Some('\\'),
            b'+' => Some('+'),
            b'#' => Some('#'),
            _ => None,
        },
        false => None,
    };
    let mut sigil_start = name_start - usize::from(sigil.is_some());

    let mut quals: Vec<String> = Vec::new();
    let mut cut = sigil_start;
    while cut > 1 && bytes[cut - 1] == b'.' {
        let mut seg = cut - 1;
        while seg > 0 && is_name_byte(bytes[seg - 1]) {
            seg -= 1;
        }
        let name = &source[seg..cut - 1];
        if name.is_empty() || !name.starts_with(|c: char| c.is_uppercase()) {
            break;
        }
        quals.insert(0, name.to_string());
        cut = seg;
    }
    // `\\Mod.cmd` and `+Mod.p` put the sigil in FRONT of the module path, so
    // the character before the name is a dot and the loop above found no
    // sigil. Look again, in front of the qualification — without this, a
    // qualified command completes as nothing at all, which on a 0.1 document
    // is every command it writes (`+StdJa.section`).
    if sigil.is_none() && !quals.is_empty() && cut > 0 {
        match bytes[cut - 1] {
            b'\\' => sigil = Some('\\'),
            b'+' => sigil = Some('+'),
            _ => {}
        }
        if sigil.is_some() {
            sigil_start = cut - 1;
        }
    }
    Word {
        sigil,
        sigil_start,
        name_start,
        quals,
    }
}

fn is_name_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'-' || b == b'_'
}

/// Which kind of text the cursor sits in.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Area {
    Program,
    Inline,
    Block,
    Math,
}

/// Fold the delimiter tokens before `byte`, the way the lexer's own area stack
/// does — `{` after program text opens inline text, `{` inside `${…}` opens a
/// math group, and the token the lexer produced already records which.
///
/// `lex_partial` rather than a full lex: the buffer being completed into is
/// half-typed by definition, and its two most important shapes (`{\emp` and
/// `'<+p`) do not lex at all. Every token *before* the cursor is still
/// well-formed, and those are the only ones read here.
fn area_at(source: &str, version: RustyfiVersion, byte: usize) -> Area {
    use rustyfi_syntax::Token;
    let (atoms, _) = rustyfi_syntax::lex_partial(source, version);
    let mut stack = vec![Area::Program];
    for a in atoms.iter().filter(|a| a.span.end.byte <= byte) {
        match a.slot {
            Token::BHorzGrp => stack.push(Area::Inline),
            Token::BVertGrp => stack.push(Area::Block),
            Token::BMathGrp => stack.push(Area::Math),
            Token::LParen | Token::BList | Token::BRecord | Token::BPath | Token::OpenModule(_) => {
                stack.push(Area::Program)
            }
            Token::EHorzGrp
            | Token::EVertGrp
            | Token::EMathGrp
            | Token::RParen
            | Token::EList
            | Token::ERecord
            | Token::EPath => {
                if stack.len() > 1 {
                    stack.pop();
                }
            }
            _ => {}
        }
    }
    *stack.last().expect("the stack always holds Program")
}

// ---------------------------------------------------------------------------
// The outline
// ---------------------------------------------------------------------------

/// The document's own declarations, as a flat JSON array in source order,
/// each carrying the depth it is nested at.
///
/// **Read out of the same [`rustyfi_lsp::Model`] hover and completion use, and
/// deliberately not out of `rustyfi_lsp::document_symbols`.** The crate's
/// outline is the better structure — a real tree, with each declaration's full
/// extent taken from the tokens it would unparse to — and it costs **1,014,881
/// bytes of WebAssembly**, measured by building the module with and without
/// the call. That is four times what hover, definition and completion together
/// add (265,862 bytes), because `node_span` instantiates `Unparse` over both
/// grammars' entire CSTs. A jump list in a single-buffer playground does not
/// earn a megabyte on every page load; the model already holds every name, its
/// namespace, how it was written and where, which is the whole of what the
/// list shows.
///
/// The filter is [`harvest`]'s: a top-level binding (its scope runs to the end
/// of the file, which is what a file-level name gets and a parameter never
/// does) or a member of a module.
pub fn symbols_json(source: &str, lang: Lang) -> String {
    let model = build_model(source, Some(lang.to_version()));
    let index = LineIndex::new(source);
    let len = source.len();

    // (position, depth, def) — modules first so their members can be listed
    // under them, then sorted back into source order.
    let mut rows: Vec<(usize, u32, &rustyfi_lsp::Def)> = Vec::new();
    for d in &model.defs {
        if matches!(d.ns, Ns::TypeVar | Ns::Field) {
            continue;
        }
        let depth = match d.container {
            Some(_) => 1,
            None if d.scope.end >= len => 0,
            None => continue,
        };
        rows.push((d.name_span.start, depth, d));
    }
    // A module's own members sort after it by position anyway, so source order
    // alone produces the nesting.
    rows.sort_by_key(|(at, _, _)| *at);

    let mut out = String::from("[");
    for (i, (_, depth, d)) in rows.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str("{\"name\":\"");
        escape_into(&mut out, &d.name);
        out.push_str("\",\"detail\":\"");
        escape_into(&mut out, d.form);
        out.push_str("\",\"kind\":\"");
        escape_into(&mut out, d.ns.noun());
        out.push_str(&format!("\",\"depth\":{depth},"));
        write_range(&mut out, &index, d.name_span);
        out.push('}');
    }
    out.push(']');
    out
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/// A byte range as the four position fields every reply carries.
fn write_range(out: &mut String, index: &LineIndex<'_>, range: ByteRange) {
    let start = index.position(range.start);
    let end = index.position(range.end.max(range.start));
    out.push_str(&format!(
        "\"line\":{},\"character\":{},\"endLine\":{},\"endCharacter\":{}",
        start.line, start.character, end.line, end.character
    ));
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A document that requires a real bundled package, whose vocabulary is
    /// therefore entirely `@require:`d — the shape every example on the page
    /// has, and the shape the single-file features answer nothing for.
    const DOC: &str = "@require: stdja-mini\n\
                       let greeting = {Hello} in\n\
                       document (|title = {t}; author = {a};|) '<\n  \
                         +p { \\emph{x} }\n\
                       >\n";

    /// Where `needle` sits in `src`, as a zero-based UTF-16 position.
    fn at(src: &str, needle: &str, offset: usize) -> (u32, u32) {
        let byte = src.find(needle).expect("needle") + offset;
        let line = src[..byte].matches('\n').count() as u32;
        let line_start = src[..byte].rfind('\n').map(|i| i + 1).unwrap_or(0);
        (line, src[line_start..byte].encode_utf16().count() as u32)
    }

    #[test]
    fn a_name_this_document_binds_is_described_from_the_buffer() {
        forget_deps();
        let (l, c) = at(DOC, "greeting", 2);
        let json = hover_json(DOC, Lang::V0_0, l, c);
        assert!(json.contains("greeting"), "{json}");
        assert!(json.contains("bound by"), "{json}");
    }

    /// The whole point of the corpus index: `+p` is bound in no buffer, and
    /// the single-file answer for it is "comes from a required package".
    #[test]
    fn a_package_command_is_named_with_its_package() {
        forget_deps();
        let (l, c) = at(DOC, "+p {", 1);
        let json = hover_json(DOC, Lang::V0_0, l, c);
        assert!(json.contains("+p"), "{json}");
        assert!(json.contains("stdja-mini"), "{json}");
        assert!(json.contains("let-block"), "{json}");
    }

    /// …and where the package's author wrote a type, it is quoted verbatim.
    /// `annot`'s `\href` is `direct` in a signature, which is the shape most
    /// of the corpus exports through.
    #[test]
    fn a_declared_command_carries_the_type_its_author_wrote() {
        forget_deps();
        let src = "@require: stdja-mini\n\
                   @require: annot\n\
                   document (|title = {t}; author = {a};|) '<\n  \
                     +p { \\href(`u`){x} }\n\
                   >\n";
        let (l, c) = at(src, "\\href", 2);
        let json = hover_json(src, Lang::V0_0, l, c);
        assert!(json.contains("annot"), "{json}");
        assert!(json.contains("direct"), "{json}");
        assert!(json.contains("Annot"), "{json}");
        // Quoted from `annot.satyh`'s own signature.
        assert!(json.contains("inline-cmd"), "{json}");
    }

    #[test]
    fn a_header_hover_says_what_it_resolved_to() {
        forget_deps();
        let (l, c) = at(DOC, "stdja-mini", 2);
        let json = hover_json(DOC, Lang::V0_0, l, c);
        assert!(json.contains("dist/packages/stdja-mini"), "{json}");
        assert!(json.contains("Declares"), "{json}");
    }

    #[test]
    fn an_unresolvable_header_says_so_rather_than_nothing() {
        forget_deps();
        let src = DOC.replace("stdja-mini", "no-such-package");
        let (l, c) = at(&src, "no-such-package", 2);
        let json = hover_json(&src, Lang::V0_0, l, c);
        assert!(json.contains("Not in the bundled corpus"), "{json}");
    }

    #[test]
    fn hovering_prose_answers_nothing() {
        forget_deps();
        let (l, c) = at(DOC, "Hello", 2);
        assert_eq!(hover_json(DOC, Lang::V0_0, l, c), "null");
    }

    /// Completion after `\` in inline text offers the corpus's inline
    /// commands — the case that answered nothing at all before.
    #[test]
    fn a_backslash_in_inline_text_offers_package_commands() {
        forget_deps();
        let src = "@require: stdja-mini\n\
                   document (|title = {t}; author = {a};|) '<\n  \
                     +p { \\\n\
                   >\n";
        let (l, c) = at(src, "\\\n", 1);
        let json = completions_json(src, Lang::V0_0, l, c);
        assert!(json.contains("\\\\emph") || json.contains("\\\\dfn"), "{json}");
        assert!(json.contains("\"kind\":3"), "{json}");
    }

    /// …and the same cursor in prose offers nothing, which is the design.
    #[test]
    fn a_bare_word_in_prose_offers_nothing() {
        forget_deps();
        let src = "@require: stdja-mini\n\
                   document (|title = {t}; author = {a};|) '<\n  \
                     +p { Hello wor\n\
                   >\n";
        let (l, c) = at(src, "wor\n", 3);
        assert_eq!(completions_json(src, Lang::V0_0, l, c), "[]");
    }

    #[test]
    fn a_block_command_prefix_offers_block_commands_only() {
        forget_deps();
        let src = "@require: stdja-mini\n\
                   document (|title = {t}; author = {a};|) '<\n  \
                     +\n\
                   >\n";
        let (l, c) = at(src, "+\n", 1);
        let json = completions_json(src, Lang::V0_0, l, c);
        assert!(json.contains("+p"), "{json}");
        assert!(!json.contains("\\\\emph"), "{json}");
    }

    /// A qualified command puts its sigil in FRONT of the module path, so the
    /// member is completed without one — `+StdJa.` + `section`, never
    /// `+StdJa.+section`. This is every command a 0.1 document writes.
    #[test]
    fn a_qualified_command_completes_to_its_bare_member_name() {
        forget_deps();
        let src = "@require: std-ja\n\n\
                   StdJa.document (| title = {t}; author = {a} |) '<\n  \
                     +StdJa.\n\
                   >\n";
        let (l, c) = at(src, "+StdJa.\n", 7);
        let json = completions_json(src, Lang::V0_1, l, c);
        assert!(json.contains("\"label\":\"section\""), "{json}");
        assert!(!json.contains("+section"), "{json}");
        // …and it replaces only the member name, which is empty here, so the
        // range is degenerate at the cursor rather than eating the prefix.
        assert!(json.contains(&format!("\"character\":{c},\"endLine\":{l},\"endCharacter\":{c}")), "{json}");
    }

    /// A module the document `open`s contributes its members unqualified.
    /// Without this a 0.1 document completes nothing at all, since a 0.1
    /// package exports through a module and has no `direct` — every command
    /// it publishes is an ordinary `val block` member.
    #[test]
    fn an_opened_modules_members_are_offered_unqualified() {
        forget_deps();
        let src = "@require: std-ja\n\n\
                   let open StdJa in\n\
                   document (| title = {t}; author = {a} |) '<\n  \
                     +sec\n\
                   >\n";
        let (l, c) = at(src, "+sec\n", 4);
        let json = completions_json(src, Lang::V0_1, l, c);
        assert!(json.contains("\"label\":\"+section\""), "{json}");
        // The same document without the `open` must NOT offer it: the member
        // is only reachable as `+StdJa.section` there, and offering it bare
        // would be exactly the invention this design refuses.
        forget_deps();
        let closed = src.replace("let open StdJa in\n", "");
        let (l, c) = at(&closed, "+sec\n", 4);
        assert_eq!(completions_json(&closed, Lang::V0_1, l, c), "[]");
    }

    #[test]
    fn definition_lands_on_the_binding_in_this_buffer() {
        forget_deps();
        let (l, c) = at(DOC, "greeting", 2);
        let json = definition_json(DOC, Lang::V0_0, l, c);
        assert!(json.contains("\"kind\":\"here\""), "{json}");
        assert!(json.contains("\"line\":1"), "{json}");
    }

    #[test]
    fn definition_of_a_package_name_says_where_it_comes_from() {
        forget_deps();
        let (l, c) = at(DOC, "+p {", 1);
        let json = definition_json(DOC, Lang::V0_0, l, c);
        assert!(json.contains("\"kind\":\"package\""), "{json}");
        assert!(json.contains("stdja-mini"), "{json}");
    }

    #[test]
    fn the_outline_carries_the_documents_own_declarations() {
        forget_deps();
        let json = symbols_json(DOC, Lang::V0_0);
        assert!(json.contains("\"name\":\"greeting\""), "{json}");
        assert!(json.contains("\"depth\":0"), "{json}");
        // A parameter is not a declaration, and neither is a package name.
        assert!(!json.contains("stdja-mini"), "{json}");
    }

    /// A module's members are listed under it, in source order.
    #[test]
    fn a_modules_members_are_nested_in_the_outline() {
        forget_deps();
        let src = "module Helpers : sig\n  val twice : int -> int\nend = struct\n  \
                   let twice n = n * 2\n\
                   end\n";
        let json = symbols_json(src, Lang::V0_0);
        let module = json.find("Helpers").expect(&json);
        let member = json.find("twice").expect(&json);
        assert!(module < member, "{json}");
        assert!(json.contains("\"depth\":1"), "{json}");
    }

    /// A CJK document: every position in and out must be counted in UTF-16
    /// code units. A byte offset would be three times too far right after the
    /// Japanese and would answer about the wrong token entirely.
    #[test]
    fn positions_after_japanese_text_are_utf16_units() {
        forget_deps();
        // The mention of `name` sits AFTER a string of Japanese on its own
        // line, which is what makes the two counts differ: each of those
        // characters is three bytes and one UTF-16 unit.
        let src = "@require: stdja-mini\n\
                   let name = 1 in\n\
                   let s = `吾輩は猫である` in let second = name in\n\
                   document (|title = {t}; author = {a};|) '< +p { x } >\n";
        let (l, c) = at(src, "name in", 0);
        assert_eq!(l, 2);
        let byte = src.find("name in").unwrap()
            - src[..src.find("name in").unwrap()]
                .rfind('\n')
                .map(|i| i + 1)
                .unwrap();
        assert!(c < byte as u32, "the fixture must not be all-ASCII");
        let json = hover_json(src, Lang::V0_0, l, c);
        assert!(json.contains("bound by"), "{json}");
        // The answer's own range is UTF-16 too: it covers `name`, four units
        // wide, at the column the cursor was given.
        assert!(
            json.contains(&format!("\"character\":{c},\"endLine\":2,\"endCharacter\":{}", c + 4)),
            "{json}"
        );
        // Go to definition points at the binding on line 1, whose column is
        // ASCII and therefore unambiguous.
        let json = definition_json(src, Lang::V0_0, l, c);
        assert!(json.contains("\"kind\":\"here\""), "{json}");
        assert!(json.contains("\"line\":1,\"character\":4"), "{json}");
    }

    /// The index is keyed on the headers, so editing the body must not
    /// rebuild it — and editing a header must.
    #[test]
    fn the_index_follows_the_headers_and_not_the_body() {
        forget_deps();
        let (l, c) = at(DOC, "+p {", 1);
        assert!(hover_json(DOC, Lang::V0_0, l, c).contains("stdja-mini"));
        let other = DOC.replace("stdja-mini", "no-such-package");
        let (l, c) = at(&other, "+p {", 1);
        let json = hover_json(&other, Lang::V0_0, l, c);
        assert!(!json.contains("stdja-mini"), "a stale index answered: {json}");
    }

    /// Nothing here may trap, whatever is in the buffer: the page runs hover
    /// on mouseover and would otherwise take the whole tab down.
    #[test]
    fn rubbish_does_not_panic() {
        for src in [
            "",
            " ",
            "\\",
            "@require:",
            "{{{{{{{{",
            "((((((((((",
            "@require: stdja-mini\n${\\",
            "let x = 𠮷 in",
        ] {
            forget_deps();
            for lang in [Lang::V0_0, Lang::V0_1] {
                for (l, c) in [(0, 0), (0, 1), (1, 0), (99, 99)] {
                    let _ = hover_json(src, lang, l, c);
                    let _ = definition_json(src, lang, l, c);
                    let _ = completions_json(src, lang, l, c);
                }
                let _ = symbols_json(src, lang);
            }
        }
    }
}

#[cfg(test)]
mod timing {
    use super::*;
    use std::time::Instant;

    #[test]
    #[ignore]
    fn measure() {
        for (name, src) in [
            ("stdjabook", "@require: stdjabook\n@require: annot\n@require: itemize\ndocument (|title = {t}; author = {a}; show-title = true; show-toc = false|) '<\n  +p { \\emph{x} }\n>\n"),
            ("stdja-mini", "@require: stdja-mini\ndocument (|title = {t}; author = {a};|) '<\n  +p { \\emph{x} }\n>\n"),
        ] {
            forget_deps();
            let t = Instant::now();
            let model = build_model(src, Some(RustyfiVersion::V0_0));
            let model_ms = t.elapsed().as_secs_f64() * 1000.0;
            let t = Instant::now();
            let (files, entries) = with_deps(&model, Lang::V0_0, |d| (d.files, d.entries.len()));
            let index_ms = t.elapsed().as_secs_f64() * 1000.0;
            let t = Instant::now();
            for _ in 0..20 {
                let _ = hover_json(src, Lang::V0_0, 4, 8);
            }
            let hover_ms = t.elapsed().as_secs_f64() * 1000.0 / 20.0;
            let t = Instant::now();
            let _ = completions_json(src, Lang::V0_0, 4, 8);
            let comp_ms = t.elapsed().as_secs_f64() * 1000.0;
            println!("{name}: model {model_ms:.2}ms, index {index_ms:.1}ms ({files} files, {entries} names), hover {hover_ms:.2}ms, completions {comp_ms:.2}ms");
        }
    }
}
