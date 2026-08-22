# rustyfi playground

The typesetter compiled to WebAssembly, running in a browser tab: no server, no
upload, no package manager. `.github/workflows/pages.yml` builds and publishes
it to GitHub Pages.

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

## Checking it without a browser

`selftest.mjs` drives the real module through the same `rustyfi.js` glue the
page uses — including every example the page ships — and is what gates the
deploy:

```console
$ node playground/selftest.mjs target/wasm32-unknown-unknown/release/rustyfi_wasm.wasm
```

## What is here

| file | |
|---|---|
| `index.html` | the page: editor, PDF preview, error panel, honest limitations |
| `rustyfi.js` | glue for the `rustyfi-wasm` C ABI — no wasm-bindgen involved |
| `examples.js` | the example documents, shared with `selftest.mjs` so they are verified rather than assumed |
| `selftest.mjs` | the offline end-to-end check |

## Limitations worth knowing before you file a bug

These are properties of a browser build, not of the typesetter:

- **Base-14 fonts by default**, which are WinAnsi Latin. Japanese will not
  typeset, and neither will the full `stdja`/`stdjabook`/`stdjareport` classes —
  their page furniture contains an em dash. Supplying a `.ttf`/`.otf` with the
  picker fixes both; the file stays in your browser. Nothing is bundled because
  a CJK face would cost every visitor megabytes.
- **`@require:` resolves against the bundled 0.0.6 corpus only** — the real
  packages from the `rustyfi/` submodule's `lib-rustyfi/dist/packages/`, baked in by
  `crates/rustyfi-wasm/build.rs` and resolved by the real loader through
  `rustyfi_loader::SourceProvider`. There is nowhere to fetch anything else
  from.
- **No filesystem**, so `load-image`, `read-file` and `load-pdf-image` have
  nothing to read. `load-pdf-image` is not compiled in at all (its reader pulls
  in `rayon` and `getrandom`, neither of which builds for
  `wasm32-unknown-unknown`) and says so if called.
- **SATySFi 0.0.6 only.** The 0.1 `use`-header dialect resolves envelopes and a
  deps config from disk.
- **A fixed 32 MiB stack** (`.cargo/config.toml`), because elaboration and
  typechecking recurse over the merged program. A deep enough document traps;
  the page reports it and a reload gives a fresh module.
