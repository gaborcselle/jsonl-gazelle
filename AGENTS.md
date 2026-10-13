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
| `src/jsonl/utils.ts` | Pure helpers: nested get/set/delete by column path (own keys first, so flat keys like `"user.name"` work; the reader is mirrored in `scripts.ts`), pretty→JSONL conversion, stringified-JSON detection. |
| `src/jsonl/documentText.ts` | `rebuildJsonlText()` — the new document text after an edit, built from the old text plus the new rows. Every write path goes through it (see Editing & Save Path). |
| `src/jsonl/splitFile.ts` | `splitJsonlFile()` — the sequential, backpressured splitter behind "Split Large File into Parts". |
| `src/jsonl/diff.ts` | JSONL-aware diff: row alignment (exact LCS, Myers O(ND) for large changed regions) and field-level changes. Used by `src/jsonlDiffProvider.ts` (Diff with Git HEAD / Compare Files). |
| `src/jsonl/rowMapping.ts` | Search filtering that preserves original row indices. |
| `src/jsonl/sorting.ts` | Column sorting: value-type autodetection (timestamp/currency/number/boolean/text) and comparators that carry row indices along. |
| `src/jsonl/columns.ts` | `getUnhideableColumns()` — which hidden columns the "Unhide Column" menu may offer (mirrored in `scripts.ts`). |
| `src/jsonl/prettyLineNumbers.ts` | `findPrettyRecordStarts()` — which lines of the Pretty Print editor begin a record, for its gutter numbers and entry navigation (mirrored in `scripts.ts`). |
| `src/jsonl/gridNavigation.ts` | `moveGridCursor()` — where the table's keyboard cell cursor lands for each navigation key, including the column-header row and row-number column (mirrored in `scripts.ts`). |
| `src/jsonl/formatOnSave.ts` | `formatJsonlForSave()` — the optional format-on-save transforms (spacing, single→double quotes). |
| `test/` | Plain Node test scripts (no framework), run by `npm test`. `test/helpers/fakeVscode.js` is an in-memory `vscode` that lets `test/provider.test.js` drive `JsonlViewerProvider` end to end (real document text in and out, webview panels that record what they're sent). |
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

1. `resolveCustomTextEditor()` sets up the webview, message listener, and an `onDidChangeTextDocument` subscription, then activates the document (see One provider, many editors).
2. `loadJsonlFile(document)` splits the document text into lines and parses each with `JSON.parse`. Each load (and each raw/pretty re-parse, and each document switch) bumps `loadGeneration`; a background chunk load checks it after every yield and stops when superseded, so it can never append an older text's lines to newer rows.
   - Files with more lines than `jsonl-gazelle.performance.chunkedLoadingThreshold` (default 1000) load progressively in the background (`loadRemainingChunks`).
   - Files with more rows than `jsonl-gazelle.performance.maxMemoryRows` (default 50000) switch to memory-optimized mode.
3. `updateWebview(panel)` posts a full snapshot `{ type: 'update', data: { rows, rowIndices, allRows, columns, parsedLines, rawContent, prettyContent, errorCount, loadingProgress, appendCompatible } }`. `allRows` is omitted when it would be identical to `rows` (no active search); the webview then aliases it to `rows`.
4. During background chunk loading (no active search), progress updates are **`appendRows` deltas** instead: only the rows/parsedLines added since the last message (`sendAppendedRows`, tracked via `lastSentRowCount` / `webviewRowsSynced`). The webview merges them into `currentData` without touching the rendered table. If a delta's `baseRowCount` doesn't match (e.g. a message was dropped while the webview was hidden), the webview replies `requestFullUpdate`. The final post-loading `update` carries `appendCompatible: true`, which lets the webview keep its DOM and scroll position.
5. On a non-append `update` the webview rebuilds the table header and re-renders the body **from scratch**, chunked 200 rows at a time as the user scrolls, then restores the previous scroll offset (`rebuildTable` / `restoreTableScroll`). Any webview-side UI state (e.g. the selected row) must be kept in a JS variable and re-applied during render — see `selectedRowActualIndex` in `scripts.ts` for the pattern.

## Message Protocol

Communication is `webview.postMessage` / `vscode.postMessage` with a `type` field.

**Webview → extension** (handled in the `onDidReceiveMessage` switch in `jsonlViewerProvider.ts`):

`search`, `removeColumn`, `updateCell`, `updateCells` (a batch, used by Replace All), `expandColumn`, `collapseColumn`, `openUrl`, `documentChanged`, `rawContentChanged`, `rawContentSave`, `prettyContentChanged`, `prettyContentSave`, `forceSave`, `unstringifyColumn`, `deleteRow`, `insertRow`, `copyRow`, `duplicateRow`, `pasteRow`, `validateClipboard`, `reorderColumns`, `reorderRows`, `setDisplaySort`, `sortRows`, `toggleColumnVisibility`, `showColumns`, `addColumn`, `addAIColumn`, `getSettings`, `getRecentEnumValues`, `checkAPIKey`, `showAPIKeyWarning`, `fetchModels`, `saveSettings`, `resetSettings`, `generateAIRows`, `requestColumnSuggestions`, `refresh`, `requestFullUpdate`, `setFollowMode`, `setViewPreference`, `setWrapTextPreference`

`prettyContentChanged` / `prettyContentSave` carry `partial: true` when the Pretty Print editor was built before the file finished loading; the extension refuses those.

**Extension → webview**:

`update` (full data snapshot; `reloadedFromDisk` is set on the first one after Refresh), `appendRows` (delta during background chunk loading), `openSettings`, `clipboardValidationResult`, `settingsLoaded`, `settingsSaved`, `recentEnumValuesLoaded`, `apiKeyCheckResult`, `columnSuggestions`

## Editing & Save Path

All writes go through `vscode.workspace.applyEdit()` with a full-document replace, wrapped in an `isUpdating` guard flag so the `onDidChangeTextDocument` handler doesn't reload the file for self-inflicted edits. Cell edits are debounced (~300 ms) via `pendingSaveTimeout`; `flushPendingCellSave()` writes them early when the document is switched away from or refreshed. The guard is time-boxed with `setTimeout` resets — **any new write path must set `isUpdating` the same way**, or edits will trigger spurious full reloads.

**The replacement text always comes from `composeDocumentText(document)`**, never from serializing `this.rows`. `this.rows` holds only the lines that parse, and only as `JSON.parse` saw them, so `rows.map(JSON.stringify).join('\n')` deletes invalid and blank lines, rounds integers beyond 2^53 in rows nobody touched, rewrites `1.50` as `1.5`, and loses CRLF and the trailing newline — this is how the table used to corrupt files. `composeDocumentText` runs `rebuildJsonlText(document.getText(), this.rows)`, which matches the new rows against the old file's rows by value (common prefix and suffix copied verbatim; a row whose value already appears in the old file reuses that line's text) and also refreshes `rawContent`, `parsedLines` and `errorCount`. Pretty Print edits are merged the same way (`prettyContentToDocumentText`), since that view shows only the rows.

Messages in `ROW_WRITE_MESSAGES` wait for background chunk loading to finish before they run: until then `this.rows` is only the start of the file. A new write message belongs in that set.

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
| `jsonl-gazelle.formatOnSave.spaceOut` | false | On save, `{"id":123}` → `{ "id": 123 }` |
| `jsonl-gazelle.formatOnSave.convertSingleQuotes` | false | On save, single-quoted strings → double-quoted, on lines that only become valid JSON that way |

Format-on-save is an `onWillSaveTextDocument` hook in `extension.ts` (skipped for delayed auto-save) that runs `formatJsonlForSave()` from `src/jsonl/formatOnSave.ts`. It rewrites the text token by token rather than re-serializing parsed values, so number spellings and key order survive, and it never touches a line that isn't valid JSON afterwards. With both settings off (the default) the file is saved exactly as written.

The webview cannot read VS Code configuration directly — anything the webview needs must be passed through the `update` payload (or the initial HTML).

## Adding a Feature — Checklist

1. **Webview UI**: add markup in `template.ts`, styles in `styles.ts`, behavior in `scripts.ts`.
2. **New message type**: post it from `scripts.ts` (`vscode.postMessage({ type: '...' })`), add a `case` in the provider's `onDidReceiveMessage` switch.
3. **Webview state**: remember the table is fully rebuilt on every `update` — persistent UI state must live in a `scripts.ts` variable and be re-applied during render.
4. **Document writes**: build the text with `composeDocumentText(document)`, wrap in the `isUpdating` guard, and add the message type to `ROW_WRITE_MESSAGES` (see Editing & Save Path).
5. **Commands/keybindings**: declare in `package.json` `contributes`, register in `extension.ts`.
6. **Tests**: pure logic belongs in `src/jsonl/` where it can be tested by a plain Node script in `test/` (follow `test/rowMapping.test.js`).

## Gotchas

- **CSP**: the webview has a Content-Security-Policy (`template.ts`). Inline scripts require the nonce that `getHtmlForWebview()` generates; external resources are limited to `https://cdn.jsdelivr.net` (Monaco) and `img-src` to webview resource URIs. If you add external resources, extend the CSP deliberately — never add `unsafe-eval`.
- **`retainContextWhenHidden` is on**: the webview keeps state when the tab is backgrounded.
- **One provider instance, many editors.** The provider's fields (`rows`, `columns`, `searchTerm`, `parsedLines`, ...) hold one document at a time. Before any webview message is handled, `activateDocument()` makes that editor's document the active one: the outgoing document's fields are parked in `documentStates` (`saveActiveDocumentState`) and the incoming one's restored, or reloaded if its text changed meanwhile. A tab coming back into focus activates too (`onDidChangeViewState`), and `onDidChangeTextDocument` ignores documents that aren't active. Switches wait for messages still being handled for the outgoing document (`activeOperations` / `waitForIdle`), so a long handler — an AI fill — holds a switch until it ends rather than writing into the next file's rows. **A new per-document field must be added to `DocumentState` and to save/restore.** Follow-mode watchers are per document (`followWatchers`); `manualColumnsPerFile` and column preferences were already keyed by URI.
- **Template-literal sources**: `scripts.ts`/`styles.ts`/`template.ts` are TypeScript files exporting giant strings — ESLint lints the TS wrapper, not the embedded JS/CSS. Backticks and `${}` inside them must be escaped.
- **Search filtering** produces `filteredRows` + `filteredRowIndices`; webview row handlers must distinguish the filtered index (`dataset.index`) from the real file index (`dataset.actualIndex`).
- **Hidden columns are advertised.** When `getUnhideableColumns()` finds any, `buildTableHeader` puts a count badge on the row-number header; clicking it calls `openUnhideColumnsMenu`, which opens the column menu with no column selected and pops the unhide submenu open. That click must `stopPropagation()` — the document-level handler closes the menu on any click outside it, and the badge sits outside.
- **Column visibility has a floor.** `toggleColumnVisibility` refuses to hide the last visible column, and `restoreColumnPreferences` ignores a stored state that hides every column. Without both, a file of bare JSON values — which has a single `(value)` column — could be left showing numbered rows with no cells and no header to right-click, and the per-file preference would bring that back on every load.
- **Two kinds of sort.** `setDisplaySort` is display-only: `filterRows()` permutes `filteredRows` **and** `filteredRowIndices` together (`applyDisplaySort`), so `actualIndex` keeps pointing at the right line and every edit path works unchanged. `sortRows` is the permanent one and rewrites the document like any other write. Consequences of an active display sort: `filteredRows` is no longer the same array as `rows`, so `appendCompatible` append-only deltas are skipped in favour of full updates; and row drag-reorder is disabled in the webview, since a drop target's screen position no longer matches its file position. The permanent sort refuses to run while the file is still loading, in memory-optimized mode, or when there are parse errors (an unparseable line has no sensible place among sorted rows).
- **The cell cursor is stored by file row + column path**, never by screen coordinates (`cursorActualRowIndex` / `cursorColumnPath` in `scripts.ts`). The tbody is rebuilt on every update, rows are filtered by search, and a display sort permutes them — coordinates would go stale on all three, whereas a row/path pair resolves to a position only when it is needed (`getCursorPosition`) and simply reports "off screen" when the row is filtered out or the column hidden. The highlight elements (`cursorCellElement`, `selectedRowElement`) are remembered so moving the cursor doesn't scan a fully rendered table, and `createTableRow` re-points them as it re-applies the classes. Anything that selects a whole row — the row-number cell, the sort-jump notice's "Jump to row" — goes through `setCursorRow` rather than `selectRow`, so the cursor and the row highlight never end up on different rows.
- **Every row gets a row element, falsy ones included.** `renderTableChunk` must not skip a row that parses to `0`, `false`, `""` or `null` — those are real lines of a bare-value file. The cell cursor, the sort-jump notice and Find/Replace all reach a row by its position in `tbody`, so dropping one shifts every later row up and an edit lands on the wrong line. For the same reason the webview's `getNestedValue` tests the row for `null`/`undefined`, never for truthiness (matching `src/jsonl/utils.ts`).
- **The cursor's two header bands are row -1 and column -1.** `HEADER_ROW_INDEX` stands in for a file row index and `ROW_HEADER_COLUMN_PATH` for a column path, so the whole cursor pipeline — `getCursorPosition`, `getCursorCell`, the `+ 1` offset past the row-number cell, the re-apply in `createTableRow` / `buildTableHeader` — keeps working with one extra branch each rather than a second cursor. Only the arrow keys step onto a band (`moveGridCursor`'s `bounds`): Tab is a data-entry motion and Home/End/paging are grid motions, so those walk along a band the cursor is on but never wander onto one. The two bands never intersect — the cell where they would cross is the row-number header, which carries the hidden-columns badge. `scrollCellIntoView` skips the axis a band is stuck to: a sticky cell measures as flush against that edge, so "scrolling it into view" would drag the table to the top or the far left on every keystroke.
- **Moving a row from the keyboard reuses the drag's message.** `handleReorderRows` moves `fromIndex` to where `toIndex` sits, which makes dropping a row onto its own next neighbour a no-op — so `moveCursorRowInFile` sends a move *down* as "pull the row below this one up over it" and follows the cursor to `toIndex + 1`. It swaps with the neighbour on screen, not in the file, so a search filter moves the row past what the user can see; a display sort disables it outright, the same reason drag-reorder is disabled.
- **The cell editor stops propagation on Enter/Tab/Escape.** The edit is over the moment the key is handled, so the grid's own document-level handler would see the same keystroke, find no editor open, and act on it a second time — committing with Enter would immediately reopen the editor on the cell below.
- **Scrolling the cursor into view is done by hand** (`scrollCellIntoView`), not with `scrollIntoView()`: the header row and the row-number column are `position: sticky`, so they float over the scroll area and the browser will happily park the cursor underneath them.
- **Editing the sorted column re-sorts the view**, so the edited row can move. `watchSortJump()` records its position when the edit is sent, `checkSortJump()` (called from `rebuildTable`) compares against the new position, and a non-modal notice offers a jump back to it. Only edits to the *sorted* column arm the watch — the sort is stable, so edits elsewhere never reorder.
- **The Pretty Print gutter numbers records, not lines, and works them out from the editor's own text.** `findPrettyRecordStarts` rescans the text on every edit (after a short debounce past `PRETTY_SYNC_RESCAN_LINES`), and the entry navigation (Ctrl/Cmd+Alt+Up/Down) uses the same list. The editor isn't rebuilt when an `update` arrives, so any numbering fixed when the editor was created goes stale on the first edit. Deleting or pasting a folded object moves every later record by many lines at once.
- **Column paths match own keys first.** Paths join keys with `.` and indices with `[n]`, but keys can contain both (`"user.name"`, `"k8s.io/app"`). `getNestedValue` / `setNestedValue` / `deleteNestedProperty` (`utils.ts`) try the longest own key a path starts with, then descend; inherited names (`constructor`) never match. The webview's reader is a copy in the `shared:nested-path` block, checked against the original by `test/nestedPath.test.js`. When writing a cell, a column without `parentPath` is a key of the row itself, so `updateCells` sets it flat even if the row lacks it.
- **Table Find/Replace works on the data, not the DOM.** Rows render 200 at a time and the tbody is rebuilt on every update, so matches are computed from `currentData.rows` and named by file row + column path (like the cell cursor), revealed with `ensureRowRendered` + `setCellCursor`. A replacement keeps the value's type (a string stays a string) and is sent as JSON text; objects/arrays are found but not replaced into. While a replace waits for its update the buttons are disabled — working from the old matches would undo it.
- **Raw and Pretty Print editors don't follow updates by themselves.** They are built when their view opens. `refreshOpenEditor` rebuilds one when it holds no edits of its own and the document moved on (end of loading, outside change); `reloadedFromDisk` drops their edits. A Pretty Print editor built while loading is read-only (`prettyEditorPartial`) until the full update rebuilds it.
