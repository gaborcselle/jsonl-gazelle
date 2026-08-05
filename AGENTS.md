# AGENTS.md — Contributor & AI Agent Guide

This document describes the actual architecture of JSONL Gazelle so that human contributors and AI coding agents can navigate, extend, and test the codebase. Everything here is grounded in the current source — if this file and the code disagree, the code wins (and this file should be fixed).

## Overview

JSONL Gazelle is a VS Code extension that registers a **custom text editor** (`jsonl-gazelle.jsonlViewer`) for `.jsonl` and `.ndjson` files. It renders three views — Table, Pretty Print, and Raw — inside a single webview, supports in-place editing that writes back to the underlying text document, and includes optional OpenAI-powered features (AI columns, AI row generation, column suggestions).

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
| `test/` | Plain Node test scripts (no framework), run by `npm test`. |
| `test-data/` | Sample JSONL files plus `generate-large.js` for a ~64 MB stress file. |

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

`search`, `removeColumn`, `updateCell`, `expandColumn`, `collapseColumn`, `openUrl`, `documentChanged`, `rawContentChanged`, `rawContentSave`, `prettyContentChanged`, `prettyContentSave`, `forceSave`, `unstringifyColumn`, `deleteRow`, `insertRow`, `copyRow`, `duplicateRow`, `pasteRow`, `validateClipboard`, `reorderColumns`, `reorderRows`, `toggleColumnVisibility`, `addColumn`, `addAIColumn`, `getSettings`, `getRecentEnumValues`, `checkAPIKey`, `showAPIKeyWarning`, `saveSettings`, `resetSettings`, `generateAIRows`, `requestColumnSuggestions`, `refresh`, `requestFullUpdate`, `setFollowMode`, `setViewPreference`, `setWrapTextPreference`, `setRowDetailsPreference`

**Extension → webview**:

`update` (full data snapshot), `appendRows` (delta during background chunk loading), `clipboardValidationResult`, `settingsLoaded`, `settingsSaved`, `recentEnumValuesLoaded`, `apiKeyCheckResult`, `columnSuggestions`

## Editing & Save Path

All writes go through `vscode.workspace.applyEdit()` with a full-document replace, wrapped in an `isUpdating` guard flag so the `onDidChangeTextDocument` handler doesn't reload the file for self-inflicted edits. Cell edits are debounced (~300 ms) via `pendingSaveTimeout`. The guard is time-boxed with `setTimeout` resets — **any new write path must set `isUpdating` the same way**, or edits will trigger spurious full reloads.

## Row Details Panel

The Table view sits in a `.content-area` flex row next to `#rowDetailsPanel`, a resizable side panel that renders the selected row's full JSON as a lazily-expanded tree (`createJsonNode` / `renderRowDetails` in `scripts.ts`). It is a webview-only feature — every row object is already in `currentData`, so no new extension-host data flows are involved; keys matching a `visible: false` column get a `hidden` badge, and string values holding embedded JSON expand as subtrees. Only the open/closed state crosses the boundary, via `setRowDetailsPreference` into the same `UI_PREFS_KEY` global-state blob as the view and wrap-text preferences. The panel is hidden outside the Table view (`syncRowDetailsVisibility`) and re-rendered after every `update`, since the table DOM — and therefore the selection — is rebuilt.

## Refresh & Follow Mode

- The `refresh` message (toolbar button, Ctrl/Cmd+R, F5, or the `jsonl-gazelle.refresh` command) reverts the document from disk (`workbench.action.files.revert`) and reloads. If the document has unsaved changes, the user is asked to confirm first.
- `setFollowMode` (tail -f style) creates a `FileSystemWatcher` on the file while enabled; disk changes revert the (non-dirty) document, which flows through the normal reload path, and the webview pins the table scroll to the bottom after each update. The watcher is disposed on toggle-off, panel dispose, and editor switch.

## AI Integration (as it actually exists)

- **Provider**: OpenAI only. `fetch` calls to `https://api.openai.com/v1/chat/completions` run in the **extension host**, not the webview.
- **API key**: `context.secrets` under `openaiApiKey`. **Model**: `context.globalState` under `openaiModel` (default `gpt-5.4-mini`). Both are managed through the in-app settings modal (gear icon), *not* VS Code settings.
- **Prompt templates** support these placeholders (resolved per row in `jsonlViewerProvider.ts`):
  - `{{row}}` — the entire row as JSON
  - `{{row.fieldname}}`, `{{row.fieldname[0]}}` — nested field / array element by path
  - `{{row_number}}` — 1-based row number
  - `{{rows_before}}` / `{{rows_after}}` — counts around the current row
  - `{{context_rows}}` / `{{row_count}}` — used by AI row generation
- **Features**: fill a new column with AI output per row (`addAIColumn`), generate new rows from context (`generateAIRows`), and AI-suggested column definitions (`requestColumnSuggestions`).

There are no other providers (no Anthropic/Gemini/local endpoints) and no WebSocket/agent-endpoint integration; adding a provider means abstracting the two `fetch` call sites in `jsonlViewerProvider.ts`.

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
