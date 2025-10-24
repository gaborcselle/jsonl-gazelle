# JSONL Gazelle

<div align="center">
  <img src="jsonl-gazelle.png" alt="JSONL Gazelle" width="200">
</div>

Fast JSONL viewer / editor for VS Code with advanced features including Table View and Pretty Print view. JSONL (JSON Lines) is increasingly important for machine learning datasets, log analysis, data streaming, and LLM training. Unlike regular JSON, it can be processed line-by-line making it perfect for large datasets.

![JSONL Gazelle Screenshot - Light Theme - Table View](jsonl-gazelle-screenshot.jpg)

![JSONL Gazelle Screenshot - Dark Theme - Table View](jsonl-gazelle-screenshot2.jpg)

![JSONL Gazelle Screenshot - Pretty Print View](jsonl-gazelle-screenshot3.jpg)

![JSONL Gazelle Screenshot - Raw View](jsonl-gazelle-screenshot4.jpg)

## Features

- **Fast Table View**: Automatically detects common JSON paths and displays them as table columns
- **Smart Column Detection**: Maps common subpaths of each JSONL row into table columns automatically
- **Column Expansion**: Click ▼ to expand objects/arrays into separate columns (e.g., `user.name`, `orders[0]`)
- **Column Management**: Right-click context menu on table headers to add, remove, or toggle column visibility
- **Memory Efficient**: All processing happens in-memory without creating separate files

## Usage

1. Open any `.jsonl` file in VS Code
2. The file will automatically open in the JSONL Gazelle viewer
4. Table View: Click ▼ buttons in column headers or double-click expandable cells to expand objects/arrays into separate columns
5. Pretty Print view: You can edit inline

## Extension Development

1. Clone this repository
2. Run `npm install` to install dependencies
3. Run `npm run compile` to build the extension
4. Press F5 to run the extension in a new Extension Development Host window

## Development

```bash
# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Watch for changes
npm run watch
```

## Test Data Generation

For testing with large datasets, you can generate a comprehensive test file with 45,000 lines (~64MB) containing varied fields and nested structures:

```bash
# Generate large test data file
cd test-data
node generate-large.js
```

This will create `test-data/large.jsonl` with:
- **User profiles** with nested addresses, preferences, and social media links
- **Orders** with items, pricing, shipping, and tracking information  
- **Analytics data** with metrics, device info, and campaign details
- **Log entries** with request details, performance metrics, and error information
- **Mixed data types**: strings, numbers, booleans, arrays, objects
- **Nested structures** up to 4-5 levels deep

The generated file is automatically excluded from git via `.gitignore` to keep the repository lightweight.

## What's next / Roadmap
- [X] Virtualize data loading
- [X] Table view: Row deletion and addition - this should be on right-click on the row header, allow Delete, Insert above, and insert below
- [X] Table view: Allow re-ordering columns, allow hiding /unhiding columns - like Google Sheets
- [X] Table view: Allow wrapping text - add a checkbox in the top bar, and if it's checked, the line contents should wrap
- [X] Table view: Column addition - this should be a right-click on the column header, Insert before, insert after. (Prompt for the name of the new column) 
- [X] Table view: Fix "unstringify column" for `escaped-json.jsonl` - it should create those columns
- [X] Table view: Insert column with AI: Pull up a prompt dialog, let me define how it should be filled by using `{{row}}` or `{{row.fieldname[index]}}`, `{{row_number}}`, `{{rows_before}}`, {{rows_after}} notation. Then parallelize the filling of the newly created column, show a progress bar.
- [X] Table view: Insert rows with AI: Right-click on the row header, then choose how many of the previous rows to feed it (default to 10), and a prompt dialog that defaults to "generate more like these, but make it different from the lines below"
- [X] Settings: A settings dialog to enter your OpenAI key and select a model (default to gpt-4.1-mini) for the above AI features
- [X] Pretty print view: Insert before and after
- [ ] Pretty print view: Resolve the layouting bug where the lines initially briefly appear in a container that's too small
- [ ] Pretty print view: Resolve the selection bug which unselects the current row first and requires a second click to select the row you wanted to selet
- [ ] Raw view: Allow editing the raw view
- [ ] Raw view: Add JSON syntax highlighting
- [ ] Find / Replace: Implement great Find / Replace / Replace All with Regex option and highlighting
- [ ] Large files: Generate a file with `generate-large.js`, loading fails above 100 MB with "Assertion Failed: Argument is `undefined` or `null`."
- [ ] Split codebase: Figure out how to split into separate files, maybe one per view?

## License

MIT License. See [LICENSE](LICENSE) file for details.
