/**
 * Column sorting with value-type autodetection.
 *
 * JSONL columns are untyped, so sorting "correctly" means first working out what
 * a column holds. We sample the column, classify each value (timestamp, currency,
 * number, boolean, string) and then sort with a comparator for the dominant type.
 * That way "$1,200.00" sorts above "$99.00" and "2024-03-01T10:00:00Z" sorts after
 * "2024-02-28", instead of both falling back to lexicographic order.
 */

import { JsonRow } from './types';
import { getNestedValue } from './utils';

export type SortDirection = 'asc' | 'desc';
export type ColumnType = 'timestamp' | 'currency' | 'number' | 'boolean' | 'string';

/** Human-readable label for the detected type, shown in the column context menu. */
export const COLUMN_TYPE_LABELS: Record<ColumnType, string> = {
    timestamp: 'Timestamp',
    currency: 'Currency',
    number: 'Number',
    boolean: 'Boolean',
    string: 'Text'
};

// Symbols that mark a string as currency. Multi-character entries must come
// first so "R$" wins over a bare "$".
const CURRENCY_SYMBOLS = /R\$|NT\$|C\$|A\$|HK\$|US\$|[$€£¥₹₽₩₪₺₴₦฿₫₱¢]/g;

// Only well-known ISO 4217 codes count, so "KEY 123" isn't read as currency.
const CURRENCY_CODES = new Set([
    'USD', 'EUR', 'GBP', 'JPY', 'CNY', 'CHF', 'CAD', 'AUD', 'NZD', 'SEK', 'NOK', 'DKK',
    'PLN', 'CZK', 'HUF', 'RUB', 'INR', 'BRL', 'MXN', 'ZAR', 'KRW', 'SGD', 'HKD', 'TRY',
    'ILS', 'AED', 'SAR', 'THB', 'IDR', 'MYR', 'PHP', 'VND', 'UAH', 'NGN', 'ARS', 'CLP',
    'COP', 'PEN', 'TWD', 'RON', 'BGN', 'HRK', 'ISK', 'EGP', 'PKR', 'BDT', 'KES'
]);

// Date shapes we accept before handing the string to Date.parse. The guard matters:
// Date.parse('5') happily returns a date, which would make any short string a
// "timestamp". Anything not matching one of these is not treated as a date.
const TIMESTAMP_PATTERNS: RegExp[] = [
    // 2024-01-15, 2024-01-15T10:30:00.123Z, 2024-01-15 10:30:00+01:00
    /^\d{4}-\d{2}-\d{2}(?:[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?\s*(?:Z|[+-]\d{2}:?\d{2})?)?$/i,
    // 2024/01/15 10:30
    /^\d{4}\/\d{1,2}\/\d{1,2}(?:[T ]\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AaPp]\.?[Mm]\.?)?)?$/,
    // 01/15/2024 10:30 PM (month/day/year, matching JS Date semantics)
    /^\d{1,2}\/\d{1,2}\/\d{4}(?:[T ]\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AaPp]\.?[Mm]\.?)?)?$/,
    // 15 Jan 2024 / Jan 15, 2024 / January 15 2024 10:30:00 GMT
    /^(?:\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{4}|[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})(?:\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AaPp]\.?[Mm]\.?)?)?(?:\s+(?:GMT|UTC|Z|[+-]\d{4}))?$/,
    // Mon, 15 Jan 2024 10:30:00 GMT (RFC 2822)
    /^[A-Za-z]{3},?\s+\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:GMT|UTC|[+-]\d{4}|[A-Z]{2,5})?$/
];

// Below this magnitude a raw epoch number is read as seconds rather than
// milliseconds (1e11 ms is 1973; 1e11 s is the year 5138).
const EPOCH_SECONDS_CUTOFF = 1e11;

/**
 * Parse a number that may use thousands separators, in either US (1,234.56) or
 * European (1.234,56) convention.
 *
 * When both separators appear the right-most one is the decimal point. With only
 * one separator we fall back to a heuristic: a single comma followed by exactly
 * three digits is grouping ("1,234"), otherwise it is a decimal comma ("1,23");
 * repeated dots are grouping ("1.234.567"), a single dot is a decimal point.
 * "1,234"-style values that actually meant 1.234 are the known ambiguous case.
 *
 * Grouping has to look like grouping: three-digit groups after a first group
 * of one to three digits (or Indian lakh grouping, "12,34,567"). Anything else
 * with repeated separators - a version "1.10.0", an address "10.0.0.1" - is not
 * a number, so such columns sort as text, where natural ordering handles them.
 */
export function parseGroupedNumber(text: string): number | null {
    if (!/\d/.test(text) || !/^[\d.,]+$/.test(text)) {
        return null;
    }

    const lastComma = text.lastIndexOf(',');
    const lastDot = text.lastIndexOf('.');
    let normalized: string;

    if (lastComma >= 0 && lastDot >= 0) {
        const decimalSep = lastComma > lastDot ? ',' : '.';
        const groupSep = decimalSep === ',' ? '.' : ',';
        const decimalAt = text.lastIndexOf(decimalSep);
        const integerPart = text.slice(0, decimalAt);
        const fraction = text.slice(decimalAt + 1);
        if (!isGrouped(integerPart, groupSep) || !/^\d*$/.test(fraction)) {
            return null;
        }
        normalized = integerPart.split(groupSep).join('') + '.' + fraction;
    } else if (lastComma >= 0) {
        const parts = text.split(',');
        if (parts.length > 2) {
            if (!isGrouped(text, ',')) {
                return null;
            }
            normalized = parts.join('');
        } else {
            normalized = parts[1].length === 3 && isGrouped(text, ',') ? parts.join('') : parts.join('.');
        }
    } else if (lastDot >= 0) {
        const parts = text.split('.');
        if (parts.length > 2) {
            if (!isGrouped(text, '.')) {
                return null;
            }
            normalized = parts.join('');
        } else {
            normalized = text;
        }
    } else {
        normalized = text;
    }

    const value = Number(normalized);
    return Number.isFinite(value) ? value : null;
}

// Whether `text` is digits grouped by `separator` the way people write numbers
function isGrouped(text: string, separator: string): boolean {
    const groups = text.split(separator);
    const rest = groups.slice(1);
    if (rest.length === 0) {
        return /^\d+$/.test(groups[0]);
    }
    if (/^\d{1,3}$/.test(groups[0]) && rest.every(group => /^\d{3}$/.test(group))) {
        return true;
    }
    // Indian grouping: 12,34,56,789
    return separator === ',' &&
        /^\d{1,2}$/.test(groups[0]) &&
        rest.slice(0, -1).every(group => /^\d{2}$/.test(group)) &&
        /^\d{3}$/.test(rest[rest.length - 1]);
}

/**
 * Parse a currency string such as "$1,234.56", "1.234,56 €", "USD 99", or the
 * accounting negative "($1,234.00)". Returns null when the string carries no
 * currency marker — a bare "1234" is a number, not currency.
 */
export function parseCurrency(raw: string): number | null {
    let text = raw.trim();
    if (!text) {
        return null;
    }

    let negative = false;
    if (text.startsWith('(') && text.endsWith(')')) {
        negative = true;
        text = text.slice(1, -1).trim();
    }

    let hasCurrencyMarker = false;

    const leadingCode = text.match(/^([A-Za-z]{3})\s*/);
    if (leadingCode && CURRENCY_CODES.has(leadingCode[1].toUpperCase())) {
        hasCurrencyMarker = true;
        text = text.slice(leadingCode[0].length);
    }

    const trailingCode = text.match(/\s*([A-Za-z]{3})$/);
    if (trailingCode && CURRENCY_CODES.has(trailingCode[1].toUpperCase())) {
        hasCurrencyMarker = true;
        text = text.slice(0, text.length - trailingCode[0].length);
    }

    CURRENCY_SYMBOLS.lastIndex = 0;
    if (CURRENCY_SYMBOLS.test(text)) {
        hasCurrencyMarker = true;
        text = text.replace(CURRENCY_SYMBOLS, '');
    }

    if (!hasCurrencyMarker) {
        return null;
    }

    // Drop ordinary, non-breaking and narrow no-break spaces used as separators
    text = text.replace(/[\s\u00a0\u202f]/g, '');

    if (text.startsWith('-')) {
        negative = !negative;
        text = text.slice(1);
    } else if (text.startsWith('+')) {
        text = text.slice(1);
    }

    const value = parseGroupedNumber(text);
    if (value === null) {
        return null;
    }
    return negative ? -value : value;
}

/**
 * Parse a plain numeric string, including grouped ("1,234.5"), signed,
 * exponential and percentage forms. Percentages keep their face value, so 5%
 * sorts below 12%.
 */
export function parseNumericString(raw: string): number | null {
    let text = raw.trim();
    if (!text) {
        return null;
    }

    if (text.endsWith('%')) {
        text = text.slice(0, -1).trim();
    }

    let sign = 1;
    if (text.startsWith('-')) {
        sign = -1;
        text = text.slice(1);
    } else if (text.startsWith('+')) {
        text = text.slice(1);
    }

    if (/^\d+(?:\.\d+)?[eE][-+]?\d+$/.test(text)) {
        const exponential = Number(text);
        return Number.isFinite(exponential) ? sign * exponential : null;
    }

    const value = parseGroupedNumber(text);
    return value === null ? null : sign * value;
}

/**
 * Parse a timestamp string into epoch milliseconds, or null when the string
 * isn't one of the recognized date shapes.
 */
export function parseTimestamp(raw: string): number | null {
    const text = raw.trim();
    if (!text || !TIMESTAMP_PATTERNS.some(pattern => pattern.test(text))) {
        return null;
    }
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? parsed : null;
}

/** Classify a single cell value. 'empty' marks null/undefined/blank cells. */
export function detectValueType(value: any): ColumnType | 'empty' {
    if (value === null || value === undefined) {
        return 'empty';
    }
    if (typeof value === 'boolean') {
        return 'boolean';
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? 'number' : 'empty';
    }
    if (typeof value !== 'string') {
        return 'string';
    }

    const text = value.trim();
    if (!text) {
        return 'empty';
    }
    if (parseCurrency(text) !== null) {
        return 'currency';
    }
    if (parseTimestamp(text) !== null) {
        return 'timestamp';
    }
    if (parseNumericString(text) !== null) {
        return 'number';
    }
    return 'string';
}

const DEFAULT_SAMPLE_SIZE = 200;
// Share of non-empty sampled values that must agree before we trust a type
const TYPE_CONFIDENCE = 0.6;

/**
 * Work out what a column holds by sampling its values. Rows are sampled evenly
 * across the dataset so a file that changes shape halfway through still gets a
 * representative read. Falls back to 'string' when no type is clearly dominant.
 */
export function detectColumnType(rows: JsonRow[], columnPath: string, sampleSize: number = DEFAULT_SAMPLE_SIZE): ColumnType {
    if (!Array.isArray(rows) || rows.length === 0) {
        return 'string';
    }

    const step = Math.max(1, Math.floor(rows.length / sampleSize));
    const counts: { [key: string]: number } = {};
    let considered = 0;

    for (let i = 0; i < rows.length; i += step) {
        const type = detectValueType(getNestedValue(rows[i], columnPath));
        if (type === 'empty') {
            continue;
        }
        counts[type] = (counts[type] || 0) + 1;
        considered++;
    }

    if (considered === 0) {
        return 'string';
    }

    const currency = counts.currency || 0;
    const number = counts.number || 0;

    // Numbers and currency amounts both sort numerically, so a column mixing
    // "1200" with "$1,200.00" should still sort as money rather than as text.
    if ((currency + number) / considered >= TYPE_CONFIDENCE && currency + number > 0) {
        // A currency marker anywhere in a numeric column is a strong signal:
        // amounts are routinely stored as a mix of 1200 and "$1,200.00"
        const numericWinner: ColumnType = currency > 0 ? 'currency' : 'number';
        const otherBest = Object.keys(counts)
            .filter(type => type !== 'currency' && type !== 'number')
            .reduce((best, type) => Math.max(best, counts[type]), 0);
        if (currency + number >= otherBest) {
            return numericWinner;
        }
    }

    let winner: ColumnType = 'string';
    let winnerCount = 0;
    (Object.keys(counts) as ColumnType[]).forEach(type => {
        if (counts[type] > winnerCount) {
            winner = type;
            winnerCount = counts[type];
        }
    });

    return winnerCount / considered >= TYPE_CONFIDENCE ? winner : 'string';
}

interface SortKey {
    /**
     * 0 = parsed as the column's type, 1 = present but not parseable as that
     * type, 2 = empty. Rank always sorts ascending, so unparseable values sit
     * below real ones and blanks stay at the bottom in both directions.
     */
    rank: number;
    numeric: number;
    text: string;
    isNumeric: boolean;
}

const EMPTY_KEY: SortKey = { rank: 2, numeric: 0, text: '', isNumeric: false };

function stringifyValue(value: any): string {
    if (typeof value === 'string') {
        return value;
    }
    try {
        return JSON.stringify(value) ?? String(value);
    } catch {
        return String(value);
    }
}

function coerceNumeric(value: any, type: ColumnType): number | null {
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            return null;
        }
        // A bare number in a timestamp column is an epoch value
        if (type === 'timestamp') {
            return Math.abs(value) < EPOCH_SECONDS_CUTOFF ? value * 1000 : value;
        }
        return value;
    }
    if (typeof value !== 'string') {
        return null;
    }
    if (type === 'timestamp') {
        return parseTimestamp(value);
    }
    // Number and currency columns accept both forms, so a stray "$5" in a
    // number column (or a bare 5 in a money column) still sorts numerically
    const currency = parseCurrency(value);
    return currency !== null ? currency : parseNumericString(value);
}

function toSortKey(value: any, type: ColumnType): SortKey {
    if (value === null || value === undefined) {
        return EMPTY_KEY;
    }
    if (typeof value === 'string' && value.trim() === '') {
        return EMPTY_KEY;
    }

    if (type === 'boolean') {
        if (typeof value === 'boolean') {
            return { rank: 0, numeric: value ? 1 : 0, text: '', isNumeric: true };
        }
    } else if (type !== 'string') {
        const numeric = coerceNumeric(value, type);
        if (numeric !== null) {
            return { rank: 0, numeric, text: '', isNumeric: true };
        }
    } else {
        return { rank: 0, numeric: 0, text: stringifyValue(value), isNumeric: false };
    }

    // Present, but not the column's type: keep it comparable, just ranked lower
    return { rank: 1, numeric: 0, text: stringifyValue(value), isNumeric: false };
}

function compareText(a: string, b: string): number {
    // numeric collation gives natural order, so item2 sorts before item10
    const collated = a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
    if (collated !== 0) {
        return collated;
    }
    return a < b ? -1 : a > b ? 1 : 0;
}

function compareKeys(a: SortKey, b: SortKey, direction: SortDirection): number {
    if (a.rank !== b.rank) {
        return a.rank - b.rank;
    }
    const sign = direction === 'desc' ? -1 : 1;
    if (a.isNumeric && b.isNumeric) {
        if (a.numeric === b.numeric) {
            return 0;
        }
        return (a.numeric < b.numeric ? -1 : 1) * sign;
    }
    return compareText(a.text, b.text) * sign;
}

/**
 * Sort rows by a column while carrying an index array along, so callers keep the
 * mapping from displayed position back to the original row index.
 *
 * Blank cells always sort last, in both directions. The sort is stable: rows
 * that compare equal keep their previous relative order.
 */
export function sortRowsWithIndices(
    rows: JsonRow[],
    indices: number[],
    columnPath: string,
    direction: SortDirection,
    columnType?: ColumnType
): { sortedRows: JsonRow[]; sortedIndices: number[] } {
    if (!Array.isArray(rows) || rows.length === 0) {
        return { sortedRows: rows || [], sortedIndices: indices || [] };
    }

    const type = columnType || detectColumnType(rows, columnPath);
    const hasIndices = Array.isArray(indices) && indices.length === rows.length;

    const entries = rows.map((row, position) => ({
        row,
        index: hasIndices ? indices[position] : position,
        position,
        key: toSortKey(getNestedValue(row, columnPath), type)
    }));

    entries.sort((a, b) => compareKeys(a.key, b.key, direction) || a.position - b.position);

    return {
        sortedRows: entries.map(entry => entry.row),
        sortedIndices: entries.map(entry => entry.index)
    };
}

/** Sort rows by a column, returning a new array. */
export function sortRows(rows: JsonRow[], columnPath: string, direction: SortDirection, columnType?: ColumnType): JsonRow[] {
    return sortRowsWithIndices(rows, [], columnPath, direction, columnType).sortedRows;
}
