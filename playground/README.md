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
and `WebAssembly.instantiateStreaming` are blocked on `file://` URLs.

Two licence links in the packages panel 404 in this setup: `LICENSE.LGPL-3.0`
and `LICENSE.GPL-3.0` live in the `rustyfi/` submodule and are copied into
`_site/licenses/` by the deploy, rather than being a second committed copy of a
frozen legal text. Run
`cp rustyfi/LICENSE.{L,}GPL-3.0 playground/licenses/` (adding the `.txt`
suffixes) if you want them locally, and do not commit the result.

## Live diagnostics

The editor underlines mistakes as you type, and lists them underneath with a
click that jumps to the offending text. Nothing is fetched and no editor
library is involved: the source is a plain `<textarea>` with a second, inert
copy of the same text mirrored beneath it, carrying the underlines. The two
layers share every declaration that decides where a character lands
(`#editor .layer`), which is what keeps a wavy underline on the right character
of a soft-wrapped line of Japanese.

Analysis runs on the module's own `rustyfi_diagnostics` export — a compile with
no rendering and no font, which is between 3 and 620 ms on the examples this
page ships — **debounced by 600 ms** after the last keystroke. That is longer
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
exactly what `textarea.setSelectionRange` and `String.prototype.slice` count. A
byte offset would be right only for ASCII and would misplace every marker in a
Japanese document — the self-test pins this with a fixture whose byte and
UTF-16 columns genuinely differ.

Two honest limitations, both stated on the page itself:

- **It reports the first problem, not every problem.** The analysis behind it
  is a compile, and a compile stops. `crates/rustyfi-wasm/src/diagnostics.rs`
  says so at length; when the typesetter grows a real `rustyfi-lsp`, `analyze`
  in that file is the one function that changes and nothing else here moves.
- **A failure it cannot place in your document gets no underline** — a problem
  inside a bundled package, or one the compiler reported without a position.
  It is listed against the document as a whole instead of guessing a line.

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
| `licenses/` | the upstream licence text of every bundled third-party package |

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
