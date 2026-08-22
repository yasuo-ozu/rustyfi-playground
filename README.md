# rustyfi-playground

[rustyfi](https://github.com/yasuo-ozu/rustyfi) — a native Rust port of the
SATySFi typesetter — compiled to WebAssembly and running in a browser tab. You
type a `.saty` document, the module typesets it, and the PDF appears beside it:
**typesetting never leaves the tab**, and there is no package manager to reach
for.

The one exception is deliberate and opt-in: the **Share** button builds a URL
that carries your document, and shortening that URL hands it to a third-party
shortener ([TinyURL](https://tinyurl.com/), falling back to
[da.gd](https://da.gd/) and [is.gd](https://is.gd/)). Nothing calls out on load
or on edit — only on that
click, and the page says so next to the button.

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
crates inside it, and `build.rs` bakes three of that checkout's trees into the
module as the corpora `@require:` resolves against: `lib-rustyfi/dist/packages/`
(the frozen SATySFi 0.0.6 standard library), a licence-cleared subset of
`layout-tests/corpus/` (third-party packages such as `easytable`, `xpath` and
SlyDIFi), and `lib-rustyfi/dist-v01/packages/` (the SATySFi 0.1 standard
library). Exactly one of the two generations is mounted per compile, chosen by
the page's Lang selector.

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

MIT, matching rustyfi's own Rust crates.

The SATySFi packages the module bundles are **not** MIT-by-default and are not
this project's to relicense. Each one's upstream licence was established from
its own repository, its licence text is committed under `playground/licenses/`,
and the deploy serves that text beside the page — the way the bundled font
ships with its OFL. `crates/rustyfi-wasm/build.rs` refuses to bake in a package
whose licence file is missing, so the two cannot drift apart.

| Bundled | Origin | Licence |
|---|---|---|
| the SATySFi 0.0.6 standard library | [gfngfn/SATySFi](https://github.com/gfngfn/SATySFi) | LGPL-3.0 |
| `base` | [nyuichi/satysfi-base](https://github.com/nyuichi/satysfi-base) | MIT |
| `easytable`, `enumitem`, `figbox`, `railway`, `class-slydifi` | [monaqa](https://github.com/monaqa) | MIT |
| `latexcmds`, `xpath` | [yasuo-ozu](https://github.com/yasuo-ozu) | LGPL-3.0 |

Two projects from rustyfi's layout-test corpus are **deliberately not bundled**:
`fss`, whose upstream repository ships no licence text (its `satysfi-fss.opam`
declares `LGPL-3.0-or-later`, but a manifest field is not the grant), and
`gakushin`, whose repository carries no licence either and which depends on
`fss` regardless. Vendoring a package for layout testing is not the same act as
redistributing it from a public website, and only the second one needs a
licence.
