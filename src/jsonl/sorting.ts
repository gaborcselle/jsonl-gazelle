/**
 * Column sorting with value-type autodetection.
 *
 * JSONL columns are untyped, so sorting "correctly" means first working out what
 * a column holds. We sample the column, classify each value (timestamp, currency,
 * number, boolean, string) and then sort with a comparator for the dominant type.
 * That way "$1,200.00" sorts above "$99.00" and "2024-03-01T10:00:00Z" sorts after
 * "2024-02-28", instead of both falling back to lexicographic order.
 *
 * Some values only make sense next to the rest of their column: "1.500" is
 * fifteen hundred where the other values are written "1.234,56", and "3.10" is
 * a version where the others read "3.9". So a sort reads the whole column for
 * those conventions before it builds its keys (readColumnKeys).
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
//
// Date.parse reads a timestamp that names no zone in the viewer's local time -
// yet an ISO date on its own as UTC - so the order of a sort depended on where
// the viewer was: west of Greenwich "2024-01-15 20:00:00" landed after
// "2024-01-16", and a time inside a daylight-saving gap came out an hour late.
// Such timestamps are read as UTC instead. A shape's `zone` group captures the
// zone a timestamp names, and `utcSuffix` pins one that names none.
interface TimestampShape {
    pattern: RegExp;
    utcSuffix: string;
}

const TIMESTAMP_SHAPES: TimestampShape[] = [
    // 2024-01-15, the one form Date.parse already reads as UTC
    { pattern: /^\d{4}-\d{2}-\d{2}$/, utcSuffix: '' },
    // 2024-01-15T10:30:00.123Z, 2024-01-15 10:30:00+01:00
    { pattern: /^\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?\s*(?<zone>Z|[+-]\d{2}:?\d{2})?$/i, utcSuffix: 'Z' },
    // 2024/01/15 10:30
    { pattern: /^\d{4}\/\d{1,2}\/\d{1,2}(?:[T ]\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AaPp]\.?[Mm]\.?)?)?$/, utcSuffix: ' UTC' },
    // 01/15/2024 10:30 PM (month/day/year, matching JS Date semantics)
    { pattern: /^\d{1,2}\/\d{1,2}\/\d{4}(?:[T ]\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AaPp]\.?[Mm]\.?)?)?$/, utcSuffix: ' UTC' },
    // 15 Jan 2024 / Jan 15, 2024 / January 15 2024 10:30:00 GMT
    {
        pattern: /^(?:\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{4}|[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})(?:\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AaPp]\.?[Mm]\.?)?)?(?:\s+(?<zone>GMT|UTC|Z|[+-]\d{4}))?$/,
        utcSuffix: ' UTC'
    },
    // Mon, 15 Jan 2024 10:30:00 GMT (RFC 2822)
    {
        pattern: /^[A-Za-z]{3},?\s+\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?<zone>GMT|UTC|[+-]\d{4}|[A-Z]{2,5})?$/,
        utcSuffix: ' UTC'
    }
];

// Below this magnitude a raw epoch number is read as seconds rather than
// milliseconds (1e11 ms is 1973; 1e11 s is the year 5138).
const EPOCH_SECONDS_CUTOFF = 1e11;

// The decimal mark a number's text shows its writer used
type DecimalMark = '.' | ',';

// A number read from text. Integers too large for a double to hold exactly
// are bigints: the 19-digit IDs some APIs emit as strings all round to the
// same double, so they would tie and keep file order in both directions.
// `<` and `>` compare a bigint with a number exactly.
type ExactNumber = number | bigint;

interface NumberReading {
    value: ExactNumber;
    // The decimal mark the text proves, or null when it has no separator or
    // reads either way ("1.500", "1,500")
    mark: DecimalMark | null;
}

/**
 * Parse a number that may use thousands separators, in either US (1,234.56) or
 * European (1.234,56) convention. Returns the nearest double; sorting reads
 * the exact value and the column's convention through readGroupedNumber.
 */
export function parseGroupedNumber(text: string): number | null {
    const reading = readGroupedNumber(text, false);
    return reading === null ? null : Number(reading.value);
}

/**
 * Read digits written with thousands separators and a decimal mark, noting
 * which mark the text proves its writer used.
 *
 * When both separators appear the right-most one is the decimal mark, and
 * repeated separators are grouping. What's left is one separator before exactly
 * three digits, where "1,500" and "1.500" each read either way. In a column
 * that writes decimal commas (`commaDecimal`) both are read that way: "1,500" is
 * one and a half, "1.500" fifteen hundred. Otherwise US habit decides: "1,500"
 * is grouping and "1.500" a decimal point. Any other single comma is a decimal
 * comma ("1,23"), any other single dot a decimal point ("12.5", "0.500").
 *
 * Grouping has to look like grouping: three-digit groups after a first group
 * of one to three digits (or Indian lakh grouping, "12,34,567"). Anything else
 * with repeated separators - a version "1.10.0", an address "10.0.0.1" - is not
 * a number, so such columns sort as text, where natural ordering handles them.
 */
function readGroupedNumber(text: string, commaDecimal: boolean): NumberReading | null {
    if (!/\d/.test(text) || !/^[\d.,]+$/.test(text)) {
        return null;
    }

    const lastComma = text.lastIndexOf(',');
    const lastDot = text.lastIndexOf('.');
    let normalized: string;
    let mark: DecimalMark | null;

    if (lastComma >= 0 && lastDot >= 0) {
        mark = lastComma > lastDot ? ',' : '.';
        const groupSep = mark === ',' ? '.' : ',';
        const decimalAt = text.lastIndexOf(mark);
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
            mark = '.';
        } else if (parts[1].length === 3 && isGrouped(text, ',')) {
            normalized = commaDecimal ? parts.join('.') : parts.join('');
            mark = null;
        } else {
            normalized = parts.join('.');
            mark = ',';
        }
    } else if (lastDot >= 0) {
        const parts = text.split('.');
        if (parts.length > 2) {
            if (!isGrouped(text, '.')) {
                return null;
            }
            normalized = parts.join('');
            mark = ',';
        } else if (parts[1].length === 3 && /^[1-9]\d{0,2}$/.test(parts[0])) {
            normalized = commaDecimal ? parts.join('') : text;
            mark = null;
        } else {
            normalized = text;
            mark = '.';
        }
    } else {
        normalized = text;
        mark = null;
    }

    const value = toExactNumber(normalized);
    return value === null ? null : { value, mark };
}

// The value of plain digits with an optional "." fraction, as a bigint when
// they are an integer past what a double holds exactly
function toExactNumber(normalized: string): ExactNumber | null {
    const value = Number(normalized);
    if (!Number.isFinite(value)) {
        return null;
    }
    if (Number.isSafeInteger(value) || !Number.isInteger(value)) {
        return value;
    }
    const integer = normalized.replace(/\.0*$/, '');
    return /^\d+$/.test(integer) ? BigInt(integer) : value;
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
    const reading = readCurrency(raw, false);
    return reading === null ? null : Number(reading.value);
}

function readCurrency(raw: string, commaDecimal: boolean): NumberReading | null {
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

    const reading = readGroupedNumber(text, commaDecimal);
    if (reading === null) {
        return null;
    }
    return negative ? { value: -reading.value, mark: reading.mark } : reading;
}

/**
 * Parse a plain numeric string, including grouped ("1,234.5"), signed,
 * exponential and percentage forms. Percentages keep their face value, so 5%
 * sorts below 12%.
 */
export function parseNumericString(raw: string): number | null {
    const reading = readNumericString(raw, false);
    return reading === null ? null : Number(reading.value);
}

function readNumericString(raw: string, commaDecimal: boolean): NumberReading | null {
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
        return Number.isFinite(exponential) ? { value: sign * exponential, mark: null } : null;
    }

    const reading = readGroupedNumber(text, commaDecimal);
    if (reading === null) {
        return null;
    }
    return sign < 0 ? { value: -reading.value, mark: reading.mark } : reading;
}

/**
 * Parse a timestamp string into epoch milliseconds, or null when the string
 * isn't one of the recognized date shapes. One that names no zone is read as
 * UTC, so the result is the same in every timezone.
 */
export function parseTimestamp(raw: string): number | null {
    const text = raw.trim();
    for (const shape of TIMESTAMP_SHAPES) {
        const match = shape.pattern.exec(text);
        if (match) {
            const zone = match.groups?.zone;
            // "PM" fits the RFC 2822 zone slot, but it is a time of day
            const namesZone = !!zone && !/^[AP]M$/.test(zone);
            const parsed = Date.parse(namesZone ? text : text + shape.utcSuffix);
            return Number.isFinite(parsed) ? parsed : null;
        }
    }
    return null;
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
    const sampled: any[] = [];

    for (let i = 0; i < rows.length; i += step) {
        const value = getNestedValue(rows[i], columnPath);
        const type = detectValueType(value);
        if (type === 'empty') {
            continue;
        }
        counts[type] = (counts[type] || 0) + 1;
        sampled.push(value);
    }

    if (sampled.length === 0) {
        return 'string';
    }

    const type = dominantType(counts, sampled.length);
    // Versions parse as numbers, but sort as text (see looksLikeVersions)
    return type === 'number' && looksLikeVersions(sampled) ? 'string' : type;
}

function dominantType(counts: { [key: string]: number }, considered: number): ColumnType {
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

/**
 * Whether a column that parses as numbers holds two-part versions instead:
 * "3.10" beside "3.9" means minor version ten, not three point one, since
 * nobody writing decimals pads one value with a trailing zero and leaves the
 * next at a single place. So: every value is a "major.minor" string, at least
 * one has a multi-digit fraction ending in zero and another a one-digit
 * fraction. A fraction with a leading zero ("3.05") is a decimal and rules the
 * reading out, so consistently padded prices ("3.10", "12.50") and plain
 * decimals ("0.5", "0.25") stay numbers. Versions sort as text, whose natural
 * ordering compares them part by part: 3.9 < 3.10 < 3.11.
 */
function looksLikeVersions(values: any[]): boolean {
    let oneDigit = false;
    let trailingZero = false;
    for (const value of values) {
        if (value === null || value === undefined) {
            continue;
        }
        if (typeof value !== 'string') {
            return false;
        }
        const text = value.trim();
        if (!text) {
            continue;
        }
        const fraction = /^\d+\.(\d+)$/.exec(text)?.[1];
        if (fraction === undefined || (fraction.length > 1 && fraction.startsWith('0'))) {
            return false;
        }
        if (fraction.length === 1) {
            oneDigit = true;
        } else if (fraction.endsWith('0')) {
            trailingZero = true;
        }
    }
    return oneDigit && trailingZero;
}

// How a sort reads one column's values, settled from the column as a whole
interface ColumnReading {
    type: ColumnType;
    // Ambiguous "1.500" and "1,500" are read with a decimal comma (see readGroupedNumber)
    commaDecimal: boolean;
}

interface SortKey {
    /**
     * 0 = parsed as the column's type, 1 = present but not parseable as that
     * type, 2 = empty. Rank always sorts ascending, so unparseable values sit
     * below real ones and blanks stay at the bottom in both directions.
     */
    rank: number;
    // Set for keys that compare as numbers, null for ones that compare as text
    numeric: ExactNumber | null;
    text: string;
}

const EMPTY_KEY: SortKey = { rank: 2, numeric: null, text: '' };

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

// `marks` collects the decimal marks the column's values prove (see readColumnKeys)
function coerceNumeric(value: any, reading: ColumnReading, marks?: Set<DecimalMark>): ExactNumber | null {
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            return null;
        }
        // A bare number in a timestamp column is an epoch value
        if (reading.type === 'timestamp') {
            return Math.abs(value) < EPOCH_SECONDS_CUTOFF ? value * 1000 : value;
        }
        return value;
    }
    if (typeof value !== 'string') {
        return null;
    }
    if (reading.type === 'timestamp') {
        return parseTimestamp(value);
    }
    // Number and currency columns accept both forms, so a stray "$5" in a
    // number column (or a bare 5 in a money column) still sorts numerically
    const parsed = readCurrency(value, reading.commaDecimal) || readNumericString(value, reading.commaDecimal);
    if (parsed === null) {
        return null;
    }
    if (parsed.mark !== null) {
        marks?.add(parsed.mark);
    }
    return parsed.value;
}

function toSortKey(value: any, reading: ColumnReading, marks?: Set<DecimalMark>): SortKey {
    if (value === null || value === undefined) {
        return EMPTY_KEY;
    }
    if (typeof value === 'string' && value.trim() === '') {
        return EMPTY_KEY;
    }

    if (reading.type === 'string') {
        // Everything belongs in a text column, but its real numbers compare as
        // numbers: as text, -5 sorted before -10 and 2.5 before 2.25
        return Number.isFinite(value)
            ? { rank: 0, numeric: value, text: '' }
            : { rank: 0, numeric: null, text: stringifyValue(value) };
    }
    if (reading.type === 'boolean') {
        if (typeof value === 'boolean') {
            return { rank: 0, numeric: value ? 1 : 0, text: '' };
        }
    } else {
        const numeric = coerceNumeric(value, reading, marks);
        if (numeric !== null) {
            return { rank: 0, numeric, text: '' };
        }
    }

    // Present, but not the column's type: keep it comparable, just ranked
    // lower. A real number there still compares as a number.
    return Number.isFinite(value)
        ? { rank: 1, numeric: value, text: '' }
        : { rank: 1, numeric: null, text: stringifyValue(value) };
}

/**
 * Sort keys for one column's values, read the way the column as a whole is
 * written. A 'number' column of versions is read as text (looksLikeVersions).
 * A number or currency column whose unambiguous values all write a decimal
 * comma ("1.234,56", "12,50", "2.000.000") reads its ambiguous "1.500" that way
 * too; with no evidence, or evidence both ways, the US reading stands. The
 * marks are collected while building the keys, so only a decimal-comma column
 * pays for a second pass.
 */
function readColumnKeys(values: any[], columnType: ColumnType): { reading: ColumnReading; keys: SortKey[] } {
    const type = columnType === 'number' && looksLikeVersions(values) ? 'string' : columnType;
    const marks = new Set<DecimalMark>();
    let reading: ColumnReading = { type, commaDecimal: false };
    let keys = values.map(value => toSortKey(value, reading, marks));
    if (marks.has(',') && !marks.has('.')) {
        reading = { type, commaDecimal: true };
        keys = values.map(value => toSortKey(value, reading));
    }
    return { reading, keys };
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
    if (a.numeric !== null && b.numeric !== null) {
        // Not ===: a bigint never equals a number, but < and > compare them exactly
        if (a.numeric < b.numeric) {
            return -sign;
        }
        return a.numeric > b.numeric ? sign : 0;
    }
    if (a.numeric !== null || b.numeric !== null) {
        // Numbers among words (a text column, or stray values in one of another
        // type) come first, as in a spreadsheet, and last when descending
        return (a.numeric !== null ? -1 : 1) * sign;
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
    const { keys } = readColumnKeys(rows.map(row => getNestedValue(row, columnPath)), type);

    const entries = rows.map((row, position) => ({
        row,
        index: hasIndices ? indices[position] : position,
        position,
        key: keys[position]
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

/**
 * The order sortRowsWithIndices puts rows in, as a comparator: negative when
 * `a` sorts before `b`, zero for a tie (which the sort leaves in file order).
 * How the column is written is read from `rows`, so compare rows from them.
 */
export function createRowComparator(rows: JsonRow[], columnPath: string, direction: SortDirection, columnType?: ColumnType) {
    const columnRows = Array.isArray(rows) ? rows : [];
    const type = columnType || detectColumnType(columnRows, columnPath);
    const { reading } = readColumnKeys(columnRows.map(row => getNestedValue(row, columnPath)), type);
    return (a: JsonRow, b: JsonRow): number => compareKeys(
        toSortKey(getNestedValue(a, columnPath), reading),
        toSortKey(getNestedValue(b, columnPath), reading),
        direction
    );
}
