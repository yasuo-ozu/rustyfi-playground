// Glue for the `rustyfi-wasm` C ABI. Deliberately hand-written and tiny:
// the module is a plain `cdylib` with no wasm-bindgen imports, so loading it
// needs nothing but `WebAssembly.instantiate` and a `Uint8Array`.
//
// The one rule worth stating: `instance.exports.memory.buffer` is DETACHED
// whenever wasm memory grows, and compiling a document grows it a lot. Every
// access below therefore takes a fresh view rather than caching one — a
// cached view would silently read zeroes after the first large compile.

/// Wrap an instantiated module in the small API the page and the self-test use.
function wrap(instance) {
  const ex = instance.exports;
  const view = () => new Uint8Array(ex.memory.buffer);
  /// Latched by the cursor-driven entry points, which cannot report a trap
  /// through their return value the way `compile` does: they answer "nothing
  /// here" for a living, and a caller must be able to tell that apart from a
  /// dead instance.
  let trapped = false;

  // Consume an `*mut Output`: copy its bytes out, then free it. The copy is
  // required — the bytes live in wasm memory and `rustyfi_output_free`
  // invalidates them.
  const take = (out) => {
    if (out === 0) throw new Error("rustyfi: the module returned a null Output (allocation failed)");
    try {
      const ok = ex.rustyfi_output_ok(out) === 1;
      const ptr = ex.rustyfi_output_ptr(out);
      const len = ex.rustyfi_output_len(out);
      // `slice` copies; `subarray` would alias memory we are about to free.
      const bytes = view().slice(ptr, ptr + len);
      return { ok, bytes };
    } finally {
      ex.rustyfi_output_free(out);
    }
  };

  const text = (bytes) => new TextDecoder("utf-8").decode(bytes);

  // Copy `bytes` into wasm memory, returning `[ptr, len]`. `[0, 0]` for an
  // empty input, which every ABI entry point accepts as "not supplied".
  const push = (bytes) => {
    if (!bytes || bytes.length === 0) return [0, 0];
    const ptr = ex.rustyfi_alloc(bytes.length);
    if (ptr === 0) throw new Error("rustyfi: out of memory");
    view().set(bytes, ptr);
    return [ptr, bytes.length];
  };

  return {
    /// Compile SATySFi source, optionally with a TrueType/OpenType font
    /// (a `Uint8Array`). Returns `{ ok: true, pdf }` or `{ ok: false, error }`.
    ///
    /// A trap — a stack overflow on a pathologically deep document, say — is
    /// caught and reported as an error rather than left to reject, because a
    /// trapped module is unusable afterwards and the page should say so.
    /// `lang` is `0` for SATySFi 0.0.6 (the default) and `1` for 0.1. Exactly
    /// one corpus is mounted per call, so a 0.1 document resolves `@require:`
    /// against the 0.1 packages and never silently against a 0.0.6 one.
    ///
    /// `cjkFont` is a SECOND face, and it is not interchangeable with the
    /// first: `font` fills the three style slots (regular/bold/oblique), while
    /// `cjkFont` is registered under the abbrevs a document names — `ipaexm`
    /// and `ipaexg`, which is what `stdja` and friends ask for. Without it a
    /// `set-font HanIdeographic` naming one of those resolves onto the Latin
    /// face and the document typesets `.notdef` WITHOUT failing, so leaving it
    /// out for a Japanese document is a silent wrong answer, not an error.
    compile(source, font, lang = 0, cjkFont = null, mathFont = null) {
      // No math mode: the PDF has one rendering, and the flag is a usage error
      // against `--format pdf` in the CLI for the same reason.
      return this.render(
        ex.rustyfi_compile_with_fonts_lang, source, font, lang, cjkFont, mathFont, null, "pdf",
      );
    },

    /// Compile SATySFi source to a self-contained HTML page. Same inputs and
    /// same failure handling as `compile`; returns `{ ok: true, html }` or
    /// `{ ok: false, error }`.
    ///
    /// The font matters here for a reason of its own: the reflowable backend
    /// NAMES faces rather than embedding them, and the family name is also
    /// what tells it a run is fixed-pitch — the only signal separating a
    /// `+code` block from a wrapped paragraph. `cjkFont` puts `IPAexGothic` at
    /// the head of a Japanese run's family stack for the same reason.
    compileHtml(source, font, lang = 0, cjkFont = null, mathFont = null, mathMode = 0) {
      return this.render(
        ex.rustyfi_compile_html_fonts, source, font, lang, cjkFont, mathFont, mathMode, "html",
      );
    },

    /// Compile SATySFi source to GitHub-flavoured Markdown. Returns
    /// `{ ok: true, markdown }` or `{ ok: false, error }`.
    ///
    /// The font is not optional in practice, for a reason peculiar to this
    /// backend: Markdown names no fonts at all, but the writer reads the
    /// family name off the store to decide which runs are fixed-pitch, and
    /// that is the whole difference between a fenced code block and a
    /// paragraph of prose.
    /// `mathMode` selects how equations are written: 0 the format's own
    /// default, 1 outlined SVG, 2 SVG text, 3 Unicode characters, 4 KaTeX,
    /// 5 MathML Core — the one the browser lays out itself, with nothing
    /// fetched and no script run.
    /// Zero rather than a name because the boundary is C; `MathMode` has no
    /// `Default` in the library precisely because the right answer differs per
    /// format, so 0 means "let the format decide", not "the first variant".
    compileMarkdown(source, font, lang = 0, cjkFont = null, mathFont = null, mathMode = 0) {
      return this.render(
        ex.rustyfi_compile_markdown_fonts, source, font, lang, cjkFont, mathFont, mathMode,
        "markdown",
      );
    },

    /// Compile SATySFi source to a complete, compilable LaTeX document.
    /// Returns `{ ok: true, latex }` or `{ ok: false, error }`.
    ///
    /// No `mathMode`, and `null` is passed for it rather than `0`: a `.tex`
    /// reaches a math typesetter by definition, so LaTeX math is the only
    /// reading with any meaning and `OutputFormat::Latex` admits no choice.
    /// The ABI reflects that — `rustyfi_compile_latex_fonts` takes the PDF
    /// entry point's argument list, not the two text backends' — so `null`
    /// here is not "the default", it is "this ABI has no such argument".
    ///
    /// The font is read for one thing only, the same one Markdown reads it
    /// for: whether a run is fixed-pitch, which separates a `verbatim` from a
    /// paragraph. Nothing is embedded — a `.tex` names its fonts and lets the
    /// engine find them.
    compileLatex(source, font, lang = 0, cjkFont = null, mathFont = null) {
      return this.render(
        ex.rustyfi_compile_latex_fonts, source, font, lang, cjkFont, mathFont, null, "latex",
      );
    },

    /// The shared body of the four above: push the source and every face, and
    /// turn the `Output` into `{ ok, pdf | html | markdown | latex }` or
    /// `{ ok: false, error }`.
    ///
    /// `field` names the successful payload, which is the only difference
    /// between them — the PDF is bytes, the two text formats are decoded.
    render(fn, source, font, lang, cjkFont, mathFont, mathMode, field) {
      const src = new TextEncoder().encode(source);
      let srcPtr = 0, srcLen = 0, fontPtr = 0, fontLen = 0;
      let cjkPtr = 0, cjkLen = 0, mathPtr = 0, mathLen = 0;
      try {
        [srcPtr, srcLen] = push(src);
        [fontPtr, fontLen] = push(font);
        [cjkPtr, cjkLen] = push(cjkFont);
        [mathPtr, mathLen] = push(mathFont);
        // The PDF entry point predates the math mode and does not take one;
        // `mathMode === null` is how a caller says "this ABI has no such
        // argument", as against 0, which means "the format's default".
        const { ok, bytes } = take(
          mathMode === null
            ? fn(srcPtr, srcLen, fontPtr, fontLen, cjkPtr, cjkLen, mathPtr, mathLen, lang)
            : fn(srcPtr, srcLen, fontPtr, fontLen, cjkPtr, cjkLen, mathPtr, mathLen, mathMode, lang),
        );
        if (!ok) return { ok: false, error: text(bytes) };
        // Only the PDF is bytes; every other backend's payload is UTF-8.
        return { ok: true, [field]: field === "pdf" ? bytes : text(bytes) };
      } catch (e) {
        trapped = true;
        return {
          ok: false,
          error:
            `the WebAssembly module trapped: ${e && e.message ? e.message : e}\n\n` +
            "This usually means the document was too deeply nested for the " +
            "module's stack. Reload the page to get a fresh module.",
          trapped: true,
        };
      } finally {
        if (srcPtr !== 0) ex.rustyfi_dealloc(srcPtr, srcLen);
        if (fontPtr !== 0) ex.rustyfi_dealloc(fontPtr, fontLen);
        if (cjkPtr !== 0) ex.rustyfi_dealloc(cjkPtr, cjkLen);
        if (mathPtr !== 0) ex.rustyfi_dealloc(mathPtr, mathLen);
      }
    },

    /// Analyse SATySFi source without typesetting it, for live editor
    /// diagnostics. Returns `{ ok: true, diagnostics: [...] }`, where each
    /// entry is
    ///
    ///     { line, character, endLine, endCharacter, severity, message }
    ///
    /// with ZERO-BASED positions whose columns count UTF-16 code units — i.e.
    /// exactly the units `textarea.setSelectionRange` and `String.length`
    /// use, so a marker lands in the right place in a Japanese document.
    /// A clean document yields an empty array.
    ///
    /// `lang` selects the generation, as for `compile`.
    ///
    /// Failure modes are the same two `compile` has, and are reported the same
    /// way, because the caller has to treat them differently from "the
    /// document has mistakes": `{ ok: false, error }` for an analysis that
    /// could not run, additionally `trapped: true` if the module itself died.
    /// A trapped module stays broken, so a caller running this on a timer must
    /// stop when it sees that.
    diagnostics(source, lang = 0) {
      const src = new TextEncoder().encode(source);
      let srcPtr = 0, srcLen = 0;
      try {
        [srcPtr, srcLen] = push(src);
        const { ok, bytes } = take(ex.rustyfi_diagnostics(srcPtr, srcLen, lang));
        if (!ok) return { ok: false, error: text(bytes) };
        return { ok: true, diagnostics: JSON.parse(text(bytes)) };
      } catch (e) {
        trapped = true;
        return {
          ok: false,
          error: `the WebAssembly module trapped while analysing: ${e && e.message ? e.message : e}`,
          trapped: true,
        };
      } finally {
        if (srcPtr !== 0) ex.rustyfi_dealloc(srcPtr, srcLen);
      }
    },

    /// Reformat the document. Returns `{ ok: true, text }` with the WHOLE new
    /// source, or `{ ok: false, error }`.
    ///
    /// Whitespace only: the module re-emits the lexer's token stream and never
    /// reorders, inserts or drops a token, so the reply differs from the input
    /// in inter-token space and nowhere else. Space inside inline text,
    /// block text, math, a string literal or a comment body is CONTENT and is
    /// left exactly as written.
    ///
    /// `ok: false` means the formatter DECLINED — a buffer that does not lex
    /// has no token stream to re-emit — and not "no changes". An
    /// already-formatted buffer answers `ok: true` with text equal to the
    /// input, so a caller that wants to say "nothing to do" compares.
    ///
    /// `lang` selects the generation, as for `compile`. Unlike the five cursor
    /// entry points this reports its failures rather than swallowing them: it
    /// runs on an explicit gesture, so there IS someone to tell.
    /// Reformat, with settings.
    ///
    /// `config` is the text a `rustyfi-fmt.toml` would hold — `max_width = 100`,
    /// `tab_spaces = 2`, `max_blank_lines = 2`, `wrap_comments = false` — or an
    /// empty string for the built-in defaults.
    ///
    /// Settings travel as TEXT rather than as arguments on purpose: adding a
    /// formatter option later changes neither the module's ABI nor this file.
    /// An unknown key is an ERROR, not a warning — a typo that silently does
    /// nothing is worse than one that says so, because you would believe you
    /// had configured the formatter.
    format(source, lang = 0, config = "") {
      // A MISSING EXPORT IS NOT A TRAP, and the difference is not cosmetic.
      // The page and the module are two separately cached files (see
      // `instantiateFromUrl` on the `?v=` stamp, and on the `compileMarkdown is
      // not a function` split that produced it), so a fresh page CAN meet a
      // stale module. Calling `undefined` would throw, land in the catch below
      // and latch `trapped` — which is permanent, and which `ask` reads, so one
      // press of a button the old module cannot serve would silently take hover,
      // completion, go-to-definition, the outline and the dependency index down
      // with it for the rest of the session. Say what is actually wrong instead.
      const withConfig = typeof ex.rustyfi_format_with_config === "function";
      if (!withConfig && typeof ex.rustyfi_format !== "function") {
        return {
          ok: false,
          error:
            "this WebAssembly module has no formatter — the page and the module " +
            "have come from different builds. Reload the page (a hard reload if " +
            "your browser has one) to get a matching pair.",
        };
      }
      const src = new TextEncoder().encode(source);
      const cfg = new TextEncoder().encode(config || "");
      let srcPtr = 0, srcLen = 0, cfgPtr = 0, cfgLen = 0;
      try {
        [srcPtr, srcLen] = push(src);
        [cfgPtr, cfgLen] = push(cfg);
        const out = withConfig
          ? ex.rustyfi_format_with_config(srcPtr, srcLen, lang, cfgPtr, cfgLen)
          : ex.rustyfi_format(srcPtr, srcLen, lang);
        const { ok, bytes } = take(out);
        if (!ok) return { ok: false, error: text(bytes) };
        return { ok: true, text: text(bytes) };
      } catch (e) {
        trapped = true;
        return {
          ok: false,
          error: `the WebAssembly module trapped while formatting: ${e && e.message ? e.message : e}`,
          trapped: true,
        };
      } finally {
        if (srcPtr !== 0) ex.rustyfi_dealloc(srcPtr, srcLen);
        if (cfgPtr !== 0) ex.rustyfi_dealloc(cfgPtr, cfgLen);
      }
    },

    /// Describe what is at a cursor, for a hover tooltip:
    ///
    ///     { line, character, endLine, endCharacter, markdown }
    ///
    /// or `null` when there is nothing to say, which is an ordinary answer —
    /// most positions in a document are prose. Positions in BOTH directions
    /// are zero-based with UTF-16 columns, exactly as `diagnostics` reports
    /// them, so an editor hands over what it already has.
    ///
    /// A trap is caught and latched (see `trapped`) rather than thrown: this
    /// runs on mouseover, and an exception per pointer movement would be
    /// unusable.
    hover(source, lang, line, character) {
        return this.ask(ex.rustyfi_hover, source, lang, line, character, null);
    },

    /// Where the name at a cursor is defined. One of
    ///
    ///     { kind: "here", line, character, endLine, endCharacter }
    ///     { kind: "package", name, detail }
    ///
    /// or `null`. The second is a name that comes from a bundled package,
    /// which the page cannot open — it says so instead of jumping.
    definition(source, lang, line, character) {
      return this.ask(ex.rustyfi_definition, source, lang, line, character, null);
    },

    /// Completion candidates at a cursor:
    ///
    ///     [{ label, detail, source, kind, line, character, endLine, endCharacter }]
    ///
    /// `kind` is LSP's `CompletionItemKind`; `source` is where the candidate
    /// came from — "this document", or the package that declares it. The range
    /// is the text a client should replace. An empty array is the common
    /// answer and means "show nothing", not "nothing exists".
    completions(source, lang, line, character) {
      return this.ask(ex.rustyfi_completions, source, lang, line, character, []);
    },

    /// The document's own declarations, in source order:
    ///
    ///     [{ name, detail, kind, depth, line, character, endLine, endCharacter }]
    symbols(source, lang) {
      return this.ask(ex.rustyfi_symbols, source, lang, undefined, undefined, []);
    },

    /// Build the `@require:` index hover and completion answer out of, and
    /// report what is in it: `{ files, names, packages, unresolved }`.
    ///
    /// Worth calling when the page is idle: the index is what makes the other
    /// three answer about package vocabulary, it costs one parse per
    /// dependency file, and it is cached until a header changes.
    index(source, lang) {
      return this.ask(ex.rustyfi_index, source, lang, undefined, undefined, {
        files: 0, names: 0, packages: [], unresolved: [],
      });
    },

    /// The shared body of the five above: push the source, call, parse JSON,
    /// and fall back to `fallback` if the module trapped.
    ask(fn, source, lang, line, character, fallback) {
      if (trapped) return fallback;
      const src = new TextEncoder().encode(source);
      let srcPtr = 0, srcLen = 0;
      try {
        [srcPtr, srcLen] = push(src);
        const out = line === undefined
          ? fn(srcPtr, srcLen, lang)
          : fn(srcPtr, srcLen, lang, line, character);
        return JSON.parse(text(take(out).bytes));
      } catch {
        trapped = true;
        return fallback;
      } finally {
        if (srcPtr !== 0) ex.rustyfi_dealloc(srcPtr, srcLen);
      }
    },

    /// Whether the module has trapped. A trapped instance stays broken, so a
    /// caller running anything on a timer must stop when it sees this.
    get trapped() {
      return trapped;
    },

    /// The package names a document may `@require:`, for one generation.
    packages(lang = 0) {
      const { bytes } = take(ex.rustyfi_packages_lang(lang));
      return text(bytes).split("\n").filter((s) => s.length > 0);
    },

    /// The `rustyfi-wasm` crate version.
    version() {
      return text(take(ex.rustyfi_version()).bytes);
    },
  };
}

/// Instantiate from raw `.wasm` bytes (an `ArrayBuffer` or view).
export async function instantiate(wasmBytes) {
  const { instance } = await WebAssembly.instantiate(wasmBytes, {});
  return wrap(instance);
}

/// Instantiate by URL, streaming where the server sets `application/wasm`.
/// Falls back to a buffered fetch, because GitHub Pages has been known to
/// serve `.wasm` with the wrong MIME type, which makes the streaming path
/// throw.
export async function instantiateFromUrl(url) {
  // Inherit this module's own `?v=` (the deploy stamps the commit onto every
  // module specifier). Without it the WASM is cached on its own terms, so a
  // fresh page could load a fresh `rustyfi.js` beside a ten-minute-old module
  // whose exports it no longer matches — the same split that produced
  // `compileMarkdown is not a function`, one layer down and harder to read,
  // because a missing WASM export surfaces as a failure inside this file.
  const version = new URL(import.meta.url).search;
  if (version && !String(url).includes("?")) url = `${url}${version}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`rustyfi: cannot fetch ${url} (HTTP ${response.status})`);
  try {
    const { instance } = await WebAssembly.instantiateStreaming(response.clone(), {});
    return wrap(instance);
  } catch {
    return instantiate(await response.arrayBuffer());
  }
}
