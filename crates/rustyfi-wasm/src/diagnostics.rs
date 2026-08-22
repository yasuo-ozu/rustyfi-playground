//! Live diagnostics for an editor — the useful half of a language server,
//! without the protocol.
//!
//! # What this is, honestly
//!
//! [`analyze`] is the seam. Its CONTRACT is the one a real analysis would
//! satisfy: a list of positioned diagnostics over one source string, positions
//! zero-based, characters counted in **UTF-16 code units** so they drop
//! straight into a browser `textarea` (`setSelectionRange`, and the character
//! cells of a mirrored overlay).
//!
//! Its current IMPLEMENTATION does not satisfy the spirit of that contract, and
//! nothing here pretends otherwise: it **compiles the document and turns the
//! one error the compiler stopped at into one diagnostic**. So it reports the
//! FIRST problem and no others, it has no notion of a warning, and it says
//! nothing at all about a document that compiles. That is genuinely useful —
//! a syntax slip or an unbound name is positioned in the editor while you
//! type, rather than after you press Typeset — but it is not an analysis, and
//! the count it produces is never evidence that a document has exactly one
//! problem.
//!
//! When `rustyfi-lsp` lands in the typesetter and the submodule pin moves,
//! **[`analyze`] is the only function that changes**: its body becomes a call
//! to that crate's own `analyze`, mapping its `Diag` onto this one. Everything
//! else here — the JSON encoding, the C ABI export in `lib.rs`, and the whole
//! browser side — is written against [`Diag`] and needs no edit. The
//! compile-derived path below ([`from_compile_error`] and its helpers) is then
//! deletable in one piece.
//!
//! # Positions
//!
//! The typesetter's own diagnostics quote a [`rustyfi_syntax::Span`], whose
//! `Display` is `line L, characters A-B` (or, across lines, `line L1,
//! character A to line L2, character B`). `L` is 1-based and `A`/`B` count
//! **Unicode scalars**, not bytes and not UTF-16 code units — `lexer.rs`'s
//! `bump` advances `col` once per `char`. So the port's own numbers are
//! already immune to the byte-offset trap that would misplace every marker in
//! a Japanese document; what is left is the astral plane, where one scalar is
//! TWO UTF-16 units. [`utf16_column`] does that conversion by re-reading the
//! line, which is also what clamps a column the source cannot actually have.

use crate::Lang;

/// How loud a diagnostic is.
///
/// `Warning` is unreachable from the compile-derived path below — the compiler
/// either produces a document or stops — and exists because the analysis this
/// is a stand-in for will produce them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Error,
    Warning,
}

impl Severity {
    /// The JSON spelling, which is also the CSS class the page styles on.
    fn as_str(self) -> &'static str {
        match self {
            Severity::Error => "error",
            Severity::Warning => "warning",
        }
    }
}

/// One positioned diagnostic over the document being edited.
///
/// Both positions are zero-based, and both columns count UTF-16 code units.
/// The range is half-open, as an editor selection is: `character` is the first
/// unit covered, `end_character` the first not covered.
///
/// A diagnostic the analysis cannot pin to a place in THIS document — a
/// failure inside a bundled package, or one the compiler reported with no span
/// at all — is placed at the very start (all four fields `0`), which is what
/// a language server does with a whole-file problem.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Diag {
    pub line: u32,
    pub character: u32,
    pub end_line: u32,
    pub end_character: u32,
    pub severity: Severity,
    pub message: String,
}

/// Analyse `source` as `lang`, returning every diagnostic found.
///
/// **This is the one function to replace when `rustyfi-lsp` lands.** See the
/// module comment for what the current body actually does and does not do.
pub fn analyze(source: &str, lang: Lang) -> Vec<Diag> {
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
// Everything below is the compile-derived stand-in, and goes away with it.
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
        message: tidy(&crate::for_a_reader(raw)),
    }
}

/// Drop from a compiler message the two things an editor is already showing
/// or does not want.
///
/// * **The leading position.** `line 4, characters 1-3: parse error: …` is how
///   the message reads when it is the only output of a command-line run. Here
///   the position is the [`Diag`]'s own, rendered by the editor next to the
///   underline it drew, so repeating it in the text is noise. Only a LEADING
///   position is stripped, and only when a `: ` follows it — a position quoted
///   mid-sentence is part of what the message is saying.
/// * **An embedded `Debug`-rendered span.** A parse failure's payload is
///   syan's own `ParseError`, formatted with `{:?}`, so a message that already
///   says "line 4, characters 1-3" goes on to say `Expected { span: Span {
///   start: Loc { line: 4, col: 1, byte: 77 }, end: … }, what: "end of input" }`.
///   The byte offsets are the same position a third time. Removing the group
///   leaves `Expected { what: "end of input" }`, which is short enough to read
///   in a list.
///
/// Deliberately NOT applied to the Typeset pane's copy of the same message:
/// there the position is all the reader has, since nothing underlines it.
fn tidy(message: &str) -> String {
    let message = strip_leading_position(message).unwrap_or(message);
    strip_debug_spans(message)
}

/// `message` without a leading `line …: `, if it has one.
fn strip_leading_position(message: &str) -> Option<&str> {
    let (_, rest) = span_at(message.strip_prefix("line ")?)?;
    rest.strip_prefix(": ")
}

/// `message` with every `span: <Type> { … }` field removed, braces balanced.
///
/// Written as a scan rather than a pattern because the group nests (`Span {
/// start: Loc { .. } }`) and because a message with no such field — which is
/// most of them — must come back untouched.
fn strip_debug_spans(message: &str) -> String {
    let mut out = String::with_capacity(message.len());
    let mut rest = message;
    while let Some(at) = rest.find("span: ") {
        let after = &rest[at..];
        match balanced_group_len(after) {
            Some(len) => {
                out.push_str(&rest[..at]);
                // The field separator that follows it goes too, so the
                // remaining struct does not read `Expected { , what: .. }`;
                // and when the span was the ONLY field, the now-empty braces
                // are normalized to `{ }` rather than `{  }`.
                let tail = &after[len..];
                let tail = tail.strip_prefix(", ").unwrap_or(tail);
                if tail.trim_start().starts_with('}') {
                    while out.ends_with(' ') || out.ends_with(',') {
                        out.pop();
                    }
                    out.push(' ');
                    rest = tail.trim_start();
                } else {
                    rest = tail;
                }
            }
            None => {
                out.push_str(&rest[..at + "span: ".len()]);
                rest = &after["span: ".len()..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// The byte length of a `span: <Type> { … }` field starting at `s`, braces
/// balanced. `None` if there is no `{` before the next `,` or if the braces
/// never close.
fn balanced_group_len(s: &str) -> Option<usize> {
    let open = s.find('{')?;
    if s[..open].contains(',') {
        return None;
    }
    let mut depth = 0usize;
    // Byte indices from `open` onward — `skip(open)` would skip that many
    // CHARACTERS, which is not the same thing once a message quotes CJK.
    for (i, c) in s[open..].char_indices() {
        match c {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(open + i + 1);
                }
            }
            _ => {}
        }
    }
    None
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
///   marks the wrong line. It is the residual dishonesty of deriving a
///   position from a whole-program compile, and it is what a per-file
///   analysis fixes.
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
/// matching a whole message shape is what keeps this working across the six
/// error types that embed a span (`ParseFileError`, `ElabError`, `TypeError`,
/// `EvalError`, and the loader's two wrappers), none of which agree on what
/// surrounds it.
///
/// A non-position `line ` — a parse error's payload is a `Debug`-formatted
/// `Span { start: Loc { line: 4, .. } }`, which contains one — simply fails to
/// parse and the scan moves on, so the LEADING position still wins.
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
/// The whole reason this is not the identity: `＋` and `吾` are one scalar and
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
            d.severity.as_str()
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
    /// somewhere else. The offending name here sits AFTER the Japanese on its
    /// own line, so a byte count would be far too large.
    #[test]
    fn a_column_after_japanese_text_is_not_a_byte_offset() {
        let src = "@require: stdja-mini\n\
                   let s = `吾輩は猫である` in let y = nosuchvariable in\n\
                   document (|title = {t}; author = {a};|) '<\n  \
                     +p { hi }\n\
                   >\n";
        let diags = analyze(src, Lang::V0_0);
        assert_eq!(diags.len(), 1, "{diags:?}");
        let line = src.split('\n').nth(1).unwrap();
        let want = line.find("nosuchvariable").unwrap();
        // The BYTE offset is what a careless implementation reports, and the
        // Japanese is exactly what makes the two differ.
        let utf16 = line[..want].encode_utf16().count() as u32;
        assert_ne!(utf16, want as u32, "the fixture must not be all-ASCII");
        assert_eq!((diags[0].line, diags[0].character), (1, utf16), "{diags:?}");
    }

    /// One scalar, two UTF-16 units — the case a scalar count (which is what
    /// the port's own `Span` carries) still gets wrong.
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
    fn both_span_spellings_are_recognised_and_a_debug_payload_is_not() {
        assert_eq!(
            scan_span("line 4, characters 1-3: parse error: nope"),
            Some((4, 1, 4, 3))
        );
        assert_eq!(
            scan_span("line 2, character 5 to line 7, character 1: bad"),
            Some((2, 5, 7, 1))
        );
        // The leading position wins over the `Debug`-rendered `Loc { line: 9 }`
        // the parser's own payload carries.
        assert_eq!(
            scan_span("line 4, characters 1-3: parse error: Expected { span: Span { start: Loc { line: 9, col: 2 } } }"),
            Some((4, 1, 4, 3))
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
            "{}/dist/packages/stdja-mini.satyh: line 2, characters 0-3: parse error: nope",
            crate::VIRTUAL_ROOT
        );
        assert_eq!(entry_span(src, &raw), None);
        // …whereas the same position attributed to the entry is taken.
        let mine = format!("{}: line 2, characters 0-3: parse error: nope", crate::ENTRY_PATH);
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
    fn a_debug_rendered_span_is_removed_but_the_rest_of_the_payload_is_not() {
        assert_eq!(
            tidy(
                "line 4, characters 1-3: parse error: Expected { span: Span { start: \
                 Loc { line: 4, col: 1, byte: 77 }, end: Loc { line: 4, col: 3, byte: 79 } }, \
                 what: \"end of input\" }"
            ),
            "parse error: Expected { what: \"end of input\" }"
        );
        // A span as the ONLY field leaves a well-formed empty struct rather
        // than `{ , }`.
        assert_eq!(
            strip_debug_spans("Eof { span: Span { start: Loc { line: 1 } } }"),
            "Eof { }"
        );
        // Nothing to strip: untouched, including the word `span` used plainly.
        assert_eq!(strip_debug_spans("a span of text"), "a span of text");
        assert_eq!(
            strip_debug_spans("unbound variable 'x'"),
            "unbound variable 'x'"
        );
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
