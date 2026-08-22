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
    compile(source, font, lang = 0) {
      const src = new TextEncoder().encode(source);
      let srcPtr = 0, srcLen = 0, fontPtr = 0, fontLen = 0;
      try {
        [srcPtr, srcLen] = push(src);
        [fontPtr, fontLen] = push(font);
        const { ok, bytes } = take(
          ex.rustyfi_compile_with_font_lang(srcPtr, srcLen, fontPtr, fontLen, lang),
        );
        return ok ? { ok: true, pdf: bytes } : { ok: false, error: text(bytes) };
      } catch (e) {
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
        return {
          ok: false,
          error: `the WebAssembly module trapped while analysing: ${e && e.message ? e.message : e}`,
          trapped: true,
        };
      } finally {
        if (srcPtr !== 0) ex.rustyfi_dealloc(srcPtr, srcLen);
      }
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
  const response = await fetch(url);
  if (!response.ok) throw new Error(`rustyfi: cannot fetch ${url} (HTTP ${response.status})`);
  try {
    const { instance } = await WebAssembly.instantiateStreaming(response.clone(), {});
    return wrap(instance);
  } catch {
    return instantiate(await response.arrayBuffer());
  }
}
