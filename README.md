# rustyfi-playground

[rustyfi](https://github.com/yasuo-ozu/rustyfi) — a native Rust port of the
SATySFi typesetter — compiled to WebAssembly and running in a browser tab. No
server, no upload, no package manager: you type a `.saty` document, the module
typesets it, and the PDF appears beside it.

Live at <https://yasuo-ozu.github.io/rustyfi-playground/>.

## Why this is a separate repository

The typesetter is the interesting artifact; the playground is a deployment of
it. Keeping them apart means rustyfi's own CI never has to build for
`wasm32-unknown-unknown`, and a Pages outage can never fail one of its pull
requests. The coupling that remains is a single submodule pin, so the deployed
page always corresponds to one identifiable rustyfi commit.

```
rustyfi/                    the typesetter, as a git submodule (pinned)
crates/rustyfi-wasm/        the wasm entry point: a cdylib exposing a C ABI
playground/                 the page, its glue, and an offline self-test
.github/workflows/pages.yml build -> self-test -> deploy
.github/workflows/bump.yml  daily: move the pin to rustyfi's main
```

## Getting a working checkout

The submodule is not optional — `crates/rustyfi-wasm` path-depends on four
crates inside it, and `build.rs` bakes that checkout's
`lib-rustyfi/dist/packages/` into the module as the corpus `@require:` resolves
against.

```console
$ git clone --recurse-submodules git@github.com:yasuo-ozu/rustyfi-playground.git
```

Already cloned without it: `git submodule update --init`.

## Building and running it

```console
$ rustup target add wasm32-unknown-unknown
$ cargo build -p rustyfi-wasm --release --target wasm32-unknown-unknown
$ node playground/selftest.mjs target/wasm32-unknown-unknown/release/rustyfi_wasm.wasm
$ cp target/wasm32-unknown-unknown/release/rustyfi_wasm.wasm playground/
$ python3 -m http.server -d playground 8000
```

Then open <http://localhost:8000>. It has to be http(s): module scripts and
`WebAssembly.instantiateStreaming` are both blocked on `file://` URLs.

`selftest.mjs` is what gates the deploy — it drives the real module through the
same glue the page uses, including every example the page ships. See
[`playground/README.md`](playground/README.md) for the limitations of a browser
build, which are worth reading before filing a bug.

## Moving the pin

`bump.yml` does it nightly, and `workflow_dispatch` runs it on demand. By hand:

```console
$ git -C rustyfi fetch origin main && git -C rustyfi checkout FETCH_HEAD
$ git commit -m "rustyfi: move the pinned submodule to <sha>" rustyfi
```

## Licence

MIT, matching rustyfi's own Rust crates. The SATySFi packages under
`rustyfi/lib-rustyfi/` that the module bundles carry their own upstream
licences; see the submodule.
