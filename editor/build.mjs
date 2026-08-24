// Build the vendored browser bundles the page serves from its own origin.
//
//   cd editor && npm install && npm run build
//
// Writes four committed files and nothing else:
//
//   playground/vendor/codemirror.js                  the editor
//   playground/licenses/LICENSE-codemirror-MIT.txt   every licence in it
//   playground/vendor/markdown.js                    the Markdown renderer
//   playground/licenses/LICENSE-markdown-MIT.txt     every licence in it
//
// All four are COMMITTED, and the deploy does not run this — GitHub Pages
// serves what is in the repository. That is the whole point of vendoring: the
// page fetches nothing at runtime, and no npm registry is in the deploy path.
//
// The licence files are generated rather than hand-copied because each has to
// list every package that actually ended up in its bundle, at the version that
// ended up in it. `npm install` moving a transitive dependency would otherwise
// silently ship MIT code with no notice — the same obligation
// `playground/licenses/` already carries for the bundled SATySFi packages.

import { build } from "esbuild";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");

/// One row per committed bundle. `title` heads the licence notice, which a
/// reader may meet without ever having seen the page.
const BUNDLES = [
  {
    name: "CodeMirror 6",
    entry: join(here, "src", "index.js"),
    out: join(repo, "playground", "vendor", "codemirror.js"),
    notice: join(repo, "playground", "licenses", "LICENSE-codemirror-MIT.txt"),
  },
  {
    // The Markdown tab shows what a READER would see, which means rendering
    // it. A CDN in the page would break the "fetches nothing at runtime"
    // invariant the selftest pins, so the renderer is vendored like the
    // editor.
    name: "marked",
    entry: join(here, "src", "markdown.js"),
    out: join(repo, "playground", "vendor", "markdown.js"),
    notice: join(repo, "playground", "licenses", "LICENSE-markdown-MIT.txt"),
  },
];

for (const bundle of BUNDLES) {
  const rel = bundle.out.slice(repo.length + 1);
  const noticeRel = bundle.notice.slice(repo.length + 1);

  await mkdir(dirname(bundle.out), { recursive: true });

  const result = await build({
    entryPoints: [bundle.entry],
    bundle: true,
    format: "esm",
    // Every browser that can run a 7 MB WebAssembly module supports these.
    target: ["es2020"],
    minify: true,
    // A source map would be several times the bundle and is only useful to
    // someone debugging the dependency itself, who has the source here anyway.
    sourcemap: false,
    legalComments: "none",
    metafile: true,
    outfile: bundle.out,
    banner: {
      js:
        `/* ${bundle.name}, bundled for the rustyfi playground by editor/build.mjs.\n` +
        `   MIT licensed; see ${noticeRel} for\n` +
        "   every package in here and its copyright notice. Do not edit: rebuild\n" +
        "   with `cd editor && npm run build`. */",
    },
  });

  // Which packages really made it into this bundle, read off esbuild's own
  // input list rather than off `package.json` — a devDependency that got
  // tree-shaken away must not appear in the notice, and a transitive one that
  // got pulled in must. Per bundle, so the editor's notice does not claim the
  // Markdown renderer and vice versa.
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
    const pkg = JSON.parse(
      await readFile(join(here, "node_modules", name, "package.json"), "utf8"),
    );
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

  const title = `${bundle.name}, as bundled into ${rel}`;
  const notice = `${title}
${"=".repeat(title.length)}

The playground serves this from its own origin — nothing is fetched from a CDN
at runtime — so the bundle is committed to this repository and its licences
travel with it. Every package below is MIT licensed. The bundle was produced by
editor/build.mjs from editor/package.json; rebuild it with
\`cd editor && npm run build\`.

${sections.join("\n")}`;

  await writeFile(bundle.notice, notice);

  const bytes = (await readFile(bundle.out)).length;
  const gz = gzipSync(await readFile(bundle.out), { level: 9 }).length;
  console.log(
    `wrote ${rel} — ${bytes} bytes (${(gz / 1024).toFixed(0)} kB gzipped), ` +
      `${packages.size} packages`,
  );
}
