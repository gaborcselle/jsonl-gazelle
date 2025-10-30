# JSONL Gazelle

<div align="center">
  <img src="jsonl-gazelle.png" alt="JSONL Gazelle" width="200">
</div>

Fast JSONL viewer / editor for VS Code with advanced features including Table View and Pretty Print view. JSONL (JSON Lines) is increasingly important for machine learning datasets, log analysis, data streaming, and LLM training. Unlike regular JSON, it can be processed line-by-line making it perfect for large datasets.

![JSONL Gazelle Screenshot - Light Theme - Table View](jsonl-gazelle-screenshot.jpg)

![JSONL Gazelle Screenshot - Dark Theme - Table View](jsonl-gazelle-screenshot2.jpg)

![JSONL Gazelle Screenshot - Pretty Print View](jsonl-gazelle-screenshot3.jpg)

![JSONL Gazelle Screenshot - Raw View](jsonl-gazelle-screenshot4.jpg)

## New

- *v0.3.1*: For extrememly large JSONL files over 100MB, this version adds a new "Split" function available by right-clicking on the file
- *v0.3.0*: Add a much improved Pretty Print View with syntax highlighting

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
- [ ] Table view column width logic: If there's only one column, for example in `escaped-json.jsonl`, that column should fill the entire horizontal width
- [ ] Table view column width logic: For files with columns that have a lot of info, like `nested.jsonl`, make the columns with the longer values wider than is currently
- [ ] AI dialog: When the OpenAI key is not set, and you click to insert a column with AI, the AI settings dialog should appear with a warning that the key is not set. Entering a key and clicking OK results in us returning to the AI column screen.
- [ ] Insert Rows with AI: When the OpenAI key is not set, ask for the OpenAI key as above.
- [ ] Insert Rows with AI: Hide the AI Prompt, but show it if you click "Advanced". Change last word of the prompt from "below" to "provided"
- [ ] AI dialog: Make column name and its text field a single line to save vertical space. Reduce vertical padding to "AI Prompt", there's too much space.
- [ ] AI dialog: "AI Prompt Template" should just be called "AI Prompt". 
- [ ] AI dialog: Remember recent values (along with any enum settings), and allow the user to prefill them from a dropdown. (Don't show the dropdown if the user has never used the feature.) 
- [ ] AI dialog: Make the (i) more like a (?) and make sure the baseline of teh ?is aligned with the text. Clicking on it should show the templace language to the right of the AI Prompt instead of below - on laptop screens, this dialog takes up too much vertical space.
- [ ] AI dialog: Change the example to "Assign a U.S. school grade (K–12 or college) that best matches the reading level of `{{row.model_output}}`."
- [ ] AI dialog: port the enum option to OpenAI's structured outputs from the current prompt-based implementation
- [ ] Test the AI column generation feature, e.g. for when you give it `{{row.paths}}` that exist in some rows but not in others
- [ ] Test the AI row generation feature
- [ ] Suggest feature in AI add column dialog: Add a "Suggest new column" to the column menu. It will prompt OpenAI with some of the example data to make suggestions for new columns to add, with the provided template language. It will suggest a bunch of column names + prompts to choose from. The user can then run that and add a new column.

## License

MIT License. See [LICENSE](LICENSE) file for details.
