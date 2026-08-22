// Putting a document into a URL, and getting it back.
//
// Its own module rather than inline in the page for the same reason
// `examples.js` is: `selftest.mjs` imports it and checks the round-trip before
// a deploy. A share link that silently mangles CJK or a math example is worse
// than no share button, and this is the only way to know without a browser.
//
// The document travels in the `?src=` QUERY STRING, not the fragment, so it
// reaches anything that reads the URL server-side. It is compressed with the
// platform's own `CompressionStream` and base64url-encoded — no library, and
// nothing to fetch, because this page has no dependencies and is meant to keep
// none.
//
// The first character of the value tags the encoding. That one byte is what
// lets a browser without `CompressionStream` still emit a readable link, and a
// browser without `DecompressionStream` say what it cannot open rather than
// showing mojibake.

/// `deflate-raw`, then base64url.
export const DEFLATED = "1";
/// UTF-8 bytes, then base64url. The fallback when compression is unavailable.
export const PLAIN = "0";

/// is.gd refuses a URL longer than this, so there is no point in a request we
/// already know will fail; the caller falls back to the long URL instead.
export const SHORTENER_MAX_URL = 5000;

const toBase64Url = (bytes) => {
  let binary = "";
  // Chunked: `String.fromCharCode(...bytes)` blows the argument limit on a
  // document of any real size.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const fromBase64Url = (text) => {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

async function through(stream, bytes) {
  const piped = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(piped).arrayBuffer());
}

/// The `src` parameter value for `text`.
export async function encodeSource(text) {
  const bytes = new TextEncoder().encode(text);
  if (typeof CompressionStream === "function") {
    try {
      return DEFLATED + toBase64Url(await through(new CompressionStream("deflate-raw"), bytes));
    } catch {
      /* fall through to the uncompressed form */
    }
  }
  return PLAIN + toBase64Url(bytes);
}

/// The inverse. Throws — with a reason worth showing a reader — rather than
/// returning something that only looks like a document.
export async function decodeSource(param) {
  const bytes = fromBase64Url(param.slice(1));
  if (param.startsWith(PLAIN)) return new TextDecoder().decode(bytes);
  if (!param.startsWith(DEFLATED)) throw new Error("unrecognised link encoding");
  if (typeof DecompressionStream !== "function") {
    throw new Error("this browser has no DecompressionStream, which the link needs");
  }
  return new TextDecoder().decode(await through(new DecompressionStream("deflate-raw"), bytes));
}

/// `here` with its query replaced by the shared document. Any existing query
/// or fragment is dropped: the link means "open this document", nothing else.
export function shareUrl(here, param) {
  const url = new URL(here);
  url.hash = "";
  url.search = `?src=${param}`;
  return url.toString();
}

/// Ask is.gd for a short URL.
///
/// Resolves to `null` when it declines, which is a normal outcome rather than
/// an error: the caller copies the long URL and says which one it copied.
///
/// **This is the one thing on the page that leaves the tab**, so it only ever
/// runs from an explicit click — never on load, never on edit. The URL carries
/// the document, so shortening does hand the document to a third party.
export async function shorten(longUrl) {
  if (longUrl.length > SHORTENER_MAX_URL) return null;
  const endpoint = `https://is.gd/create.php?format=json&url=${encodeURIComponent(longUrl)}`;
  try {
    const res = await fetch(endpoint);
    // is.gd answers HTTP 200 whatever happens, and an outage comes back as
    // plain text ("Error, database insert failed") rather than as its
    // documented `{errorcode, errormessage}` JSON — so a parse failure is one
    // of the shapes to expect here, not an impossibility.
    const body = await res.json();
    return typeof body.shorturl === "string" ? body.shorturl : null;
  } catch {
    return null;
  }
}
