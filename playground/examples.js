// The playground's example documents.
//
// Their own module rather than inline in the page, so `selftest.mjs` can
// compile every one of them against the real `.wasm` before a deploy. An
// example that does not typeset is worse than no example at all, and this is
// the only way to know without opening a browser.
//
// `needsFont` marks the ones that cannot work under the base-14 fonts: the
// `stdja` family renders page furniture containing an em dash, and the two
// equation examples use symbols outside WinAnsi. Those are expected to FAIL
// without a font and to succeed with one, and the self-test checks both
// directions.
//
// `needsCjk` marks the ones that additionally need the JAPANESE face, and it
// is a stronger claim than `needsFont`: an example that needs a font FAILS
// without one, but an example that needs the CJK face SUCCEEDS without it and
// draws nothing, because a font with no glyph for 日 renders .notdef rather
// than refusing. The self-test therefore checks the rendered PDF for these
// rather than checking that they compiled — see its section 7b, which also
// keeps the without-CJK control, so a check that stopped discriminating would
// be caught rather than staying quietly green.
//
// `lang` is the SATySFi generation the source is written in — `0` for 0.0.6
// and `1` for 0.1 — and is OMITTED wherever it is 0, which is the default and
// what every example here predates. It is not decoration: the two generations
// have different grammars and different bundled corpora, so compiling an entry
// under the wrong one is a parse error rather than a subtly different render.
// Choosing an example sets the header's Lang selector from this field; the
// self-test compiles each entry under it.
//
// `refuses` is a regular expression, and marks an example that is EXPECTED
// NOT TO COMPILE — the cross-version refusal at the end of the list, which
// exists to show what a deliberate, explained refusal looks like. The
// self-test asserts the failure and that its message matches, which is
// stricter than asserting a compile: a refusal that started saying something
// else, or that quietly became a success, would both fail.
//
// Every example after "Inline code" exercises one bundled third-party package
// and is adapted from that package's own documentation, cited at the top of
// each source.
//
// These are JS template literals, so a SATySFi backslash is written `\\`, a
// backtick `` \` `` and a `${` `\${`. Getting that wrong is silent, which is
// the other reason the self-test compiles all of them.

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
    name: "Equation gallery",
    needsFont: true,
    source: `% Big operators are the part worth looking at. A display-size sum or
% integral is a DIFFERENT GLYPH from the one its character maps to --
% the font's MATH table supplies it as a variant, addressable only by
% glyph id. An SVG <text> can name a character but not a glyph id, so
% the HTML backend draws these from the font outline as a <path>.
% Before that, they came out base-size with their limits hanging off
% to one side, because the layout had been computed for the big glyph.

@require: stdja-mini
@require: math

document (| title = {Equations}; author = {rustyfi}; |) '<
  +p {
    Every equation here is set by the same compiler that produces the PDF, then
    serialized as HTML. A glyph is text where a character names it, and an SVG
    path drawn from the font outline where the MATH table supplies a display
    variant that no character names — which is what makes the operators below
    the right size with their limits centred.
  }

  +p { Big operators carry their limits: }
  +math(\${ \\sum_{k=1}^{n} k^2 = \\frac{n \\paren{n + 1} \\paren{2n + 1}}{6} });
  +math(\${ \\int_{0}^{\\infty} e^{-x^2} \\ordd x = \\frac{\\sqrt{\\pi}}{2} });
  +math(\${ \\prod_{k=1}^{n} \\frac{k}{k + 1} = \\frac{1}{n + 1} });

  +p { Fractions nest, radicals grow, and fences stretch to their contents: }
  +math(\${ x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a} });
  +math(\${ \\frac{1}{1 + \\frac{1}{1 + \\frac{1}{1 + \\frac{1}{2}}}} = \\frac{8}{13} });
  +math(\${ \\sqrt{\\sqrt{\\sqrt{x}}} = x^{1/8} });
  +math(\${ \\abs{\\frac{a}{b}} \\leq \\norm{\\frac{a}{b}} \\leq \\ceil{\\frac{a}{b}} });
  +math(\${ \\lim_{n \\to \\infty} \\paren{1 + \\frac{1}{n}}^n = e });

  +p {
    The bundled Junicode covers no Greek and no set-theory symbols, so this
    example stays inside what it can draw. Supply a fuller face with the font
    picker and Greek, quantifiers and set operators follow.
  }
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
  {
    name: "Japanese (stdja, needs a font)",
    needsFont: true,
    needsCjk: true,
    source: `@require: stdja

% SATySFi is a Japanese typesetter, and this is what it was built for: mixed
% Japanese and Latin, with the inter-script spacing and the line breaking
% handled rather than left to luck.
%
% The Japanese face (IPAexGothic, 5.8 MB) is fetched the first time a document
% contains Japanese — not on page load, because most documents here do not.
% Watch the status line the first time you typeset this one.
%
% \\emph switches to a gothic face for CJK, so it stands out from the mincho
% body the way italic does in Latin text. Here both are the same file, since
% the page fetches one face and answers to both names with it.

document (|
  title = {日本語の組版};
  author = {rustyfi};
  show-title = true;
  show-toc = false;
|) '<
  +section { はじめに } <
    +p {
      これは日本語の文書です。SATySFi は組版処理システムであり、
      \\emph{行分割}や\\emph{文字間の調整}を自動で行います。
    }
    +p {
      Latin と日本語が同じ段落に混ざる場合、その境目には自然な空きが
      入ります — for example, the word \\emph{typesetting} sits inside
      Japanese text with a quarter-em on either side, which is JLreq's
      rule and not a space anybody typed.
    }
  >
  +section { 引用 } <
    +p {
      吾輩は猫である。名前はまだ無い。どこで生れたかとんと見当がつかぬ。
      何でも薄暗いじめじめした所でニャーニャー泣いていた事だけは記憶している。
    }
  >
>
`,
  },
  {
    name: "Syntax highlighting (code-printer)",
    needsFont: false,
    source: `% code-printer highlights a source listing. It drives \`string-scan\`, a
% regexp primitive whose absence used to stop the package loading at all.
%
% The colours are the theme's; the FOUR code faces it also asks for are not
% bundled here, so keyword/identifier/string/comment share one face. The
% highlighting is unaffected — only the typographic distinction is.

@require: stdja-mini
@require: code-printer/code-printer
@require: code-printer/code-theme
@require: code-printer/code-syntax

document (|
  title = {Syntax highlighting};
  author = {};
  show-title = false;
  show-toc = false;
|) '<
  +p { Rust, in the \`basic-light\` theme: }
  +code-printer ?:(
    CodePrinter.make-config CodeSyntax.rust CodeTheme.basic-light
  )(\`fn main() {
    // greet, twice
    let greeting = "hello";
    for i in 0..2 {
        println!("{} {}", greeting, i);
    }
}\`);

  +p { The same listing as OCaml, in \`gruvbox-dark\`: }
  +code-printer ?:(
    CodePrinter.make-config CodeSyntax.ocaml CodeTheme.gruvbox-dark
  )(\`let () =
  (* greet, twice *)
  let greeting = "hello" in
  for i = 0 to 1 do
    Printf.printf "%s %d\\n" greeting i
  done\`);
>
`,
  },
  {
    name: "Tables (easytable)",
    needsFont: false,
    source: `% Adapted from easytable's own manual, layout-tests/corpus/easytable/doc/easytable.saty.

@require: stdja-mini
@require: easytable/easytable

open EasyTableAlias

document (|
  title = {Tables};
  author = {rustyfi};
|) '<
  +p {
    The second argument is one flat inline text. Cell boundaries are the
    vertical bars, so a table reads in the source the way it prints.
  }
  +easytable[l; c; r]{
    | header1    | header2      | header3
    | align left | align center | align right
    | a          | b            | c
    |}
  +p {
    Rules go in an optional first argument: \\emph{t} and \\emph{b} for the
    top and bottom, \\emph{m n} for one after row n.
  }
  +easytable?:[t; b; m 1][r; c; l]{
    | How       | I       | want
    | a         | drink   | alcoholic
    | of        | course  | after
    |}
>
`,
  },
  {
    name: "Lists (enumitem)",
    needsFont: false,
    source: `% Adapted from enumitem's own manual, layout-tests/corpus/enumitem/doc/enumitem.saty.

@require: stdja-mini
@require: enumitem/enumitem

open EnumitemAlias

document (|
  title = {Lists};
  author = {rustyfi};
|) '<
  +p {
    Nesting is by the number of stars, and the label style is one optional
    argument.
  }
  +listing{
    * a bulleted item
    * another, with children
      ** nested one level
        *** and two
      ** back out again
  }
  +enumerate?:(paren-alph){
    * numbered, with the label style chosen by the option
    * the counters nest with the list
      ** so this one is lettered too
  }
>
`,
  },
  {
    name: "Floating figures (stdjareport)",
    needsFont: true,
    source: `% A stdjareport \\figure does NOT sit where you write it. The class registers
% it on the page it appears on and emits it at the top of a LATER page, out of
% the page-parts callback — so the document has to be long enough to have a
% later page, which is what the filler below is for. Scroll to page 2.
%
% Until rustyfi 0.1.4 this rendered NOTHING, in PDF or anywhere else: the port
% fired page-break hooks after the whole page loop had finished, so the float
% list was always empty by the time a header was built. Upstream interleaves
% them per page.
%
% Switch Output to HTML and the figure disappears again — that one is honest,
% not a regression. A continuous web document has no "top of the next page" to
% float to, and the reflowable backend reads the block stream from BEFORE page
% breaking, where a \\figure contributes nothing at all. Where such a figure
% should land in a pageless document is still an open question.

@require: stdjareport
@require: color

let-inline ctx \\bars =
  let w = 60pt in let h = 18pt in
  inline-graphics w h 0pt (fun (x, y) -> (
    [0; 1; 2; 3; 4] |> List.map (fun i -> (
      let fi = float i in
      let bx = x +' w *' (0.02 +. fi *. 0.2) in
      fill (Color.gray (0.75 -. fi *. 0.12))
        (Gr.rectangle (bx, y) (bx +' w *' 0.14, y +' h *' (0.25 +. fi *. 0.18)))
    ))
  ))

let-block ctx +center it =
  line-break true true ctx (inline-fil ++ read-inline ctx it ++ inline-fil)

let filler = {A floating figure is page furniture: the class registers it on the
page where you write it, and emits it at the top of a later one. So a document
has to be long enough to have a later page, or the figure has nowhere to go.}
in

document (| title = {Floating figures}; author = {rustyfi}; |) '<
  +chapter {Registered here, printed overleaf} <
    +p {
      \\figure ?:(\`f1\`) {A bar chart} < +center { \\bars; } >
      is registered in this paragraph and appears at the top of the next page.
    }
    +p { #filler; } +p { #filler; } +p { #filler; } +p { #filler; }
    +p { #filler; } +p { #filler; } +p { #filler; } +p { #filler; }
  >
>
`,
  },
  {
    name: "Figures (figbox)",
    needsFont: false,
    source: `% Adapted from figbox's own manual, layout-tests/corpus/figbox/doc/manual.saty.

@require: stdja-mini
@require: gr
@require: color
@require: figbox/figbox

open FigBox

document (|
  title = {Figures};
  author = {rustyfi};
|) '<
  +p {
    A figbox is a rectangle you build up and then place. Text becomes one:
  }
  +fig-center(textbox-with-width 140pt
    {The quick brown fox jumps over the lazy dog.} |> frame 1pt (Color.gray 0.8));
  +p {
    So do graphics, sized either by hand or from their own bounding box:
  }
  +fig-center(from-graphics (150pt, 100pt) [
    Gr.circle (30pt, 40pt) 20pt |> fill Color.blue;
    Gr.rectangle (30pt, 40pt) (90pt, 80pt) |> stroke 2pt Color.red;
    Gr.rectangle-round 4pt (70pt, 90pt) (120pt, 10pt) |> stroke 5pt Color.orange;
  ] |> frame 1pt (Color.gray 0.8));
  +p {
    And boxes compose, so a row of figures is one \\emph{hconcat}:
  }
  +fig-center(hconcat [
    dummy-box 60pt 40pt;
    gap 10pt;
    textbox {caption} |> hvmargin 6pt |> frame 1pt Color.black;
  ]);
>
`,
  },
  {
    name: "Boxes and rotation (latexcmds)",
    needsFont: false,
    source: `% Adapted from latexcmds' own manual,
% layout-tests/corpus/latexcmds/doc/latexcmds-doc.saty.

@require: stdja-mini
@require: color
@require: latexcmds/latexcmds

document (|
  title = {LaTeX-like commands};
  author = {rustyfi};
|) '<
  +p {
    Four box decorations, each taking the same optional line width, padding,
    stroke colour and fill colour: \\fbox{fbox}, \\doublebox{doublebox},
    \\ovalbox{ovalbox}, \\shadowbox{shadowbox}.
  }
  +p {
    With those options given:
    \\fbox ?:(2pt) ?:(6pt) ?:(Color.blue) ?:(RGB(0.9, 1.0, 0.95)) {hello}, and
    \\shadowbox ?:(1pt) ?:(6pt) ?:(Color.black) ?:(Color.white) ?:(4pt) ?:(Color.red) {hello}.
  }
  +p {
    \\framebox(4cm){a fixed-width box wraps its contents}, then
    \\scalebox?:(2.0)?:(2.0){Ouch} and \\rotatebox(0.5){tilted}.
  }
>
`,
  },
  {
    name: "Rails and curves (railway)",
    needsFont: false,
    source: `% railway ships no manual — this is built from the API its own \`rail.satyh\`
% documents in comments, and from the way SlyDIFi's themes actually call it
% (layout-tests/corpus/slydifi/src/theme/*.satyh).

@require: stdja-mini
@require: color
@require: railway/railway

let-inline ctx \\diagram =
  let grf (x, y) =
    let edge = Rail.(init |> push-line (18pt, 18pt)) in
    let square =
      Rail.(map-repeat (fun i -> edge ^ (90. *. (float i))) 4)
        |> Rail.to-loop (x +' 10pt, y +' 4pt)
    in
    let leaf =
      Rail.(init |> push-smooth-curve (30pt, 0pt) (14pt, 22pt)
                 |> push-smooth-curve (0pt -' 30pt, 0pt) (0pt -' 14pt, 22pt))
        |> Rail.to-loop (x +' 60pt, y +' 4pt)
    in
    [ square |> stroke 1pt Color.black
    ; leaf |> fill (Color.gray 0.75) ]
  in
  inline-graphics 110pt 42pt 0pt grf

in

document (|title = {Rails}; author = {rustyfi};|) '<
  +p {
    A \\emph{rail} is a run of line and Bezier segments with no absolute
    position, so it can be rotated, scaled and repeated before it is pinned
    to a point. \\diagram; is one square built by repeating a single edge at
    four angles, and one closed curve built from two smooth segments.
  }
  +p {
    The wavy underline is the same idea applied to text: \\uwave{a rail cut
    to the measured width of the box it decorates}.
  }
>
`,
  },
  {
    name: "Path algorithms (xpath)",
    needsFont: false,
    source: `% Adapted from xpath's own manual, layout-tests/corpus/xpath/doc/xpath-doc.saty
% — the self-intersecting star, with \`get-intersections\` marking the crossings.

@require: stdja-mini
@require: gr
@require: list
@require: color
@require: code
@require: xpath/xpath

let-inline ctx \\star =
  let grf (x, y) =
    let star = XPath.(
      [2.; 4.; 1.; 3.] |> List.fold-left (fun pp r -> (
        let theta = r *. 6.28 /. 5. +. 1.57 in
        pp |> line-to (x +' 40pt *' (cos theta), y +' 40pt +' 40pt *' (sin theta))
      )) (start-path (x, y +' 80pt)) |> close-with-line
    ) in
    let marks = XPath.get-intersections 0.2pt star
      |> List.map (fun p -> Gr.circle p 3pt |> fill Color.yellow)
    in
    (star |> XPath.stroke 1pt Color.blue) :: marks
  in
  inline-graphics 84pt 84pt 0pt grf

in

document (|title = {Paths}; author = {rustyfi};|) '<
  +p {
    \\code(\`XPath.t\`); is a path built the same way the built-in one is, but
    it can also be asked questions. Here a five-point star is folded out of
    four \\code(\`line-to\`); steps, and \\code(\`get-intersections\`); finds every
    point where it crosses itself.
  }
  +p { \\star; }
>
`,
  },
  {
    name: "Slides (SlyDIFi)",
    needsFont: false,
    source: `% Adapted from SlyDIFi's own slide deck, layout-tests/corpus/slydifi/doc/slydifi.saty.
% That deck uses the \`arctic\` theme with Japanese fonts; \`plain\` is the theme
% that needs no font beyond the one you are already typesetting with.

@require: class-slydifi/theme/plain

SlydifiThemePlain.document '<
  +make-title(|
    title = {| SlyDIFi in the browser |};
    author = {| rustyfi |};
    date = {| today |};
  |);
  +frame{A slide}<
    +p { Every frame is one page, laid out by the theme rather than by a
         page-break algorithm. }
  >
  +frame{Overlays}<
    +listing{
      * items appear
      * one frame at a time
    }
  >
>
`,
  },
  {
    name: "Standard library (base)",
    // Flipped when the submodule pin moved to the typesetter's 0.1.1: text
    // inside a line-stacked `EmbeddedBlock` used to be dropped, which silently
    // swallowed the CONTENTS of the natural-deduction tree at the end of this
    // document. Now they are typeset, and one of them is `\vdash` (⊢), which
    // is outside WinAnsi. So the example did not change and neither did the
    // label's meaning — the renderer stopped losing the character that makes
    // it true.
    needsFont: true,
    source: `% Adapted from satysfi-base's own README, whose TL;DR opens with \`Inline.read\`,
% and from its \`__test__/satysrc/derive\` cases.

@require: stdja-mini
@require: code
@require: math
@require: base/typeset/base
@require: base/typeset/derive
@require: base/inline
@require: base/int
@require: base/list-ext
@require: base/string

open Derive

let squares =
  List.iterate 6 (fun n -> n + 1) 0
    |> List.map (fun n -> Int.to-string (n * n))
    |> List.intersperse \`, \`
    |> List.fold-left (^) \` \`

in

document (|title = {Base}; author = {rustyfi};|) '<
  +p {
    \\code(\`satysfi-base\`); is a standard library: basic types, data
    structures, text processing, and extra typesetting. Its README opens with
    \\code(\`Inline.read\`);, which turns inline text into boxes under whatever
    context you hand it, and everything else composes the same way.
  }
  +p {
    Six squares, built with \\code(\`List.iterate\`);, \\code(\`List.map\`); and
    \\code(\`List.intersperse\`);:
    \\eval(Inline.of-string squares);
  }
  +p {
    And \\code(\`typeset/derive\`); renders natural-deduction trees inside math:
    \${\\proven!(
      open DeriveDSL in
      derive \${\\vdash A \\wedge B}
      |> by {\${\\wedge} I}
      |> from [
        assume \${\\vdash A};
        assume \${\\vdash B};
      ]
    )}
  }
>
`,
  },
  {
    name: "The rustyfi logo (xpath)",
    needsFont: false,
    source: `@require: color
@require: list
@require: math
@require: xpath/xpath

% An excerpt of rustyfi's own logo (manual/logo.saty), which draws every mark
% on the page as a \`satysfi-xpath\` path. The full file adds a lit bevel, coin
% beading, specular arcs and the engraved syntax marks; this keeps the parts
% that make the shape: the cog, the rim, the guilloche and the logotype.

let pw = 264pt
let cx = 132pt
let cy = 132pt
let tau = 6.283185307179586
let kappa = 0.5522847498307936   % circle-from-4-beziers magic constant

let c-rim   = Color.rgb 0.34 0.11 0.03
let c-oxide = Color.rgb 0.76 0.30 0.08
let c-deep  = Color.rgb 0.42 0.15 0.05
let c-ember = Color.rgb 0.97 0.68 0.26
let c-page  = Color.rgb 0.98 0.955 0.90
let c-line  = Color.rgb 0.89 0.84 0.72
let c-ink   = Color.rgb 0.13 0.11 0.12

% A full circle as one closed XPath, centred at the origin.
let circle-at-origin r =
  let k = r *' kappa in
  XPath.start-path (r, 0pt)
    |> XPath.bezier-to (r, k) (k, r) (0pt, r)
    |> XPath.bezier-to (0pt -' k, r) (0pt -' r, k) (0pt -' r, 0pt)
    |> XPath.bezier-to (0pt -' r, 0pt -' k) (0pt -' k, 0pt -' r) (0pt, 0pt -' r)
    |> XPath.bezier-to (k, 0pt -' r) (r, 0pt -' k) (r, 0pt)
    |> XPath.terminate-path

let circle c r = circle-at-origin r |> XPath.shift-path c

let rotate-path th p =
  XPath.linear-transform-path (cos th) (0.0 -. (sin th)) (sin th) (cos th) p

% Fold one shape rotated \`n\` ways into a SINGLE path, so the whole ring of
% copies is one fill. Teeth and guilloche are both built this way.
let rosette n shape =
  let-rec go i acc =
    if i == n then acc
    else go (i + 1) (XPath.unite-path acc (rotate-path (tau *. (float i) /. (float n)) shape))
  in
  go 1 shape

% One cog tooth, pointing along +y, convex across the top.
let tooth =
  let xb = 84pt *' (sin 0.088) in
  let yb = 84pt *' (cos 0.088) in
  let xt = 112pt *' (sin 0.044) in
  let yt = 112pt *' (cos 0.044) in
  XPath.start-path (0pt -' xb, yb)
    |> XPath.line-to (0pt -' xt, yt)
    |> XPath.bezier-to (0pt -' (xt *' 0.4), yt +' 1.2pt) (xt *' 0.4, yt +' 1.2pt) (xt, yt)
    |> XPath.line-to (xb, yb)
    |> XPath.close-with-line

let cog = rosette 16 tooth |> XPath.shift-path (cx, cy)

% Engine-turning: 48 circles whose centres sit on a ring of their own radius,
% so every one passes through the middle.
let guilloche =
  rosette 48 (circle-at-origin 31pt |> XPath.shift-path (0pt, 31pt))
    |> XPath.shift-path (cx, cy)

let ctx = get-initial-context pw (command \\math)
      |> set-dominant-narrow-script Latin
      |> set-font-size 30pt

% There is no stroked type, so the logotype is drawn 16 times around a small
% circle in the outline colour and once more in the page tone on top: what
% survives between the copies IS the outline.
let logotype =
  let ib c = read-inline (ctx |> set-text-color c) {rustyfi} in
  let (w, h, d) = get-natural-metrics (ib c-ink) in
  let x = cx -' (w *' 0.5) in
  let y = cy -' ((h -' d) *' 0.5) in
  let-rec halo i =
    if i == 16 then []
    else
      let th = tau *. (float i) /. 16.0 in
      (draw-text (x +' (1.4pt *' (cos th)), y +' (1.4pt *' (sin th))) (ib c-deep))
        :: (halo (i + 1))
  in
  % \`{\` and \`}\` are SATySFi's inline-text delimiters: flanking the logotype
  % with them says what this program eats, in the language's own notation.
  let brace str px =
    let bb = read-inline (ctx |> set-font-size 46pt |> set-text-color c-oxide)
               (embed-string str) in
    let (bw, bh, bd) = get-natural-metrics bb in
    draw-text (px -' (bw *' 0.5), cy -' ((bh -' bd) *' 0.5)) bb
  in
  List.concat
    [ [ brace \`{\` (x -' 12pt); brace \`}\` (x +' w +' 12pt) ]
    ; halo 0
    ; [ draw-text (x, y) (ib c-page) ]
    ]

let emblem =
  List.concat
    [ [ XPath.fill c-deep cog ]
    ; [ XPath.fill c-rim (circle (cx, cy) 95pt) ]
    ; [ XPath.fill c-ember (circle (cx, cy) 93pt) ]
    ; [ XPath.fill c-oxide (circle (cx, cy) 89pt) ]
    ; [ XPath.fill c-page (circle (cx, cy) 79pt) ]
    ; [ XPath.stroke 0.22pt c-line guilloche ]
    ; [ XPath.stroke 1.5pt c-oxide (circle (cx, cy) 79.4pt) ]
      % The margin guide is DERIVED from the page outline by \`offset-path\`,
      % the operation satysfi-xpath has and the built-in path API does not.
    ; [ XPath.dashed-stroke 0.75pt (2.6pt, 3.0pt, 0pt) c-oxide
          (XPath.offset-path 6pt (circle (cx, cy) 79pt)) ]
    ; logotype
    ]

let body =
  line-break false false ctx
    (inline-graphics pw pw 0pt (fun (x, y) ->
       emblem |> List.map (shift-graphics (x, y))))
in

page-break (UserDefinedPaper (pw, pw))
  (fun _ -> (| text-origin = (0pt, 0pt); text-height = pw; |))
  (fun _ -> (| header-origin = (0pt, 0pt); header-content = block-nil;
               footer-origin = (0pt, 0pt); footer-content = block-nil; |))
  body
`,
  },

  // ---------------------------------------------------------------------
  // SATySFi 0.1 (the dev-0-1-0 / saphe-split line).
  //
  // A separate generation, not a dialect: different grammar, different
  // bundled corpus, and the two do not mix here — the module mounts exactly
  // one corpus per compile. Every entry below therefore carries `lang: 1`,
  // and picking one moves the header's Lang selector with it.
  // ---------------------------------------------------------------------

  {
    name: "0.1: A first document",
    lang: 1,
    needsFont: false,
    source: `% SATySFi 0.1. Choose 0.1 in the Lang selector above — this document is a
% parse error under 0.0.6, and every 0.0.6 example above is a parse error
% under 0.1. Each generation has its own bundled package corpus, and
% @require: resolves against exactly one of them.
%
% What is different from 0.0.6, all of it visible below:
%
%   - a package IS a module, so its bindings are reached qualified
%     (V01Mini.document) or brought into scope with "let open M in" — note
%     the leading "let", which 0.0.6's bare "open M in" did not have;
%   - records separate their fields with a comma, not a semicolon;
%   - math is split in two. \${...} is math-TEXT, the unevaluated source, and
%     read-math turns it into math-BOXES; that is why V01Mini declares its
%     fraction as "val math ctx \\frac numer denom" and reads each argument
%     explicitly rather than receiving boxes.

@require: v01-mini

let open V01Mini in
document (| title = \`A first document\` |) '<
  +p {
    Typeset in your browser by the same Rust code the command-line rustyfi
    runs, read with the SATySFi 0.1 grammar rather than 0.0.6's.
  }
  +p {
    Inline commands are module members too: \\emph{emphasised} and
    \\bold{bold} are both val inline bindings inside V01Mini, in scope
    without a prefix because of the let open above.
  }
  +p {
    Math comes through that same split: \${a^2 + b^2 = c^2}, a fraction
    \${\\frac{1}{x + 1}}, and a limit \${\\lim_{n} a_n = L}.
  }
>
`,
  },
  {
    name: "0.1: Modules and sealing",
    lang: 1,
    needsFont: false,
    source: `% The headline difference from 0.0.6: a package is a real module, and a
% module can be SEALED. The bundled V01Sealed is declared
%
%   module V01Sealed :> sig
%     type t :: o
%     val make : int -> t
%     val get : t -> int
%     val \\show : inline [t]
%   end = struct ... end
%
% The sealing sigil is :>, never 0.0.6's "module M : sig ... end" — that
% spelling is a parse error in 0.1. "type t :: o" declares t OPAQUE, so its
% real definition (a one-constructor variant) does not escape: the
% constructor is deregistered at the seal point, and make/get/\\show are the
% only way to build, read or print one from out here.

@require: v01-mini
@require: v01-sealed

let open V01Mini in

let boxed = V01Sealed.make 41 in
let answer = embed-string (arabic (V01Sealed.get boxed + 1)) in

% V01Mini is UNSEALED, so let open puts all of it in scope at once: a
% val rec, a user-defined operator, and a variant with its constructors.
let total = embed-string (arabic (sum-list [1, 2, 3, 4])) in
let label =
  match Known 7 with
  | Known n -> embed-string (arabic (n +++ 0))
  | Unknown -> embed-string \`unknown\`
  end
in

document (| title = \`Modules and sealing\` |) '<
  +p {
    Reading a sealed value back and adding one gives #answer;. Nothing out
    here can look inside it: only the three members the signature exports.
  }
  +p {
    A qualified inline command runs the module's own code:
    \\V01Sealed.show(V01Sealed.make 7);
  }
  +p {
    And from the opened V01Mini: its recursive sum is #total;, and its
    user-defined operator, applied inside a match on its own variant,
    gives #label;.
  }
>
`,
  },
  {
    name: "0.1: Multi-stage (quote and splice)",
    lang: 1,
    needsFont: false,
    source: `% Multi-stage evaluation. "&e" QUOTES an expression — its value is code, to
% be run one stage later — and "~e" SPLICES in the result of a computation
% from the stage before.
%
% A document is stage 1, so a bare quote here is refused outright:
%
%   let c = &(1) in ...
%   -> \`&\` (next-stage quote) is only valid at stage 0, but this is stage 1
%
% The way in is a splice, because a splice reads its OPERAND one stage
% earlier. Everything inside the two "~( ... )" below therefore runs before
% the document does, and every "&" inside those builds a piece of the
% program the document will actually run.
%
% One part of the 0.1 staging surface CANNOT appear here. 0.1 replaced
% 0.0.6's whole-file "@stage:" header with a per-binding qualifier,
% "val ~x" and "val persistent ~x" — but those are LIBRARY bindings, and 0.1
% has neither an expression-level module nor a staged "let", so a
% single-file document has nowhere to put one. The playground compiles
% exactly one file, so they are out of reach here rather than unsupported;
% rustyfi's crates/rustyfi-lang/tests/staging_v1.rs exercises them.

@require: v01-mini

% Stage-0 recursion that BUILDS code rather than computing a number: each
% step quotes a multiplication whose right operand is spliced in from the
% step before, so what reaches the document is 3 * (3 * (3 * 1)) as an
% expression — unrolled at stage 0, run at stage 1.
let cube =
  ~(
    let rec pow n = if n <= 0 then &(1) else &( 3 * ~(pow (n - 1)) ) in
    pow 3
  )
in

% "code int" is 0.1's type for a quoted int. 0.0.6 has no spelling for it at
% all — deliberately, matching upstream — so this annotation is 0.1-only.
% It types the parameter of a stage-0 function that duplicates whatever code
% it is handed, without ever running it.
let doubled =
  ~(
    let twice (c : code int) = &( ~c + ~c ) in
    twice (&(21))
  )
in

let a = embed-string (arabic cube) in
let b = embed-string (arabic doubled) in

let open V01Mini in
document (| title = \`Multi-stage\` |) '<
  +p {
    The unrolled power gives #a;, and the duplicating macro gives #b;.
  }
  +p {
    Neither number was computed by this document. Both arrived as code
    assembled one stage earlier, and all the document did was run it.
  }
>
`,
  },
  {
    name: "0.1: Lists (itemize)",
    lang: 1,
    needsFont: false,
    source: `% itemize is one of the real upstream 0.1 packages bundled here
% (dist-v01/packages/itemize.satyh). Two things about the call are pure 0.1
% surface:
%
%   - the list is a VALUE, not a block-text tree — Item(text, children),
%     nested by nesting the constructor;
%   - the optional argument is a LABELLED BUNDLE, ?(break = true). 0.1
%     dropped 0.0.6's fused ?: sigil entirely, so an optional argument is
%     named at the call site instead of being positional.
%
% The outermost Item's own text is a conventional throwaway: itemize's
% listing and enumerate both match Item(_, items) and discard it.

@require: v01-mini
@require: itemize

let open V01Mini in
document (| title = \`Lists\` |) '<
  +p { Before the list. }
  +Itemize.listing?(break = true)(Item({}, [
    Item({a bulleted item}, []),
    Item({another, with children}, [
      Item({nested one level}, []),
      Item({and a sibling}, []),
    ]),
  ]));
  +p { A numbered list is the same shape, through a different member: }
  +Itemize.enumerate(Item({}, [
    Item({first entry}, []),
    Item({second entry}, []),
  ]));
  +p { After the list. }
>
`,
  },
  {
    name: "0.1: The std-ja class (needs a font)",
    lang: 1,
    needsFont: true,
    source: `% std-ja is the real upstream SATySFi 0.1 document class
% (dist-v01/packages/std-ja.satyh), driving the whole pipeline: loader,
% lowering, sealing, evaluation, line breaking, page breaking, PDF.
%
% Like the 0.0.6 stdja family it renders its own title block, numbered
% sections and running page furniture — and that furniture contains an em
% dash, which the base-14 fonts cannot encode. Supply a font with the picker
% above; without one it fails with an honest encoding error rather than
% dropping the character.
%
% Note the shape of the call. The class is a module, so the document
% envelope is StdJa.document and every block command is +StdJa.something —
% there is no bare +p here, because nothing was opened.

@require: std-ja

StdJa.document (|
  title  = {A 0.1 document class},
  author = {rustyfi},
|) '<
  +StdJa.p {
    This is upstream's own 0.1 class, vendored into the WebAssembly module
    and rendered end to end by the Rust port.
  }
  +StdJa.section{Introduction}<
    +StdJa.p {
      Sections are numbered and set by the class itself, from a sealed
      module with optional-argument rows and closed record types.
    }
  >
  +StdJa.section{Conclusion}<
    +StdJa.p {
      The quick brown fox jumps over the lazy dog.
    }
  >
>
`,
  },
  {
    name: "0.1 + 0.0.6: a class from the other generation",
    lang: 1,
    source: `% CROSS-VERSION IMPORT. This document is SATySFi 0.1, and the class that
% typesets it is a SATySFi 0.0.6 package.
%
% Nothing here selects that. \`@require: stdja-mini\` is an ordinary require;
% the loader searches the generation of the file asking — 0.1, so
% dist-v01/packages/ first — and falls back to the other, which is where
% stdja-mini lives. That fallback IS the bridge. Check the Packages panel
% with Lang on 0.1 and stdja-mini is not in the list; switch to 0.0.6 and it
% is. So this example cannot be passing by picking up a 0.1 package of the
% same name, because there is no such package.
%
% What the port does with it, per file rather than per document: the 0.0.6
% package is parsed with the 0.0.6 grammar, elaborated under 0.0.6, and its
% bindings are spliced into the merged program wrapped in a version scope,
% so \`page-break A4Paper\` inside it resolves to 0.0.6's page constructor and
% 0.0.6's primitive — while everything below is read as 0.1.
%
% The staging block proves the second half of that. \`~( ... )\` and \`&\` are
% 0.1 surface here (0.0.6 spells staging with a whole-file @stage: header),
% and they run one stage before the document does, so the number in the
% second paragraph was assembled as code and only then evaluated.

@require: stdja-mini

let unrolled =
  ~(
    let rec pow n = if n <= 0 then &(1) else &( 2 * ~(pow (n - 1)) ) in
    pow 10
  )
in
let n = embed-string (arabic unrolled) in

document (|
  title  = {Across the generations},
  author = {rustyfi},
|) '<
  +p {
    This document is read with the SATySFi 0.1 grammar. The comma between
    the two record fields just above is one place you can see that, since
    0.0.6 separates them with a semicolon instead. The class that typesets
    it, \\emph{stdja-mini}, is a 0.0.6 package, and so are the +p and
    \\bold{emph} commands themselves.
  }
  +p {
    The unrolled power above is 0.1-only staging, and it gives #n;.
  }
>
`,
  },
  {
    name: "0.1 + 0.0.6: a 0.0.6 command in a 0.1 document",
    lang: 1,
    source: `% The other way round from the previous example: here the CLASS is 0.1
% (v01-mini, from dist-v01/packages/) and one COMMAND comes from 0.0.6 —
% \\tabular, out of the frozen 0.0.6 standard library's table.satyh, which
% has no counterpart in the 0.1 corpus at all.
%
% Both packages are in one program at once, each read as its own generation.
% That is the point worth seeing: the boundary is per FILE, not per document,
% so a 0.1 document does not have to choose a side.
%
% Everything below the requires is 0.1 surface — commas in list literals,
% \`match ... end\`, parenthesised command arguments — while the command being
% called declares its argument types in 0.0.6:
%
%   direct \\tabular : [ (| l : inline-text -> cell; ... |) -> (cell list) list;
%                       length list -> length list -> graphics list ] inline-cmd
%
% The record of cell constructors it hands the callback, and the two lists of
% boundary positions it hands the rule function, cross the boundary as
% ordinary values; nothing about them is version-forked.

@require: v01-mini
@require: table

% The last element of a list, for the table's right-hand edge.
let rec last d xs =
  match xs with
  | []        -> d
  | x :: rest -> last x rest
  end
in

% cs is the record table.satyh passes in: c centres a cell, l left-aligns it.
let rows cs = [
  [cs#c({generation}), cs#c({what it supplies})],
  [cs#l({0.1}),        cs#l({the document class, v01-mini})],
  [cs#l({0.0.6}),      cs#l({the tabular command, from table})],
] in

% xs and ys are the column and row boundaries, in the table's own
% coordinates. One rule per row boundary, full width.
let rules xs ys =
  let right = last 0pt xs in
  let rec hlines ys =
    match ys with
    | []        -> []
    | y :: rest ->
        stroke 0.5pt (Gray 0.6)
          (start-path (0pt, y) |> line-to (right, y) |> terminate-path)
          :: hlines rest
    end
  in
  hlines ys
in

let open V01Mini in
document (| title = \`A 0.0.6 table in a 0.1 document\` |) '<
  +p { Below, a table drawn entirely by 0.0.6 code: }
  +p {
    \\tabular(rows)(rules);
  }
  +p { And back to the 0.1 class for this paragraph. }
>
`,
  },
  {
    name: "0.1 + 0.0.6: a refusal, on purpose",
    lang: 1,
    // Expected to FAIL, and the self-test asserts the reason rather than
    // compiling it — see `refuses` there.
    refuses: /cross-version import[\s\S]*`page`/,
    source: `% THIS EXAMPLE DOES NOT COMPILE, AND THAT IS THE POINT. Press Typeset and
% read what comes back; the problem listed under the editor says the same.
%
% The two previous examples cross the version boundary. This one asks for a
% crossing that cannot be made, and the port refuses it with the reason
% rather than mis-rendering:
%
%   cross-version import (X3): dependency stdjabook.satyh references \`page\`,
%   a version-forked builtin — 0.0.6's page is a 9-ctor ADT; 0.1's is a
%   length*length tuple — no shared runtime representation
%
% \`page\` is a REPRESENTATION fork. In 0.0.6 a page size is a variant with
% nine constructors (A0Paper … UserDefinedPaper); in 0.1 it is a pair of
% lengths. Those are different runtime values wearing the same name, so
% there is no wrapper to write: a bridge would have to invent an answer for
% \`A4Paper\` under a vocabulary that has no constructors at all. The same
% holds for \`font\`, a store abbreviation in one generation and an opaque
% handle on a loaded face in the other.
%
% Contrast stdja-mini two examples up, which crosses cleanly. It calls
% \`page-break A4Paper\` too — but it writes no TYPE annotation mentioning
% \`page\`, so nothing in its text has to be re-read under 0.1's vocabulary
% and the constructor resolves inside its own version scope. The refusal is
% keyed on what a package's type text NAMES, not on what it does.
%
% A refusal costs you the package, not the generation: switch Lang to 0.0.6
% and stdjabook is available in full.

@require: stdjabook

document (|
  title  = {Refused},
  author = {rustyfi},
  show-title = true,
  show-toc = false,
|) '<
  +p { This paragraph is never reached. }
>
`,
  },
];
