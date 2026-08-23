// End-to-end check of the real `.wasm`, through the same `rustyfi.js` glue the
// page uses. Run from the repository root after a wasm build:
//
//   cargo build -p rustyfi-wasm --release --target wasm32-unknown-unknown
//   node playground/selftest.mjs target/wasm32-unknown-unknown/release/rustyfi_wasm.wasm
//
// The Pages workflow runs this before deploying, so a module that builds but
// cannot actually typeset never reaches the site. Offline, no TTY.

import { readFile } from "node:fs/promises";
import { instantiate } from "./rustyfi.js";
import { EXAMPLES } from "./examples.js";
import { decodeSource, encodeSource, shareLang, shareUrl, SHORTENERS } from "./share.js";
import { PACKAGE_SETS, PACKAGE_SETS_V01, groupPackages, setsFor } from "./packages.js";

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

// 8. Every example the page actually ships. A broken example is worse than no
//    example, and this is the only way to know without opening a browser.
//
//    Each is compiled under ITS OWN generation (`example.lang`, defaulting to
//    0.0.6). Compiling everything as 0.0.6 — which is what this loop used to
//    do — would fail every 0.1 example on a parse error, and, worse, a 0.1
//    example that regressed into being valid 0.0.6 would pass silently.
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
      const withFont = rustyfi.compile(example.source, fontBytes, lang);
      check(
        `example "${example.name}" succeeds with a font`,
        withFont.ok,
        withFont.ok ? "" : withFont.error.split("\n")[0],
      );
      if (withFont.ok) console.log(`     ${withFont.pdf.length} bytes of PDF (with a font)`);
    }
  } else {
    check(
      `example "${example.name}" compiles`,
      out.ok,
      out.ok ? "" : out.error.split("\n")[0],
    );
    if (out.ok) console.log(`     ${out.pdf.length} bytes of PDF`);
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

  // The REVERSE crossing, which no example ships but which mounting both
  // corpora also makes reachable — and which needed a third compile arm
  // (`compile_document_v006_xver_with_aux`), since `merge_program` cannot
  // take a `FileV1`. Untested, that arm would be a panic waiting for the
  // first person who tried it.
  {
    check("`int` is a 0.1-only package", v01.has("int") && !v006.has("int"),
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

  // COMPLETION. Only ever after a sigil or a `Module.` prefix — the page will
  // not even ask otherwise — and an empty answer means "show no popup".
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
      rustyfi.index(text, lang);
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
  const page = await read("index.html");
  // Every URL the page loads has to be relative. The two absolute ones it
  // carries are LINKS a reader may click, not resources it fetches.
  const fetched = [...page.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((u) => /^https?:/.test(u))
    .filter((u) => !/github\.com|opensource\.org/.test(u));
  check("the page fetches nothing from another origin", fetched.length === 0, fetched.join(" "));
  check("the page loads the vendored editor", /from "\.\/vendor\/codemirror\.js"/.test(page));
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
