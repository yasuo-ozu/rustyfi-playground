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
    name: "Displayed equations",
    needsFont: true,
    source: `@require: stdja-mini
@require: math

document (|
  title = {Displayed equations};
  author = {rustyfi};
|) '<
  +p {
    \`+math\` sets an equation on its own line. Fractions nest, radicals grow to
    fit what is under them, and \`\\paren\` stretches to its contents rather than
    being a fixed-height glyph.
  }
  +math(\${
    x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}
  });
  +p {
    Big operators carry their limits above and below in display style:
  }
  +math(\${
    \\sum_{k=1}^{n} k^2 = \\frac{n \\paren{n + 1} \\paren{2n + 1}}{6}
  });
  +math(\${
    \\int_{0}^{\\infty} e^{-x^2} \\ordd x = \\frac{\\sqrt{\\pi}}{2}
  });
  +math(\${
    \\lim_{n \\to \\infty} \\paren{1 + \\frac{1}{n}}^n = e
  });
>
`,
  },
  {
    name: "Aligned equations",
    needsFont: true,
    source: `@require: stdja-mini
@require: math

document (|
  title = {Aligned equations};
  author = {rustyfi};
|) '<
  +p {
    \`+align\` takes a list of rows, each a list of cells. The cells are aligned
    on their column boundaries, which is how a derivation lines up on its
    relation symbol.
  }
  +align([
    [\${\\paren{a + b}^2}; \${= a^2 + 2ab + b^2}];
    [\${\\paren{a - b}^2}; \${= a^2 - 2ab + b^2}];
    [\${\\paren{a + b}\\paren{a - b}}; \${= a^2 - b^2}];
  ]);
  +p {
    Nesting is unrestricted, so a fraction may contain a radical containing a
    sum, and each level is set at the right script size:
  }
  +math(\${
    \\sqrt{\\frac{1}{n} \\sum_{i=1}^{n} \\paren{x_i - \\mu}^2}
  });
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
