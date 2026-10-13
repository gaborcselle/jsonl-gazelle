/**
 * Turning the viewer's rows back into document text after an edit.
 *
 * The table, row and column commands all work on parsed rows, but the file
 * holds more than the rows: lines that don't parse, blank lines, the original
 * spelling of every value (`1.50`, `1e3`, `"é"`, integers beyond 2^53 that
 * JSON.parse rounds), the line endings and the trailing newline. Serializing
 * the rows from scratch loses all of that - one cell edit used to delete every
 * invalid line and rewrite every big ID in the file.
 *
 * So the new text is built from the old text: the rows are matched against
 * the old file's rows, every line the edit didn't change is copied through
 * verbatim, and only rows that actually changed are re-serialized. Lines that
 * aren't rows stay where they were.
 */

export interface RebuiltLine {
    /** Index into the new rows, or null for a blank or unparseable line */
    rowIndex: number | null;
    text: string;
    /** Parse error, for a line that isn't valid JSON */
    error?: string;
}

export interface RebuiltDocument {
    text: string;
    lines: RebuiltLine[];
    errorCount: number;
}

/** The document's line ending. VS Code keeps one per document. */
export function detectEol(text: string): '\n' | '\r\n' {
    return text.includes('\r\n') ? '\r\n' : '\n';
}

/** Split document text into lines without their line endings. */
export function splitDocumentLines(text: string): string[] {
    if (text === '') {
        return [];
    }
    const lines = text.split('\n');
    if (detectEol(text) === '\r\n') {
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].endsWith('\r')) {
                lines[i] = lines[i].slice(0, -1);
            }
        }
    }
    return lines;
}

function canonical(value: unknown): string {
    // JSON.stringify(undefined) is undefined; a row is never undefined in a
    // parsed file, but a hole must not turn into the text "undefined"
    const text = JSON.stringify(value);
    return text === undefined ? 'null' : text;
}

/**
 * Build the text of a JSONL document holding `newRows`, starting from the
 * document's current text.
 *
 * Rows are matched by value: the common prefix and suffix of the old and new
 * row lists keep their lines exactly; within the changed middle, the k-th old
 * row line holds the k-th new row, extra new rows follow the last of them and
 * surplus old row lines are dropped. A new row whose value already appears in
 * the old file reuses that line's text, so moved and duplicated rows keep their
 * original spelling too.
 */
export function rebuildJsonlText(oldText: string, newRows: readonly unknown[]): RebuiltDocument {
    const eol = detectEol(oldText);
    const oldLines = splitDocumentLines(oldText);

    type OldLine = { rowOrdinal: number } | { rowOrdinal: -1; error?: string };
    const oldRowCanon: string[] = [];
    const oldRowLine: number[] = [];
    const textByCanon = new Map<string, string>();
    const info: OldLine[] = oldLines.map((line, lineIndex) => {
        const trimmed = line.trim();
        if (!trimmed) {
            return { rowOrdinal: -1 };
        }
        try {
            const canon = canonical(JSON.parse(trimmed));
            oldRowCanon.push(canon);
            oldRowLine.push(lineIndex);
            if (!textByCanon.has(canon)) {
                textByCanon.set(canon, line);
            }
            return { rowOrdinal: oldRowCanon.length - 1 };
        } catch (error) {
            return { rowOrdinal: -1, error: error instanceof Error ? error.message : 'Parse error' };
        }
    });

    const newCanon = newRows.map(canonical);
    const n = oldRowCanon.length;
    const m = newCanon.length;

    let prefix = 0;
    while (prefix < n && prefix < m && oldRowCanon[prefix] === newCanon[prefix]) {
        prefix++;
    }
    let suffix = 0;
    while (suffix < n - prefix && suffix < m - prefix && oldRowCanon[n - 1 - suffix] === newCanon[m - 1 - suffix]) {
        suffix++;
    }
    const oldMiddle = n - prefix - suffix;
    const newMiddle = m - prefix - suffix;

    // Where a pure insertion (no old rows replaced) goes: before the first
    // unchanged row after it, else after the last row, else before any blank
    // lines that end the file
    let insertBeforeLine = -1;
    if (oldMiddle === 0 && newMiddle > 0) {
        if (suffix > 0) {
            insertBeforeLine = oldRowLine[n - suffix];
        } else if (n > 0) {
            insertBeforeLine = oldRowLine[n - 1] + 1;
        } else {
            insertBeforeLine = oldLines.length;
            while (insertBeforeLine > 0 && oldLines[insertBeforeLine - 1].trim() === '') {
                insertBeforeLine--;
            }
        }
    }

    const out: RebuiltLine[] = [];
    let errorCount = 0;
    const emitNew = (rowIndex: number) => {
        const canon = newCanon[rowIndex];
        out.push({ rowIndex, text: textByCanon.get(canon) ?? canon });
    };
    const emitInserted = () => {
        for (let j = prefix; j < prefix + newMiddle; j++) {
            emitNew(j);
        }
    };

    for (let lineIndex = 0; lineIndex < oldLines.length; lineIndex++) {
        if (lineIndex === insertBeforeLine) {
            emitInserted();
        }
        const line = info[lineIndex];
        if (line.rowOrdinal === -1) {
            const error = (line as { error?: string }).error;
            out.push(error ? { rowIndex: null, text: oldLines[lineIndex], error } : { rowIndex: null, text: oldLines[lineIndex] });
            if (error) {
                errorCount++;
            }
            continue;
        }
        const r = line.rowOrdinal;
        if (r < prefix) {
            out.push({ rowIndex: r, text: oldLines[lineIndex] });
        } else if (r >= n - suffix) {
            out.push({ rowIndex: r + (m - n), text: oldLines[lineIndex] });
        } else {
            const k = r - prefix;
            if (k < newMiddle) {
                emitNew(prefix + k);
            }
            if (k === oldMiddle - 1) {
                for (let j = prefix + oldMiddle; j < prefix + newMiddle; j++) {
                    emitNew(j);
                }
            }
        }
    }
    if (insertBeforeLine === oldLines.length) {
        emitInserted();
    }

    return { text: out.map(line => line.text).join(eol), lines: out, errorCount };
}
