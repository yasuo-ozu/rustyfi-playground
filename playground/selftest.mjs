// End-to-end check of the real `.wasm`, through the same `rustyfi.js` glue the
// page uses. Run from the repository root after a wasm build:
//
//   cargo build -p rustyfi-wasm --release --target wasm32-unknown-unknown
//   node playground/selftest.mjs target/wasm32-unknown-unknown/release/rustyfi_wasm.wasm
//
// The Pages workflow runs this before deploying, so a module that builds but
// cannot actually typeset never reaches the site. Offline, no TTY.

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { instantiate } from "./rustyfi.js";
import { EXAMPLES } from "./examples.js";
import { decodeSource, encodeSource, shareLang, shareUrl, SHORTENERS } from "./share.js";
import {
  PACKAGE_SETS, PACKAGE_SETS_V01, FONTS, groupPackages, setFor, setsFor,
} from "./packages.js";

const wasmPath = process.argv[2];
if (!wasmPath) {
  console.error("usage: node playground/selftest.mjs <path to rustyfi_wasm.wasm>");
  process.exit(2);
}

let failures = 0;
const check = (name, condition, detail = "") => {
  if (condition) {
    console.log(`ok   ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL ${name}${detail ? `\n     ${detail}` : ""}`);
  }
};

/// Where a served font legitimately lives, in the order to look.
///
/// Fonts are fetched by the deploy rather than committed — they are gitignored
/// build inputs — so this is a search rather than one path. First: beside the
/// module under test, which is `_site/fonts/` when the workflow runs this
/// against `_site/rustyfi_wasm.wasm`, i.e. the very copy a visitor downloads.
/// Then the local preview directory, then the submodule's own font install.
const FONT_DIRS = [
  resolve(dirname(wasmPath), "fonts"),
  fileURLToPath(new URL("./fonts/", import.meta.url)),
  fileURLToPath(new URL("../rustyfi/lib-rustyfi/dist/fonts/", import.meta.url)),
];

const wasm = await readFile(wasmPath);
const rustyfi = await instantiate(wasm);

console.log(`rustyfi-wasm ${rustyfi.version()}, ${wasm.length} bytes`);

// 1. The bundled corpus is reachable.
const packages = rustyfi.packages();
check("bundled corpus is non-empty", packages.length > 0, `got ${packages.length}`);
check("stdja-mini is bundled", packages.includes("stdja-mini"), packages.join(", "));
check("stdjabook is bundled", packages.includes("stdjabook"), packages.join(", "));

// 1b. …and every name in it is ATTRIBUTED. This is the one check here that is
//     not about the page working: the module redistributes third-party SATySFi
//     source, and a package with no entry in `packages.js` would be served with
//     its licence unstated. Fail the deploy rather than ship that.
{
  const { groups, drift } = groupPackages(packages);
  check("every bundled package has a stated licence", drift.length === 0, drift.join(", "));

  // The same obligation for the 0.1 corpus, which is a SEPARATE set of files
  // redistributed under the same licence — and, per `lib-rustyfi/LICENSE`, a
  // MODIFIED one, which LGPL-3.0 section 4 requires be marked as such.
  {
    const v01 = rustyfi.packages(1);
    check("the 0.1 corpus is bundled", v01.length > 0, "no 0.1 packages");
    check(
      "the two generations are different sets",
      JSON.stringify(v01) !== JSON.stringify(packages),
      "0.0.6 and 0.1 listed identically, so one corpus is being read twice",
    );
    const g1 = groupPackages(v01, 1);
    check(
      "every bundled 0.1 package has a stated licence",
      g1.drift.length === 0,
      g1.drift.join(", "),
    );
    const empty1 = PACKAGE_SETS_V01.filter((s) => !g1.groups.some((g) => g.set === s));
    check(
      "every described 0.1 package is actually bundled",
      empty1.length === 0,
      empty1.map((s) => s.name).join(", "),
    );
    check(
      "the 0.1 entry marks itself as modified, as the LGPL requires",
      setsFor(1).every((s) => /modif/i.test(`${s.version} ${s.what}`)),
      "no modification notice on the 0.1 provenance entry",
    );
  }

  const empty = PACKAGE_SETS.filter((set) => !groups.some((g) => g.set === set));
  // The mirror image: an entry claiming a package the module no longer carries
  // puts a licence on the page for something that is not there.
  check(
    "every described package is actually bundled",
    empty.length === 0,
    empty.map((s) => s.name).join(", "),
  );
  // 1c. …and so does every FONT. A font file is third-party redistribution
  //     exactly as a package is, and both of these carry a licence that says
  //     in so many words that its text must travel with the file: OFL 1.1 §2
  //     for Junicode, IPA Font License 1.0 Article 3 Paragraph 2(3) for
  //     IPAex. `pages.yml` copies each pair in one step; this is what notices
  //     if one of the two lines is ever dropped.
  //
  //     "Travels with it" is checked as ADJACENCY, in the one directory the
  //     face was actually found in — not as "both files exist somewhere".
  //     That is the shape of the obligation, and it is also the shape of the
  //     mistake: two `cp` lines in `pages.yml`, one of them forgotten.
  for (const font of FONTS) {
    check(`${font.name}: has a stated licence`, Boolean(font.license && font.licenseHref));
    const licenseName = font.licenseHref.replace("./fonts/", "");
    let found = null;
    for (const dir of FONT_DIRS) {
      const bytes = await readFile(resolve(dir, font.file)).catch(() => null);
      if (bytes !== null) {
        found = { dir, bytes };
        break;
      }
    }
    if (found === null) {
      console.log(`skip ${font.name}: no ${font.file} in any served directory`);
      continue;
    }
    check(
      `${font.name}: is served under its own unmodified name`,
      found.bytes.length === font.bytes,
      `${found.bytes.length} bytes, expected ${font.bytes} — a resized file is ` +
      "a modified one, which neither licence permits redistributing under this name",
    );
    const text = await readFile(resolve(found.dir, licenseName), "utf8").catch(() => null);
    check(
      `${font.name}: its licence travels with it`,
      text !== null && text.length > 500,
      `${licenseName} is missing from ${found.dir}, which is serving ${font.file}`,
    );
  }

  // 1d. …and every package set is actually USED by an example.
  //
  //     This is the third leg of the same obligation. Bundling a third-party
  //     package puts its source on a public site under someone else's licence;
  //     doing that for a package nothing on the page demonstrates is carrying
  //     the obligation for nothing. It is also the failure mode that merging
  //     examples invites: fold two together carelessly and the only user of
  //     some package quietly disappears, with nothing else noticing.
  //
  //     Keyed on the SET rather than on individual names, because a set is
  //     what a licence attaches to — `easytable/matrix` going unused is a
  //     documentation gap, `easytable` going unused is a licence with no
  //     reason to be here.
  {
    const required = new Set();
    for (const example of EXAMPLES) {
      const lang = example.lang ?? 0;
      for (const m of example.source.matchAll(/^@require:[ \t]*(\S+)/gm)) {
        // A require resolves against the asking file's own generation first
        // and falls back to the other, so a name is claimed by whichever
        // table has it — which is what makes the cross-version examples count
        // towards both corpora rather than neither.
        required.add(setFor(m[1], lang) ?? setFor(m[1], lang === 1 ? 0 : 1));
      }
    }
    for (const set of [...PACKAGE_SETS, ...PACKAGE_SETS_V01]) {
      check(`${set.name}: at least one example uses it`, required.has(set),
        "bundled, attributed, and demonstrated nowhere");
    }
  }

  for (const { set, members } of groups) {
    const href = set.licenseHref.replace("./", "playground/");
    // The LGPL/GPL pair is copied out of the submodule by the deploy, so it is
    // legitimately absent from a source checkout; everything else is committed.
    const fromSubmodule = /LICENSE\.L?GPL-3\.0\.txt$/.test(href);
    let present = fromSubmodule;
    if (!present) {
      try {
        await readFile(new URL(`../${href}`, import.meta.url));
        present = true;
      } catch {
        present = false;
      }
    }
    check(`${set.name}: licence text is committed`, present, href);
    check(`${set.name}: has members`, members.length > 0);
  }
}

// 2. A real document, with a real `@require:`, compiles to a real PDF.
const HELLO = `@require: stdja-mini
document (|title = {Playground}; author = {rustyfi};|) '<
  +p { Hello from WebAssembly. }
>
`;
const good = rustyfi.compile(HELLO);
check("a document with @require: compiles", good.ok, good.ok ? "" : good.error);
if (good.ok) {
  const header = new TextDecoder().decode(good.pdf.slice(0, 5));
  check("output is a PDF", header === "%PDF-", `header was ${JSON.stringify(header)}`);
  check("PDF is non-trivial", good.pdf.length > 500, `${good.pdf.length} bytes`);
  console.log(`     rendered ${good.pdf.length} bytes of PDF`);
}

// 3. A broken document takes the error path with something readable, rather
//    than trapping the module.
const bad = rustyfi.compile("@require: stdja-mini\nthis is not a document");
check("a broken document does not throw", true);
check("a broken document reports an error", !bad.ok, bad.ok ? "it compiled!" : "");
if (!bad.ok) {
  check("the error is readable", bad.error.trim().length > 0, JSON.stringify(bad.error));
  console.log(`     error: ${bad.error.split("\n")[0]}`);
}

// 4. An unresolvable `@require:` names the package it could not find.
const missing = rustyfi.compile(HELLO.replace("stdja-mini", "no-such-package"));
check("an unknown @require: fails", !missing.ok);
if (!missing.ok) {
  check(
    "the error names the missing package",
    missing.error.includes("no-such-package"),
    missing.error.split("\n")[0],
  );
}

// 5. The module survives repeated use — the memory-growth/detached-buffer bug
//    this glue exists to avoid only shows up on a second large compile.
// A 0.1 document, against the 0.1 corpus. Without this the language switch is
// untested plumbing: every check above runs on 0.0.6 and would keep passing
// while selecting 0.1 failed for everyone.
{
  const v01Doc =
    "@require: v01-mini\n\nlet open V01Mini in\ndocument (| title = `v01` |) '<\n" +
    "  +p { Hello from 0.1. }\n>\n";
  const out = rustyfi.compile(v01Doc, null, 1);
  check("a 0.1 document compiles", out.ok, out.ok ? "" : out.error);
  if (out.ok) {
    check("the 0.1 result is a PDF", String.fromCharCode(...out.pdf.slice(0, 5)) === "%PDF-", "");
  }
  // …and the same document must NOT compile as 0.0.6, which is what proves the
  // switch selects a different corpus rather than being decorative.
  const wrong = rustyfi.compile(v01Doc, null, 0);
  check("the same document fails as 0.0.6", !wrong.ok, "0.1 source compiled as 0.0.6");
}

const again = rustyfi.compile(HELLO);
check("compiling twice still works", again.ok, again.ok ? "" : again.error);
if (again.ok && good.ok) {
  check(
    "the same input renders the same bytes",
    again.pdf.length === good.pdf.length,
    `${again.pdf.length} vs ${good.pdf.length}`,
  );
}

// 5b. The HTML render mode. Same compiler, different serialization — so what
//     is worth pinning is that it produces a real page, that it is
//     SELF-CONTAINED (the point of the writer: never a script, never a remote
//     asset), and that it is genuinely reflowable rather than the
//     page-faithful twin, which positions every run absolutely.
{
  const page = rustyfi.compileHtml(HELLO);
  check("the HTML mode compiles", page.ok, page.ok ? "" : page.error);
  if (page.ok) {
    check(
      "the HTML output is a document",
      page.html.startsWith("<!doctype html>"),
      JSON.stringify(page.html.slice(0, 40)),
    );
    check(
      "the HTML output has flowing paragraphs",
      page.html.includes('<p class="para"'),
      "no flowing paragraph in the output",
    );
    // The invariant the reflowable backend exists for. `position: absolute`
    // DOES appear once in its stylesheet — a framed block's drawing layer —
    // so this looks at the body rather than the whole file.
    const body = page.html.split("<body>")[1] ?? page.html;
    check(
      "the HTML content positions nothing",
      !body.includes("position:absolute") && !body.includes("position: absolute"),
      "the reflowed content is absolutely positioned",
    );
    check(
      "the HTML output fetches nothing and runs nothing",
      !page.html.includes("<script") && !/(?:src|href)="https?:/.test(page.html),
      "the page reaches off-origin",
    );
    console.log(`     rendered ${new TextEncoder().encode(page.html).length} bytes of HTML`);
  }
  // A broken document must take the error path here too, not trap.
  const badHtml = rustyfi.compileHtml("@require: stdja-mini\nthis is not a document");
  check("a broken document fails in HTML mode too", !badHtml.ok, "it compiled!");
  check(
    "the HTML-mode error is readable",
    !badHtml.ok && badHtml.error.trim().length > 0,
    JSON.stringify(badHtml.error),
  );
}

// 6. Base-14 refuses a character it cannot encode, rather than dropping it.
//    This is the limitation the page states, so it is worth pinning: silent
//    loss would be far worse than the error.
const nonLatin = rustyfi.compile(HELLO.replace("Hello from WebAssembly.", "\\; dash —"));
check("un-encodable text under base-14 is refused, not dropped", !nonLatin.ok);
if (!nonLatin.ok) {
  check(
    "the error explains the encoding limit",
    /encodable|WinAnsi/i.test(nonLatin.error),
    nonLatin.error.split("\n")[0],
  );
}

// 7. The font path, when a system font happens to be available. Skipped
//    rather than failed otherwise: CI runners vary, and this must not be the
//    reason a deploy is blocked.
const fontCandidates = [
  // Junicode first: it is the face the page itself loads on startup, so the
  // `needsFont` examples get checked against the font a visitor will actually
  // have. Two locations because the deploy fetches it into the submodule and
  // copies it beside the page; a local preview may have either or neither.
  // Resolved against this MODULE rather than the working directory, since the
  // deploy runs `node playground/selftest.mjs` from the repository root.
  new URL("./fonts/Junicode.ttf", import.meta.url),
  new URL("../rustyfi/lib-rustyfi/dist/fonts/Junicode.ttf", import.meta.url),
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/TTF/DejaVuSans.ttf",
  "/usr/share/fonts/liberation-sans/LiberationSans-Regular.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
];
let fontBytes = null;
for (const candidate of fontCandidates) {
  try {
    fontBytes = await readFile(candidate);
    console.log(`     using system font ${candidate}`);
    break;
  } catch {
    /* try the next one */
  }
}
if (fontBytes === null) {
  console.log("skip supplying a font (no system font found; the ABI path is unexercised here)");
} else {
  const withFont = rustyfi.compile(HELLO, fontBytes);
  check("a supplied font renders", withFont.ok, withFont.ok ? "" : withFont.error);
  if (withFont.ok) {
    check(
      "the embedded-font PDF is larger than the base-14 one",
      good.ok && withFont.pdf.length > good.pdf.length,
      `${withFont.pdf.length} vs ${good.ok ? good.pdf.length : "n/a"}`,
    );
  }
  const badFont = rustyfi.compile(HELLO, new Uint8Array([1, 2, 3, 4]));
  check("garbage in the font slot is rejected cleanly", !badFont.ok);
}

// 7b. THE JAPANESE FACE.
//
//     Checked on the RENDERED PDF and not on `result.ok`, because `result.ok`
//     is exactly what used to lie: a document asks for a CJK face by abbrev
//     (`stdja`'s `set-font HanIdeographic (`ipaexm`, …)`), a store with no
//     abbrev map answers `None`, and rustyfi-lang's three-face spelling
//     heuristic — which cannot fail — hands back the Latin face. The compile
//     then succeeds and draws .notdef for every Japanese character. There is
//     no error to assert on, so the assertion has to be about ink.
//
//     What is read out of the PDF is its ToUnicode CMaps, which is what a
//     copy-paste or a `pdftotext` would read. In the broken render every CJK
//     character shares one glyph (.notdef) and the map carries ONE CJK
//     codepoint; in a correct one it carries dozens, and 日, 本 and 語 are
//     each individually present. The control below is not decoration: without
//     it a check that stopped discriminating would stay green forever, which
//     is precisely how this bug survived.
//
//     Unlike section 7 this does NOT skip when the font is missing. A silent
//     skip is the failure mode being tested.

/// Every Unicode scalar any embedded font's ToUnicode CMap maps to.
///
/// A ToUnicode stream is a CMap program; the two forms a `bfchar`/`bfrange`
/// table can take are `<src> <dst>` pairs and `<lo> <hi> <dst>` ranges, and
/// the destination is a UTF-16BE string, so a surrogate pair is two units.
/// Only the BMP is decoded here, which is all a Japanese document reaches.
function pdfMappedCodepoints(bytes) {
  const buf = Buffer.from(bytes);
  const latin1 = buf.toString("latin1");
  const found = new Set();
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(latin1)) !== null) {
    const start = m.index + m[0].length;
    const end = latin1.indexOf("endstream", start);
    if (end < 0) continue;
    const raw = buf.subarray(start, end);
    let text;
    try {
      text = zlib.inflateSync(raw).toString("latin1");
    } catch {
      text = raw.toString("latin1");
    }
    if (!/beginbfchar|beginbfrange/.test(text)) continue;
    for (const pair of text.matchAll(/<([0-9A-Fa-f]{4})>\s*<([0-9A-Fa-f]{4,})>/g)) {
      const dst = pair[2];
      for (let i = 0; i + 4 <= dst.length; i += 4) {
        found.add(parseInt(dst.slice(i, i + 4), 16));
      }
    }
  }
  return found;
}

const isCjk = (cp) =>
  (cp >= 0x3000 && cp <= 0x30ff) || (cp >= 0x3400 && cp <= 0x9fff) ||
  (cp >= 0xf900 && cp <= 0xfaff);

const JA = `@require: stdja
document (|
  title = {日本語の組版};
  author = {rustyfi};
  show-title = true;
  show-toc = false;
|) '<
  +p { これは日本語のテスト文書です。吾輩は猫である。名前はまだ無い。 }
>
`;

let cjkFontBytes = null;
for (const dir of FONT_DIRS) {
  const candidate = resolve(dir, "ipaexg.ttf");
  cjkFontBytes = await readFile(candidate).catch(() => null);
  if (cjkFontBytes !== null) {
    console.log(`     using CJK font ${candidate}`);
    break;
  }
}
check(
  "the Japanese face is available to test against",
  cjkFontBytes !== null,
  "run `sh rustyfi/download-fonts.sh` — this check does not skip, because a " +
  "skip is how the missing-CJK-face bug stayed invisible",
);

{
  const cjkBytes = cjkFontBytes;
  if (cjkBytes !== null && fontBytes !== null) {
    // THE CONTROL: a Latin face alone. This is the old behaviour, and it must
    // still succeed — that is the bug — while drawing essentially nothing.
    const latinOnly = rustyfi.compile(JA, fontBytes, 0);
    check(
      "a Japanese document compiles with only a Latin face (it always did)",
      latinOnly.ok,
      latinOnly.ok ? "" : latinOnly.error.split("\n")[0],
    );
    if (latinOnly.ok) {
      const drawn = [...pdfMappedCodepoints(latinOnly.pdf)].filter(isCjk);
      check(
        "…and draws no Japanese, which is why `ok` cannot be the assertion",
        drawn.length <= 1,
        `${drawn.length} CJK codepoints reached the page without a CJK face`,
      );
    }

    // AND THE FIX.
    const withCjk = rustyfi.compile(JA, fontBytes, 0, cjkBytes);
    check(
      "a Japanese document compiles with the CJK face",
      withCjk.ok,
      withCjk.ok ? "" : withCjk.error.split("\n")[0],
    );
    if (withCjk.ok) {
      const drawn = new Set([...pdfMappedCodepoints(withCjk.pdf)].filter(isCjk));
      check(
        "…and the Japanese is really drawn, not .notdef",
        drawn.size >= 15,
        `only ${drawn.size} distinct CJK codepoints in the PDF`,
      );
      for (const ch of "日本語") {
        check(`the PDF carries ${ch}`, drawn.has(ch.codePointAt(0)));
      }
      check(
        "the CJK face makes the PDF bigger, so it really was embedded",
        latinOnly.ok && withCjk.pdf.length > latinOnly.pdf.length,
        `${withCjk.pdf.length} vs ${latinOnly.ok ? latinOnly.pdf.length : "n/a"}`,
      );
      console.log(`     ${withCjk.pdf.length} bytes of PDF, ${drawn.size} CJK codepoints`);
    }

    // One face, two abbrevs: `stdja` sets body text in `ipaexm` and section
    // headings in `ipaexg`, and the page fetches one file for both. If the two
    // were embedded separately the PDF would carry the 5.8 MB face twice.
    check(
      "one CJK file is embedded, not one per abbrev",
      withCjk.ok && withCjk.pdf.length < cjkBytes.length,
      withCjk.ok ? `${withCjk.pdf.length} bytes` : "no PDF",
    );

    // HTML mode NAMES faces rather than embedding them, so what has to arrive
    // there is the family name at the head of the stack.
    const html = rustyfi.compileHtml(JA, fontBytes, 0, cjkBytes);
    check("a Japanese document compiles in HTML mode", html.ok,
      html.ok ? "" : html.error.split("\n")[0]);
    if (html.ok) {
      check("the HTML names the Japanese family", /IPAex/i.test(html.html),
        "no IPAex family in the emitted CSS");
      check("the HTML carries the Japanese text itself", html.html.includes("吾輩は猫である"));
    }
  }
}

// 8. Every example the page actually ships. A broken example is worse than no
//    example, and this is the only way to know without opening a browser.
//
//    Each is compiled under ITS OWN generation (`example.lang`, defaulting to
//    0.0.6). Compiling everything as 0.0.6 — which is what this loop used to
//    do — would fail every 0.1 example on a parse error, and, worse, a 0.1
//    example that regressed into being valid 0.0.6 would pass silently.
//
//    The floor a rendered example has to clear. `HELLO` above is one short
//    paragraph and comes to about 1.2 kB; every example ships several pages
//    of content, and the smallest is over 5 kB, so this catches a document
//    whose body stopped being rendered without catching a legitimately small
//    one.
const PDF_FLOOR = 2000;
for (const example of EXAMPLES) {
  const lang = example.lang ?? 0;
  const out = rustyfi.compile(example.source, null, lang);
  if (example.refuses) {
    // An example whose whole point is the refusal. Checking the MESSAGE and
    // not merely the failure is what makes this worth shipping: the example's
    // own commentary quotes that message and explains it, so a refusal that
    // started saying something else would leave the page explaining a
    // diagnostic nobody gets.
    check(
      `example "${example.name}" is refused, as it is meant to be`,
      !out.ok,
      "it compiled; drop the refuses pattern",
    );
    if (!out.ok) {
      check(
        `example "${example.name}" is refused for the stated reason`,
        example.refuses.test(out.error),
        out.error.split("\n")[0],
      );
    }
  } else if (example.needsFont) {
    // Expected to fail WITHOUT a font, for the stated reason — if it ever
    // starts succeeding, the label on the page has become a lie.
    check(
      `example "${example.name}" fails without a font, as labelled`,
      !out.ok && /encodable|WinAnsi/i.test(out.error),
      out.ok ? "it compiled; drop the needsFont label" : out.error.split("\n")[0],
    );
    if (fontBytes !== null) {
      // A `needsCjk` example gets the CJK face too, and is checked for INK
      // rather than for success — succeeding while drawing nothing is the
      // failure mode, so `ok` alone would pass on the broken render.
      const cjk = example.needsCjk ? cjkFontBytes : null;
      const withFont = rustyfi.compile(example.source, fontBytes, lang, cjk);
      check(
        `example "${example.name}" succeeds with a font`,
        withFont.ok,
        withFont.ok ? "" : withFont.error.split("\n")[0],
      );
      if (withFont.ok && example.needsCjk) {
        const drawn = new Set([...pdfMappedCodepoints(withFont.pdf)].filter(isCjk));
        check(
          `example "${example.name}" really draws its Japanese`,
          drawn.size >= 15,
          `only ${drawn.size} distinct CJK codepoints in the PDF`,
        );
      }
      if (withFont.ok) {
        console.log(`     ${withFont.pdf.length} bytes of PDF (with a font)`);
        check(
          `example "${example.name}" renders a document, not an empty page`,
          withFont.pdf.length > PDF_FLOOR,
          `${withFont.pdf.length} bytes`,
        );
      }
    }
  } else {
    check(
      `example "${example.name}" compiles`,
      out.ok,
      out.ok ? "" : out.error.split("\n")[0],
    );
    if (out.ok) {
      console.log(`     ${out.pdf.length} bytes of PDF`);
      // An example that compiles to a nearly empty PDF has stopped teaching
      // whatever it was for. These are multi-feature documents now — the
      // smallest is several kilobytes — so a floor well under the smallest
      // one still catches a body that silently stopped being rendered.
      check(
        `example "${example.name}" renders a document, not an empty page`,
        out.pdf.length > PDF_FLOOR,
        `${out.pdf.length} bytes`,
      );
      // …and SUPPLYING a font must not break a document that did not need
      // one. Every metric in the document changes when the face does, so a
      // layout that only holds together under base-14 — an alignment, a
      // fixed-width figbox — would fail here and nowhere else.
      if (fontBytes !== null) {
        const withFont = rustyfi.compile(example.source, fontBytes, lang);
        check(
          `example "${example.name}" still compiles with a font supplied`,
          withFont.ok,
          withFont.ok ? "" : withFont.error.split("\n")[0],
        );
      }
    }
  }
}

// 8b. THE OTHER OUTPUT MODE, on every example. Section 5b pins the HTML
//     writer's properties on one hand-written document; this runs the whole
//     shipped corpus through it, because the page offers the mode for all of
//     them and the writer's hard cases — math drawn from a font outline, a
//     table, a figure, a slide deck — only appear in the examples.
//
//     The self-containment check is per example rather than once, since that
//     is exactly the kind of thing one construct could break: a raster image
//     or a font emitted as a URL would reach off-origin from the one document
//     that used it and nowhere else.
for (const example of EXAMPLES) {
  const lang = example.lang ?? 0;
  const page = rustyfi.compileHtml(
    example.source,
    example.needsFont ? fontBytes : null,
    lang,
    example.needsCjk ? cjkFontBytes : null,
  );
  if (example.refuses) {
    check(
      `example "${example.name}" is refused in HTML mode too`,
      !page.ok,
      "it compiled; a refusal must not depend on the output format",
    );
    continue;
  }
  if (example.needsFont && fontBytes === null) continue;
  check(
    `example "${example.name}" renders as HTML`,
    page.ok,
    page.ok ? "" : page.error.split("\n")[0],
  );
  if (page.ok) {
    check(
      `example "${example.name}" renders HTML that fetches nothing`,
      page.html.startsWith("<!doctype html>") &&
        !page.html.includes("<script") &&
        !/(?:src|href)="https?:/.test(page.html),
      "the page reaches off-origin, or is not a document",
    );
  }
}

// …and the generations are really being told apart. Two ways this could rot
// without any example visibly breaking: the 0.1 entries could all quietly
// disappear, or `lang` could stop being threaded and every example compile as
// 0.0.6 anyway. The second is only detectable by checking that a 0.1 example
// FAILS under 0.0.6 — which every one of them must, the grammars being
// different — so that is what is checked.
{
  const v01 = EXAMPLES.filter((e) => (e.lang ?? 0) === 1);
  check("the page ships 0.1 examples", v01.length > 0, "no example carries lang: 1");
  for (const example of v01) {
    const wrong = rustyfi.compile(example.source, fontBytes, 0);
    check(
      `example "${example.name}" is really 0.1-only`,
      !wrong.ok,
      "it compiled as 0.0.6 too, so `lang` is not selecting anything",
    );
  }
  // And the mirror, which was missing: a 0.0.6 example must fail as 0.1. The
  // omitted `lang` is a real claim about the source, not merely a default, and
  // an example that satisfied BOTH grammars would make the Lang selector look
  // decorative on the very document a reader tried it on. Every generation
  // difference the examples rely on — `;` between record fields, `let-rec`,
  // `open M in` without the `let` — is a parse error on the other side, so
  // this holds for a reason rather than by accident.
  const v006 = EXAMPLES.filter((e) => (e.lang ?? 0) === 0);
  check("the page ships 0.0.6 examples", v006.length > 0, "no example is 0.0.6");
  for (const example of v006) {
    const wrong = rustyfi.compile(example.source, fontBytes, 1);
    check(
      `example "${example.name}" is really 0.0.6-only`,
      !wrong.ok,
      "it compiled as 0.1 too, so `lang` is not selecting anything",
    );
  }
}

// 9. Share links round-trip EXACTLY. The failure mode this guards against is
//    silent: a link that loses a byte still opens, it just opens the wrong
//    document. CJK and the math examples are the interesting inputs, because
//    both leave the ASCII range where a careless base64 would break.
//
//    The network leg is deliberately NOT exercised here: a deploy must not be
//    gated on a third-party service being up — is.gd was down for new links
//    while this was written, which is exactly why there is more than one
//    shortener and why the button degrades to the long URL. The list's SHAPE
//    is checked below, offline, because a typo there fails identically to an
//    outage and would be blamed on the outage.
// The shortener list's shape, offline. A provider whose `endpoint` drops the
// URL, or whose `parse` cannot read its own service's success body, fails the
// same way a real outage does — and would be blamed on the outage.
check("at least one shortener is configured", SHORTENERS.length > 0, "SHORTENERS is empty");
for (const s of SHORTENERS) {
  const probe = "https://example.com/?src=abc";
  const url = typeof s.endpoint === "function" ? s.endpoint(probe) : "";
  check(`shortener ${s.id}: endpoint carries the url`,
    url.startsWith("https://") && url.includes(encodeURIComponent(probe)),
    `endpoint() must embed the encoded URL, got ${url}`);
  check(`shortener ${s.id}: parse rejects an error body`,
    s.parse("Error, database insert failed") === null,
    "a plain-text error body must parse as a decline, not a short URL");
  check(`shortener ${s.id}: maxUrl is a sane positive number`,
    Number.isFinite(s.maxUrl) && s.maxUrl > 100, `maxUrl = ${s.maxUrl}`);
}
check("da.gd parses its own success body",
  SHORTENERS.find((s) => s.id === "da.gd")?.parse("https://da.gd/abc12") === "https://da.gd/abc12",
  "the plain-text success shape must be recognised");
check("tinyurl parses its own success body",
  SHORTENERS.find((s) => s.id === "tinyurl.com")?.parse("https://tinyurl.com/abc123") ===
    "https://tinyurl.com/abc123",
  "the plain-text success shape must be recognised");
// TinyURL is first by request, but its keyless endpoint has been seen serving a
// deprecation interstitial instead of redirecting. The fallbacks are what make
// that survivable, so losing them would quietly turn an intermittent failure
// into a total one.
check("a fallback shortener exists behind tinyurl",
  SHORTENERS.length > 1 && SHORTENERS[0].id === "tinyurl.com",
  "tinyurl must be first, and must not be the only provider");
check("is.gd parses its own success body",
  SHORTENERS.find((s) => s.id === "is.gd")?.parse('{ "shorturl": "https://is.gd/AG3Hwv" }') ===
    "https://is.gd/AG3Hwv",
  "the JSON success shape must be recognised");

const shareCases = [
  ["CJK", "@require: stdjabook\n% 日本語の組版。\ndocument (|title = {組版};|) '<\n  +p { 吾輩は猫である。 }\n>\n"],
  ...EXAMPLES.map((e) => [`example "${e.name}"`, e.source]),
  ["empty", ""],
];
for (const [name, text] of shareCases) {
  const param = await encodeSource(text);
  const back = await decodeSource(param);
  check(`share round-trip: ${name}`, back === text,
    back === text ? "" : `${text.length} chars in, ${back.length} out`);
  check(`share alphabet is URL-safe: ${name}`, /^[01][A-Za-z0-9_-]*$/.test(param),
    param.slice(0, 48));
  // A `+` or `/` surviving into the query would be re-encoded or eaten; this
  // is what makes the parameter safe to paste into a URL unescaped.
  const url = shareUrl("https://example.invalid/rustyfi-playground/", param);
  check(`share survives the query string: ${name}`,
    new URL(url).searchParams.get("src") === param);
}
// The generation travels with the document. Without it a shared 0.1 example
// opens as 0.0.6 and greets the reader with a parse error, which is exactly the
// failure a share link exists to avoid.
{
  const base = "https://example.invalid/rustyfi-playground/";
  const v01 = shareUrl(base, "1abc", 1);
  check("a 0.1 share link says so", shareLang(new URL(v01).search) === 1, v01);
  check("the source survives beside it", new URL(v01).searchParams.get("src") === "1abc", v01);
  // 0.0.6 is the default at both ends, so its links must be UNCHANGED — a
  // `&lang=0` here would break every link already in the wild the moment
  // anything started reading the parameter strictly.
  const v006 = shareUrl(base, "1abc", 0);
  check("a 0.0.6 share link is unchanged", v006 === shareUrl(base, "1abc"), v006);
  check("a link without the parameter means 0.0.6", shareLang(new URL(v006).search) === 0, v006);
  check("rubbish in the parameter means 0.0.6", shareLang("?src=1abc&lang=banana") === 0);
}

// 10. Live diagnostics. The page runs these on every pause in typing, so the
//     properties that matter are: a clean document says nothing, a broken one
//     is positioned WHERE it is broken, and neither can leave the module
//     unusable. Positions are zero-based and count UTF-16 code units, so they
//     are checked against `String.prototype.slice` — the same units a
//     `textarea` uses, which is the whole point of reporting them that way.
//
//     TWO TIERS stand behind `rustyfi_diagnostics`: `rustyfi_lsp::analyze`
//     (lex + parse, no packages, no compile) and, only when that is silent,
//     the whole-program compile against the bundled corpus. They fail in
//     completely different ways, so the checks below say which tier each one
//     is about — a regression that took out one of them entirely would
//     otherwise hide behind the other's passing checks.
{
  const CLEAN = `@require: stdja-mini
document (|title = {t}; author = {a};|) '<
  +p { Nothing wrong here. }
>
`;
  const clean = rustyfi.diagnostics(CLEAN);
  check("a clean document analyses", clean.ok, clean.ok ? "" : clean.error);
  check("a clean document has no diagnostics", clean.ok && clean.diagnostics.length === 0,
    clean.ok ? JSON.stringify(clean.diagnostics) : "");

  // Every field the page reads is present and of the right kind — a missing
  // `endCharacter` would silently produce a zero-width, invisible marker.
  // All four LSP severities are accepted because `rustyfi_lsp::Severity` has
  // four; only `error` is emitted today, and `#diags button` styles every row
  // as one, so a spelling the CSS does not know would be a silent mis-render
  // rather than a crash.
  const shape = (d) =>
    ["line", "character", "endLine", "endCharacter"].every((k) => Number.isInteger(d[k])) &&
    typeof d.message === "string" && d.message.length > 0 &&
    ["error", "warning", "information", "hint"].includes(d.severity);

  // Absolute UTF-16 offsets, exactly as the page's own `rangeOf` computes
  // them. A range that ENDS on the following line is still a range; comparing
  // `endCharacter` to `character` alone would call it empty.
  const spanOf = (text, d) => {
    const lines = text.split("\n");
    const startOf = (l) => lines.slice(0, l).reduce((n, s) => n + s.length + 1, 0);
    return [startOf(d.line) + d.character, startOf(d.endLine) + d.endCharacter];
  };

  // TIER 1: a syntax error, at the line it is on. Line 4 of the source
  // (`>>>`), which is index 3 zero-based — getting THAT wrong by one is the
  // classic way this feature ships broken.
  //
  // `>>>` closes the document and then runs out of input looking for the right
  // operand of a `>`, so the raw failure is ZERO-WIDTH at end of file. The
  // compile-derived stand-in reported that verbatim and the page drew nothing
  // at all; `rustyfi_lsp` widens a degenerate span so there is a character to
  // underline. That is what the range check below is really pinning.
  const SYNTAX = `@require: stdja-mini
document (|title = {t}; author = {a};|) '<
  +p { hi }
>>>
`;
  const syntax = rustyfi.diagnostics(SYNTAX);
  check("a syntax error yields exactly one diagnostic",
    syntax.ok && syntax.diagnostics.length === 1,
    syntax.ok ? JSON.stringify(syntax.diagnostics) : syntax.error);
  if (syntax.ok && syntax.diagnostics.length === 1) {
    const d = syntax.diagnostics[0];
    const [from, to] = spanOf(SYNTAX, d);
    check("the diagnostic has every field the page reads", shape(d), JSON.stringify(d));
    check("the syntax error is on the line it is written on (zero-based 3)",
      d.line === 3, `line ${d.line}`);
    check("the syntax error has a non-empty range", to > from,
      `offsets ${from}-${to} from ${JSON.stringify(d)}`);
    check("the position is not repeated in the message", !/^line \d+, character/.test(d.message),
      d.message);
    // The payload used to be `format!("{err:?}")` over syan's whole error
    // tree: a second and third copy of the position, in byte offsets, inside
    // a nested `Span { start: Loc { .. } }`. It must not come back.
    check("the message is prose, not a Debug dump",
      !/Loc \{|span:|Expected \{/.test(d.message), d.message);
  }

  // THE UTF-16 CHECK, on BOTH tiers. A byte offset would put these markers
  // fourteen characters too far right — one extra position per Japanese
  // character before them — and it would be wrong on exactly the documents
  // this playground exists to show. The two tiers compute the column by
  // completely different routes (a byte-keyed line index in `rustyfi_lsp`,
  // a re-read of the line for a compiler message), so a regression in either
  // would be invisible in the other's check.
  const cjkPrefix = "let s = `吾輩は猫である` in ";
  const utf16Check = (tier, line, needle, lang = 0) => {
    const src =
      `@require: stdja-mini\n${line}\ndocument (|title = {t}; author = {a};|) '<\n  +p { hi }\n>\n`;
    const out = rustyfi.diagnostics(src, lang);
    check(`${tier}: a CJK document analyses to one diagnostic`,
      out.ok && out.diagnostics.length === 1,
      out.ok ? JSON.stringify(out.diagnostics) : out.error);
    if (!out.ok || out.diagnostics.length !== 1) return;
    const d = out.diagnostics[0];
    const want = line.indexOf(needle);
    const bytes = Buffer.byteLength(line.slice(0, want), "utf8");
    // The fixture has to be able to tell the two apart, or the check below
    // passes for the wrong reason.
    check(`${tier}: the CJK fixture really distinguishes bytes from UTF-16`,
      bytes !== want, `both are ${want}`);
    check(`${tier}: a column after Japanese text is in UTF-16 units, not bytes`,
      d.line === 1 && d.character === want,
      `got ${d.line}:${d.character}, want 1:${want} (a byte offset would be ${bytes})`);
    // …and the range, sliced out of the JS string with those numbers, starts
    // at the text the message is about. This is what the underline covers.
    check(`${tier}: the range starts at the offending token`,
      src.split("\n")[d.line].slice(d.character).startsWith(needle),
      JSON.stringify(src.split("\n")[d.line].slice(d.character, d.character + 20)));
  };
  // Tier 1: `@@` is not a token in either generation, so the lexer stops on
  // it — after the Japanese, which is the whole point of the fixture.
  utf16Check("parse tier", `${cjkPrefix}@@`, "@@");
  // Tier 2: an unbound name. Parsing has nothing to say about it; only the
  // whole program does, which is why this tier is still here.
  utf16Check("program tier", `${cjkPrefix}let y = nosuchvariable in`, "nosuchvariable");

  // A failure with no place in THIS document — an unresolvable `@require:` —
  // must not be pinned to a line, or the editor underlines an innocent one.
  // Zero width is how that is said, and the page draws nothing for it.
  const unplaced = rustyfi.diagnostics(CLEAN.replace("stdja-mini", "no-such-package"));
  check("an unresolvable @require: is reported", unplaced.ok && unplaced.diagnostics.length === 1,
    unplaced.ok ? JSON.stringify(unplaced.diagnostics) : unplaced.error);
  if (unplaced.ok && unplaced.diagnostics.length === 1) {
    const d = unplaced.diagnostics[0];
    check("a diagnostic with nowhere to go has an empty range",
      d.line === 0 && d.character === 0 && d.endCharacter === 0, JSON.stringify(d));
    check("…and still names the package", d.message.includes("no-such-package"), d.message);
  }

  // THE ORDER OF THE TIERS. A document that both fails to parse and names a
  // package that does not exist reports the SYNTAX — that is what the author
  // is looking at, and the package name is very likely a casualty of the same
  // half-finished edit. Repairing only the syntax then surfaces the package.
  //
  // Read this for what it is: `rustyfi_loader::load` also parses the entry
  // before resolving a header (it cannot find a header otherwise), so this
  // would pass with the parse tier removed. It pins the ORDER the page relies
  // on, not the existence of the tier.
  {
    const both = "@require: no-such-package\ndocument (|title = {t}; author = {a};|) '<\n" +
      "  +p { hi }\n>>>\n";
    const first = rustyfi.diagnostics(both);
    check("a document with both a syntax error and a bad @require: reports the syntax",
      first.ok && first.diagnostics.length === 1 &&
        !first.diagnostics[0].message.includes("no-such-package"),
      first.ok ? JSON.stringify(first.diagnostics) : first.error);
    const then = rustyfi.diagnostics(both.replace(">>>", ">"));
    check("…and repairing the syntax surfaces the package",
      then.ok && then.diagnostics.length === 1 &&
        then.diagnostics[0].message.includes("no-such-package"),
      then.ok ? JSON.stringify(then.diagnostics) : then.error);
  }

  // The generation is respected: the same 0.1 source is clean as 0.1 and not
  // as 0.0.6. Without this, `lang` could stop being threaded and every
  // diagnostic would silently be about the wrong grammar.
  const v01Doc =
    "@require: v01-mini\n\nlet open V01Mini in\ndocument (| title = `v01` |) '<\n" +
    "  +p { Hello from 0.1. }\n>\n";
  const as01 = rustyfi.diagnostics(v01Doc, 1);
  const as006 = rustyfi.diagnostics(v01Doc, 0);
  check("a 0.1 document is clean when analysed as 0.1",
    as01.ok && as01.diagnostics.length === 0,
    as01.ok ? JSON.stringify(as01.diagnostics) : as01.error);
  check("…and is not, analysed as 0.0.6",
    as006.ok && as006.diagnostics.length === 1,
    as006.ok ? JSON.stringify(as006.diagnostics) : as006.error);

  // Analysis must not wedge the module. The page runs it unattended on a
  // timer, so a document that killed the instance would take the whole page
  // down without anyone pressing anything.
  for (const nasty of ["", " ", "((((((((((((((((((((", "@require:", "\\", "{{{{{{{{"]) {
    const out = rustyfi.diagnostics(nasty);
    check(`analysing ${JSON.stringify(nasty.slice(0, 12))} does not trap`, !out.trapped,
      out.trapped ? out.error : "");
  }
  const after = rustyfi.diagnostics(CLEAN);
  check("the module still works after all of that",
    after.ok && after.diagnostics.length === 0,
    after.ok ? JSON.stringify(after.diagnostics) : after.error);
  const stillTypesets = rustyfi.compile(HELLO);
  check("…and still typesets", stillTypesets.ok, stillTypesets.ok ? "" : stillTypesets.error);

  // Every example the page ships is clean under the ANALYSIS too, not only
  // under a full typeset. The two differ (no rendering, no font), so an
  // example that opens with a red underline would go unnoticed otherwise.
  for (const example of EXAMPLES) {
    const out = rustyfi.diagnostics(example.source, example.lang ?? 0);
    if (example.refuses) {
      // The one example that is supposed to be underlined. It must be
      // underlined for the RIGHT reason, and exactly once — the page tells
      // the reader to go and look at it.
      check(
        `example "${example.name}" analyses to its one intended problem`,
        out.ok && out.diagnostics.length === 1 && example.refuses.test(out.diagnostics[0].message),
        out.ok ? JSON.stringify(out.diagnostics).slice(0, 200) : out.error,
      );
    } else {
      check(
        `example "${example.name}" analyses clean`,
        out.ok && out.diagnostics.length === 0,
        out.ok ? JSON.stringify(out.diagnostics).slice(0, 200) : out.error,
      );
    }
  }
}

// 11. CROSS-VERSION IMPORT: a 0.1 document `@require:`-ing a 0.0.6 package.
//
//     The trap this section exists to avoid is vacuity. If a cross-version
//     example required a name that exists in BOTH corpora, the loader would
//     hand a 0.1 document the 0.1 package, nothing would cross, and the check
//     would pass while demonstrating nothing. So the property checked is not
//     "it compiles" — section 8 already does that — but "it compiles AND the
//     package it needs exists ONLY in the other generation's corpus", which
//     no same-generation resolution can satisfy.
{
  const v006 = new Set(rustyfi.packages(0));
  const v01 = new Set(rustyfi.packages(1));
  const only006 = (name) => v006.has(name) && !v01.has(name);
  const requiresOf = (src) => [...src.matchAll(/^@require:[ \t]*(\S+)/gm)].map((m) => m[1]);

  const crossing = EXAMPLES.filter((e) => (e.lang ?? 0) === 1 && requiresOf(e.source).some(only006));
  check("the page ships cross-version examples", crossing.length > 0,
    "no 0.1 example requires a 0.0.6-only package");

  for (const example of crossing) {
    const foreign = requiresOf(example.source).filter(only006);
    // Non-vacuity, stated as a check rather than assumed: these names are
    // absent from the 0.1 corpus, so a 0.1 document that resolves them can
    // only have reached the 0.0.6 tree.
    check(
      `"${example.name}" requires ${foreign.join(", ")}, which the 0.1 corpus does not have`,
      foreign.every((n) => !v01.has(n)),
      foreign.join(", "),
    );
    const out = rustyfi.compile(example.source, fontBytes, 1);
    if (example.refuses) {
      check(`"${example.name}" is refused across the boundary`, !out.ok && example.refuses.test(out.error),
        out.ok ? "it compiled" : out.error.split("\n")[0]);
    } else {
      check(`"${example.name}" really crosses the version boundary`, out.ok,
        out.ok ? "" : out.error.split("\n")[0]);
    }
  }

  // THE REVERSE CROSSING — a 0.0.6 document reaching into the 0.1 corpus —
  // which needed a third compile arm (`compile_document_v006_xver_with_aux`),
  // since `merge_program` cannot take a `FileV1`. Untested, that arm would be
  // a panic waiting for the first person who tried it.
  //
  // The page ships an example for this direction too, and it gets the same
  // non-vacuity treatment as the forward ones: the names it requires must be
  // absent from the 0.0.6 corpus, or a same-generation resolution could be
  // satisfying them.
  const only01 = (name) => v01.has(name) && !v006.has(name);
  const reversing = EXAMPLES.filter(
    (e) => (e.lang ?? 0) === 0 && requiresOf(e.source).some(only01),
  );
  check("the page ships a reverse cross-version example", reversing.length > 0,
    "no 0.0.6 example requires a 0.1-only package");
  for (const example of reversing) {
    const foreign = requiresOf(example.source).filter(only01);
    check(
      `"${example.name}" requires ${foreign.join(", ")}, which the 0.0.6 corpus does not have`,
      foreign.every((n) => !v006.has(n)),
      foreign.join(", "),
    );
    const out = rustyfi.compile(example.source, fontBytes, 0);
    check(`"${example.name}" really crosses the version boundary`, out.ok,
      out.ok ? "" : out.error.split("\n")[0]);
  }
  // …and the hand-written fixture stays, minimal and independent of whatever
  // the shipped example happens to do this month.
  {
    check("`int` is a 0.1-only package", only01("int"),
      "the fixture must be absent from the 0.0.6 corpus, or this proves nothing");
    const reverse = "@require: stdja-mini\n@require: int\n" +
      "let n = Int.max 3 9 in\nlet s = embed-string (arabic n) in\n" +
      "document (|title = {t}; author = {a};|) '<\n  +p { The larger is #s; . }\n>\n";
    const out = rustyfi.compile(reverse, null, 0);
    check("a 0.0.6 document can call into a 0.1 package", out.ok,
      out.ok ? "" : out.error.split("\n")[0]);
  }

  // Both corpora are mounted at once, like a real library root — but the
  // loader still searches the asking file's OWN generation first, so a name
  // present in both must resolve to the caller's. `itemize` is the case that
  // matters: 0.1's has `?(break)` on `listing` and 0.0.6's does not, so a 0.1
  // document silently given the 0.0.6 one fails at the CALL site with a
  // missing label, which reads like a compiler gap.
  check("a name in both corpora still resolves per generation",
    v006.has("itemize") && v01.has("itemize"),
    "the fixture name must exist in both, or this proves nothing");
  {
    const shared = "@require: v01-mini\n@require: itemize\n\nlet open V01Mini in\n" +
      "document (| title = `x` |) '<\n  +Itemize.listing?(break = true)(Item({}, [Item({a}, [])]));\n>\n";
    const out = rustyfi.compile(shared, null, 1);
    check("…and a 0.1 document gets the 0.1 itemize, not the 0.0.6 one", out.ok,
      out.ok ? "" : out.error.split("\n")[0]);
  }
  // The mirror, for the generation that was NOT changed by mounting both:
  // a 0.0.6 document must still get the 0.0.6 package for a shared name.
  {
    const shared = "@require: stdja-mini\n@require: itemize\n" +
      "document (|title = {t}; author = {a};|) '<\n  +listing{ * a\n * b }\n>\n";
    const out = rustyfi.compile(shared, null, 0);
    check("a 0.0.6 document still gets the 0.0.6 itemize", out.ok,
      out.ok ? "" : out.error.split("\n")[0]);
  }
}

// 12. THE CURSOR-DRIVEN FEATURES: hover, completion, go to definition, the
//     outline, and the `@require:` index the first three answer package
//     vocabulary out of.
//
//     The property that matters most here is not "it answers" but "it answers
//     ABOUT THE RIGHT TEXT". Every position in and out is zero-based with
//     UTF-16 columns, so each check below slices the JavaScript string with
//     the numbers the module returned and asserts what it finds — the same
//     discipline the diagnostics checks use, and for the same reason: a byte
//     offset would pass every ASCII test and be wrong on half this corpus.
{
  const DOC = `@require: stdja-mini
@require: annot
let greeting = {Hello} in
document (|title = {t}; author = {a};|) '<
  +p { \\href(\`https://example.invalid\`){\\emph{x}} #greeting; }
>
`;
  const lines = DOC.split("\n");
  /// The zero-based UTF-16 position of `needle`, `offset` characters in.
  const at = (text, needle, offset = 0) => {
    const abs = text.indexOf(needle) + offset;
    const before = text.slice(0, abs);
    const line = before.split("\n").length - 1;
    return [line, abs - (before.lastIndexOf("\n") + 1)];
  };
  /// What the module's own range covers, sliced out of the document with its
  /// own numbers.
  const covered = (text, r) => {
    const rows = text.split("\n");
    return r.line === r.endLine
      ? rows[r.line].slice(r.character, r.endCharacter)
      : rows[r.line].slice(r.character);
  };

  // The index first: everything else answers out of it.
  const index = rustyfi.index(DOC, 0);
  check("the @require: index resolves the document's packages",
    index.files >= 2 && index.names > 10 && index.unresolved.length === 0,
    JSON.stringify(index));
  check("…and names the packages it read", index.packages.includes("annot"),
    index.packages.join(", "));
  {
    const missing = rustyfi.index(DOC.replace("@require: annot", "@require: nope"), 0);
    check("an unresolvable @require: is reported by the index",
      missing.unresolved.includes("nope"), JSON.stringify(missing));
  }

  // HOVER on a name the document itself binds: answered from the buffer.
  {
    const [l, c] = at(DOC, "greeting", 2);
    const h = rustyfi.hover(DOC, 0, l, c);
    check("hover describes a name this document binds", h !== null && /bound by/.test(h.markdown),
      JSON.stringify(h));
    check("…and its range covers exactly that word", h && covered(DOC, h) === "greeting",
      h ? JSON.stringify(covered(DOC, h)) : "no answer");
  }
  // HOVER on a name only a PACKAGE binds. This is the case the whole
  // dependency index exists for: single-file analysis can say no more than
  // "an inline command, from somewhere else", and 90% of the command sites in
  // the examples this page ships are of this kind.
  {
    const [l, c] = at(DOC, "\\href", 2);
    const h = rustyfi.hover(DOC, 0, l, c);
    check("hover names the package a command comes from",
      h !== null && /package `annot`/.test(h.markdown), JSON.stringify(h));
    check("…and quotes the type its author wrote",
      h !== null && /inline-cmd/.test(h.markdown), h ? h.markdown : "");
    check("…and says it is not bound here, rather than implying it is",
      h !== null && /Not bound in this document/.test(h.markdown), h ? h.markdown : "");
  }
  // HOVER on a header says what it resolved to, out of the same index.
  {
    const [l, c] = at(DOC, "stdja-mini", 2);
    const h = rustyfi.hover(DOC, 0, l, c);
    check("hover on a @require: says which file it resolved to",
      h !== null && /dist\/packages\/stdja-mini/.test(h.markdown), JSON.stringify(h));
  }
  // …and PROSE answers nothing. A hover that fires on every word of a
  // paragraph is worse than one that never fires at all.
  {
    const [l, c] = at(DOC, "Hello", 2);
    check("hover on prose answers nothing", rustyfi.hover(DOC, 0, l, c) === null);
  }

  // THE UTF-16 CHECK for the cursor features, on the same principle as the
  // diagnostics one: a Japanese string before the name on the SAME LINE, so
  // that a byte column and a UTF-16 column disagree by fourteen.
  {
    const CJK = `@require: stdja-mini
let name = 1 in
let s = \`吾輩は猫である\` in let second = name in
document (|title = {t}; author = {a};|) '< +p { x } >
`;
    const [l, c] = at(CJK, "name in");
    const row = CJK.split("\n")[l];
    const bytes = Buffer.byteLength(row.slice(0, c), "utf8");
    check("the CJK fixture really distinguishes bytes from UTF-16", bytes !== c,
      `both are ${c}`);
    const h = rustyfi.hover(CJK, 0, l, c);
    check("hover after Japanese text answers about the name under the cursor",
      h !== null && covered(CJK, h) === "name",
      h ? JSON.stringify(covered(CJK, h)) : "no answer");
    // The byte column, handed over as if it were a character column, must NOT
    // answer the same thing — otherwise the check above would pass for a
    // module that had confused the two.
    const wrong = rustyfi.hover(CJK, 0, l, bytes);
    check("…and the byte column would have answered about something else",
      wrong === null || covered(CJK, wrong) !== "name",
      wrong ? JSON.stringify(covered(CJK, wrong)) : "nothing");
    // Go to definition lands on the binding, whose own columns are ASCII.
    const d = rustyfi.definition(CJK, 0, l, c);
    check("definition after Japanese text lands on the binding",
      d !== null && d.kind === "here" && covered(CJK, d) === "name", JSON.stringify(d));
    check("…on the line the binding is written on", d !== null && d.line === 1,
      JSON.stringify(d));
  }

  // COMPLETION. The page asks on anything that could want a name — a sigil, a
  // `Module.` prefix, a bare word, an empty record label slot — and the MODULE
  // decides, because it is the side that knows the area. An empty answer means
  // "show no popup", which is what prose gets.
  {
    const typing = `@require: stdja-mini
@require: annot
document (|title = {t}; author = {a};|) '<
  +p { \\hr }
>
`;
    const [l, c] = at(typing, "\\hr", 3);
    const items = rustyfi.completions(typing, 0, l, c);
    check("completion after a backslash offers the package's commands",
      items.some((i) => i.label === "\\href"), JSON.stringify(items.slice(0, 4)));
    const href = items.find((i) => i.label === "\\href");
    check("…each carrying the fields the popup shows",
      href !== undefined && typeof href.detail === "string" && href.source === "annot" &&
        Number.isInteger(href.kind), JSON.stringify(href));
    check("…and a range that replaces the sigil too, so the insert is not doubled",
      href !== undefined && covered(typing, href) === "\\hr", JSON.stringify(href));
    // Prose gets nothing at all.
    const [pl, pc] = at(typing, "+p {", 4);
    check("completion in prose offers nothing",
      rustyfi.completions(typing, 0, pl, pc).length === 0);
  }
  // A QUALIFIED command puts its sigil in front of the module path, so the
  // member is inserted WITHOUT one. `+StdJa.+section` would be the bug.
  {
    const v01 = `@require: std-ja

StdJa.document (| title = {t}; author = {a} |) '<
  +StdJa.
>
`;
    const [l, c] = at(v01, "+StdJa.\n", 7);
    const items = rustyfi.completions(v01, 1, l, c);
    check("a qualified command completes to its bare member name",
      items.some((i) => i.label === "section"), JSON.stringify(items.slice(0, 4)));
    check("…and never re-inserts the sigil",
      items.every((i) => !i.label.startsWith("+")), JSON.stringify(items.slice(0, 4)));
  }

  // THE LANGUAGE'S OWN VOCABULARY. A primitive is built into the compiler and
  // appears in no `.satyh`, so an index assembled by walking package SOURCES
  // — which is what everything else here is — could never contain one. That
  // left the completion list missing the core of the language: `read-inline`,
  // `inline-fil`, `get-font-size`, 182 names under 0.0.6 and 206 under 0.1.
  //
  // Taken from `base_env_with_version`, the environment the evaluator actually
  // runs against, so the list cannot drift from what exists.
  {
    const prim = "@require: stdja\nlet z = read-in\n";
    const [l, c] = at(prim, "= read-in", 9);
    const items = rustyfi.completions(prim, 0, l, c);
    const ri = items.find((i) => i.label === "read-inline");
    check("a primitive is offered", ri !== undefined, JSON.stringify(items.slice(0, 5)));
    // With its real signature, not a bare name: the type comes from
    // `prim_types`, which answers for every primitive.
    check("...carrying the type the compiler gives it",
      ri !== undefined && ri.detail.includes("context") && ri.detail.includes("inline-boxes"),
      JSON.stringify(ri));
    check("...and saying it is built in", ri !== undefined && ri.source === "built-in",
      JSON.stringify(ri));
    // Operators are bound in the same environment and are deliberately NOT
    // offered: punctuation is faster to type than to pick, and an empty prefix
    // in program text would put `+`, `++` and `::` at the head of the list.
    const anyOp = "@require: stdja\nlet z = \n";
    const [ol, oc] = at(anyOp, "= \n", 2);
    check("an operator is not a completion candidate",
      rustyfi.completions(anyOp, 0, ol, oc).every((i) => /^[A-Za-z]/.test(i.label)),
      JSON.stringify(rustyfi.completions(anyOp, 0, ol, oc).filter((i) => !/^[A-Za-z]/.test(i.label))));
  }

  // TYPE POSITIONS. Two bugs at once before: an ascription offered nothing,
  // and a type synonym's right-hand side offered VALUES where only a type can
  // go. Both halves are checked, because fixing one without the other is
  // invisible.
  {
    const ann = "@require: stdja\nlet f : inline-tex\n";
    const [al, ac] = at(ann, ": inline-tex", 12);
    check("an ascription offers a base type",
      rustyfi.completions(ann, 0, al, ac).some((i) => i.label === "inline-text"),
      JSON.stringify(rustyfi.completions(ann, 0, al, ac).slice(0, 5)));
    const syn = "@require: stdja\ntype t = leng\n";
    const [sl, sc] = at(syn, "= leng", 6);
    const st = rustyfi.completions(syn, 0, sl, sc);
    check("a type synonym's right-hand side offers a type",
      st.some((i) => i.label === "length"), JSON.stringify(st.slice(0, 5)));
    // The wrong answer it used to give. `length-abs` is a VALUE.
    check("...and no longer offers values there",
      !st.some((i) => i.label === "length-abs"), JSON.stringify(st.slice(0, 5)));
  }

  // HEADERS. `@require:` is the one completion answered out of the bundled
  // corpus rather than out of the document — `rustyfi-lsp` is single-buffer and
  // has no library root to enumerate, while this build has every package
  // compiled in. It is also the name a visitor can least guess, which is why
  // the page carries a Packages panel at all.
  {
    // The KEYWORD half, which the typesetter answers: `@re` does not lex, so
    // the module reads it from the text. `@stage:` is 0.0.6 only -- 0.1 treats
    // it as a hard lexer error -- and the page has a Lang selector, so getting
    // that wrong would offer a compile failure on one of the two settings.
    const kw = "@re\n";
    const [kl, kc] = at(kw, "@re", 3);
    const kws = rustyfi.completions(kw, 0, kl, kc);
    check("a half-typed header completes to the keyword",
      kws.some((i) => i.label === "@require:"), JSON.stringify(kws));
    const st = "@st\n";
    const [tl, tc] = at(st, "@st", 3);
    check("the stage header is offered under 0.0.6",
      rustyfi.completions(st, 0, tl, tc).some((i) => i.label === "@stage:"));
    const st01 = rustyfi.completions(st, 1, tl, tc);
    check("...and withheld under 0.1, where the lexer rejects it",
      st01.length === 0, JSON.stringify(st01));

    const req = "@require: std\n";
    const [l, c] = at(req, ": std", 5);
    const items = rustyfi.completions(req, 0, l, c);
    check("a `@require:` completes a bundled package name",
      items.some((i) => i.label === "stdja"), JSON.stringify(items.slice(0, 6)));
    // The asking generation sorts first, mirroring `resolve_require`'s own
    // search: a 0.0.6 document reaches 0.1 packages through the cross-version
    // fallback, so both are offered and the nearer one leads.
    const i006 = items.findIndex((i) => i.label === "stdja");
    const i01 = items.findIndex((i) => i.label === "std-ja");
    check("\u2026with the document's own generation first",
      i006 >= 0 && i01 >= 0 && i006 < i01, `stdja at ${i006}, std-ja at ${i01}`);
    // A slash is part of a package name, not a boundary.
    const sub = "@require: base/ar\n";
    const [sl, sc] = at(sub, ": base/ar", 9);
    check("\u2026and completes a package name containing a slash",
      rustyfi.completions(sub, 0, sl, sc).some((i) => i.label === "base/array"));
    // `@import:` resolves relative to the importing file's OWN directory, and
    // this page has one file, so there is nothing it could ever name. Offering
    // the bundled list there would be offering names that cannot resolve.
    const imp = "@import: st\n";
    const [il, ic] = at(imp, ": st", 4);
    check("an `@import:` offers nothing, having no directory to resolve against",
      rustyfi.completions(imp, 0, il, ic).length === 0);
  }

  // RECORD LABELS. The first line of almost every document is a record whose
  // labels come from the doc class, not from the buffer — `document (| title =
  // …` — so this is both the commonest completion in the language and the one
  // a reader is least able to guess. It needs BOTH halves of the module: the
  // slot is recognised by `rustyfi-lsp`, and the candidate comes out of the
  // compiled-in package corpus, since nothing in the buffer mentions `title`
  // until it has been typed.
  {
    // `stdja`, not `stdja-mini`: the mini class deliberately accepts ANY
    // record shape and names no label in code, so there is nothing there to
    // harvest. The full class declares the record type, which is exactly the
    // source this feature reads.
    const fresh = `@require: stdja
document (| ti
`;
    const [l, c] = at(fresh, "(| ti", 5);
    const items = rustyfi.completions(fresh, 0, l, c);
    check("a record label slot offers the doc class's own labels",
      items.some((i) => i.label === "title"), JSON.stringify(items.slice(0, 6)));
    // The half that was wrong rather than missing: this slot used to answer
    // with every VALUE in scope, which buried the one useful candidate.
    // Checked by KIND (LSP `CompletionItemKind.Field` is 5) rather than by the
    // shape of the label — a value named `titular` looks exactly like a label.
    check("…and offers nothing but labels there",
      items.length > 0 && items.every((i) => i.kind === 5),
      JSON.stringify(items.slice(0, 6)));

    // Past the `=` the same record is an ordinary expression again.
    const valuePos = `@require: stdja-mini
let titular = 1
in
document (| title = ti
`;
    const [vl, vc] = at(valuePos, "title = ti", 10);
    const vals = rustyfi.completions(valuePos, 0, vl, vc);
    check("past a field's `=` it is a value position again",
      vals.some((i) => i.label === "titular"), JSON.stringify(vals.slice(0, 6)));

    // `#` means field access in program text, not a value embed.
    const access = `@require: stdja-mini
let cfg = (| title = {t}; author = {a} |)
let x = cfg#ti
`;
    const [al, ac] = at(access, "cfg#ti", 6);
    const acc = rustyfi.completions(access, 0, al, ac);
    check("`#` in program text completes a field name",
      acc.some((i) => i.label === "title"), JSON.stringify(acc.slice(0, 6)));
  }

  // DEFINITION on a name from a package cannot jump — this page has one
  // buffer — so it says where the name comes from instead of doing nothing.
  {
    const [l, c] = at(DOC, "\\href", 2);
    const d = rustyfi.definition(DOC, 0, l, c);
    check("definition of a package name says which package",
      d !== null && d.kind === "package" && /annot/.test(d.detail), JSON.stringify(d));
  }

  // THE OUTLINE.
  {
    const symbols = rustyfi.symbols(DOC, 0);
    check("the outline lists the document's own declarations",
      symbols.some((s) => s.name === "greeting" && s.depth === 0),
      JSON.stringify(symbols));
    check("…positioned so a jump lands on the name",
      symbols.every((s) => covered(DOC, s).length > 0), JSON.stringify(symbols));
    check("…and does not list package names as declarations",
      !symbols.some((s) => s.name === "stdja-mini"), JSON.stringify(symbols));
  }

  // COVERAGE, over every example the page ships. Not a target — the features
  // are allowed to be silent, and in prose they must be — but a floor: a
  // regression that broke the dependency index would take these to zero while
  // every check above still passed on its own hand-written fixture.
  {
    let sites = 0, answered = 0, fromCorpus = 0, offered = 0;
    for (const example of EXAMPLES) {
      const lang = example.lang ?? 0;
      const text = example.source;
      const rows = text.split("\n");
      const lineStart = [0];
      for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) lineStart.push(i + 1);
      const lc = (abs) => {
        let line = 0;
        while (line + 1 < lineStart.length && lineStart[line + 1] <= abs) line++;
        return [line, abs - lineStart[line]];
      };
      // The index is a SEPARATE resolution of the same `@require:` graph from
      // the one the compiler does — no elaboration, no typecheck, just enough
      // to answer hover and completion out of a detached buffer. So an
      // example whose packages the compiler finds and the index does not is a
      // real bug, and one that would surface as the editor silently knowing
      // nothing about half the commands in it.
      const index = rustyfi.index(text, lang);
      check(
        `example "${example.name}": the editor's index resolves its packages`,
        index.unresolved.length === 0 && index.names > 0,
        JSON.stringify({ unresolved: index.unresolved, names: index.names }),
      );
      for (const m of text.matchAll(/[\\+][A-Za-z][A-Za-z0-9-]*/g)) {
        sites++;
        const [l, c] = lc(m.index + 1);
        const h = rustyfi.hover(text, lang, l, c);
        if (h) {
          answered++;
          if (/package `/.test(h.markdown)) fromCorpus++;
        }
        const [el, ec] = lc(m.index + m[0].length);
        if (rustyfi.completions(text, lang, el, ec).length > 0) offered++;
      }
      void rows;
    }
    const pct = (n) => Math.round((100 * n) / sites);
    console.log(
      `     ${sites} command sites across the examples: ${pct(answered)}% hover, ` +
      `${pct(fromCorpus)}% of them naming a package, ${pct(offered)}% offer a completion`,
    );
    check("hover answers at most command sites", pct(answered) >= 85, `${pct(answered)}%`);
    check("most of those answers come from the bundled corpus", pct(fromCorpus) >= 80,
      `${pct(fromCorpus)}%`);
    check("completion answers at most command prefixes", pct(offered) >= 75, `${pct(offered)}%`);
  }

  // None of this may wedge the module. It runs on mouseover and on
  // keystrokes, unattended, so a document that killed the instance would take
  // the page down without anyone pressing anything.
  for (const nasty of ["", " ", "\\", "@require:", "{{{{{{{{", "${\\", "let x = 𠮷 in"]) {
    for (const lang of [0, 1]) {
      for (const [l, c] of [[0, 0], [0, 1], [1, 0], [99, 99]]) {
        rustyfi.hover(nasty, lang, l, c);
        rustyfi.definition(nasty, lang, l, c);
        rustyfi.completions(nasty, lang, l, c);
      }
      rustyfi.symbols(nasty, lang);
      rustyfi.index(nasty, lang);
    }
  }
  check("the cursor features do not trap on rubbish", !rustyfi.trapped);
  const stillWorks = rustyfi.compile(HELLO);
  check("…and the module still typesets afterwards", stillWorks.ok,
    stillWorks.ok ? "" : stillWorks.error);
}

// 13. THE LANG SELECTOR'S OWN MISTAKE.
//
//     A 0.1 document analysed as 0.0.6 is underlined from end to end, and the
//     mistake is the selector rather than the text. The extra `otherLang`
//     field is what lets the page offer the switch instead of leaving the
//     reader to work it out.
{
  const v01 = "@require: v01-mini\n\nlet open V01Mini in\ndocument (| title = `v01` |) '<\n" +
    "  +p { Hello from 0.1. }\n>\n";
  const wrong = rustyfi.diagnostics(v01, 0);
  check("a 0.1 document read as 0.0.6 says it parses as 0.1",
    wrong.ok && wrong.diagnostics.length === 1 && wrong.diagnostics[0].otherLang === 1,
    wrong.ok ? JSON.stringify(wrong.diagnostics) : wrong.error);
  const right = rustyfi.diagnostics(v01, 1);
  check("…and there is nothing to offer when it is read correctly",
    right.ok && right.diagnostics.length === 0, JSON.stringify(right.diagnostics ?? right.error));
  // A document that is broken under BOTH generations must not offer a switch
  // that would fix nothing.
  const broken = rustyfi.diagnostics("@require: stdja-mini\ndocument >>> '<", 0);
  check("a document broken either way offers no switch",
    broken.ok && broken.diagnostics.length === 1 &&
      broken.diagnostics[0].otherLang === undefined,
    broken.ok ? JSON.stringify(broken.diagnostics) : broken.error);
}

// 14. THE VENDORED EDITOR.
//
//     The page must fetch NOTHING at runtime: it is served from GitHub Pages
//     with no CDN, no external stylesheet and no remote font, and the editor
//     is the first dependency it has ever had. So the bundle is committed, and
//     these checks are what keep it that way — a `<script src="https://…">`
//     slipped into the page would work perfectly in a browser with a network
//     and break the moment one is missing, which is exactly the failure this
//     playground exists not to have.
{
  const read = async (rel) => readFile(new URL(`./${rel}`, import.meta.url), "utf8");
  const bundle = await read("vendor/codemirror.js").catch(() => null);
  check("the editor bundle is committed", bundle !== null && bundle.length > 100_000,
    bundle === null ? "playground/vendor/codemirror.js is missing" : `${bundle.length} bytes`);
  if (bundle !== null) {
    console.log(`     editor bundle: ${bundle.length} bytes`);
    // A bundler that left an import unresolved would emit a bare or absolute
    // specifier, and the page would then try to fetch it.
    check("the bundle imports nothing at runtime",
      !/\bfrom\s*["'][^."'][^"']*["']/.test(bundle) && !/\bimport\s*\(/.test(bundle),
      "an unresolved import survived bundling");
    check("the bundle contains no absolute URL",
      !/https?:\/\/(?!www\.w3\.org|codemirror\.net)/.test(bundle),
      (bundle.match(/https?:\/\/\S{0,40}/g) ?? []).slice(0, 3).join(" "));
  }
  const notice = await read("licenses/LICENSE-codemirror-MIT.txt").catch(() => null);
  check("the editor's licences travel with it", notice !== null && /MIT/.test(notice ?? ""),
    "playground/licenses/LICENSE-codemirror-MIT.txt is missing");
  if (notice !== null && bundle !== null) {
    // Every package the bundle actually contains has to be named in the
    // notice. `editor/build.mjs` generates it from esbuild's own input list,
    // so a drift here means the bundle was rebuilt by hand.
    for (const pkg of ["@codemirror/state", "@codemirror/view", "@lezer/highlight", "style-mod"]) {
      check(`${pkg} is named in the licence notice`, notice.includes(pkg));
    }
  }
  // The Markdown renderer is vendored on exactly the same terms as the
  // editor: committed, self-contained, and its licence beside it.
  const mdBundle = await read("vendor/markdown.js").catch(() => null);
  check("the Markdown renderer is committed", mdBundle !== null && mdBundle.length > 10_000,
    mdBundle === null ? "playground/vendor/markdown.js is missing" : `${mdBundle.length} bytes`);
  if (mdBundle !== null) {
    console.log(`     markdown bundle: ${mdBundle.length} bytes`);
    check("the Markdown bundle imports nothing at runtime",
      !/\bfrom\s*["'][^."'][^"']*["']/.test(mdBundle) && !/\bimport\s*\(/.test(mdBundle),
      "an unresolved import survived bundling");
  }
  const mdNotice = await read("licenses/LICENSE-markdown-MIT.txt").catch(() => null);
  check("the Markdown renderer's licence travels with it",
    mdNotice !== null && /MIT/.test(mdNotice ?? ""),
    "playground/licenses/LICENSE-markdown-MIT.txt is missing");
  check("marked is named in its licence notice", (mdNotice ?? "").includes("marked"));

  const page = await read("index.html");
  // Every URL the page loads has to be relative. The absolute ones it carries
  // are LINKS a reader may click, not resources it fetches.
  //
  // `action` is scanned beside `src`/`href`, and that is a WIDENING rather than
  // bookkeeping: a form posting off-origin sends the reader's document
  // somewhere, which is exactly what this check exists to notice, and the old
  // pattern could not see one at all.
  const fetched = [...page.matchAll(/(?:src|href|action)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((u) => /^https?:/.test(u))
    .filter((u) => !/github\.com|opensource\.org/.test(u))
    // The two LaTeX hand-offs, allowed here because they are click targets —
    // and held to that by the block below rather than on trust.
    .filter((u) => !/overleaf\.com|latexonline\.cc/.test(u));
  check("the page fetches nothing from another origin", fetched.length === 0, fetched.join(" "));

  // Those hand-offs SEND THE DOCUMENT off-origin, so they are held to the
  // Share button's bargain: on a click, never on load, on edit or on typeset.
  check("the LaTeX hand-offs are click targets, not fetches",
    !/fetch\(\s*[`'"]https:\/\/(?:www\.)?(?:overleaf\.com|latexonline\.cc)/.test(page),
    "something requests one of them without a click");
  check("the hand-offs appear only once a .tex exists",
    /id="texlinks" hidden/.test(page) && /\$\("texlinks"\)\.hidden = false/.test(page),
    "a hand-off shown before a compile would send the PREVIOUS document");
  // Both must name an ENGINE, and it is not a nicety: the generated preamble
  // refuses pdflatex through `iftex`, so a hand-off without one lands the
  // reader on a hard `\PackageError` and reads as a broken button.
  check("the Overleaf hand-off asks for lualatex",
    /name="engine" value="lualatex"/.test(page),
    "Overleaf would default to pdflatex, which this preamble refuses");
  check("the latexonline hand-off asks for lualatex",
    /latexonline\.cc\/compile\?command=lualatex/.test(page),
    "latexonline would default to pdflatex, which this preamble refuses");
  // Overleaf by POST: a `.tex` of any real size does not fit in a URL.
  check("the Overleaf hand-off posts rather than gets",
    /action="https:\/\/www\.overleaf\.com\/docs" method="post"/.test(page));
  // latexonline has only a GET, so an oversized document is refused HERE
  // rather than turned into a request the server answers with a 414.
  check("an oversized document disables latexonline instead of 414ing",
    /LATEXONLINE_MAX_URL/.test(page) && /removeAttribute\("href"\)/.test(page),
    "the whole document rides in the query string, and servers cap that");

  // KaTeX is the ONE off-origin resource, and it is confined to the preview
  // FRAME — it appears in a template string, never in the page's own markup,
  // which is why the check above still holds. Three properties are pinned,
  // because each would fail quietly on its own:
  //   * an exact version, so the CDN cannot hand us a different KaTeX;
  //   * subresource integrity on all three files, since this is SCRIPT running
  //     in a frame that holds the reader's own document;
  //   * `crossorigin`, without which the browser does not CHECK the SRI at all
  //     and the hashes are decoration.
  // The URL and the hashes are BUILT from constants, so grepping the markup
  // for a literal `katex@0.18.4` or `integrity="sha384-` finds nothing and
  // passes for the wrong reason. Check the constants themselves.
  const usesKatex = /cdn\.jsdelivr\.net/.test(page);
  const katexUrls = usesKatex ? ["cdn.jsdelivr.net"] : [];
  check(
    "KaTeX is pinned to an exact version",
    !usesKatex || /KATEX_VERSION = "\d+\.\d+\.\d+"/.test(page),
    "the CDN could hand back a different KaTeX than the hashes were taken from",
  );
  const sri = (page.match(/sha384-[A-Za-z0-9+/]{40,}/g) ?? []).length;
  const cors = (page.match(/crossorigin="anonymous"/g) ?? []).length;
  check("every KaTeX asset carries subresource integrity", !usesKatex || sri === 3,
    `${sri} sha384 hashes for 3 assets`);
  check("SRI is actually checked, i.e. crossorigin is set", katexUrls.length === 0 || cors === 3,
    `${cors} crossorigin attributes`);
  // A dollar the DOCUMENT wrote must not become a KaTeX delimiter. The backend
  // escapes it for Markdown; `marked` resolves that escape to a bare `$`, and
  // auto-render then pairs it with the next one and eats the prose between.
  check(
    "a literal dollar is protected from auto-render",
    !usesKatex ||
      (/ignoredClasses:\['nomath'\]/.test(page) && /function protectLiteralDollars/.test(page)),
    "prose containing ${ would render as mangled text in KaTeX mode",
  );
  // Markdown has no idea what math is, so it applies emphasis inside the
  // delimiters: `$${}_{x}li_{\to}m_{0}$$` became `$${}<em>{x}li</em>…$$` and
  // KaTeX was handed markup instead of LaTeX. Needs an underscore FOLLOWING
  // punctuation to fire, which is why `$x_1$` survived and a centred limit —
  // written with an empty base, `{}_{…}` — did not.
  check(
    "math spans are carried through the Markdown renderer untouched",
    !usesKatex || /function protectMath/.test(page),
    "emphasis inside $…$ would destroy the LaTeX before KaTeX sees it",
  );
  // Rendering must be hooked on DOMContentLoaded, not the scripts' own
  // `onload`. Measured: `onload` fired in the Markdown frame and NOT in the
  // HTML one, so every equation stayed raw `\(…\)` while
  // `renderMathInElement` sat there defined — calling it by hand took 0
  // rendered equations to 17. DOMContentLoaded is ordered by the spec (a
  // deferred script always executes before it fires) rather than by resource
  // timing, so it cannot vary between two documents.
  check(
    "KaTeX rendering is hooked on DOMContentLoaded, not script onload",
    !usesKatex ||
      (/DOMContentLoaded/.test(page) && !/onload=\\"renderMathInElement/.test(page)),
    "script onload does not fire reliably in both preview frames",
  );
  check(
    "KaTeX is only fetched when a KaTeX mode is chosen",
    katexUrls.length === 0 || /mathMode !== 4\) return ""/.test(page),
    "the CDN would be contacted even for readers who never ask for KaTeX",
  );
  check("the page loads the vendored editor", /from "\.\/vendor\/codemirror\.js"/.test(page));
  check("the page bundles a math face", /\.\/fonts\/latinmodern-math\.otf/.test(page),
    "the page never fetches a MATH-table font, so equations will lay out against " +
    "the text face and collapse");
  check("the page loads the vendored Markdown renderer",
    /from "\.\/vendor\/markdown\.js"/.test(page));
  // The format dropdown is gone; the four tabs replace it. A stale `#format`
  // would mean `currentFormat()` reads a control nothing updates.
  check("the output format is chosen by tabs, not a dropdown",
    !/id="format"/.test(page) && (page.match(/class="fmt[ "]/g) ?? []).length === 4,
    `${(page.match(/class="fmt[ "]/g) ?? []).length} tabs, dropdown ${/id="format"/.test(page)}`);
  check("the LaTeX tab is one of them", /data-fmt="latex"/.test(page));
  // `OutputFormat::Latex` admits NO math mode — a `.tex` reaches a math
  // typesetter by definition — so the picker must not appear on that tab. This
  // is the `syncMathOptions` rule one step earlier: there, a mode that would be
  // ignored is disabled; here, a whole control that would be is not shown.
  check("the math picker is not offered on the LaTeX tab",
    !/fmt-latex[^{,]*\.mathpick/.test(page),
    "a control whose every value the backend ignores would be offered");
  // Source is a PRESENTATION of the Markdown result, not a fourth format: both
  // come from one compile, so a tab made switching cost a typeset.
  check("Markdown source is a toggle beside the theme buttons, not a tab",
    /id="mdsrc"/.test(page) && !/data-fmt="markdown-src"/.test(page),
    "the Markdown Source tab is still a format");
  // Choosing a theme means "show me the rendering, like this", so it releases
  // the Source toggle rather than being silently ignored.
  check("choosing a theme releases the source toggle",
    /setSource\(false\)/.test(page),
    "picking light/dark while the source is up would look like a dead click");
  check("the source state has a single owner",
    /function setSource\(on\)/.test(page),
    "the button, the theme buttons and the pressed styling could disagree");
  check("the header no longer names a font", !/id="fontlabel"/.test(page));

  // The Markdown preview's light/dark toggle. The frame is standing in for
  // someone else's Markdown reader, so an explicit choice has to beat the
  // reader's own `prefers-color-scheme` — which needs a rule in BOTH
  // directions, not just a dark one.
  // The math-mode picker. Every mode must reach the module and produce
  // DIFFERENT bytes, or the control is decoration.
  check("the page offers a math-mode picker", /id="mathmode"/.test(page));
  check("the picker is hidden on the PDF tab",
    /body\.fmt-markdown \.mathpick, body\.fmt-html \.mathpick/.test(page),
    "a PDF has one rendering, so the control means nothing there");
  check("markdown-only modes are disabled on the HTML tab",
    /data-md-only/.test(page) && /function syncMathOptions\(\)/.test(page),
    "the module falls back silently, so an offered-but-ignored mode is the " +
      "worst outcome: measured identical output with Unicode selected in HTML");
  {
    // A document WITH math. `HELLO` has none, and with no equation every mode
    // emits the same bytes — the checks below would all pass and mean nothing.
    const EQ =
      "@require: stdja-mini\n@require: math\n" +
      "document (|title = {m}; author = {a}|) '<+p{inline ${x^2 + 1} and " +
      "${\\frac{a}{b}} here}>";
    const mathFace = await readFile(
      new URL("./fonts/latinmodern-math.otf", import.meta.url),
    ).catch(() =>
      readFile(
        new URL("../rustyfi/lib-rustyfi/dist/fonts/latinmodern-math.otf", import.meta.url),
      ).catch(() => null),
    );
    const NAMES = { 1: "outline", 2: "svg-text", 3: "unicode", 4: "katex", 5: "mathml" };
    const md = new Map(), htm = new Map();
    for (const m of [0, 1, 2, 3, 4, 5]) {
      const r = rustyfi.compileMarkdown(EQ, fontBytes, 0, null, mathFace, m);
      if (r.ok) md.set(m, r.markdown);
      const h = rustyfi.compileHtml(EQ, fontBytes, 0, null, mathFace, m);
      if (h.ok) htm.set(m, h.html);
    }
    check("every math mode compiles in markdown", md.size === 6, `${md.size}/6`);
    check("every math mode compiles in html", htm.size === 6, `${htm.size}/6`);
    // Markdown's default is SVG text; HTML's is outline. Those two pairings
    // must match, and the others must not — that is the whole contract.
    check("markdown's default is the SVG-text mode", md.get(0) === md.get(2));
    check("html's default is the outline mode", htm.get(0) === htm.get(1));
    check("markdown's outline mode differs from its default", md.get(0) !== md.get(1));
    check("html's svg-text mode differs from its default", htm.get(0) !== htm.get(2));
    for (const m of [3, 4, 5]) {
      check(`markdown's ${NAMES[m]} mode differs from its default`, md.get(0) !== md.get(m));
    }
    check("html's katex mode differs from its default", htm.get(0) !== htm.get(4));
    check("html's mathml mode differs from its default", htm.get(0) !== htm.get(5));

    // MathML is the one mode whose output is neither a drawing nor someone
    // else's notation, so "differs from the default" is too weak a claim for
    // it: a mode that emitted one `<mtext>` per equation would satisfy that
    // and lose everything the mode exists for. Check the STRUCTURE, in both
    // formats — the fixture has a superscript and a fraction, so `<msup>` and
    // `<mfrac>` are exactly what a real recovery produces.
    for (const [fmt, out] of [["html", htm.get(5)], ["markdown", md.get(5)]]) {
      check(`${fmt}'s mathml mode writes a <math> element`,
        out.includes("<math ") && out.includes("</math>"),
        "no MathML reached the output");
      for (const el of ["<mfrac>", "<msup>"]) {
        check(`${fmt}'s mathml mode writes ${el}`, out.includes(el),
          "the equation arrived unrecovered, which is what this mode exists to avoid");
      }
      check(`${fmt}'s mathml mode draws no equation SVG`, !out.includes("<svg class=\"math"),
        "an equation was still drawn rather than written as MathML");
    }
  }

  check("the Markdown preview has a theme toggle", /class="mdt"/.test(page));
  for (const th of ["auto", "light", "dark"]) {
    check(`the theme toggle offers ${th}`, new RegExp(`data-theme="${th}"`).test(page));
  }
  check(
    "an explicit theme overrides the system preference in both directions",
    /:root\[data-theme="light"\]/.test(page) && /:root\[data-theme="dark"\]/.test(page),
    "only one direction is stated, so forcing light on a dark system will not work",
  );
  check(
    "the forced theme also moves color-scheme",
    /\[data-theme="dark"\][^}]*color-scheme:\s*dark/s.test(page),
    "without it the frame's scrollbars stay in the system palette",
  );
  check(
    "the toggle is scoped to the rendered-Markdown tab",
    /body\.fmt-markdown \.mdtheme/.test(page),
    "it would otherwise show on tabs where it means nothing",
  );

  // Every module the page imports has to be one the deploy cache-busts.
  //
  // `.github/workflows/pages.yml` stamps the commit onto a fixed LIST of
  // specifiers, because Pages caches index.html and its modules independently
  // and a fresh page beside a stale module is a `TypeError` naming a method
  // that plainly exists. An import added here and not added there would go
  // back to being cacheable on its own, and the failure would reappear months
  // later looking like a bug in the page.
  const BUSTED = [
    "./rustyfi.js", "./examples.js", "./share.js", "./packages.js",
    "./vendor/markdown.js", "./vendor/codemirror.js",
  ];
  const imported = [...page.matchAll(/from "(\.\/[^"]+)"/g)].map((m) => m[1]);
  const missed = imported.filter((s) => !BUSTED.includes(s));
  check(
    "every module the page imports is cache-busted by the deploy",
    missed.length === 0,
    `${missed.join(" ")} — add it to the loop in .github/workflows/pages.yml`,
  );
}

// 5d. The Markdown render mode. It is a SUBSET of the HTML one — same
//     recovered structure, written as GitHub-flavoured Markdown — so what is
//     worth pinning is that it is Markdown rather than a page, that the
//     structure survived, and that the two Markdown TABS agree, since they
//     are one compile shown two ways.
{
  const md = rustyfi.compileMarkdown(HELLO, fontBytes);
  check("the Markdown mode compiles", md.ok, md.ok ? "" : md.error);
  if (md.ok) {
    check(
      "the Markdown output is text, not a page",
      !md.markdown.startsWith("<!doctype"),
      JSON.stringify(md.markdown.slice(0, 40)),
    );
    check(
      "the Markdown output is not empty",
      md.markdown.trim().length > 0,
      "nothing was written",
    );
    // The one thing a Markdown reader will not do for us: a `<script>` in the
    // output would run when the page frames the rendering.
    check(
      "the Markdown output runs nothing",
      !/<script/i.test(md.markdown),
      "the Markdown carries a script",
    );
    console.log(
      `     rendered ${new TextEncoder().encode(md.markdown).length} bytes of Markdown`,
    );
  }
  // Structure, on a document that HAS some — HELLO is one paragraph.
  // No CJK face here on purpose: `cjkBytes` is loaded inside the Japanese
  // block and is not in scope, and the check is about STRUCTURE — a heading is
  // a heading whether or not its characters resolve.
  const structured = EXAMPLES.find((e) => /full document class/i.test(e.name));
  const rich = rustyfi.compileMarkdown(structured?.source ?? HELLO, fontBytes, structured?.lang ?? 0);
  if (rich.ok) {
    check(
      "a structured document yields Markdown headings",
      /(?:^|\n)#{1,6} \S/.test(rich.markdown),
      "no ATX heading in the output",
    );
  }
  // A broken document must take the error path here too, not trap.
  const badMd = rustyfi.compileMarkdown("@require: stdja-mini\nthis is not a document");
  check("a broken document fails in Markdown mode too", !badMd.ok, "it compiled!");
  check(
    "the Markdown-mode error is readable",
    !badMd.ok && badMd.error.trim().length > 0,
    JSON.stringify(badMd.error),
  );
}

// 5d′. The LaTeX render mode. The same recovered structure once more, handed to
//      another TYPESETTER rather than to a reader — so what is worth pinning is
//      that it is a COMPLETE document rather than a fragment (a preamble is the
//      difference between something `lualatex` compiles and something it
//      refuses), that it is LaTeX rather than one of the two sibling writers,
//      and that the structure survived the crossing.
{
  const tex = rustyfi.compileLatex(HELLO, fontBytes);
  check("the LaTeX mode compiles", tex.ok, tex.ok ? "" : tex.error);
  if (tex.ok) {
    // Complete, not a fragment. All three, because each is a different way of
    // being incomplete: no preamble, no body, or a body left unclosed.
    for (const marker of ["\\documentclass", "\\begin{document}", "\\end{document}"]) {
      check(`the LaTeX output has ${marker}`, tex.latex.includes(marker),
        "a fragment is not something a TeX engine will compile");
    }
    // NOT one of its siblings. The three writers share `rustyfi_html::recover`,
    // so a mis-wired tab would produce perfectly valid output of the wrong
    // kind — and "is not empty" would not notice.
    check("the LaTeX output is not HTML", !/<!doctype|<p class=/i.test(tex.latex),
      "the HTML writer answered on the LaTeX tab");
    console.log(`     rendered ${new TextEncoder().encode(tex.latex).length} bytes of LaTeX`);
  }
  // Structure, on a document that HAS some — as for Markdown above, and for
  // the same reason: HELLO is one paragraph and would pin nothing.
  const structured = EXAMPLES.find((e) => /full document class/i.test(e.name));
  const richTex = rustyfi.compileLatex(
    structured?.source ?? HELLO, fontBytes, structured?.lang ?? 0,
  );
  if (richTex.ok) {
    check(
      "a structured document yields LaTeX sectioning",
      /\\(?:sub)*section\*?\{/.test(richTex.latex),
      "no sectioning command in the output",
    );
  }
  // A broken document must take the error path here too, not trap.
  const badTex = rustyfi.compileLatex("@require: stdja-mini\nthis is not a document");
  check("a broken document fails in LaTeX mode too", !badTex.ok, "it compiled!");
  check(
    "the LaTeX-mode error is readable",
    !badTex.ok && badTex.error.trim().length > 0,
    JSON.stringify(badTex.error),
  );
}

// 5e. THE MATH FACE. A text face has no `MATH` table, so without a separate
//     math font `Context::math_font` falls back to the Latin one and every
//     constant math layout reads becomes a guess: limits land on top of their
//     operator, fraction bars vanish, fences stop stretching. It RENDERS —
//     which is why this needs a test rather than an error path.
{
  const mathBytes = await readFile(
    new URL("./fonts/latinmodern-math.otf", import.meta.url),
  ).catch(() =>
    readFile(
      new URL("../rustyfi/lib-rustyfi/dist/fonts/latinmodern-math.otf", import.meta.url),
    ).catch(() => null),
  );
  check(
    "the math face is available to test against",
    mathBytes !== null,
    "latinmodern-math.otf is in neither playground/fonts/ nor the submodule — " +
      "run `sh rustyfi/download-fonts.sh`",
  );
  if (mathBytes !== null && fontBytes !== null) {
    const EQ = "@require: stdja-mini\n@require: math\n" +
      "document (|title = {m}; author = {a}|) '<+p{${\\sum_{k=1}^{n} k^2 = \\frac{1}{6}}}>";
    const withMath = rustyfi.compile(EQ, fontBytes, 0, null, mathBytes);
    const without = rustyfi.compile(EQ, fontBytes, 0, null, null);
    check("an equation compiles with the math face", withMath.ok,
      withMath.ok ? "" : withMath.error);
    check("an equation compiles without one too", without.ok,
      without.ok ? "" : without.error);
    // The load-bearing one. Both succeed; what proves the math face actually
    // reached the LAYOUT is that the two PDFs differ. If this ever passes
    // vacuously, the face is being accepted and ignored.
    if (withMath.ok && without.ok) {
      const same =
        withMath.pdf.length === without.pdf.length &&
        withMath.pdf.every((b, i) => b === without.pdf[i]);
      check(
        "the math face changes the typeset result",
        !same,
        "identical output with and without a MATH-table face — the math " +
          "default is not reaching Context::math_font",
      );
      console.log(
        `     equation: ${without.pdf.length} bytes without a math face, ` +
          `${withMath.pdf.length} with`,
      );
    }
  }
}

// A link a browser cannot decode must SAY so rather than load garbage.
let refused = null;
try {
  await decodeSource("2AAAA");
} catch (e) {
  refused = e.message;
}
check("an unknown share encoding is refused", refused !== null, "it decoded something");

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
