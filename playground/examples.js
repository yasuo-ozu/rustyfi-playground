// The playground's example documents.
//
// Their own module rather than inline in the page, so `selftest.mjs` can
// compile every one of them against the real `.wasm` before a deploy. An
// example that does not typeset is worse than no example at all, and this is
// the only way to know without opening a browser.
//
// `needsFont` marks the ones that cannot work under the base-14 fonts: the
// `stdja` family renders page furniture containing an em dash, which is
// outside WinAnsi. Those are expected to FAIL without a font and to succeed
// with one, and the self-test checks both directions.

export const EXAMPLES = [
  {
    name: "Hello world",
    needsFont: false,
    source: `@require: stdja-mini

document (|
  title = {A first document};
  author = {rustyfi};
|) '<
  +p {
    Hello from WebAssembly. This document was typeset in your browser,
    by the same Rust code the command-line rustyfi runs.
  }
>
`,
  },
  {
    name: "Paragraphs and emphasis",
    needsFont: false,
    source: `@require: stdja-mini

document (|
  title = {Paragraphs};
  author = {rustyfi};
|) '<
  +p {
    SATySFi breaks paragraphs with a Knuth-Plass style line breaker, so this
    paragraph is set to fill its measure rather than simply wrapped at the
    right margin. Add or remove a few words and watch the whole paragraph
    re-flow, not just the last line.
  }
  +p {
    Inline commands work as usual: \\emph{emphasised text} sits inside an
    ordinary paragraph.
  }
>
`,
  },
  {
    name: "Math",
    needsFont: false,
    source: `@require: stdja-mini
@require: math

document (|
  title = {Math};
  author = {rustyfi};
|) '<
  +p {
    Inline math is written between \`\${\` and \`}\`, like \${1 + 2 = 3},
    and is set with the math layout engine rather than as plain text.
  }
  +p {
    Note that most math symbols live outside WinAnsi, so anything beyond
    ASCII needs a font supplied above.
  }
>
`,
  },
  {
    name: "Inline code",
    needsFont: false,
    source: `@require: stdja-mini
@require: code

document (|
  title = {Code};
  author = {rustyfi};
|) '<
  +p {
    A backtick literal such as \`let x = 1 in x + 1\` is set in the
    context's code font.
  }
>
`,
  },
  {
    name: "Full stdja class (needs a font)",
    needsFont: true,
    source: `@require: stdja

% The stdja family renders its own title block and page furniture with
% characters outside WinAnsi, so this example needs a font supplied with the
% picker above. Without one it fails with an honest encoding error rather
% than dropping the characters.

document (|
  title = {A document with a title page};
  author = {rustyfi};
  show-title = true;
  show-toc = false;
|) '<
  +section { Introduction } <
    +p {
      The full stdja class gives you sections, a title block and running
      page furniture.
    }
  >
>
`,
  },
];
