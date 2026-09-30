/**
 * Where each record starts in the Pretty Print editor's text.
 *
 * The Pretty Print gutter numbers only the first line of each record, and the
 * Ctrl/Cmd+Alt+Up/Down entry navigation jumps between those lines. Both have
 * to follow the editor's *current* text: deleting or pasting a folded object
 * moves every later record by many lines at once, so a mapping computed when
 * the editor was created points at the wrong lines after the first edit.
 *
 * A line starts a record when it opens at the top level (outside any object,
 * array or string) and has something on it. That covers pretty-printed
 * objects and arrays - whose continuation lines all open inside a bracket -
 * and a file of bare values, where every record is a single line. The depth
 * tracking matches `convertPrettyToJsonl`, which splits the same text back
 * into JSONL lines on save.
 *
 * The webview cannot import this module, so `scripts.ts` carries a copy in a
 * `shared:pretty-line-numbers` block, which `test/prettyLineNumbers.test.js`
 * extracts and runs against the same cases.
 */

/** 0-based indices of the lines that begin a top-level record. */
export function findPrettyRecordStarts(lines: string[]): number[] {
    const starts: number[] = [];
    let depth = 0;
    let inString = false;

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const line = lines[lineIndex];
        if (depth <= 0 && !inString && line.trim() !== '') {
            starts.push(lineIndex);
        }

        let escapeNext = false;
        for (let i = 0; i < line.length; i++) {
            const char = line[i];
            if (escapeNext) {
                escapeNext = false;
                continue;
            }
            if (char === '\\') {
                escapeNext = inString;
                continue;
            }
            if (char === '"') {
                inString = !inString;
                continue;
            }
            if (!inString) {
                if (char === '{' || char === '[') {
                    depth++;
                } else if (char === '}' || char === ']') {
                    depth--;
                }
            }
        }

        // A stray closing bracket mid-edit must not push every later record
        // below the top level; a string can't span lines in valid JSON, so an
        // unterminated one ends with its line
        if (depth < 0) {
            depth = 0;
        }
        inString = false;
    }

    return starts;
}
