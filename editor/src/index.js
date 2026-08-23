// The vendored editor's public surface: exactly the CodeMirror 6 pieces
// `playground/index.html` names, and nothing else.
//
// Written as an explicit re-export list rather than `export * from …` so that
// the bundle's size is a function of this file, which is reviewable, instead
// of a function of what CodeMirror happens to export. `basicSetup` is
// deliberately NOT used: it pulls in search, code folding, bracket
// auto-closing and a rectangular-selection mode, none of which this page
// wants, and all of which would be paid for on every load.
//
// No SATySFi language mode is built in here — that is the page's own code
// (`satysfiHighlighting` in `index.html`), so this file stays pure upstream
// and can be rebuilt from `package.json` alone.

export {
  EditorState,
  Compartment,
  StateEffect,
  StateField,
  RangeSetBuilder,
} from "@codemirror/state";

export {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  drawSelection,
  dropCursor,
  placeholder,
  hoverTooltip,
  Decoration,
  ViewPlugin,
} from "@codemirror/view";

export { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";

export {
  autocompletion,
  completionKeymap,
  startCompletion,
  closeCompletion,
} from "@codemirror/autocomplete";

export { linter, lintGutter, forceLinting, openLintPanel } from "@codemirror/lint";

export {
  StreamLanguage,
  HighlightStyle,
  syntaxHighlighting,
  indentUnit,
  bracketMatching,
} from "@codemirror/language";

export { tags } from "@lezer/highlight";
