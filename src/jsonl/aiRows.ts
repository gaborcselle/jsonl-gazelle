/**
 * Turning rows into AI prompts, and AI answers back into cell values and rows.
 */

import { getNestedValue } from './utils';

/**
 * Fill a per-row prompt template: {{row}}, {{row.<field path>}},
 * {{row_number}}, {{rows_before}} and {{rows_after}}.
 *
 * One pass with a function replacement. A replacement string would read `$&`,
 * `$'` and `$$` in the row's data as patterns, and a second pass would expand
 * placeholders that the first one copied in from the data.
 */
export function fillRowTemplate(template: string, row: unknown, rowIndex: number, totalRows: number): string {
    return template.replace(/\{\{(row(?:\.([^{}]+?))?|row_number|rows_before|rows_after)\}\}/g, (match, name: string, fieldPath?: string) => {
        if (fieldPath !== undefined) {
            // Any field name: "first-name", "Full Name", "@timestamp", "items[0].id"
            const value = getNestedValue(row, fieldPath);
            if (value === undefined || value === null) {
                return '';
            }
            return typeof value === 'object' ? JSON.stringify(value) : String(value);
        }
        switch (name) {
            case 'row': return JSON.stringify(row);
            case 'row_number': return String(rowIndex + 1);
            case 'rows_before': return String(rowIndex);
            case 'rows_after': return String(totalRows - rowIndex - 1);
            default: return match;
        }
    });
}

/** Fill named {{placeholders}} in one pass, leaving `$` sequences in the values alone. */
export function fillPlaceholders(template: string, values: { [name: string]: string }): string {
    return template.replace(/\{\{([a-z_]+)\}\}/g, (match, name: string) =>
        Object.prototype.hasOwnProperty.call(values, name) ? values[name] : match);
}

/**
 * The number a model's answer spells, or null when it is text that merely
 * looks numeric. Only plain JSON numbers count: "02134" (a ZIP code),
 * "+14155550123" (a phone number), "0x1F", "1e999" and integers too large to
 * hold exactly ("12345678901234567890", an ID) stay text, where Number() would
 * quietly change them.
 */
export function parseModelNumber(text: string): number | null {
    if (!/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(text)) {
        return null;
    }
    const value = Number(text);
    if (!Number.isFinite(value)) {
        return null;
    }
    if (/^-?\d+$/.test(text) && !Number.isSafeInteger(value)) {
        return null;
    }
    return value;
}

type ValueType = 'number' | 'boolean' | 'string' | 'object';

const typeOf = (value: unknown): ValueType =>
    typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : value !== null && typeof value === 'object' ? 'object' : 'string';

/** What rows generated after these context rows should look like. */
export type RowShape =
    | { kind: 'object'; fields: { name: string; type: ValueType }[]; example: unknown }
    | { kind: 'value'; type: ValueType; example: unknown };

/**
 * Every field the context rows have, in order of first appearance, typed by
 * its first non-null value. Taking only the first row's fields lost the others
 * whenever that row was sparser than the rest. A file of bare values (numbers,
 * strings) generates bare values.
 */
export function describeContextRows(contextRows: readonly unknown[]): RowShape {
    const objects = contextRows.filter(row => row !== null && typeof row === 'object' && !Array.isArray(row)) as { [key: string]: unknown }[];
    if (objects.length === 0) {
        const sample = contextRows.find(row => row !== null && row !== undefined);
        return { kind: 'value', type: typeOf(sample), example: sample === undefined ? null : sample };
    }
    const fields: { name: string; type: ValueType }[] = [];
    const seen = new Map<string, { name: string; type: ValueType; typed: boolean }>();
    objects.forEach(row => {
        Object.keys(row).forEach(name => {
            let field = seen.get(name);
            if (!field) {
                field = { name, type: 'string', typed: false };
                seen.set(name, field);
                fields.push(field);
            }
            if (!field.typed && row[name] !== null && row[name] !== undefined) {
                field.type = typeOf(row[name]);
                field.typed = true;
            }
        });
    });
    const example = objects.reduce((best, row) => (Object.keys(row).length > Object.keys(best).length ? row : best));
    return { kind: 'object', fields: fields.map(({ name, type }) => ({ name, type })), example };
}

function coerce(type: ValueType, value: unknown): unknown {
    if (typeof value !== 'string') {
        return value;
    }
    if (type === 'number') {
        // "n/a" stays "n/a": turning it into null would lose what the model said
        const number = parseModelNumber(value.trim());
        return number === null ? value : number;
    }
    if (type === 'boolean') {
        const lower = value.trim().toLowerCase();
        return lower === 'true' ? true : lower === 'false' ? false : value;
    }
    return value;
}

/**
 * A generated row shaped like the context rows: their fields (missing ones
 * null, extra ones dropped - the prompt asks for exactly these) with numbers
 * and booleans the model quoted unquoted. Null if it isn't a row of that kind.
 */
export function fitGeneratedRow(generated: unknown, shape: RowShape): unknown {
    if (shape.kind === 'value') {
        return coerce(shape.type, generated);
    }
    if (generated === null || typeof generated !== 'object' || Array.isArray(generated)) {
        return null;
    }
    const source = generated as { [key: string]: unknown };
    const fitted: { [key: string]: unknown } = {};
    shape.fields.forEach(({ name, type }) => {
        fitted[name] = Object.prototype.hasOwnProperty.call(source, name) ? coerce(type, source[name]) : null;
    });
    return fitted;
}

/** Index of the bracket closing the one at `start`, skipping strings; -1 if none. */
function matchingBracket(text: string, start: number): number {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (ch === '\\') {
                i++;
            } else if (ch === '"') {
                inString = false;
            }
        } else if (ch === '"') {
            inString = true;
        } else if (ch === '[') {
            depth++;
        } else if (ch === ']') {
            depth--;
            if (depth === 0) {
                return i;
            }
        }
    }
    return -1;
}

/**
 * The rows in a model's answer. Models wrap them in prose and code fences
 * ("Here are [2] rows: ```json [...] ```"), or answer one JSON value per line,
 * so this tries the whole answer, then each bracketed array in it, then the
 * answer as JSONL. With several arrays it prefers one with `rowCount` rows.
 * Null when nothing in the answer is a list of rows of the wanted kind.
 */
export function extractGeneratedRows(text: string, wantObjects: boolean, rowCount: number): unknown[] | null {
    const isRow = (item: unknown) => !wantObjects || (item !== null && typeof item === 'object' && !Array.isArray(item));
    const candidates: unknown[][] = [];
    const consider = (value: unknown) => {
        if (Array.isArray(value) && value.length > 0 && value.every(isRow)) {
            candidates.push(value);
        }
    };

    const unfenced = text.replace(/```[a-zA-Z]*\s*\n?/g, '').trim();
    try {
        consider(JSON.parse(unfenced));
    } catch {
        // Not a bare JSON value; look inside it
    }

    if (candidates.length === 0) {
        // Every bracketed array in the prose, not just the first: "[2] rows: [...]"
        for (let start = unfenced.indexOf('['); start !== -1; ) {
            const end = matchingBracket(unfenced, start);
            let next = start + 1;
            if (end !== -1) {
                try {
                    consider(JSON.parse(unfenced.slice(start, end + 1)));
                    next = end + 1; // Its own nested arrays aren't candidates
                } catch {
                    // "[really]" isn't JSON; keep looking
                }
            }
            start = unfenced.indexOf('[', next);
        }
    }

    if (candidates.length === 0) {
        const lines = unfenced.split('\n').map(line => line.trim()).filter(Boolean);
        try {
            consider(lines.map(line => JSON.parse(line)));
        } catch {
            // Not JSONL either
        }
    }

    if (candidates.length === 0) {
        return null;
    }
    return candidates.find(candidate => candidate.length === rowCount) || candidates[0];
}
