# rustyfi playground

The typesetter compiled to WebAssembly, running in a browser tab: no server and
no package manager. **Typesetting never leaves the tab** — the module, the
package corpus and the font are all fetched once and everything after that is
local. `.github/workflows/pages.yml` builds and publishes it to GitHub Pages.

The single exception is the **Share** button, which is opt-in and says so on the
page: it puts the document into a URL and asks a third-party shortener
([TinyURL](https://tinyurl.com/), falling back to [da.gd](https://da.gd/) and
[is.gd](https://is.gd/)) to shorten it, which means the document goes to that
service. Nothing calls out on load or
on edit, only on that click, and if the service declines you get the long URL
with a message telling you which one you got.

## Running it locally

The `.wasm` is a build artifact, so it is not checked in — build it, put it
beside `index.html`, and serve the directory over http:

```console
$ cargo build -p rustyfi-wasm --release --target wasm32-unknown-unknown
$ cp target/wasm32-unknown-unknown/release/rustyfi_wasm.wasm playground/
$ python3 -m http.server -d playground 8000
```

Then open <http://localhost:8000>. It has to be http(s): both module scripts
and `WebAssembly.instantiateStreaming` are blocked on `file://` URLs. The
editor bundle is committed, so there is nothing to build for it.

Two licence links in the packages panel 404 in this setup: `LICENSE.LGPL-3.0`
and `LICENSE.GPL-3.0` live in the `rustyfi/` submodule and are copied into
`_site/licenses/` by the deploy, rather than being a second committed copy of a
frozen legal text. Run
`cp rustyfi/LICENSE.{L,}GPL-3.0 playground/licenses/` (adding the `.txt`
suffixes) if you want them locally, and do not commit the result.

## Live diagnostics

The editor underlines mistakes as you type, marks them in the gutter, and
lists them underneath with a click that jumps to the offending text. The
editor is CodeMirror 6, **vendored** — see [The editor](#the-editor) — so
nothing is fetched at runtime; the underlines are its own decorations, which
means they are *mapped through your edits* rather than being absolute offsets
into a mirror of the text that has to be taken down the moment you type.

Analysis runs on the module's own `rustyfi_diagnostics` export, which is **two
tiers**:

1. **`rustyfi_lsp::analyze`** — the typesetter's own language server, minus the
   protocol. It lexes and parses under the chosen generation and stops there:
   no packages are resolved, nothing is compiled, and the span it reports is
   the token the parse could not get past. Well under a millisecond on
   anything this page ships.
2. **the whole program**, and only when the first tier is silent — a compile
   with no rendering and no font, between 1 and 530 ms on the examples here.

The second tier is not a leftover. `rustyfi_lsp::analyze` deliberately stops at
parsing, because a *detached buffer* has no program behind it and every name a
real document imports would come back unbound; the crate's answer to that is
`rustyfi_lsp::project::check`, which resolves the buffer's dependency graph off
a disk and so cannot exist in a browser. This module already *is* that program
— the whole corpus is compiled into it — so tier 2 here is the browser's
counterpart of `project::check`, and it is what keeps `unbound variable`,
`cannot resolve @require:` and the cross-version refusals underlined as you
type.

Ordering them this way is what makes the pair cheap: a document that does not
parse cannot be compiled anyway, and a document that does not parse is the
normal state of one being typed into.

The whole thing is **debounced by 600 ms** after the last keystroke. That is longer
than the gap between keystrokes of anyone typing continuously, so a burst costs
one analysis rather than one per character, and short enough that pausing to
look at the screen produces an answer. Everything here is on the main thread,
so what matters is the delay plus the work; at 600 ms even the slowest example
leaves the page idle most of the time.

600 ms is a floor rather than a fixed interval: the page measures what each
analysis actually costs and waits at least three times that, capped at four
seconds. A document heavy enough to be felt is therefore checked less often
instead of blocking the tab every time you pause, and the ratio of blocked to
idle stays roughly constant across document sizes rather than being right for
one of them.

Positions come back **zero-based, with columns in UTF-16 code units**, which is
exactly what a JavaScript string index and a CodeMirror document offset already
count. A byte offset would be right only for ASCII and would misplace every
marker in a Japanese document — the self-test pins this with fixtures whose
byte and UTF-16 columns genuinely differ, for the diagnostics and for hover and
go-to-definition alike.

Two honest limitations, both stated on the page itself:

- **It reports the first problem, not every problem.** Both tiers stop at the
  first thing they cannot get past: this port's parser has no error recovery,
  and a compile stops. The `Vec` is the shape `rustyfi_lsp` chose so that
  adding recovery later would not be a breaking change.
- **A failure it cannot place in your document gets no underline** — a problem
  inside a bundled package, or one the compiler reported without a position.
  It is listed against the document as a whole instead of guessing a line.
  This is a tier-2 limitation only; tier 1's spans are exact, and a
  zero-width one (an unexpected end of input) is widened so there is still a
  character to draw under.

One more thing the analysis reports, and it is about the **Lang selector**
rather than about your text: when a document fails to parse as the selected
generation but parses cleanly as the other, the problem row carries a *parses
as 0.1 — switch* button. The selector is never overridden silently (it says how
to read what is in the editor, which is a decision that belongs to you), but a
valid document underlined end to end because the wrong generation is selected
is the one case where the error is not where the reader is looking.

## Editor navigation

Hover, completion, go-to-definition and an outline, out of the same module and
the same `rustyfi_lsp` half — plus the **`@require:` index** described below,
which is what makes them answer about package vocabulary rather than shrugging.

| | how you get it | what it does |
|---|---|---|
| hover | point at a name | says what it is, which package declares it, and the type its author wrote |
| completion | type `\`, `+`, `#` or `Module.`, or press <kbd>Ctrl</kbd>-<kbd>Space</kbd> | offers names in scope in this buffer, then names the required packages declare |
| definition | <kbd>Ctrl</kbd>-click or <kbd>F12</kbd> | jumps, if the name is bound in this document; otherwise says which package it comes from |
| outline | the *n declarations…* picker in the pane heading | jumps to any declaration; hidden below two |

### Why a dependency index

`rustyfi_lsp`'s cursor half is **single-file scoped**, deliberately: a detached
buffer has no program behind it, so a name it does not bind is answered with
silence rather than invention. That is the same ceiling tier 1 of the
diagnostics has, and on a playground document it is severe — the document is
almost entirely package vocabulary (`document`, `+p`, `\emph`, `List.map`), and
none of it is bound in the buffer. Wired up as-is, hover would say no more than
"an inline command, from somewhere else" and completion would have nothing at
all to offer on most of the examples here.

So the browser does what a detached editor cannot: it **resolves the document's
`@require:`/`@import:` graph** — through the loader's own `resolve_require`,
against the corpus compiled into the module — builds a `rustyfi_lsp::Model` per
dependency file, and indexes what each one declares. Hover then answers out of
the package's own source: which module, how it was written (`direct`, `val`,
`let-inline`), and the type text its author wrote, quoted rather than inferred.

Measured over the 154 command sites (`\cmd`, `+cmd`) in the 24 examples this
page ships: **92% get a hover, and 90% of all of them name a package** — that
is, nearly every hover that answers does so because of the index. **86% of
command prefixes offer at least one completion**, against nothing at all before.

It stays honest about what it knows. An index entry proves that a required
package *declares* that spelling, not that the name is in scope at your cursor,
and the wording says "declared by", never "bound here". Completion offers a
module's members unqualified only where the document actually wrote `open` on
it.

### Silence is the normal answer

Most positions in a SATySFi document are prose, and a hover that fires on every
word of a paragraph is worse than one that never fires. Over *all* cursor
positions rather than command sites, hover answers about a quarter of the time,
and that is the design rather than a shortfall. Completion is stricter still:
it needs a sigil, a `Module.` prefix or an explicit <kbd>Ctrl</kbd>-<kbd>Space</kbd>,
and when it has nothing to say **no popup appears at all** — an empty popup is
something to dismiss, which is what makes a quiet completion feel broken.

Go-to-definition lands in this buffer about one time in twenty, so it is not
advertised in the interface, only in the hint line under the editor. When the
name comes from a package — which this page cannot open, having one buffer — it
says so in a toast instead of doing nothing.

### Cost

The index is the one expensive thing: one parse per dependency file, 1–130 ms
depending on the graph (thirteen files for a `stdjabook` document). It is
**cached against the document's header lines** and built on an idle callback
after an analysis, so ordinary typing never rebuilds it and no hover ever waits
for it. A hover itself is one parse of the buffer — 0.06 ms on a small
document, 2.6 ms on the largest example here — and a completion is that plus a
filter over the index. Everything runs on the main thread, as the rest of this
page does.

The outline is deliberately read out of the same `Model` and **not** out of
`rustyfi_lsp::document_symbols`, which is the better structure and costs
**1,014,881 bytes of WebAssembly** — measured, by building the module with and
without the call. That is four times what hover, definition and completion
together add (265,862 bytes), because it instantiates `Unparse` over both
grammars' entire CSTs to get each declaration's exact extent. A jump list does
not earn a megabyte on every page load.

## The editor

CodeMirror 6, **committed to this repository** under `vendor/codemirror.js` and
served from this origin. The page fetches nothing at runtime — no CDN, no
external stylesheet, no remote font — and the editor is the first dependency it
has ever had, so it is vendored rather than linked. The self-test fails the
deploy if the page grows an absolute URL, or if the bundle contains an import
that did not get resolved.

- **362,651 bytes, 115 kB gzipped**, against a WebAssembly module of 7.6 MB /
  2.0 MB gzipped: about 5% more to download.
- Assembled from six `@codemirror/*` packages and their dependencies —
  `basicSetup` is deliberately not used, since it would add search, folding and
  bracket auto-closing that this page does not want.
- All MIT. `editor/build.mjs` regenerates
  `licenses/LICENSE-codemirror-MIT.txt` from the licence text of every package
  that actually ended up in the bundle, read off esbuild's own input list, so a
  new transitive dependency cannot ship unattributed.

Rebuild it with:

```console
$ cd editor && npm install && npm run build
```

The deploy does **not** run that — it copies what is committed. A syntax
highlighting mode for SATySFi is the page's own code, not part of the bundle: a
stream tokenizer that knows comments, string literals, command names, headers,
numbers with units and the keyword list. It is not a grammar and does not
pretend to parse.

## Checking it without a browser

`selftest.mjs` drives the real module through the same `rustyfi.js` glue the
page uses — including every example the page ships, and the share link
round-trip — and is what gates the deploy:

```console
$ node playground/selftest.mjs target/wasm32-unknown-unknown/release/rustyfi_wasm.wasm
```

It stays offline on purpose. The shortener leg is not exercised there, because a
deploy must not be gated on a third party being up.

## What is here

| file | |
|---|---|
| `index.html` | the page: editor with live diagnostics, PDF preview, error panel, packages panel |
| `rustyfi.js` | glue for the `rustyfi-wasm` C ABI — no wasm-bindgen involved |
| `examples.js` | the example documents, shared with `selftest.mjs` so they are verified rather than assumed |
| `packages.js` | who wrote each bundled package, which release it is, and under what licence |
| `share.js` | the `?src=` codec and the shortener call, likewise shared with the self-test |
| `selftest.mjs` | the offline end-to-end check |
| `vendor/codemirror.js` | the editor, bundled from `editor/` and served from this origin |
| `licenses/` | the upstream licence text of every bundled third-party package, and of the editor |

`packages.js` is checked against the module's real package list by the
self-test, in both directions: a package baked in with no entry fails the
deploy, and so does an entry for a package that is no longer bundled. The first
would put third-party source on a public site with its licence unstated, which
is the one thing here that is not merely cosmetic.

`examples.js` is generated-looking on purpose: its sources are JS template
literals, so every SATySFi `\` is written `\\`, every backtick `` \` `` and
every `${` `\${`. Getting that wrong is silent, which is why the self-test
compiles all of them.

Each entry also carries the generation it is written in — `lang: 1` for
SATySFi 0.1, omitted for 0.0.6, which is the default. Choosing an example moves
the header's Lang selector to match; moving the selector by hand never rewrites
the editor, because the selector says how to read what is there rather than
what should be there. The self-test compiles each example under its own `lang`,
and separately checks that every 0.1 entry really does *fail* as 0.0.6 — the
only way to catch a `lang` that has stopped being threaded anywhere. A share
link carries the generation too, as `&lang=1`, emitted only for 0.1 so that
every 0.0.6 link ever minted still means what it did.

One entry carries `refuses`, a regular expression, and is expected NOT to
compile: it is the cross-version refusal below. The self-test asserts the
failure *and* the message, which is stricter than asserting a compile — the
example's own commentary quotes that message, so a refusal that started saying
something else would leave the page explaining a diagnostic nobody gets.

## Limitations worth knowing before you file a bug

These are properties of a browser build, not of the typesetter:

- **Base-14 fonts by default**, which are WinAnsi Latin. Japanese will not
  typeset, and neither will the full `stdja`/`stdjabook`/`stdjareport` classes —
  their page furniture contains an em dash. Junicode is served beside the page
  and loaded before the first typeset, which covers Latin; for CJK, pick a
  `.ttf`/`.otf` with the picker. **Whatever you pick is read in the tab and is
  never uploaded.** No CJK face is bundled because it would cost every visitor
  megabytes.
- **`@require:` resolves against fixed bundled corpora only** — the frozen
  SATySFi 0.0.6 standard library, a licence-cleared subset of rustyfi's
  layout-test corpus, and the SATySFi 0.1 standard library, all from the
  `rustyfi/` submodule, baked in by `crates/rustyfi-wasm/build.rs` and resolved
  by the real loader through `rustyfi_loader::SourceProvider`. There is nowhere
  to fetch anything else from; the "Packages" panel lists the selected
  generation's set, with each package's upstream, version and licence, and
  both sets together are the exhaustive list (see *Cross-version import*).
- **No filesystem**, so `load-image`, `read-file` and `load-pdf-image` have
  nothing to read. `load-pdf-image` is not compiled in at all (its reader pulls
  in `rayon` and `getrandom`, neither of which builds for
  `wasm32-unknown-unknown`) and says so if called.
- **One file, which must be a document.** Whichever generation is selected, the
  editor holds the entry and everything else comes from the baked-in corpus.
  Under 0.1 that is a real restriction rather than a cosmetic one: a module is
  a *file*, so the surface that only exists at the top of a library — `module M
  :> sig … end = struct … end`, and with it the per-binding stage qualifiers
  `val ~x` and `val persistent ~x` — has nowhere to go. 0.1 has neither an
  expression-level module nor a staged `let`, so those are out of reach here.
  Everything else about staging is not: `&e` and `~e` work in the document
  body, and so does the `code τ` type (`fun (c : code int) -> …` inside a
  splice), which is what the "0.1: Multi-stage" example does. A library source
  pasted in is refused clearly — *entry file must be a document (with an
  `in …` body), found a library*.
- **Not every cross-version import works** — see below. The ones that do not
  are refused with their reason rather than mis-rendered.
- **A fixed 32 MiB stack** (`.cargo/config.toml`), because elaboration and
  typechecking recurse over the merged program. A deep enough document traps;
  the page reports it and a reload gives a fresh module.
- **It is single-threaded.** A long compile blocks the tab until it finishes.

## Cross-version import

Both package corpora are mounted at once, under `dist/packages/` and
`dist-v01/packages/`, the way a real library root carries them. The **Lang**
selector therefore says which generation the *entry document* is written in,
not which packages exist.

A `@require:` searches the asking file's own generation first and falls back to
the other, which is the typesetter's own rule — so a 0.1 document can use a
0.0.6 package, and a 0.0.6 document a 0.1 one. A name present in both
(`itemize`, `list`, `code`, …) still resolves to the caller's generation, so the
fallback only ever *adds* resolutions; the self-test pins that in both
directions, since it is the way this could quietly hand a 0.1 document the
wrong `itemize`.

The last three examples are this feature:

| example | what crosses |
|---|---|
| *a class from the other generation* | the 0.0.6 `stdja-mini` class typesets a 0.1 document, whose body uses 0.1-only staging |
| *a 0.0.6 command in a 0.1 document* | the 0.1 `v01-mini` class plus `\tabular` from the frozen 0.0.6 `table.satyh` |
| *a refusal, on purpose* | nothing: `stdjabook`'s type text names `page`, which the two generations represent differently |

Each crossing example requires a package that exists **only** in the other
corpus, and the self-test checks that as a separate assertion. That is the
trap worth knowing about here: require a name present in both and the document
gets its own generation's package, nothing crosses, and the example passes
while demonstrating nothing.

The refusal is worth reading rather than working around. `page` is a nine-
constructor variant in 0.0.6 and a pair of lengths in 0.1; `font` is a store
abbreviation in one and an opaque handle on a loaded face in the other. Those
are different runtime values sharing a name, so no wrapper exists to write, and
the port says so instead of guessing. Refusals keyed on a *missing bridge
feature* rather than a representation fork say that too, in the same message.
