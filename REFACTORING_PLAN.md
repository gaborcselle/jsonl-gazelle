# JSONL Gazelle Codebase Refactoring Plan

## Current State
- Single file: `src/jsonlViewerProvider.ts` (6595 lines)
- Contains: Backend logic, HTML, CSS, and JavaScript all in one file
- Difficult to maintain and navigate

## Proposed Structure

### Option A: Moderate Split (Recommended)
Keep the webview content inline but split backend logic:

```
src/
├── jsonlViewerProvider.ts          (Main provider - 500 lines)
├── jsonl/
│   ├── parser.ts                   (JSONL parsing logic)
│   ├── columnManager.ts            (Column detection & management)
│   ├── dataManager.ts              (Row filtering, searching)
│   └── aiFeatures.ts               (AI column/row generation)
├── webview/
│   ├── htmlGenerator.ts            (Generate webview HTML)
│   ├── styles.ts                   (CSS as string exports)
│   └── scripts.ts                  (JavaScript as string exports)
```

### Option B: Full Split (More complex)
Separate everything including webview scripts:

```
src/
├── jsonlViewerProvider.ts          (Main provider - 300 lines)
├── jsonl/
│   ├── parser.ts
│   ├── columnManager.ts
│   ├── dataManager.ts
│   └── aiFeatures.ts
├── webview/
│   ├── index.html                  (HTML template)
│   ├── styles/
│   │   ├── main.css
│   │   ├── modals.css
│   │   └── views.css
│   ├── src/
│   │   ├── main.ts                 (Entry point)
│   │   ├── tableView.ts
│   │   ├── jsonView.ts
│   │   ├── rawView.ts
│   │   ├── findReplace.ts
│   │   ├── columnManager.ts
│   │   └── utils.ts
│   └── dist/
│       └── bundle.js               (Compiled webview code)
```

## Implementation Strategy

### Phase 1: Backend Split (Least Risky)
1. Extract JSONL parsing logic → `parser.ts`
2. Extract column management → `columnManager.ts`
3. Extract data filtering/search → `dataManager.ts`
4. Extract AI features → `aiFeatures.ts`
5. Keep webview HTML/CSS/JS inline in main file

**Benefits:**
- Easier to maintain backend logic
- No changes to webview loading
- Low risk of breaking existing functionality

### Phase 2: Webview Organization (Medium Risk)
1. Move CSS to separate file → `styles.ts` (export as string)
2. Move JavaScript to separate file → `scripts.ts` (export as string)
3. Move HTML template to separate file → `htmlGenerator.ts`
4. Main provider assembles them

**Benefits:**
- Cleaner file structure
- Easier to edit styles and scripts
- Still uses inline approach (no bundler needed)

### Phase 3: Full Webview Split (High Risk, High Reward)
1. Set up webpack/esbuild for webview code
2. Split JavaScript into TypeScript modules
3. Use proper imports/exports
4. Bundle into single file for webview

**Benefits:**
- Proper TypeScript for webview code
- Better IDE support and type checking
- Reusable modules
- Easier testing

**Challenges:**
- Requires build setup
- More complex deployment
- Need to handle CSP (Content Security Policy)

## Recommended Approach

### Start with Phase 1 (Backend Split)
This gives immediate maintainability benefits with minimal risk:

1. Create `src/jsonl/` directory
2. Extract parsing logic (400-500 lines)
3. Extract column management (500-600 lines)
4. Extract data operations (300-400 lines)
5. Extract AI features (400-500 lines)

**Result:** Main file reduced from 6595 to ~4000 lines

### Then Phase 2 (Webview Organization)
Move HTML/CSS/JS to separate files but keep as strings:

1. Create `src/webview/` directory
2. Extract CSS (~1500 lines) → `styles.ts`
3. Extract JavaScript (~2000 lines) → `scripts.ts`
4. Extract HTML template (~400 lines) → `template.ts`

**Result:** Main file reduced to ~500 lines

## File Size Estimates

Current:
- `jsonlViewerProvider.ts`: 6595 lines

After Phase 1:
- `jsonlViewerProvider.ts`: ~4000 lines
- `jsonl/parser.ts`: ~500 lines
- `jsonl/columnManager.ts`: ~600 lines
- `jsonl/dataManager.ts`: ~400 lines
- `jsonl/aiFeatures.ts`: ~500 lines

After Phase 2:
- `jsonlViewerProvider.ts`: ~500 lines
- `jsonl/*`: ~2000 lines
- `webview/styles.ts`: ~1500 lines
- `webview/scripts.ts`: ~2000 lines
- `webview/template.ts`: ~400 lines

## Next Steps

1. **Create branch**: `git checkout -b refactor/split-codebase`
2. **Start with Phase 1**: Extract backend logic
3. **Test thoroughly**: Ensure all features still work
4. **Commit incrementally**: Small, testable commits
5. **Create PR**: Get feedback before proceeding

## Implementation Order

### Step 1: Parser Module
Extract all JSONL parsing logic:
- `loadJsonlFile()`
- `loadRemainingChunks()`
- `processChunk()`

### Step 2: Column Manager Module
Extract column management:
- `updateColumns()`
- `addNewColumnsOnly()`
- `countPaths()`
- `expandColumn()`
- `collapseColumn()`
- `reorderColumns()`
- `toggleColumnVisibility()`

### Step 3: Data Manager Module
Extract data operations:
- `filterRows()`
- `searchRows()`
- `updateCell()`
- `getNestedValue()`
- `setNestedValue()`

### Step 4: AI Features Module
Extract AI functionality:
- `handleAIColumn()`
- `handleAIRows()`
- AI prompt processing
- API key management

## Notes

- Keep the current structure working throughout
- Each extraction should be a separate commit
- Add unit tests as we split (optional but recommended)
- Update imports and exports carefully
- Consider using barrel exports (index.ts) for cleaner imports
