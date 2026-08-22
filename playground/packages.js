// Where the bundled packages come from.
//
// The names themselves are read out of the WebAssembly module at load, so this
// table only carries what the module cannot know: who wrote each package, which
// upstream release the bundled copy actually IS, and under what licence it is
// being redistributed.
//
// Its own module rather than inline in the page because `selftest.mjs` checks
// it against the module's real package list before a deploy. A package baked in
// by `crates/rustyfi-wasm/build.rs` with no entry here would be redistributed
// with its licence unstated, which is the one failure on this page that is not
// merely cosmetic — so it fails the build instead.
//
// `version` was established by matching each bundled file's git blob hash
// against its upstream repository's release tags, not by trusting a manifest;
// `+ patch` marks a package the typesetter's layout tests carry a local fix to.
// `what` and `repo` come from Satyrographos' opam repository, via
// <https://yasuo-ozu.github.io/rustyfi-packages/>.
//
// Two projects from that same layout-test corpus are deliberately absent, and
// their absence is the point: `fss`, whose upstream repository ships no licence
// text at all (its `satysfi-fss.opam` declares `LGPL-3.0-or-later`, but a
// manifest field is not the grant), and `gakushin`, whose repository carries no
// licence either and which depends on `fss` regardless.

export const PACKAGE_SETS = [
  {
    // The flat, un-prefixed names: `stdjabook`, `math`, `gr`, …
    prefix: null,
    name: "SATySFi standard library",
    repo: "https://github.com/gfngfn/SATySFi",
    version: "v0.0.6",
    license: "LGPL-3.0",
    licenseHref: "./licenses/LICENSE.LGPL-3.0.txt",
    what:
      "The distribution's own packages, redistributed under the LGPL. 27 of the 30 " +
      "files are byte-identical to upstream and two differ only by added comments; " +
      "stdja-mini is rustyfi's own work and is MIT.",
  },
  {
    prefix: "base",
    name: "satysfi-base",
    repo: "https://github.com/nyuichi/satysfi-base",
    version: "master 37e6774",
    license: "MIT",
    licenseHref: "./licenses/LICENSE-base-MIT.txt",
    what: "A collection of utility functions and modules for SATySFi.",
  },
  {
    prefix: "easytable",
    name: "satysfi-easytable",
    repo: "https://github.com/monaqa/satysfi-easytable",
    version: "v1.1.2 + patch",
    license: "MIT",
    licenseHref: "./licenses/LICENSE-easytable-MIT.txt",
    what: "A SATySFi package to build simple tables.",
  },
  {
    prefix: "enumitem",
    name: "satysfi-enumitem",
    repo: "https://github.com/monaqa/satysfi-enumitem",
    version: "v3.0.1",
    license: "MIT",
    licenseHref: "./licenses/LICENSE-enumitem-MIT.txt",
    what: "A SATySFi package for creating itemized lists.",
  },
  {
    prefix: "figbox",
    name: "satysfi-figbox",
    repo: "https://github.com/monaqa/satysfi-figbox",
    version: "v0.1.4",
    license: "MIT",
    licenseHref: "./licenses/LICENSE-figbox-MIT.txt",
    what: "A SATySFi package for creating charts and placing them in inappropriate positions.",
  },
  {
    prefix: "latexcmds",
    name: "satysfi-latexcmds",
    repo: "https://github.com/yasuo-ozu/satysfi-latexcmds",
    version: "v0.1.2",
    license: "LGPL-3.0",
    licenseHref: "./licenses/LICENSE-latexcmds-LGPL-3.0.txt",
    what: "LaTeX-like commands in SATySFi.",
  },
  {
    prefix: "railway",
    name: "satysfi-railway",
    repo: "https://github.com/monaqa/satysfi-railway",
    version: "v0.1.0",
    license: "MIT",
    licenseHref: "./licenses/LICENSE-railway-MIT.txt",
    what: "Drawing library for SATySFi.",
  },
  {
    // Published under `class-slydifi`, not `slydifi`: the prefix is the name
    // Satyrographos installs it as, and that is what `@require:` spells.
    prefix: "class-slydifi",
    name: "SlyDIFi",
    repo: "https://github.com/monaqa/slydifi",
    version: "v0.5.0",
    license: "MIT",
    licenseHref: "./licenses/LICENSE-slydifi-MIT.txt",
    what: "A SATySFi document class for creating presentation slides.",
  },
  {
    prefix: "xpath",
    name: "satysfi-xpath",
    repo: "https://github.com/yasuo-ozu/satysfi-xpath",
    version: "v0.3.0",
    license: "LGPL-3.0",
    licenseHref: "./licenses/LICENSE-xpath-LGPL-3.0.txt",
    what: "Advanced path algorithms in SATySFi.",
  },
];

/// The set a `@require:` name belongs to, or `null` if nothing claims it.
///
/// A flat name is the standard library by definition; anything else is keyed on
/// the directory it is published under.
export function setFor(name) {
  const slash = name.indexOf("/");
  const prefix = slash === -1 ? null : name.slice(0, slash);
  return PACKAGE_SETS.find((set) => set.prefix === prefix) ?? null;
}

/// Group `names` by provenance, keeping the table's order.
///
/// Returns `{ groups, drift }` — `drift` holding every name no entry claims, so
/// the caller can show it rather than lose it.
export function groupPackages(names) {
  const members = new Map(PACKAGE_SETS.map((set) => [set, []]));
  const drift = [];
  for (const name of names) {
    const set = setFor(name);
    if (set) members.get(set).push(name);
    else drift.push(name);
  }
  const groups = [];
  for (const [set, list] of members) if (list.length > 0) groups.push({ set, members: list });
  return { groups, drift };
}
