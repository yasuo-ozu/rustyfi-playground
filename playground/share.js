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

/// The shorteners tried, in order, first success wins.
///
/// More than one because a single provider is a single point of failure, and
/// both of the obvious ones failed:
///
/// - **is.gd** answers `Error, database insert failed` (HTTP 200, plain text)
///   to every request regardless of length — a 113-character URL fails
///   identically to a 2,703-character one, so it is not a length limit, a rate
///   limit or a CORS problem. Kept last because it has worked before and
///   trying it costs a request only after the others have declined.
/// - **TinyURL is first by request.** Its keyless `api-create.php` is the
///   LEGACY endpoint and has been seen to serve a "created using a deprecated
///   API end point" interstitial instead of redirecting. That is not
///   reproducible on demand — every link minted here answers 301 with the
///   right `location`, browser headers included — so it appears intermittent
///   rather than universal. Its current API would avoid the question but needs
///   a Bearer token, and this page is static and public, so a token shipped in
///   it would be published with it. The two providers below stay as fallbacks
///   precisely because of the interstitial: if TinyURL declines, a link still
///   gets made.
export const SHORTENERS = [
  {
    id: "tinyurl.com",
    // Plain text: the short URL on success, a body containing "Error"
    // otherwise. No length limit is documented; 8000 is the practical ceiling
    // for a URL that still has to survive being pasted around.
    maxUrl: 8000,
    endpoint: (u) => `https://tinyurl.com/api-create.php?url=${encodeURIComponent(u)}`,
    parse: (body) => (body.trim().startsWith("https://") ? body.trim() : null),
  },
  {
    id: "da.gd",
    // Plain text, no key, and `access-control-allow-origin: *`. The first
    // fallback because it is keyless BY DESIGN rather than by legacy, and was
    // answering when is.gd was not.
    maxUrl: 8000,
    endpoint: (u) => `https://da.gd/shorten?url=${encodeURIComponent(u)}`,
    parse: (body) => (body.trim().startsWith("https://") ? body.trim() : null),
  },
  {
    id: "is.gd",
    maxUrl: 5000,
    endpoint: (u) => `https://is.gd/create.php?format=json&url=${encodeURIComponent(u)}`,
    parse: (body) => {
      try {
        const parsed = JSON.parse(body);
        return typeof parsed.shorturl === "string" ? parsed.shorturl : null;
      } catch {
        // Its failure mode is plain text, not JSON, and not an HTTP error.
        return null;
      }
    },
  },
];

/// The longest URL any configured shortener will consider. Past this the
/// caller need not ask at all.
export const SHORTENER_MAX_URL = Math.max(...SHORTENERS.map((s) => s.maxUrl));

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
///
/// `lang` travels beside the source because the two generations have different
/// grammars: a 0.1 document opened as 0.0.6 is a parse error, so a link that
/// carried only the text would reliably arrive broken. It is emitted ONLY for
/// 0.1 — 0.0.6 is the default at both ends, so every link that worked before
/// is still byte-identical.
export function shareUrl(here, param, lang = 0) {
  const url = new URL(here);
  url.hash = "";
  url.search = lang === 1 ? `?src=${param}&lang=1` : `?src=${param}`;
  return url.toString();
}

/// The generation a share link asks for: `1` only when it says so, and `0`
/// (0.0.6, the default) for anything else, including a link from before the
/// parameter existed and a link carrying rubbish.
export function shareLang(search) {
  return new URLSearchParams(search).get("lang") === "1" ? 1 : 0;
}

/// Ask each shortener in turn for a short URL.
///
/// Resolves to `null` when they all decline, which is a normal outcome rather
/// than an error: the caller copies the long URL and says which one it copied.
///
/// **This is the one thing on the page that leaves the tab**, so it only ever
/// runs from an explicit click — never on load, never on edit. The URL carries
/// the document, so shortening does hand the document to a third party.
///
/// Every response is read as TEXT, never as JSON: these services answer HTTP
/// 200 with a plain-text error, so `res.json()` would throw on exactly the
/// case that has to be handled.
export async function shorten(longUrl) {
  for (const service of SHORTENERS) {
    if (longUrl.length > service.maxUrl) continue;
    try {
      const res = await fetch(service.endpoint(longUrl));
      if (!res.ok) continue;
      const short = service.parse(await res.text());
      if (short) return short;
    } catch {
      // Unreachable, blocked, or CORS-refused: try the next one.
    }
  }
  return null;
}
