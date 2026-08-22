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
for (const example of EXAMPLES) {
  const out = rustyfi.compile(example.source);
  if (example.needsFont) {
    // Expected to fail WITHOUT a font, for the stated reason — if it ever
    // starts succeeding, the label on the page has become a lie.
    check(
      `example "${example.name}" fails without a font, as labelled`,
      !out.ok && /encodable|WinAnsi/i.test(out.error),
      out.ok ? "it compiled; drop the needsFont label" : out.error.split("\n")[0],
    );
    if (fontBytes !== null) {
      const withFont = rustyfi.compile(example.source, fontBytes);
      check(
        `example "${example.name}" succeeds with a font`,
        withFont.ok,
        withFont.ok ? "" : withFont.error.split("\n")[0],
      );
    }
  } else {
    check(
      `example "${example.name}" compiles`,
      out.ok,
      out.ok ? "" : out.error.split("\n")[0],
    );
  }
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
