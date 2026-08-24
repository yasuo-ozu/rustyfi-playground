// The Markdown renderer the playground's "Markdown" tab uses, bundled from
// `marked` by `../build.mjs`.
//
// Configured for what rustyfi's own Markdown backend actually emits:
//
//   gfm       — pipe tables and fenced code, which the backend writes.
//   breaks    — OFF. The backend already decides where a paragraph ends; a
//               soft wrap inside one is its own line and must NOT become a
//               `<br>`, or every rejoined line gains a break the PDF has not.
//
// Raw HTML passes through, which is load-bearing rather than lax: a drawing
// is emitted as an inline `<svg>`, and sanitising it away would silently drop
// every figure. The input is not user-supplied — it is this page's own
// compiler output, from source the same reader just typed.
import { marked } from "marked";

marked.setOptions({ gfm: true, breaks: false });

/// Named for what it does rather than `renderMarkdown`, which the page
/// already has: that one is the hover tooltip's three-case formatter, which
/// builds TEXT NODES so a type quoted out of a package cannot become markup.
/// This one deliberately does the opposite — it is a full parser and it lets
/// raw HTML through — because its input is the compiler's own output, not a
/// package's prose. Two different jobs; two different names.
export function markdownToHtml(src) {
  return marked.parse(src);
}
