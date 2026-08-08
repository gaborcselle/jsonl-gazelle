# AGENTS.md — Contributor & AI Agent Guide

This document describes the actual architecture of JSONL Gazelle so that human contributors and AI coding agents can navigate, extend, and test the codebase. Everything here is grounded in the current source — if this file and the code disagree, the code wins (and this file should be fixed).

## Overview

JSONL Gazelle is a VS Code extension that registers a **custom text editor** (`jsonl-gazelle.jsonlViewer`) for `.jsonl` and `.ndjson` files. It renders three views — Table, Pretty Print, and Raw — inside a single webview, supports in-place editing that writes back to the underlying text document, includes a file stats popover showing record count, column count, and file size, and provides optional AI-powered features (AI columns, AI row generation, column suggestions) via multiple providers (OpenAI, Anthropic, Google Gemini, or local OpenAI-compatible servers).

## Repository Layout

| Path | Purpose |
|---|---|
| `src/extension.ts` | Activation: registers the custom editor provider, the `jsonl-gazelle.refresh` and `jsonl-gazelle.openLargeFile` (split) commands, a file decoration provider that badges large files, and the rating prompt manager. |
| `src/jsonlViewerProvider.ts` | The core `CustomTextEditorProvider`: parses JSONL, manages rows/columns/search state, handles all webview messages, applies document edits, calls the OpenAI API. |
| `src/webview/template.ts` | Webview HTML, exported as a template-literal function `getHtmlTemplate(...)`. |
| `src/webview/styles.ts` | Webview CSS as one exported string. |
| `src/webview/scripts.ts` | Webview JavaScript as one exported string (table rendering, view switching, editing UI, find/replace, modals). |
| `src/jsonl/types.ts` | Shared interfaces (`JsonRow`, `ParsedLine`, `ColumnInfo`). |
| `src/jsonl/utils.ts` | Pure helpers: nested get/set/delete by dot-path, pretty→JSONL conversion, stringified-JSON detection. |
| `src/jsonl/rowMapping.ts` | Search filtering that preserves original row indices. |
| `src/jsonl/sorting.ts` | Column sorting: value-type autodetection (timestamp/currency/number/boolean/text) and comparators that carry row indices along. |
| `src/jsonl/columns.ts` | `getUnhideableColumns()` — which hidden columns the "Unhide Column" menu may offer (mirrored in `scripts.ts`). |
| `src/jsonl/gridNavigation.ts` | `moveGridCursor()` — where the table's keyboard cell cursor lands for each navigation key (mirrored in `scripts.ts`). |
| `test/` | Plain Node test scripts (no framework), run by `npm test`. |
| `test-data/` | Sample JSONL files plus `generate-large.js` for a ~64 MB stress file. |
| `tools/screenshots/` | Regenerates the README's `jsonl-gazelle-*.jpg` screenshots from the real webview code via headless Chromium (see its own README.md). Dev-only, excluded from the `.vsix`. |

There is **no bundler for the webview**: `getHtmlForWebview()` stitches `template.ts` + `styles.ts` + `scripts.ts` into a single HTML string. The Monaco editor (used for Raw and Pretty Print views) is loaded at runtime from `https://cdn.jsdelivr.net`.

## Build, Test, Lint

```bash
npm install        # or npm ci
npm run compile    # tsc -p ./
npm run lint       # eslint src --ext .ts
npm test           # compile + node test/*.test.js
npm run bundle     # esbuild bundle of src/extension.ts -> out/extension.js (used by vsce packaging)
```

Launch the extension with F5 in VS Code (Extension Development Host). CI runs compile + lint + test on every PR via `.github/workflows/ci.yml`.

Packaging (`vsce package`) runs `vscode:prepublish`, which bundles the whole extension host into a single minified `out/extension.js` via esbuild. `.vscodeignore` excludes everything else except the icon, `gazelle.svg`, `gazelle-animation.gif`, README, LICENSE, and `package.json` — the two gazelle assets are loaded at runtime via `asWebviewUri`, so they must stay in the package. Note that `npm run bundle` overwrites the `tsc` output at `out/extension.js`; run `npm run compile` again before F5 debugging if you packaged first.

## Data Flow

1. `resolveCustomTextEditor()` sets up the webview, message listener, and an `onDidChangeTextDocument` subscription.
2. `loadJsonlFile(document)` splits the document text into lines and parses each with `JSON.parse`:
   - Files with more lines than `jsonl-gazelle.performance.chunkedLoadingThreshold` (default 1000) load progressively in the background (`loadRemainingChunks`).
   - Files with more rows than `jsonl-gazelle.performance.maxMemoryRows` (default 50000) switch to memory-optimized mode.
3. `updateWebview(panel)` posts a full snapshot `{ type: 'update', data: { rows, rowIndices, allRows, columns, parsedLines, rawContent, prettyContent, prettyLineMapping, errorCount, loadingProgress, appendCompatible } }`. `allRows` is omitted when it would be identical to `rows` (no active search); the webview then aliases it to `rows`.
4. During background chunk loading (no active search), progress updates are **`appendRows` deltas** instead: only the rows/parsedLines added since the last message (`sendAppendedRows`, tracked via `lastSentRowCount` / `webviewRowsSynced`). The webview merges them into `currentData` without touching the rendered table. If a delta's `baseRowCount` doesn't match (e.g. a message was dropped while the webview was hidden), the webview replies `requestFullUpdate`. The final post-loading `update` carries `appendCompatible: true`, which lets the webview keep its DOM and scroll position.
5. On a non-append `update` the webview rebuilds the table header and re-renders the body **from scratch**, chunked 200 rows at a time as the user scrolls, then restores the previous scroll offset (`rebuildTable` / `restoreTableScroll`). Any webview-side UI state (e.g. the selected row) must be kept in a JS variable and re-applied during render — see `selectedRowActualIndex` in `scripts.ts` for the pattern.

## Message Protocol

Communication is `webview.postMessage` / `vscode.postMessage` with a `type` field.

**Webview → extension** (handled in the `onDidReceiveMessage` switch in `jsonlViewerProvider.ts`):

`search`, `removeColumn`, `updateCell`, `expandColumn`, `collapseColumn`, `openUrl`, `documentChanged`, `rawContentChanged`, `rawContentSave`, `prettyContentChanged`, `prettyContentSave`, `forceSave`, `unstringifyColumn`, `deleteRow`, `insertRow`, `copyRow`, `duplicateRow`, `pasteRow`, `validateClipboard`, `reorderColumns`, `reorderRows`, `setDisplaySort`, `sortRows`, `toggleColumnVisibility`, `showColumns`, `addColumn`, `addAIColumn`, `getSettings`, `getRecentEnumValues`, `checkAPIKey`, `showAPIKeyWarning`, `saveSettings`, `resetSettings`, `generateAIRows`, `requestColumnSuggestions`, `refresh`, `requestFullUpdate`, `setFollowMode`, `setViewPreference`, `setWrapTextPreference`

**Extension → webview**:

`update` (full data snapshot), `appendRows` (delta during background chunk loading), `clipboardValidationResult`, `settingsLoaded`, `settingsSaved`, `recentEnumValuesLoaded`, `apiKeyCheckResult`, `columnSuggestions`

## Editing & Save Path

All writes go through `vscode.workspace.applyEdit()` with a full-document replace, wrapped in an `isUpdating` guard flag so the `onDidChangeTextDocument` handler doesn't reload the file for self-inflicted edits. Cell edits are debounced (~300 ms) via `pendingSaveTimeout`. The guard is time-boxed with `setTimeout` resets — **any new write path must set `isUpdating` the same way**, or edits will trigger spurious full reloads.

## Refresh & Follow Mode

- The `refresh` message (toolbar button, Ctrl/Cmd+R, F5, or the `jsonl-gazelle.refresh` command) reverts the document from disk (`workbench.action.files.revert`) and reloads. If the document has unsaved changes, the user is asked to confirm first.
- `setFollowMode` (tail -f style) creates a `FileSystemWatcher` on the file while enabled; disk changes revert the (non-dirty) document, which flows through the normal reload path, and the webview pins the table scroll to the bottom after each update. The watcher is disposed on toggle-off, panel dispose, and editor switch.

## AI Integration (as it actually exists)

- **Providers**: OpenAI, Anthropic, Google Gemini, and OpenAI-compatible endpoints (Ollama, LM Studio, vLLM, etc.). API calls run in the **extension host**, not the webview.
- **Settings**: API keys and selected provider/model are stored in `context.secrets` and `context.globalState`, managed through the in-app settings modal (gear icon), *not* VS Code settings.
- **Prompt templates** support these placeholders (resolved per row in `jsonlViewerProvider.ts`):
  - `{{row}}` — the entire row as JSON
  - `{{row.fieldname}}`, `{{row.fieldname[0]}}` — nested field / array element by path
  - `{{row_number}}` — 1-based row number
  - `{{rows_before}}` / `{{rows_after}}` — counts around the current row
  - `{{context_rows}}` / `{{row_count}}` — used by AI row generation
- **Features**: fill a new column with AI output per row (`addAIColumn`), generate new rows from context (`generateAIRows`), and AI-suggested column definitions (`requestColumnSuggestions`).
- **Model lists** are fetched live from each provider at settings time, allowing users to select from available models without manual configuration.

## Configuration

VS Code settings (`contributes.configuration` in `package.json`):

| Setting | Default | Effect |
|---|---|---|
| `jsonl-gazelle.largeFile.splitThresholdMB` | 100 | Size above which the split command/badge activates |
| `jsonl-gazelle.largeFile.partSizeMB` | 50 | Max size of each split part |
| `jsonl-gazelle.performance.chunkedLoadingThreshold` | 1000 | Line count above which files load progressively |
| `jsonl-gazelle.performance.maxMemoryRows` | 50000 | Row count above which memory-optimized mode kicks in |

The webview cannot read VS Code configuration directly — anything the webview needs must be passed through the `update` payload (or the initial HTML).

## Adding a Feature — Checklist

1. **Webview UI**: add markup in `template.ts`, styles in `styles.ts`, behavior in `scripts.ts`.
2. **New message type**: post it from `scripts.ts` (`vscode.postMessage({ type: '...' })`), add a `case` in the provider's `onDidReceiveMessage` switch.
3. **Webview state**: remember the table is fully rebuilt on every `update` — persistent UI state must live in a `scripts.ts` variable and be re-applied during render.
4. **Document writes**: wrap in the `isUpdating` guard (see Editing & Save Path).
5. **Commands/keybindings**: declare in `package.json` `contributes`, register in `extension.ts`.
6. **Tests**: pure logic belongs in `src/jsonl/` where it can be tested by a plain Node script in `test/` (follow `test/rowMapping.test.js`).

## Gotchas

- **CSP**: the webview has a Content-Security-Policy (`template.ts`). Inline scripts require the nonce that `getHtmlForWebview()` generates; external resources are limited to `https://cdn.jsdelivr.net` (Monaco) and `img-src` to webview resource URIs. If you add external resources, extend the CSP deliberately — never add `unsafe-eval`.
- **`retainContextWhenHidden` is on**: the webview keeps state when the tab is backgrounded.
- **One provider instance** serves all editors; per-document state (e.g. `activeDocumentUri`, `manualColumnsPerFile`) is keyed or reset in `resolveCustomTextEditor`.
- **Template-literal sources**: `scripts.ts`/`styles.ts`/`template.ts` are TypeScript files exporting giant strings — ESLint lints the TS wrapper, not the embedded JS/CSS. Backticks and `${}` inside them must be escaped.
- **Search filtering** produces `filteredRows` + `filteredRowIndices`; webview row handlers must distinguish the filtered index (`dataset.index`) from the real file index (`dataset.actualIndex`).
- **Hidden columns are advertised.** When `getUnhideableColumns()` finds any, `buildTableHeader` puts a count badge on the row-number header; clicking it calls `openUnhideColumnsMenu`, which opens the column menu with no column selected and pops the unhide submenu open. That click must `stopPropagation()` — the document-level handler closes the menu on any click outside it, and the badge sits outside.
- **Column visibility has a floor.** `toggleColumnVisibility` refuses to hide the last visible column, and `restoreColumnPreferences` ignores a stored state that hides every column. Without both, a file of bare JSON values — which has a single `(value)` column — could be left showing numbered rows with no cells and no header to right-click, and the per-file preference would bring that back on every load.
- **Two kinds of sort.** `setDisplaySort` is display-only: `filterRows()` permutes `filteredRows` **and** `filteredRowIndices` together (`applyDisplaySort`), so `actualIndex` keeps pointing at the right line and every edit path works unchanged. `sortRows` is the permanent one and rewrites the document like any other write. Consequences of an active display sort: `filteredRows` is no longer the same array as `rows`, so `appendCompatible` append-only deltas are skipped in favour of full updates; and row drag-reorder is disabled in the webview, since a drop target's screen position no longer matches its file position. The permanent sort refuses to run while the file is still loading, in memory-optimized mode, or when there are parse errors — in each case `rows` is not the whole file and rewriting it would lose data.
- **The cell cursor is stored by file row + column path**, never by screen coordinates (`cursorActualRowIndex` / `cursorColumnPath` in `scripts.ts`). The tbody is rebuilt on every update, rows are filtered by search, and a display sort permutes them — coordinates would go stale on all three, whereas a row/path pair resolves to a position only when it is needed (`getCursorPosition`) and simply reports "off screen" when the row is filtered out or the column hidden. The highlight elements (`cursorCellElement`, `selectedRowElement`) are remembered so moving the cursor doesn't scan a fully rendered table, and `createTableRow` re-points them as it re-applies the classes.
- **The cell editor stops propagation on Enter/Tab/Escape.** The edit is over the moment the key is handled, so the grid's own document-level handler would see the same keystroke, find no editor open, and act on it a second time — committing with Enter would immediately reopen the editor on the cell below.
- **Scrolling the cursor into view is done by hand** (`scrollCellIntoView`), not with `scrollIntoView()`: the header row and the row-number column are `position: sticky`, so they float over the scroll area and the browser will happily park the cursor underneath them.
- **Editing the sorted column re-sorts the view**, so the edited row can move. `watchSortJump()` records its position when the edit is sent, `checkSortJump()` (called from `rebuildTable`) compares against the new position, and a non-modal notice offers a jump back to it. Only edits to the *sorted* column arm the watch — the sort is stable, so edits elsewhere never reorder.
