# JSONL Gazelle

<div align="center">
  <img src="jsonl-gazelle.png" alt="JSONL Gazelle" width="200">
</div>

A fast JSONL viewer / editor for VS Code with advanced features including table view, item view, JSON pretty print view, search, and AI. JSONL (JSON Lines) is increasingly important for machine learning datasets, log analysis, data streaming, and LLM training - unlike regular JSON, it can be processed line-by-line making it perfect for large datasets.

![JSONL Gazelle Screenshot](jsonl-gazelle-screenshot.jpg)

![JSONL Gazelle Screenshot 2](jsonl-gazelle-screenshot2.jpg)

![JSONL Gazelle Screenshot 3](jsonl-gazelle-screenshot3.jpg)

![JSONL Gazelle Screenshot 4](jsonl-gazelle-screenshot4.jpg)

## Features

- **Fast Table View**: Automatically detects common JSON paths and displays them as table columns
- **Smart Column Detection**: Maps common subpaths of each JSONL row into table columns automatically
- **Column Expansion**: Click ▼ to expand objects/arrays into separate columns (e.g., `user.name`, `orders[0]`)
- **Column Management**: Right-click context menu on table headers to add, remove, or toggle column visibility
- **Advanced Search**: Fast search with regex support and magnifying glass icon (🔍)
- **Find & Replace**: Replace functionality with and without regex patterns
- **AI Integration**: OpenAI API integration with field reference syntax `{{fieldname.subname[0]}}`
- **CSV Export**: Export tables to CSV with all JSON paths flattened
- **Indexing State**: Shows Gazelle icon during file loading/indexing
- **Memory Efficient**: All processing happens in memory without creating separate files

## Usage

1. Open any `.jsonl` file in VS Code
2. The file will automatically open in the JSONL Gazelle viewer
3. Use the search bar to filter rows (with regex support)
4. Click ▼ buttons in column headers to expand objects/arrays into separate columns
5. Right-click column headers to manage columns
6. Set your OpenAI API key in settings for AI features
7. Ask questions about specific rows using the AI input field
8. Export filtered results to CSV

## Column Expansion

JSONL Gazelle automatically detects when columns contain objects or arrays and provides expand/collapse functionality:

- **Expand**: Click ▼ to expand a column containing objects/arrays
  - Objects become separate columns: `user.name`, `user.profile.email`
  - Arrays become indexed columns: `orders[0]`, `orders[1]`, etc.
- **Collapse**: Click ▶ to collapse expanded columns back to the original column
- **Nested Expansion**: Sub-columns can be further expanded if they contain objects/arrays

## AI Field References

Use the following syntax in your AI questions to reference specific fields:

- `{{name}}` - Reference the name field
- `{{address.city}}` - Reference nested fields
- `{{hobbies[0]}}` - Reference array elements

Example: "What is the average age of users who live in {{address.city}}?"

## Keyboard Shortcuts

- **Ctrl/Cmd + F**: Focus search input
- **Ctrl/Cmd + R**: Focus replace input
- **Right-click**: Open column context menu

## Installation

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

## What's next / Roadmap

- [X] Basic plugin working
- [X] Improve UI for nested JSON (column expansion functionality)
- [ ] Improve table display for long text
- [ ] Improve Find / Replace UI
- [ ] Improve table display for Strings
- [ ] Better search highlighting
- [ ] Add varied test data in a separate repo
- [ ] Super powered AI mode where you can quickly run LLMs through each line and evaluate things. Highly parallelized

## License

MIT License. See [LICENSE](LICENSE) file for details.
