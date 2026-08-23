// Build the vendored editor bundle the page serves from its own origin.
//
//   cd editor && npm install && npm run build
//
// Writes two committed files and nothing else:
//
//   playground/vendor/codemirror.js              the bundle
//   playground/licenses/LICENSE-codemirror-MIT.txt   every licence in it
//
// Both are COMMITTED, and the deploy does not run this — GitHub Pages serves
// what is in the repository. That is the whole point of vendoring: the page
// fetches nothing at runtime, and no npm registry is in the deploy path.
//
// The licence file is generated rather than hand-copied because it has to
// list every package that actually ended up in the bundle, at the version
// that ended up in it. `npm install` moving a transitive dependency would
// otherwise silently ship MIT code with no notice — the same obligation
// `playground/licenses/` already carries for the bundled SATySFi packages.

import { build } from "esbuild";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const out = join(repo, "playground", "vendor", "codemirror.js");

await mkdir(dirname(out), { recursive: true });

const result = await build({
  entryPoints: [join(here, "src", "index.js")],
  bundle: true,
  format: "esm",
  // Every browser that can run a 7 MB WebAssembly module supports these.
  target: ["es2020"],
  minify: true,
  // A source map would be four times the bundle and is only useful to someone
  // debugging CodeMirror itself, who has the source here anyway.
  sourcemap: false,
  legalComments: "none",
  metafile: true,
  outfile: out,
  banner: {
    js:
      "/* CodeMirror 6, bundled for the rustyfi playground by editor/build.mjs.\n" +
      "   MIT licensed; see playground/licenses/LICENSE-codemirror-MIT.txt for\n" +
      "   every package in here and its copyright notice. Do not edit: rebuild\n" +
      "   with `cd editor && npm run build`. */",
  },
});

// Which packages really made it into the bundle, read off esbuild's own input
// list rather than off `package.json` — a devDependency that got tree-shaken
// away must not appear in the notice, and a transitive one that got pulled in
// must.
const packages = new Set();
for (const file of Object.keys(result.metafile.inputs)) {
  const at = file.lastIndexOf("node_modules/");
  if (at < 0) continue;
  const rest = file.slice(at + "node_modules/".length);
  const parts = rest.split("/");
  packages.add(parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]);
}

const sections = [];
for (const name of [...packages].sort()) {
  const pkg = JSON.parse(await readFile(join(here, "node_modules", name, "package.json"), "utf8"));
  let text = "";
  for (const candidate of ["LICENSE", "LICENSE.md", "license", "LICENSE.txt"]) {
    try {
      text = await readFile(join(here, "node_modules", name, candidate), "utf8");
      break;
    } catch {
      /* try the next spelling */
    }
  }
  if (!text) throw new Error(`${name} ships no licence text; it cannot be redistributed`);
  if (pkg.license !== "MIT") throw new Error(`${name} is ${pkg.license}, not MIT`);
  sections.push(`${name} ${pkg.version}\n${"-".repeat(60)}\n\n${text.trim()}\n`);
}

const notice = `CodeMirror 6, as bundled into playground/vendor/codemirror.js
==============================================================

The playground serves its editor from its own origin — nothing is fetched from
a CDN at runtime — so the bundle is committed to this repository and its
licences travel with it. Every package below is MIT licensed. The bundle was
produced by editor/build.mjs from editor/package.json; rebuild it with
\`cd editor && npm run build\`.

${sections.join("\n")}`;

await writeFile(join(repo, "playground", "licenses", "LICENSE-codemirror-MIT.txt"), notice);

const bytes = (await readFile(out)).length;
const { gzipSync } = await import("node:zlib");
const gz = gzipSync(await readFile(out), { level: 9 }).length;
console.log(
  `wrote playground/vendor/codemirror.js — ${bytes} bytes (${(gz / 1024).toFixed(0)} kB gzipped), ` +
    `${packages.size} packages`,
);
