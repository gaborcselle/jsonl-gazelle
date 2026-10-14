/**
 * JSONL-aware diff engine.
 *
 * Aligns the rows of two JSONL documents line by line (exact LCS or Myers'
 * O(ND) diff where affordable, anchored on lines that occur once on each side
 * where not), then pairs the removed and added rows of each changed block
 * that look like edits of the same record and computes their field-level
 * changes. Pure module (no vscode imports) so it can be unit tested.
 */

export type RowChangeType = 'unchanged' | 'added' | 'removed' | 'modified';

export interface FieldChange {
    /** Dot/bracket path of the changed field, e.g. "user.name" or "tags[2]" */
    path: string;
    type: 'added' | 'removed' | 'changed';
    /**
     * The values as parsed, except that numbers JSON.parse cannot hold
     * exactly are marked strings holding their literal (see
     * protectNumberLiterals); restoreNumberLiterals turns them back for display.
     */
    oldValue?: any;
    newValue?: any;
}

export interface DiffRow {
    type: RowChangeType;
    /** 1-based line number in the old document (null for added rows) */
    oldLineNumber: number | null;
    /** 1-based line number in the new document (null for removed rows) */
    newLineNumber: number | null;
    oldText: string | null;
    newText: string | null;
    /** Present for 'modified' rows */
    fieldChanges?: FieldChange[];
}

export interface JsonlDiffSummary {
    added: number;
    removed: number;
    modified: number;
    unchanged: number;
}

export interface LineEndingChanges {
    /** Some line ends with a different terminator (CRLF, LF, CR) */
    lineEndings: boolean;
    /** One text ends with a line terminator and the other does not */
    finalNewline: boolean;
}

export interface JsonlDiffResult {
    rows: DiffRow[];
    summary: JsonlDiffSummary;
    /**
     * Set when every row is unchanged but the texts are not identical: the
     * only thing left to differ is how the lines are terminated.
     */
    lineEndingChanges?: LineEndingChanges;
}

/** Maximum number of DP cells for one exact LCS; beyond this the O(ND) diff takes over. */
const MAX_LCS_CELLS = 4_000_000;

/**
 * Most edits the O(ND) diff looks for before giving up on an exact alignment
 * (its bookkeeping grows with the square of this). A few edits in a file of
 * any length stay well inside it.
 */
const MAX_MYERS_EDITS = 2000;

/**
 * LCS table cells and O(ND) search steps one alignment may spend: a floor
 * (room for a full-size table or search, and a few more) plus an allowance
 * per line. Anchoring splits a big change into many gaps, and input built
 * against it (long runs of repeated lines between unique ones) would
 * otherwise run a failing search in every gap. Once it is spent, gaps go to
 * the cheaper strategies.
 */
const ALIGNMENT_WORK_FLOOR = 16_000_000;
const ALIGNMENT_WORK_PER_LINE = 8;

/** An LCS table this small is always affordable: all of them together stay linear in the input. */
const SMALL_LCS_CELLS = 4096;

/** How many times the gaps between anchors are anchored again (each level is one linear pass). */
const MAX_ANCHOR_DEPTH = 24;

/** Maximum field changes reported per row (safety cap for pathological rows). */
const MAX_FIELD_CHANGES_PER_ROW = 200;

/**
 * Fraction of leaf values (see leafSimilarity) that must be identical for a
 * removed/added row pair to be reported as a single 'modified' row instead of
 * remove + add.
 */
const MODIFIED_SIMILARITY_THRESHOLD = 0.3;

/**
 * Removed x added rows weighed against each other in one changed block. Up to
 * this the block is paired for the highest total similarity; beyond it the
 * k-th removed row is tried against the k-th added one.
 */
const MAX_PAIRING_CELLS = 40_000;

/** A block this small is always weighed in full: a constant amount of work per row. */
const SMALL_PAIRING_CELLS = 64;

/**
 * Leaf comparisons the similarity pairing may spend across one diff, so a
 * file rewritten almost everywhere does not weigh every pairing of every block.
 */
const MAX_PAIRING_WORK = 2_000_000;

export function computeJsonlDiff(oldText: string, newText: string): JsonlDiffResult {
    const oldLines = splitLines(oldText);
    const newLines = splitLines(newText);

    const rows: DiffRow[] = [];

    // Trim common prefix
    let start = 0;
    while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
        rows.push(unchangedRow(oldLines[start], start + 1, start + 1));
        start++;
    }

    // Trim common suffix (collected back to front, reversed once: unshift
    // made this quadratic in the number of unchanged trailing rows)
    let oldEnd = oldLines.length;
    let newEnd = newLines.length;
    const suffixRows: DiffRow[] = [];
    while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
        suffixRows.push(unchangedRow(oldLines[oldEnd - 1], oldEnd, newEnd));
        oldEnd--;
        newEnd--;
    }
    suffixRows.reverse();

    const ops = diffLines(oldLines.slice(start, oldEnd), newLines.slice(start, newEnd));

    // Walk the edit script; the changes between two kept lines form one block
    const pairingBudget = { work: MAX_PAIRING_WORK };
    let i = 0;
    let oldLineNo = start; // 0-based index into full old doc
    let newLineNo = start;
    while (i < ops.length) {
        if (ops[i] === 0) {
            rows.push(unchangedRow(oldLines[oldLineNo], oldLineNo + 1, newLineNo + 1));
            oldLineNo++;
            newLineNo++;
            i++;
            continue;
        }

        // The removed lines are consecutive in the old doc and the added
        // lines are consecutive in the new doc, regardless of op interleaving.
        let removed = 0;
        let added = 0;
        while (i < ops.length && ops[i] !== 0) {
            if (ops[i] === -1) { removed++; } else { added++; }
            i++;
        }
        appendChangedBlock(rows, oldLines, oldLineNo, removed, newLines, newLineNo, added, pairingBudget);
        oldLineNo += removed;
        newLineNo += added;
    }

    // Not rows.push(...suffixRows): spreading a long array overflows the stack
    for (const row of suffixRows) {
        rows.push(row);
    }

    const summary: JsonlDiffSummary = { added: 0, removed: 0, modified: 0, unchanged: 0 };
    for (const row of rows) {
        summary[row.type]++;
    }

    const result: JsonlDiffResult = { rows, summary };
    if (summary.added + summary.removed + summary.modified === 0 && oldText !== newText) {
        result.lineEndingChanges = describeLineEndingChanges(oldText, newText);
    }
    return result;
}

function unchangedRow(text: string, oldLine: number, newLine: number): DiffRow {
    return { type: 'unchanged', oldLineNumber: oldLine, newLineNumber: newLine, oldText: text, newText: text };
}

/**
 * What differs between two texts made of the same lines: the terminator
 * ending some line, and/or whether the text ends with one at all.
 */
function describeLineEndingChanges(oldText: string, newText: string): LineEndingChanges {
    const oldBreaks = oldText.match(/\r\n|\r|\n/g) || [];
    const newBreaks = newText.match(/\r\n|\r|\n/g) || [];
    // The lines are the same, so the k-th terminator ends the same line on both sides
    let lineEndings = false;
    for (let k = Math.min(oldBreaks.length, newBreaks.length) - 1; k >= 0 && !lineEndings; k--) {
        lineEndings = oldBreaks[k] !== newBreaks[k];
    }
    return { lineEndings, finalNewline: /[\r\n]$/.test(oldText) !== /[\r\n]$/.test(newText) };
}

interface RowPair {
    /** Offsets of the paired rows within the block's removed and added rows */
    oldOffset: number;
    newOffset: number;
    changes: FieldChange[];
}

/**
 * Emit one changed block: `removed` old lines from `oldFrom` replaced by
 * `added` new lines from `newFrom`. Rows that pair up as edits of the same
 * record become 'modified'; the others are removals and additions, kept in
 * document order on both sides.
 */
function appendChangedBlock(
    rows: DiffRow[],
    oldLines: string[], oldFrom: number, removed: number,
    newLines: string[], newFrom: number, added: number,
    budget: { work: number }
): void {
    const pairs = removed > 0 && added > 0 ? pairChangedRows(oldLines, oldFrom, removed, newLines, newFrom, added, budget) : [];
    let r = 0;
    let c = 0;
    const emitUnpaired = (oldUntil: number, newUntil: number) => {
        for (; r < oldUntil; r++) {
            rows.push({ type: 'removed', oldLineNumber: oldFrom + r + 1, newLineNumber: null, oldText: oldLines[oldFrom + r], newText: null });
        }
        for (; c < newUntil; c++) {
            rows.push({ type: 'added', oldLineNumber: null, newLineNumber: newFrom + c + 1, oldText: null, newText: newLines[newFrom + c] });
        }
    };
    for (const pair of pairs) {
        emitUnpaired(pair.oldOffset, pair.newOffset);
        rows.push({
            type: 'modified',
            oldLineNumber: oldFrom + r + 1,
            newLineNumber: newFrom + c + 1,
            oldText: oldLines[oldFrom + r],
            newText: newLines[newFrom + c],
            fieldChanges: pair.changes
        });
        r++;
        c++;
    }
    emitUnpaired(removed, added);
}

/**
 * Decide which removed rows of a changed block are edits of which added
 * rows. A block small enough to weigh every pairing is paired for the
 * highest total similarity, so a row deleted or inserted next to an edited
 * one is not mistaken for it; a bigger one tries the k-th removed row
 * against the k-th added one.
 */
function pairChangedRows(
    oldLines: string[], oldFrom: number, removed: number,
    newLines: string[], newFrom: number, added: number,
    budget: { work: number }
): RowPair[] {
    const cells = removed * added;
    if (cells <= SMALL_PAIRING_CELLS || (cells <= MAX_PAIRING_CELLS && budget.work > 0)) {
        const pairs = pairBySimilarity(oldLines, oldFrom, removed, newLines, newFrom, added, cells <= SMALL_PAIRING_CELLS ? null : budget);
        if (pairs) {
            return pairs;
        }
    }
    const pairs: RowPair[] = [];
    for (let k = 0; k < Math.min(removed, added); k++) {
        const changes = diffRowPair(oldLines[oldFrom + k], newLines[newFrom + k]);
        if (changes) {
            pairs.push({ oldOffset: k, newOffset: k, changes });
        }
    }
    return pairs;
}

interface PairableRow {
    value: any;
    /** For telling rows apart that differ only in formatting or key order */
    canonical: string;
}

function pairableRow(raw: string): PairableRow | null {
    const value = tryParse(raw);
    return isPlainObject(value) ? { value, canonical: canonicalStringify(value) } : null;
}

/**
 * Pair a block's rows in order, maximising the summed similarity of the pairs
 * (each at least MODIFIED_SIMILARITY_THRESHOLD): a DP over removed x added
 * rows. Returns null when `budget` runs out first.
 */
function pairBySimilarity(
    oldLines: string[], oldFrom: number, removed: number,
    newLines: string[], newFrom: number, added: number,
    budget: { work: number } | null
): RowPair[] | null {
    const oldRows: (PairableRow | null)[] = [];
    const newRows: (PairableRow | null)[] = [];
    for (let r = 0; r < removed; r++) {
        oldRows.push(pairableRow(oldLines[oldFrom + r]));
    }
    for (let c = 0; c < added; c++) {
        newRows.push(pairableRow(newLines[newFrom + c]));
    }

    // best[r * width + c]: highest total similarity pairing the first r
    // removed rows with the first c added rows
    const width = added + 1;
    const best = new Float64Array((removed + 1) * width);
    const counts = { union: 0, equal: 0 };
    for (let r = 1; r <= removed; r++) {
        const oldRow = oldRows[r - 1];
        for (let c = 1; c <= added; c++) {
            const at = r * width + c;
            let value = Math.max(best[at - width], best[at - 1]);
            const newRow = newRows[c - 1];
            // Equal values written differently have no field to show: never a pair
            if (oldRow && newRow && oldRow.canonical !== newRow.canonical) {
                counts.union = 0;
                counts.equal = 0;
                countLeaves(oldRow.value, newRow.value, counts);
                if (budget) {
                    budget.work -= counts.union + 1;
                }
                const similarity = counts.union === 0 ? 1 : counts.equal / counts.union;
                if (similarity >= MODIFIED_SIMILARITY_THRESHOLD && best[at - width - 1] + similarity > value) {
                    value = best[at - width - 1] + similarity;
                }
            }
            best[at] = value;
        }
        if (budget && budget.work < 0) {
            return null;
        }
    }

    // Walk back from the end. Skipping a row wherever that loses nothing pairs
    // each record as early as possible, as pairing by position did on ties.
    const pairs: RowPair[] = [];
    let r = removed;
    let c = added;
    while (r > 0 && c > 0) {
        const at = r * width + c;
        if (best[at] === best[at - width]) {
            r--;
        } else if (best[at] === best[at - 1]) {
            c--;
        } else {
            const changes: FieldChange[] = [];
            collectFieldChanges(oldRows[r - 1]!.value, newRows[c - 1]!.value, '', changes);
            if (changes.length > 0) {
                pairs.push({ oldOffset: r - 1, newOffset: c - 1, changes });
            }
            r--;
            c--;
        }
    }
    return pairs.reverse();
}

/**
 * Split document text into lines, dropping the trailing empty line produced
 * by a final newline character.
 */
export function splitLines(text: string): string[] {
    if (text === '') {
        return [];
    }
    const lines = text.split(/\r\n|\r|\n/);
    if (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
    }
    return lines;
}

/**
 * Line diff over the (already prefix/suffix-trimmed) middle sections.
 * Returns an edit script as an array of ops: 0 = keep, -1 = remove old line,
 * 1 = add new line. Between two kept lines removals come first, but nothing
 * depends on that: computeJsonlDiff pairs up each run of changes itself.
 */
function diffLines(oldLines: string[], newLines: string[]): number[] {
    const m = oldLines.length;
    const n = newLines.length;
    if (m === 0 && n === 0) {
        return [];
    }
    if (m === 0) {
        return new Array(n).fill(1);
    }
    if (n === 0) {
        return new Array(m).fill(-1);
    }

    // Intern lines as integers for fast comparison
    const ids = new Map<string, number>();
    const oldIds = new Int32Array(m);
    const newIds = new Int32Array(n);
    for (let i = 0; i < m; i++) {
        let id = ids.get(oldLines[i]);
        if (id === undefined) { id = ids.size; ids.set(oldLines[i], id); }
        oldIds[i] = id;
    }
    for (let j = 0; j < n; j++) {
        let id = ids.get(newLines[j]);
        if (id === undefined) { id = ids.size; ids.set(newLines[j], id); }
        newIds[j] = id;
    }

    const aligner = new LineAligner(oldIds, newIds, ids.size);
    aligner.align(positions(m), positions(n), 0);
    return aligner.editScript();
}

function positions(length: number): Int32Array {
    const result = new Int32Array(length);
    for (let i = 0; i < length; i++) {
        result[i] = i;
    }
    return result;
}

/**
 * Chooses the lines the two sides keep. A stretch of lines is aligned by the
 * first strategy that applies:
 *
 * 1. an exact LCS table, when it fits;
 * 2. Myers' O(ND) diff, when the stretch needs at most MAX_MYERS_EDITS edits;
 * 3. anchors: of the lines that occur exactly once on each side, the longest
 *    run that is in the same order on both sides is kept (as in patience
 *    diff), and the gaps between anchors are aligned the same way;
 * 4. by position, for a gap with no unique line to anchor on.
 *
 * Before any of that, lines with no counterpart on the other side are set
 * aside, since nothing can keep them. That is exact, and it shrinks the
 * usual big change - rows edited or deleted all over the file - to nothing.
 */
class LineAligner {
    private readonly oldCounts: Int32Array;
    private readonly newCounts: Int32Array;
    /** For a line unique on both sides: its index in the new stretch being anchored */
    private readonly uniqueNewIndex: Int32Array;
    private readonly keptOld: number[] = [];
    private readonly keptNew: number[] = [];
    private work: number;

    constructor(private readonly oldIds: Int32Array, private readonly newIds: Int32Array, distinctLines: number) {
        this.oldCounts = new Int32Array(distinctLines);
        this.newCounts = new Int32Array(distinctLines);
        this.uniqueNewIndex = new Int32Array(distinctLines);
        this.work = ALIGNMENT_WORK_FLOOR + ALIGNMENT_WORK_PER_LINE * (oldIds.length + newIds.length);
    }

    /**
     * Align the old lines at positions `oldAt` with the new lines at `newAt`
     * (both increasing). Kept pairs are recorded left to right, so every
     * stretch is finished before the next one starts.
     */
    align(oldAt: Int32Array, newAt: Int32Array, depth: number): void {
        const oldIds = this.oldIds;
        const newIds = this.newIds;
        let start = 0;
        while (start < oldAt.length && start < newAt.length && oldIds[oldAt[start]] === newIds[newAt[start]]) {
            this.keep(oldAt[start], newAt[start]);
            start++;
        }
        let oldEnd = oldAt.length;
        let newEnd = newAt.length;
        while (oldEnd > start && newEnd > start && oldIds[oldAt[oldEnd - 1]] === newIds[newAt[newEnd - 1]]) {
            oldEnd--;
            newEnd--;
        }
        if (oldEnd > start && newEnd > start) {
            this.alignMiddle(oldAt.subarray(start, oldEnd), newAt.subarray(start, newEnd), depth);
        }
        for (let k = 0; oldEnd + k < oldAt.length; k++) {
            this.keep(oldAt[oldEnd + k], newAt[newEnd + k]);
        }
    }

    editScript(): number[] {
        const ops: number[] = [];
        let x = 0;
        let y = 0;
        for (let k = 0; k < this.keptOld.length; k++) {
            for (; x < this.keptOld[k]; x++) { ops.push(-1); }
            for (; y < this.keptNew[k]; y++) { ops.push(1); }
            ops.push(0);
            x++;
            y++;
        }
        for (; x < this.oldIds.length; x++) { ops.push(-1); }
        for (; y < this.newIds.length; y++) { ops.push(1); }
        return ops;
    }

    private keep(oldPosition: number, newPosition: number): void {
        this.keptOld.push(oldPosition);
        this.keptNew.push(newPosition);
    }

    /** A stretch with different first and last lines on the two sides. */
    private alignMiddle(oldAt: Int32Array, newAt: Int32Array, depth: number): void {
        this.count(oldAt, newAt, 1);
        const oldShared = this.withCounterpart(oldAt, this.oldIds, this.newCounts);
        const newShared = this.withCounterpart(newAt, this.newIds, this.oldCounts);
        this.count(oldAt, newAt, -1);
        if (oldShared.length === 0 || newShared.length === 0) {
            return;
        }
        if ((oldShared.length < oldAt.length || newShared.length < newAt.length) && depth < MAX_ANCHOR_DEPTH) {
            // Setting lines aside can bring equal ones together at the ends
            this.align(oldShared, newShared, depth + 1);
        } else {
            this.solve(oldShared, newShared, depth);
        }
    }

    private solve(oldAt: Int32Array, newAt: Int32Array, depth: number): void {
        const cells = oldAt.length * newAt.length;
        if (cells <= MAX_LCS_CELLS && (cells <= SMALL_LCS_CELLS || cells <= this.work)) {
            this.work -= cells;
            this.keepLcs(oldAt, newAt);
            return;
        }
        if (Math.abs(oldAt.length - newAt.length) <= MAX_MYERS_EDITS && this.work > 0) {
            const search = myersSearch(idsAt(this.oldIds, oldAt), idsAt(this.newIds, newAt), MAX_MYERS_EDITS, this.work);
            this.work -= search.work;
            if (search.ops) {
                this.keepScript(oldAt, newAt, search.ops);
                return;
            }
        }
        if (depth < MAX_ANCHOR_DEPTH && this.anchor(oldAt, newAt, depth)) {
            return;
        }
        // Last resort: keep the lines that sit at the same position on both sides
        const paired = Math.min(oldAt.length, newAt.length);
        for (let k = 0; k < paired; k++) {
            if (this.oldIds[oldAt[k]] === this.newIds[newAt[k]]) {
                this.keep(oldAt[k], newAt[k]);
            }
        }
    }

    /**
     * Keep the longest run of lines that occur once on each side, in the same
     * order on both, and align the gaps between them. False when no line
     * occurs once on each side.
     */
    private anchor(oldAt: Int32Array, newAt: Int32Array, depth: number): boolean {
        const oldIds = this.oldIds;
        const newIds = this.newIds;
        this.count(oldAt, newAt, 1);
        for (let y = 0; y < newAt.length; y++) {
            const id = newIds[newAt[y]];
            if (this.oldCounts[id] === 1 && this.newCounts[id] === 1) {
                this.uniqueNewIndex[id] = y;
            }
        }
        const candidateOld: number[] = [];
        const candidateNew: number[] = [];
        for (let x = 0; x < oldAt.length; x++) {
            const id = oldIds[oldAt[x]];
            if (this.oldCounts[id] === 1 && this.newCounts[id] === 1) {
                candidateOld.push(x);
                candidateNew.push(this.uniqueNewIndex[id]);
            }
        }
        this.count(oldAt, newAt, -1);
        if (candidateOld.length === 0) {
            return false;
        }

        let oldFrom = 0;
        let newFrom = 0;
        for (const t of longestIncreasingSubsequence(candidateNew)) {
            const x = candidateOld[t];
            const y = candidateNew[t];
            if (x > oldFrom && y > newFrom) {
                this.align(oldAt.subarray(oldFrom, x), newAt.subarray(newFrom, y), depth + 1);
            }
            this.keep(oldAt[x], newAt[y]);
            oldFrom = x + 1;
            newFrom = y + 1;
        }
        if (oldFrom < oldAt.length && newFrom < newAt.length) {
            this.align(oldAt.subarray(oldFrom), newAt.subarray(newFrom), depth + 1);
        }
        return true;
    }

    private count(oldAt: Int32Array, newAt: Int32Array, delta: number): void {
        for (let i = 0; i < oldAt.length; i++) {
            this.oldCounts[this.oldIds[oldAt[i]]] += delta;
        }
        for (let j = 0; j < newAt.length; j++) {
            this.newCounts[this.newIds[newAt[j]]] += delta;
        }
    }

    /** The positions in `at` whose line occurs on the other side (per `otherCounts`). */
    private withCounterpart(at: Int32Array, ids: Int32Array, otherCounts: Int32Array): Int32Array {
        let shared = 0;
        for (let i = 0; i < at.length; i++) {
            if (otherCounts[ids[at[i]]] > 0) { shared++; }
        }
        if (shared === at.length) {
            return at;
        }
        const result = new Int32Array(shared);
        for (let i = 0, k = 0; i < at.length; i++) {
            if (otherCounts[ids[at[i]]] > 0) { result[k++] = at[i]; }
        }
        return result;
    }

    private keepLcs(oldAt: Int32Array, newAt: Int32Array): void {
        const a = idsAt(this.oldIds, oldAt);
        const b = idsAt(this.newIds, newAt);
        const m = a.length;
        const n = b.length;

        // Standard LCS DP table
        const width = n + 1;
        const table = new Uint32Array((m + 1) * width);
        for (let i = 1; i <= m; i++) {
            const rowBase = i * width;
            const prevBase = rowBase - width;
            for (let j = 1; j <= n; j++) {
                if (a[i - 1] === b[j - 1]) {
                    table[rowBase + j] = table[prevBase + j - 1] + 1;
                } else {
                    const up = table[prevBase + j];
                    const left = table[rowBase + j - 1];
                    table[rowBase + j] = up >= left ? up : left;
                }
            }
        }

        // Backtrack from the end, collecting the kept pairs in reverse
        const kept: number[] = [];
        let i = m;
        let j = n;
        while (i > 0 && j > 0) {
            if (a[i - 1] === b[j - 1]) {
                kept.push(i - 1, j - 1);
                i--;
                j--;
            } else if (table[(i - 1) * width + j] >= table[i * width + j - 1]) {
                i--;
            } else {
                j--;
            }
        }
        for (let k = kept.length - 2; k >= 0; k -= 2) {
            this.keep(oldAt[kept[k]], newAt[kept[k + 1]]);
        }
    }

    private keepScript(oldAt: Int32Array, newAt: Int32Array, ops: number[]): void {
        let x = 0;
        let y = 0;
        for (const op of ops) {
            if (op === 0) {
                this.keep(oldAt[x], newAt[y]);
                x++;
                y++;
            } else if (op === -1) {
                x++;
            } else {
                y++;
            }
        }
    }
}

function idsAt(ids: Int32Array, at: Int32Array): Int32Array {
    const result = new Int32Array(at.length);
    for (let i = 0; i < at.length; i++) {
        result[i] = ids[at[i]];
    }
    return result;
}

/** Indices of a longest strictly increasing subsequence of `values` (patience sorting, O(n log n)). */
function longestIncreasingSubsequence(values: number[]): number[] {
    const n = values.length;
    // tails[l]: index of the smallest value that ends an increasing run of length l + 1
    const tails = new Int32Array(n);
    const previous = new Int32Array(n);
    let length = 0;
    for (let i = 0; i < n; i++) {
        let lo = 0;
        let hi = length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (values[tails[mid]] < values[i]) { lo = mid + 1; } else { hi = mid; }
        }
        previous[i] = lo > 0 ? tails[lo - 1] : -1;
        tails[lo] = i;
        if (lo === length) { length++; }
    }
    const result: number[] = new Array(length);
    for (let k = length - 1, t = length > 0 ? tails[length - 1] : -1; k >= 0; k--, t = previous[t]) {
        result[k] = t;
    }
    return result;
}

/**
 * Myers' O(ND) shortest edit script (same ops as diffLines), or null when the
 * sides need more than `maxEdits` insertions and deletions. Keeps the
 * furthest-reaching x per diagonal for every edit count to backtrack through.
 */
export function myersDiff(a: Int32Array, b: Int32Array, maxEdits: number): number[] | null {
    return myersSearch(a, b, maxEdits, Infinity).ops;
}

/**
 * myersDiff that also gives up after about `maxWork` steps - diagonal slots
 * allocated plus line comparisons - and reports how many it took.
 */
function myersSearch(a: Int32Array, b: Int32Array, maxEdits: number, maxWork: number): { ops: number[] | null; work: number } {
    const n = a.length;
    const m = b.length;
    const trace: Int32Array[] = [];
    let previous = new Int32Array(1);
    let work = 0;

    for (let d = 0; d <= maxEdits && work <= maxWork; d++) {
        // current[k + d] = furthest x on diagonal k (x - y = k) after d edits
        const current = new Int32Array(2 * d + 1);
        work += 2 * d + 1;
        for (let k = -d; k <= d; k += 2) {
            let x: number;
            if (d === 0) {
                x = 0;
            } else if (k === -d || (k !== d && previous[k - 1 + d - 1] < previous[k + 1 + d - 1])) {
                x = previous[k + 1 + d - 1]; // down: insert b[y]
            } else {
                x = previous[k - 1 + d - 1] + 1; // right: delete a[x]
            }
            let y = x - k;
            const snakeStart = x;
            while (x < n && y < m && a[x] === b[y]) {
                x++;
                y++;
            }
            work += x - snakeStart;
            current[k + d] = x;
            if (x >= n && y >= m) {
                trace.push(current);
                return { ops: backtrackMyers(trace, n, m), work };
            }
        }
        trace.push(current);
        previous = current;
    }
    return { ops: null, work };
}

function backtrackMyers(trace: Int32Array[], n: number, m: number): number[] {
    const reversed: number[] = [];
    let x = n;
    let y = m;
    for (let d = trace.length - 1; d > 0; d--) {
        const previous = trace[d - 1];
        const k = x - y;
        const down = k === -d || (k !== d && previous[k - 1 + d - 1] < previous[k + 1 + d - 1]);
        const previousK = down ? k + 1 : k - 1;
        const previousX = previous[previousK + d - 1];
        const previousY = previousX - previousK;
        // The snake after the edit, then the edit itself
        while (x > (down ? previousX : previousX + 1) && y > (down ? previousY + 1 : previousY)) {
            reversed.push(0);
            x--;
            y--;
        }
        if (down) {
            reversed.push(1);
            y--;
        } else {
            reversed.push(-1);
            x--;
        }
    }
    while (x > 0 && y > 0) {
        reversed.push(0);
        x--;
        y--;
    }
    return reversed.reverse();
}

/** U+E000, the first private-use character: no real text uses it as a marker. */
const PRIVATE_USE_CHAR = String.fromCharCode(0xE000);

/**
 * Prefix of the strings protectNumberLiterals puts in place of a number.
 * A line that holds U+E000 anyway (raw or escaped) is left unprotected, so
 * none of its own strings can be taken for a marked number.
 */
export const NUMBER_LITERAL_MARK = PRIVATE_USE_CHAR + 'jsonl-number' + PRIVATE_USE_CHAR;

/** Cheap test for text that may hold such a number: 16+ digits in a row, or a 3-digit exponent. */
const LONG_NUMBER_HINT = /\d{16}|[eE][+-]?\d{3}/;
const NUMBER_LITERAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const MARKED_NUMBER = new RegExp('"' + NUMBER_LITERAL_MARK + '(-?[0-9][0-9.eE+-]*)"', 'g');

/**
 * Wrap every number literal that JSON.parse would change - an integer beyond
 * Number.MAX_SAFE_INTEGER, which it rounds, or one out of a double's range,
 * which becomes Infinity and is then written as null - in a marked string
 * holding its text, so that it is compared as written and shown as written.
 * Digits inside strings are left alone. Other numbers are not touched: 1.50
 * and 1.5 still compare equal. (src/webview/diffView.ts carries a copy.)
 */
export function protectNumberLiterals(text: string): string {
    if (!LONG_NUMBER_HINT.test(text) || text.indexOf(PRIVATE_USE_CHAR) !== -1 || /\\u[eE]000/.test(text)) {
        return text;
    }
    let result = '';
    let copied = 0;
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (ch === '"') {
            // Skip the string, escaped quotes and all
            i++;
            while (i < text.length && text[i] !== '"') {
                i += text[i] === '\\' ? 2 : 1;
            }
            i++;
        } else if (ch === '-' || (ch >= '0' && ch <= '9')) {
            let end = i + 1;
            while (end < text.length && '0123456789.eE+-'.indexOf(text[end]) !== -1) {
                end++;
            }
            const literal = text.slice(i, end);
            if (isInexactNumber(literal)) {
                result += text.slice(copied, i) + '"' + NUMBER_LITERAL_MARK + literal + '"';
                copied = end;
            }
            i = end;
        } else {
            i++;
        }
    }
    return copied === 0 ? text : result + text.slice(copied);
}

function isInexactNumber(literal: string): boolean {
    if (!NUMBER_LITERAL.test(literal)) {
        return false;
    }
    const value = Number(literal);
    return !isFinite(value) || (/^-?\d+$/.test(literal) && !Number.isSafeInteger(value));
}

/** Undo protectNumberLiterals in JSON text (e.g. a value's JSON.stringify): marked strings become their numbers again. */
export function restoreNumberLiterals(json: string): string {
    return json.indexOf(NUMBER_LITERAL_MARK) === -1 ? json : json.replace(MARKED_NUMBER, '$1');
}

function tryParse(line: string): any {
    const trimmed = line.trim();
    if (trimmed === '') {
        return undefined;
    }
    try {
        const value = JSON.parse(trimmed);
        // The plain parse decides whether the line is valid; the values come
        // from a second one, with the numbers it would change protected
        const protectedText = protectNumberLiterals(trimmed);
        return protectedText === trimmed ? value : JSON.parse(protectedText);
    } catch {
        return undefined;
    }
}

function hasOwn(obj: any, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(obj, key);
}

function isPlainObject(value: any): boolean {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Decide whether an old/new line pair represents an edit of the same record.
 * Returns the field-level changes when it does, or null when the rows should
 * be shown as a plain removal + addition.
 */
export function diffRowPair(oldRaw: string, newRaw: string): FieldChange[] | null {
    const oldObj = tryParse(oldRaw);
    const newObj = tryParse(newRaw);
    if (!isPlainObject(oldObj) || !isPlainObject(newObj)) {
        return null;
    }

    const similarity = leafSimilarity(oldObj, newObj);
    if (similarity < MODIFIED_SIMILARITY_THRESHOLD) {
        return null;
    }

    const changes: FieldChange[] = [];
    collectFieldChanges(oldObj, newObj, '', changes);
    if (changes.length === 0) {
        // Raw text differs (formatting/key order) but values are equal:
        // there is no field to show, so the rows stay a removal + addition
        return null;
    }
    return changes;
}

/** Cap on leaves visited by the similarity check, to bound work on huge rows. */
const MAX_SIMILARITY_LEAVES = 5000;

/** Sentinel for "key absent on this side" — never equals a parsed JSON value. */
const MISSING: unique symbol = Symbol('missing');

/**
 * Fraction of leaf values (union of both rows) that are identical.
 * Comparing at leaf level keeps a change deep inside a nested object from
 * disqualifying the whole record.
 */
export function leafSimilarity(oldObj: any, newObj: any): number {
    const counts = { union: 0, equal: 0 };
    countLeaves(oldObj, newObj, counts);
    return counts.union === 0 ? 1 : counts.equal / counts.union;
}

function countLeaves(oldVal: any, newVal: any, counts: { union: number; equal: number }): void {
    if (counts.union >= MAX_SIMILARITY_LEAVES) {
        return;
    }
    const oldIsContainer = oldVal !== null && typeof oldVal === 'object';
    const newIsContainer = newVal !== null && typeof newVal === 'object';
    if (!oldIsContainer && !newIsContainer && oldVal !== MISSING && newVal !== MISSING) {
        // Two plain values, most of any record: compared without serializing them
        counts.union++;
        if (sameParsedValue(oldVal, newVal)) {
            counts.equal++;
        }
        return;
    }
    const oldIsObj = isPlainObject(oldVal);
    const newIsObj = isPlainObject(newVal);
    const oldIsArr = Array.isArray(oldVal);
    const newIsArr = Array.isArray(newVal);

    if (oldIsObj && newIsObj) {
        // The union of the keys: the old row's, then those only the new one has
        for (const key of Object.keys(oldVal)) {
            countLeaves(oldVal[key], hasOwn(newVal, key) ? newVal[key] : MISSING, counts);
        }
        for (const key of Object.keys(newVal)) {
            if (!hasOwn(oldVal, key)) {
                countLeaves(MISSING, newVal[key], counts);
            }
        }
        return;
    }
    if (oldIsArr && newIsArr) {
        const maxLen = Math.max(oldVal.length, newVal.length);
        for (let i = 0; i < maxLen; i++) {
            countLeaves(i < oldVal.length ? oldVal[i] : MISSING, i < newVal.length ? newVal[i] : MISSING, counts);
        }
        return;
    }

    // At least one side is a leaf (or the container types differ / a side is missing):
    // compare whole subtrees as single units.
    const oldLeaves = oldVal === MISSING ? 0 : subtreeLeafCount(oldVal);
    const newLeaves = newVal === MISSING ? 0 : subtreeLeafCount(newVal);
    if (oldVal !== MISSING && newVal !== MISSING && canonicalStringify(oldVal) === canonicalStringify(newVal)) {
        counts.union += oldLeaves;
        counts.equal += oldLeaves;
    } else {
        counts.union += Math.max(oldLeaves, newLeaves, 1);
    }
}

/**
 * Whether two plain values are equal as JSON.parse sees them: a protected
 * number counts as the double it parses to, and JSON writes every non-finite
 * number as null. Similarity only decides whether two rows are the same
 * record, so it weighs numbers as it always has; the field changes of a pair
 * compare them as written.
 */
function sameParsedValue(oldVal: any, newVal: any): boolean {
    const a = asParsed(oldVal);
    const b = asParsed(newVal);
    return a === b || ((isNonFinite(a) || isNonFinite(b)) && JSON.stringify(a) === JSON.stringify(b));
}

function asParsed(value: any): any {
    return typeof value === 'string' && value.startsWith(NUMBER_LITERAL_MARK) ? Number(value.slice(NUMBER_LITERAL_MARK.length)) : value;
}

function isNonFinite(value: any): boolean {
    return typeof value === 'number' && !isFinite(value);
}

function subtreeLeafCount(value: any): number {
    if (isPlainObject(value)) {
        let total = 0;
        for (const key of Object.keys(value)) {
            total += subtreeLeafCount(value[key]);
            if (total >= MAX_SIMILARITY_LEAVES) { return total; }
        }
        return Math.max(total, 1);
    }
    if (Array.isArray(value)) {
        let total = 0;
        for (const item of value) {
            total += subtreeLeafCount(item);
            if (total >= MAX_SIMILARITY_LEAVES) { return total; }
        }
        return Math.max(total, 1);
    }
    return 1;
}

/**
 * Recursively collect field-level changes between two values known to be
 * plain objects. Arrays are compared index-wise.
 */
export function collectFieldChanges(oldObj: any, newObj: any, basePath: string, out: FieldChange[]): void {
    const keys = new Set([...Object.keys(oldObj), ...Object.keys(newObj)]);
    for (const key of keys) {
        if (out.length >= MAX_FIELD_CHANGES_PER_ROW) {
            return;
        }
        const path = basePath === '' ? key : `${basePath}.${key}`;
        // Own keys only: `"toString" in {}` is true, which reported a new
        // "toString" field as a change from Object.prototype.toString
        const inOld = hasOwn(oldObj, key);
        const inNew = hasOwn(newObj, key);
        if (inOld && !inNew) {
            out.push({ path, type: 'removed', oldValue: oldObj[key] });
        } else if (!inOld && inNew) {
            out.push({ path, type: 'added', newValue: newObj[key] });
        } else {
            compareValues(oldObj[key], newObj[key], path, out);
        }
    }
}

function compareValues(oldVal: any, newVal: any, path: string, out: FieldChange[]): void {
    if (out.length >= MAX_FIELD_CHANGES_PER_ROW) {
        return;
    }
    if (canonicalStringify(oldVal) === canonicalStringify(newVal)) {
        return;
    }
    if (isPlainObject(oldVal) && isPlainObject(newVal)) {
        collectFieldChanges(oldVal, newVal, path, out);
        return;
    }
    if (Array.isArray(oldVal) && Array.isArray(newVal)) {
        const maxLen = Math.max(oldVal.length, newVal.length);
        for (let i = 0; i < maxLen; i++) {
            if (out.length >= MAX_FIELD_CHANGES_PER_ROW) {
                return;
            }
            const itemPath = `${path}[${i}]`;
            if (i >= oldVal.length) {
                out.push({ path: itemPath, type: 'added', newValue: newVal[i] });
            } else if (i >= newVal.length) {
                out.push({ path: itemPath, type: 'removed', oldValue: oldVal[i] });
            } else {
                compareValues(oldVal[i], newVal[i], itemPath, out);
            }
        }
        return;
    }
    out.push({ path, type: 'changed', oldValue: oldVal, newValue: newVal });
}

/**
 * JSON.stringify with object keys sorted, so logically equal values compare equal.
 */
export function canonicalStringify(value: any): string {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return '[' + value.map(v => v === undefined ? 'null' : canonicalStringify(v)).join(',') + ']';
    }
    const keys = Object.keys(value).sort();
    const parts: string[] = [];
    for (const key of keys) {
        if (value[key] !== undefined) {
            parts.push(JSON.stringify(key) + ':' + canonicalStringify(value[key]));
        }
    }
    return '{' + parts.join(',') + '}';
}
