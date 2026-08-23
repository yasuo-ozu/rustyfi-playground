//! Live diagnostics for an editor — the useful half of a language server,
//! without the protocol.
//!
//! # Two tiers, and why there are still two
//!
//! [`analyze`] is the seam the browser side was written against, and its
//! contract has not moved: a list of positioned diagnostics over one source
//! string, positions zero-based, characters counted in **UTF-16 code units**
//! so they drop straight into a `textarea` (`setSelectionRange`, and the
//! character cells of a mirrored overlay).
//!
//! What has moved is what stands behind it. [`Diag`] and [`Severity`] are no
//! longer declared here — they are `rustyfi_lsp`'s own, re-exported — and the
//! first thing [`analyze`] does is ask that crate:
//!
//! 1. **`rustyfi_lsp::analyze`** — lex and parse, under the chosen generation.
//!    No filesystem, no packages, no compile. Sub-millisecond on every
//!    document this playground ships, and its span is the token the parse
//!    could not get past rather than a position scraped out of a message.
//! 2. **the whole program**, but only when the first tier is silent. The
//!    document is loaded against the bundled corpus and taken through
//!    elaborate → typecheck → evaluate ([`crate::check_lang`]), and the one
//!    error the compiler stopped at becomes one diagnostic.
//!
//! The second tier is deliberately kept, and it is worth saying why, because
//! the note this module used to carry predicted it would be deleted.
//! `rustyfi_lsp::analyze` **stops at parsing, on purpose** — a detached buffer
//! has no program behind it, so every name a real document imports
//! (`document`, `\emph`, `+p`, `List.map`) would be an unbound variable and
//! the one real error would drown. The crate's answer to that is
//! `rustyfi_lsp::project::check`, which supplies the missing program by
//! resolving the buffer's dependency graph off the disk — and which is
//! therefore absent from a `wasm32` build.
//!
//! But this shim already *is* that program: [`crate::EmbeddedCorpus`] serves
//! the whole resolved dependency graph out of memory, which is the one thing a
//! browser has that a detached editor buffer does not. So tier 2 here is not a
//! leftover stand-in for tier 1; it is the wasm-side counterpart of
//! `project::check`, and dropping it would have taken `unbound variable`,
//! `cannot resolve @require:` and every cross-version refusal off the page —
//! the three mistakes a visitor picking packages out of a panel is most likely
//! to make.
//!
//! Ordering the two this way is what makes the pair cheap. A document that
//! does not parse cannot be compiled anyway, so tier 1 answers it for the
//! price of a lex; and a document that does not parse is the *normal* state of
//! a buffer being typed into. Only a syntactically complete document pays for
//! tier 2.
//!
//! # What each tier can and cannot say
//!
//! Neither tier reports more than one diagnostic: this port's parser stops at
//! the first failure, and so does its compiler. The `Vec` is the shape both
//! crates chose so that error recovery would not be a breaking change, and the
//! page says so out loud under the problems list.
//!
//! Tier 1's position is exact — a byte span from the stream's own high-water
//! mark, converted through `rustyfi_lsp::LineIndex`. Tier 2's is *derived*, by
//! reading `line L, characters A-B` back out of a message ([`scan_span`]), and
//! it is honest about the cases where that cannot be attributed to the entry
//! document at all: see [`entry_span`], which declines rather than guess.
//!
//! # Positions
//!
//! Tier 2's numbers come from a [`rustyfi_syntax::Span`], whose `Display` is
//! `line L, characters A-B` (or, across lines, `line L1, character A to line
//! L2, character B`). `L` is 1-based and `A`/`B` count **Unicode scalars**,
//! not bytes and not UTF-16 code units — `lexer.rs`'s `bump` advances `col`
//! once per `char`. So the port's own numbers are already immune to the
//! byte-offset trap that would misplace every marker in a Japanese document;
//! what is left is the astral plane, where one scalar is TWO UTF-16 units.
//! [`utf16_column`] does that conversion by re-reading the line, which is also
//! what clamps a column the source cannot actually have.
//!
//! Tier 1 needs none of that — `rustyfi_lsp` works in byte offsets internally
//! and converts once, at the end, through an index built over the same buffer.

use crate::Lang;

/// One positioned diagnostic over the document being edited, and how loud it
/// is.
///
/// **`rustyfi_lsp`'s own types**, not a copy of them. This module used to
/// declare a `Diag` of exactly these six fields with exactly these units,
/// written against a crate that did not exist yet; when it landed, the two
/// declarations turned out to agree field for field, so keeping a second one
/// here would only have been something to let drift.
///
/// `Severity` is the one place the two shapes differed: the local copy had
/// `Error` and `Warning`, the real one also has `Information` and `Hint`.
/// [`severity_str`] spells all four, and nothing in this build emits anything
/// but `Error` today.
///
/// Both positions are zero-based, both columns count UTF-16 code units, and
/// the range is half-open, as an editor selection is.
///
/// A diagnostic the analysis cannot pin to a place in THIS document — a
/// failure inside a bundled package, or one the compiler reported with no span
/// at all — is placed at the very start (all four fields `0`), which is what
/// a language server does with a whole-file problem, and which the page draws
/// as a row with no underline.
pub use rustyfi_lsp::{Diag, Severity};

/// The JSON spelling of a severity, which is also the CSS class the page
/// styles on.
fn severity_str(severity: Severity) -> &'static str {
    match severity {
        Severity::Error => "error",
        Severity::Warning => "warning",
        Severity::Information => "information",
        Severity::Hint => "hint",
    }
}

/// Analyse `source` as `lang`, returning every diagnostic found.
///
/// Parse first, compile only if that was silent — see the module comment for
/// why both tiers are here and why this order is the cheap one.
pub fn analyze(source: &str, lang: Lang) -> Vec<Diag> {
    // Tier 1. `analyze`, not `analyze_auto`: the generation is not a guess
    // here, it is what the reader picked in the header's Lang selector, and
    // silently analysing 0.1 source under 0.0.6 because it happens to parse
    // would disagree with the Typeset button standing next to it.
    let parsed = rustyfi_lsp::analyze(source, lang.to_version());
    if !parsed.is_empty() {
        return parsed;
    }
    // Tier 2.
    match crate::check_lang(source, lang) {
        Ok(()) => Vec::new(),
        Err(raw) => vec![from_compile_error(source, &raw)],
    }
}

/// [`analyze`], serialized as the JSON array the browser reads.
pub fn analyze_json(source: &str, lang: Lang) -> String {
    to_json(&analyze(source, lang))
}

// ---------------------------------------------------------------------------
// Tier 2: one diagnostic, derived from the compiler's own message.
// ---------------------------------------------------------------------------

/// A position as the port's own diagnostics spell it: `(line, column,
/// end_line, end_column)`, with 1-based lines and 0-based columns counted in
/// **Unicode scalars**. Not the units [`Diag`] uses — [`utf16_column`] is what
/// converts one to the other.
type ScalarSpan = (u32, u32, u32, u32);

/// Turn one raw compiler diagnostic into one positioned [`Diag`].
///
/// `raw` is the message BEFORE [`crate::for_a_reader`] rewrites it, because
/// the part that rewrite drops — the leading virtual path — is exactly what
/// says WHICH file the position belongs to.
fn from_compile_error(source: &str, raw: &str) -> Diag {
    let (line, character, end_line, end_character) =
        entry_span(source, raw).unwrap_or((0, 0, 0, 0));
    Diag {
        line,
        character,
        end_line,
        end_character,
        severity: Severity::Error,
        message: tidy(&crate::for_a_reader(raw)).to_string(),
    }
}

/// Drop from a compiler message the leading position the editor is already
/// showing.
///
/// `line 4, characters 1-3: unbound variable 'x'` is how the message reads
/// when it is the only output of a command-line run. Here the position is the
/// [`Diag`]'s own, rendered by the editor next to the underline it drew, so
/// repeating it in the text is noise. Only a LEADING position is stripped, and
/// only when a `: ` follows it — a position quoted mid-sentence is part of
/// what the message is saying.
///
/// Deliberately NOT applied to the Typeset pane's copy of the same message:
/// there the position is all the reader has, since nothing underlines it.
///
/// This used to strip a second thing as well — an embedded `Debug`-rendered
/// span, because a parse failure's payload was `format!("{err:?}")` over
/// syan's whole error tree and read `Expected { span: Span { start: Loc {
/// line: 4, col: 1, byte: 77 }, .. }, what: "end of input" }`. Two separate
/// changes in the typesetter removed the need for it: parse failures are now
/// reduced to one located, one-line message by `rustyfi_syntax::
/// parse_error::locate`, and in any case a parse failure no longer reaches
/// this tier at all, because tier 1 answers first.
fn tidy(message: &str) -> &str {
    strip_leading_position(message).unwrap_or(message)
}

/// `message` without a leading `line …: `, if it has one.
fn strip_leading_position(message: &str) -> Option<&str> {
    let (_, rest) = span_at(message.strip_prefix("line ")?)?;
    rest.strip_prefix(": ")
}

/// The zero-based, UTF-16 range `raw` reports **in the entry document**, if it
/// reports one there at all.
///
/// Three ways this declines, all of them deliberate:
///
/// * the message names a bundled package rather than the entry
///   ([`crate::VIRTUAL_ROOT`] prefix). Its line numbers are that package's,
///   and marking them in the editor would underline an unrelated line of the
///   user's own text.
/// * the message carries no span at all — a `TypeError` whose rule had no
///   `Var` node to blame, or an unresolvable `@require:`.
/// * the message carries a span, has no path to attribute it to (every
///   post-parse phase runs on the MERGED program, whose bindings came from
///   several files), and names a line the entry does not have. That last
///   clause is a floor, not a proof: a merged-program span really can point
///   into a package at a line the entry also happens to have, and then this
///   marks the wrong line. It is the residual imprecision of deriving a
///   position from a whole-program compile, and it is the one thing tier 1
///   does not have.
fn entry_span(source: &str, raw: &str) -> Option<ScalarSpan> {
    let entry_prefix = format!("{}: ", crate::ENTRY_PATH);
    let (body, known_entry) = match raw.strip_prefix(&entry_prefix) {
        Some(rest) => (rest, true),
        // Some OTHER virtual path: a bundled package's own parse/read failure.
        None if raw.starts_with(crate::VIRTUAL_ROOT) => return None,
        None => (raw, false),
    };
    let (line, col, end_line, end_col) = scan_span(body)?;
    let lines = source.split('\n').count() as u32;
    if !known_entry && (line > lines || end_line > lines) {
        return None;
    }
    Some((
        line.saturating_sub(1),
        utf16_column(source, line, col),
        end_line.saturating_sub(1),
        utf16_column(source, end_line, end_col),
    ))
}

/// The first `Span`-shaped position in `message`, as the port spells it:
/// 1-based line, 0-based Unicode-scalar column, `(line, col, end_line,
/// end_col)`.
///
/// Both of `Span`'s `Display` forms are accepted. Scanning rather than
/// matching a whole message shape is what keeps this working across the error
/// types that embed a span (`ElabError`, `TypeError`, `EvalError`, and the
/// loader's two wrappers), none of which agree on what surrounds it.
fn scan_span(message: &str) -> Option<ScalarSpan> {
    let mut rest = message;
    loop {
        let at = rest.find("line ")?;
        let after = &rest[at + "line ".len()..];
        if let Some((found, _)) = span_at(after) {
            return Some(found);
        }
        rest = after;
    }
}

/// Parse one position out of the text immediately after a `line ` marker,
/// returning it alongside what follows it.
fn span_at(after: &str) -> Option<(ScalarSpan, &str)> {
    let (line, rest) = number(after)?;
    if let Some(rest) = rest.strip_prefix(", characters ") {
        let (col, rest) = number(rest)?;
        let (end_col, rest) = number(rest.strip_prefix('-')?)?;
        return Some(((line, col, line, end_col), rest));
    }
    let rest = rest.strip_prefix(", character ")?;
    let (col, rest) = number(rest)?;
    let (end_line, rest) = number(rest.strip_prefix(" to line ")?)?;
    let (end_col, rest) = number(rest.strip_prefix(", character ")?)?;
    Some(((line, col, end_line, end_col), rest))
}

/// A leading run of ASCII digits, and what follows it.
fn number(s: &str) -> Option<(u32, &str)> {
    let end = s.find(|c: char| !c.is_ascii_digit()).unwrap_or(s.len());
    s[..end].parse().ok().map(|n| (n, &s[end..]))
}

/// Re-express a 1-based line and 0-based SCALAR column as a 0-based UTF-16
/// column on that line.
///
/// Tier 2's numbers arrive as text, already split into a line and a column, so
/// `rustyfi_lsp::LineIndex` — which is keyed on byte offsets — has nothing to
/// take. This does the same conversion for the coordinates that are available.
///
/// The whole reason it is not the identity: `＋` and `吾` are one scalar and
/// one UTF-16 unit, but `𠮷` is one scalar and TWO, so a column counted in
/// scalars lands half a code point early once anything astral precedes it on
/// the line. Both are also the wrong answer if bytes are used, which is the
/// mistake this exists to avoid on exactly the documents the playground ships.
///
/// A column past the end of the line clamps to the line's length: a `Span`
/// end can legitimately sit one past the last character, and nothing good
/// comes of an editor selection that runs off the row.
fn utf16_column(source: &str, line: u32, column: u32) -> u32 {
    let text = source
        .split('\n')
        .nth(line.saturating_sub(1) as usize)
        .unwrap_or("");
    text.chars()
        .take(column as usize)
        .map(|c| c.len_utf16() as u32)
        .sum()
}

/// Serialize diagnostics as the JSON array the page consumes.
///
/// Hand-rolled because this crate has no serializer and adding one to emit
/// six fields would be a dependency for nothing.
fn to_json(diags: &[Diag]) -> String {
    let mut out = String::from("[");
    for (i, d) in diags.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(&format!(
            "{{\"line\":{},\"character\":{},\"endLine\":{},\"endCharacter\":{},\
             \"severity\":\"{}\",\"message\":\"",
            d.line,
            d.character,
            d.end_line,
            d.end_character,
            severity_str(d.severity)
        ));
        escape_into(&mut out, &d.message);
        out.push_str("\"}");
    }
    out.push(']');
    out
}

/// Append `text` to `out` as the body of a JSON string.
///
/// Compiler messages carry quotes and backslashes constantly (`` `int` ``,
/// `'\\fail'`, Windows-ish paths) and newlines occasionally, and a lone
/// control character would make the whole array unparseable — which, since the
/// page runs this on every pause in typing, would take the feature out
/// silently on exactly the documents that most need it.
fn escape_into(out: &mut String, text: &str) {
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_clean_document_has_no_diagnostics() {
        let src = "@require: stdja-mini\n\
                   document (|title = {t}; author = {a};|) '<\n  \
                     +p { Hello. }\n\
                   >\n";
        assert_eq!(analyze(src, Lang::V0_0), Vec::new());
    }

    /// TIER 1, and the one thing it does here that the compile path measurably
    /// could not: **a parse failure at end of input is still drawable.**
    ///
    /// `>>>` closes the document and then runs out of tokens looking for the
    /// right operand of a `>`, so the failure's span is zero-width at EOF. The
    /// compile path reported that verbatim, `4:0-4:0`, and the page draws
    /// nothing at all for a zero-width range — the reader got a row saying
    /// "document" and no underline. `rustyfi_lsp::span_to_range` widens a
    /// degenerate span, backwards when there is nothing ahead of it, so there
    /// is a character to underline.
    ///
    /// The message is checked for what it must NOT contain as well: the
    /// payload used to be a `Debug` dump of syan's whole error tree, complete
    /// with byte offsets and a nested `Span { start: Loc { .. } }`.
    #[test]
    fn a_parse_failure_at_end_of_input_is_still_underlinable() {
        let src = "@require: stdja-mini\n\
                   document (|title = {t}; author = {a};|) '<\n  \
                     +p { hi }\n\
                   >>>\n";
        let diags = analyze(src, Lang::V0_0);
        assert_eq!(diags.len(), 1, "{diags:?}");
        let d = &diags[0];
        assert!(!d.message.contains("Loc {"), "{d:?}");
        assert!(!d.message.contains("span:"), "{d:?}");
        // Non-degenerate: the last `>` of line 4 (zero-based 3) through the
        // newline that ends it. Anything zero-width here is invisible.
        assert_eq!((d.line, d.character, d.end_line, d.end_character), (3, 3, 4, 0), "{d:?}");
    }

    /// The ORDER of the two tiers, stated as a property rather than assumed.
    ///
    /// A document that both fails to parse and names a package that does not
    /// exist must report the syntax, because the syntax is what the author is
    /// looking at. Repairing only the syntax must then surface the package.
    ///
    /// Worth knowing while reading this: it would pass even with tier 1
    /// removed, because `rustyfi_loader::load` also parses the entry before
    /// resolving a single header — a header cannot be found without parsing.
    /// So this pins the ORDER the page depends on, not the existence of tier
    /// 1; what tier 1 changes about this case is the span, above.
    #[test]
    fn syntax_is_reported_before_an_unresolvable_package() {
        let src = "@require: no-such-package-at-all\n\
                   document (|title = {t}; author = {a};|) '<\n  \
                     +p { hi }\n\
                   >>>\n";
        let diags = analyze(src, Lang::V0_0);
        assert_eq!(diags.len(), 1, "{diags:?}");
        assert!(
            !diags[0].message.contains("no-such-package-at-all"),
            "{diags:?}"
        );
        let fixed = src.replace(">>>", ">");
        let diags = analyze(&fixed, Lang::V0_0);
        assert_eq!(diags.len(), 1, "{diags:?}");
        assert!(
            diags[0].message.contains("no-such-package-at-all"),
            "{diags:?}"
        );
    }

    /// TIER 2. Parsing says nothing about a name that is not bound; only the
    /// program does, and this shim has the program.
    #[test]
    fn an_unbound_name_is_positioned_where_it_is_written() {
        let src = "@require: stdja-mini\n\
                   let x = nosuchvariable in\n\
                   document (|title = {t}; author = {a};|) '<\n  \
                     +p { hi }\n\
                   >\n";
        let diags = analyze(src, Lang::V0_0);
        assert_eq!(diags.len(), 1, "{diags:?}");
        // Line 2 of the source, zero-based 1; `let x = ` is eight characters.
        assert_eq!((diags[0].line, diags[0].character), (1, 8), "{diags:?}");
        assert_eq!(diags[0].end_line, 1);
        assert!(diags[0].message.contains("nosuchvariable"), "{diags:?}");
    }

    /// The trap this feature is most likely to fall into: the column is
    /// counted in the wrong unit and every marker in a Japanese document lands
    /// somewhere else. Checked on BOTH tiers, because they compute the column
    /// by completely different routes — tier 1 through a byte-keyed line
    /// index, tier 2 by re-reading the line — and a regression in either would
    /// be invisible in the other's test.
    #[test]
    fn a_column_after_japanese_text_is_not_a_byte_offset() {
        let jp = "let s = `吾輩は猫である` in ";
        let head = "@require: stdja-mini\n";
        let tail = "document (|title = {t}; author = {a};|) '<\n  +p { hi }\n>\n";

        // Tier 2: an unbound name after the Japanese.
        let line = format!("{jp}let y = nosuchvariable in");
        let src = format!("{head}{line}\n{tail}");
        let diags = analyze(&src, Lang::V0_0);
        assert_eq!(diags.len(), 1, "{diags:?}");
        let at = line.find("nosuchvariable").unwrap();
        let utf16 = line[..at].encode_utf16().count() as u32;
        assert_ne!(utf16, at as u32, "the fixture must not be all-ASCII");
        assert_eq!((diags[0].line, diags[0].character), (1, utf16), "{diags:?}");

        // Tier 1: a syntax error after the Japanese, on the same line. `@@` is
        // not a token in either generation, so the lexer stops exactly there.
        let line = format!("{jp}@@");
        let src = format!("{head}{line}\n{tail}");
        let diags = analyze(&src, Lang::V0_0);
        assert_eq!(diags.len(), 1, "{diags:?}");
        let at = line.find("@@").unwrap();
        let utf16 = line[..at].encode_utf16().count() as u32;
        assert_ne!(utf16, at as u32, "the fixture must not be all-ASCII");
        assert_eq!((diags[0].line, diags[0].character), (1, utf16), "{diags:?}");
    }

    /// One scalar, two UTF-16 units — the case a scalar count (which is what
    /// tier 2 reads out of a message) still gets wrong.
    #[test]
    fn an_astral_character_counts_as_two_units() {
        // `𠮷` is U+20BB7, outside the BMP.
        let src = "let a = 1 in\nlet b = `𠮷𠮷` in nosuchvariable\n";
        // Up to the opening backtick the two counts agree…
        assert_eq!(utf16_column(src, 2, 8), 8);
        // …and one astral scalar past it they differ by one, two scalars past
        // it by two. A scalar column used verbatim would land inside a
        // surrogate pair.
        assert_eq!(utf16_column(src, 2, 10), 11);
        assert_eq!(utf16_column(src, 2, 11), 13);
        // Past the end of the line clamps rather than running away.
        assert_eq!(
            utf16_column(src, 2, 9_999),
            src.split('\n').nth(1).unwrap().encode_utf16().count() as u32
        );
    }

    #[test]
    fn both_span_spellings_are_recognised() {
        assert_eq!(
            scan_span("line 4, characters 1-3: unbound variable 'x'"),
            Some((4, 1, 4, 3))
        );
        assert_eq!(
            scan_span("line 2, character 5 to line 7, character 1: bad"),
            Some((2, 5, 7, 1))
        );
        assert_eq!(scan_span("cannot resolve `@require: nope`"), None);
        assert_eq!(scan_span("line 4"), None);
    }

    /// A span the compiler reported against a BUNDLED PACKAGE must not place a
    /// marker in the user's own text.
    #[test]
    fn a_package_position_is_not_claimed_as_the_documents() {
        let src = "one\ntwo\nthree\n";
        let raw = format!(
            "{}/dist/packages/stdja-mini.satyh: line 2, characters 0-3: boom",
            crate::VIRTUAL_ROOT
        );
        assert_eq!(entry_span(src, &raw), None);
        // …whereas the same position attributed to the entry is taken.
        let mine = format!("{}: line 2, characters 0-3: boom", crate::ENTRY_PATH);
        assert_eq!(entry_span(src, &mine), Some((1, 0, 1, 3)));
    }

    /// An unattributed span naming a line the document does not have came from
    /// somewhere else in the merged program.
    #[test]
    fn an_unattributed_span_past_the_end_is_dropped() {
        let src = "one\ntwo\n";
        assert_eq!(entry_span(src, "line 900, characters 0-3: boom"), None);
        assert_eq!(entry_span(src, "line 2, characters 0-3: boom"), Some((1, 0, 1, 3)));
    }

    #[test]
    fn a_message_loses_the_position_the_editor_already_draws() {
        assert_eq!(
            tidy("line 2, characters 8-22: unbound variable 'x'"),
            "unbound variable 'x'"
        );
        assert_eq!(
            tidy("line 2, character 1 to line 4, character 2: bad"),
            "bad"
        );
        // A position that is not LEADING, or not followed by `: `, is part of
        // what the message says and stays.
        assert_eq!(
            tidy("the package declares it at line 2, characters 0-1"),
            "the package declares it at line 2, characters 0-1"
        );
        assert_eq!(tidy("no position at all"), "no position at all");
    }

    #[test]
    fn json_is_parseable_when_the_message_carries_quotes_and_newlines() {
        let json = to_json(&[Diag {
            line: 1,
            character: 2,
            end_line: 1,
            end_character: 5,
            severity: Severity::Error,
            message: "a \"quoted\" \\ thing\nover two lines\u{1}".into(),
        }]);
        assert!(json.contains(r#""severity":"error""#), "{json}");
        assert!(json.contains(r#"\"quoted\""#), "{json}");
        assert!(json.contains(r"\\ thing\n"), "{json}");
        // A raw control character would make the whole array unparseable.
        assert!(json.contains("\\u0001"), "{json}");
        assert_eq!(to_json(&[]), "[]");
        // The two severities the local copy of this enum did not have still
        // have a spelling, so a future warning cannot serialize as an error.
        for (s, want) in [
            (Severity::Warning, "warning"),
            (Severity::Information, "information"),
            (Severity::Hint, "hint"),
        ] {
            assert_eq!(severity_str(s), want);
        }
    }

    /// A 0.1 document analysed as 0.1 is clean, and the SAME document analysed
    /// as 0.0.6 is not — the language selector has to reach this path, or a
    /// 0.1 document would be underlined from end to end.
    #[test]
    fn the_generation_is_respected() {
        let src = "@require: v01-mini\n\nlet open V01Mini in\ndocument (| title = `v01` |) '<\n  +p { Hello from 0.1. }\n>\n";
        assert_eq!(analyze(src, Lang::V0_1), Vec::new());
        assert_eq!(analyze(src, Lang::V0_0).len(), 1);
    }
}
