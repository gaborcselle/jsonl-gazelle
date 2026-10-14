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
 *
 * A value alone doesn't always say which line that is: JSON.parse rounds
 * integers beyond 2^53, so `{"id":1700000000000000001}` and
 * `{"id":1700000000000000003}` parse to equal rows. Giving every such row the
 * first line's text turned distinct IDs into copies of one. `sourceTextOf`,
 * when the caller knows it, names the line a row was read from, and it wins.
 * Otherwise equal rows in the changed stretch take the old lines holding that
 * value in order, each line once, and a value several different lines share is
 * written as parsed rather than borrowing one of them.
 */
export function rebuildJsonlText(
    oldText: string,
    newRows: readonly unknown[],
    sourceTextOf?: (row: unknown) => string | undefined
): RebuiltDocument {
    const eol = detectEol(oldText);
    const oldLines = splitDocumentLines(oldText);

    type OldLine = { rowOrdinal: number } | { rowOrdinal: -1; error?: string };
    const oldRowCanon: string[] = [];
    const oldRowLine: number[] = [];
    const textByCanon = new Map<string, string>();
    // Values that differently spelled lines share (rounded big integers, 1.50
    // and 1.5): no single line's text stands for all of them
    const ambiguousCanon = new Set<string>();
    const canonByText = new Map<string, string>();
    const info: OldLine[] = oldLines.map((line, lineIndex) => {
        const trimmed = line.trim();
        if (!trimmed) {
            return { rowOrdinal: -1 };
        }
        try {
            const canon = canonical(JSON.parse(trimmed));
            oldRowCanon.push(canon);
            oldRowLine.push(lineIndex);
            canonByText.set(line, canon);
            const known = textByCanon.get(canon);
            if (known === undefined) {
                textByCanon.set(canon, line);
            } else if (known !== line) {
                ambiguousCanon.add(canon);
            }
            return { rowOrdinal: oldRowCanon.length - 1 };
        } catch (error) {
            return { rowOrdinal: -1, error: error instanceof Error ? error.message : 'Parse error' };
        }
    });

    const newCanon = newRows.map(canonical);
    // The line each row was read from, when the caller knows it and that line
    // still holds the row's value (an edited row is re-serialized instead)
    const newSource = newRows.map((row, index) => {
        const source = sourceTextOf ? sourceTextOf(row) : undefined;
        return source !== undefined && canonByText.get(source) === newCanon[index] ? source : undefined;
    });
    // Old row r can stay where it is as new row j: same value, and not a row
    // known to come from a different line (equal by value, different text)
    const sameRow = (r: number, j: number) => oldRowCanon[r] === newCanon[j] &&
        (newSource[j] === undefined || newSource[j] === oldLines[oldRowLine[r]]);
    const n = oldRowCanon.length;
    const m = newCanon.length;

    let prefix = 0;
    while (prefix < n && prefix < m && sameRow(prefix, prefix)) {
        prefix++;
    }
    let suffix = 0;
    while (suffix < n - prefix && suffix < m - prefix && sameRow(n - 1 - suffix, m - 1 - suffix)) {
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

    // The changed stretch's old lines by value, in order: equal rows written
    // back there take them in turn rather than all taking the first
    const middleTexts = new Map<string, { texts: string[]; next: number }>();
    for (let r = prefix; r < n - suffix; r++) {
        const queue = middleTexts.get(oldRowCanon[r]);
        const text = oldLines[oldRowLine[r]];
        if (queue) {
            queue.texts.push(text);
        } else {
            middleTexts.set(oldRowCanon[r], { texts: [text], next: 0 });
        }
    }

    const textFor = (rowIndex: number, canon: string): string => {
        const source = newSource[rowIndex];
        if (source !== undefined) {
            return source;
        }
        const queue = middleTexts.get(canon);
        if (queue && queue.next < queue.texts.length) {
            return queue.texts[queue.next++];
        }
        if (!ambiguousCanon.has(canon)) {
            const text = textByCanon.get(canon);
            if (text !== undefined) {
                return text;
            }
        }
        return canon;
    };

    const out: RebuiltLine[] = [];
    let errorCount = 0;
    const emitNew = (rowIndex: number) => {
        out.push({ rowIndex, text: textFor(rowIndex, newCanon[rowIndex]) });
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
