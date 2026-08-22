# rustyfi playground

The typesetter compiled to WebAssembly, running in a browser tab: no server and
no package manager. **Typesetting never leaves the tab** — the module, the
package corpus and the font are all fetched once and everything after that is
local. `.github/workflows/pages.yml` builds and publishes it to GitHub Pages.

The single exception is the **Share** button, which is opt-in and says so on the
page: it puts the document into a URL and asks [is.gd](https://is.gd/) to
shorten it, which means the document goes to is.gd. Nothing calls out on load or
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

## Checking it without a browser

`selftest.mjs` drives the real module through the same `rustyfi.js` glue the
page uses — including every example the page ships, and the share link
round-trip — and is what gates the deploy:

```console
$ node playground/selftest.mjs target/wasm32-unknown-unknown/release/rustyfi_wasm.wasm
```

It stays offline on purpose. The is.gd leg is not exercised there, because a
deploy must not be gated on a third party being up.

## What is here

| file | |
|---|---|
| `index.html` | the page: editor, PDF preview, error panel, packages panel |
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

## Limitations worth knowing before you file a bug

These are properties of a browser build, not of the typesetter:

- **Base-14 fonts by default**, which are WinAnsi Latin. Japanese will not
  typeset, and neither will the full `stdja`/`stdjabook`/`stdjareport` classes —
  their page furniture contains an em dash. Junicode is served beside the page
  and loaded before the first typeset, which covers Latin; for CJK, pick a
  `.ttf`/`.otf` with the picker. **Whatever you pick is read in the tab and is
  never uploaded.** No CJK face is bundled because it would cost every visitor
  megabytes.
- **`@require:` resolves against a fixed bundled corpus only** — the frozen
  SATySFi 0.0.6 standard library plus a licence-cleared subset of rustyfi's
  layout-test corpus, both from the `rustyfi/` submodule, baked in by
  `crates/rustyfi-wasm/build.rs` and resolved by the real loader through
  `rustyfi_loader::SourceProvider`. There is nowhere to fetch anything else
  from; the "Packages" panel in the header is the exhaustive list, with each
  package's upstream, version and licence.
- **No filesystem**, so `load-image`, `read-file` and `load-pdf-image` have
  nothing to read. `load-pdf-image` is not compiled in at all (its reader pulls
  in `rayon` and `getrandom`, neither of which builds for
  `wasm32-unknown-unknown`) and says so if called.
- **SATySFi 0.0.6 only.** The 0.1 `use`-header dialect resolves envelopes and a
  deps config from disk.
- **A fixed 32 MiB stack** (`.cargo/config.toml`), because elaboration and
  typechecking recurse over the merged program. A deep enough document traps;
  the page reports it and a reload gives a fresh module.
- **It is single-threaded.** A long compile blocks the tab until it finishes.
