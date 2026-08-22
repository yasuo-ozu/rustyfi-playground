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
// `lang` is the SATySFi generation the source is written in — `0` for 0.0.6
// and `1` for 0.1 — and is OMITTED wherever it is 0, which is the default and
// what every example here predates. It is not decoration: the two generations
// have different grammars and different bundled corpora, so compiling an entry
// under the wrong one is a parse error rather than a subtly different render.
// Choosing an example sets the header's Lang selector from this field; the
// self-test compiles each entry under it.
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
    needsFont: false,
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
];
