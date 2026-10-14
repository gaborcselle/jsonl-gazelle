const assert = require('assert');
const {
    parseGroupedNumber,
    parseCurrency,
    parseNumericString,
    parseTimestamp,
    detectValueType,
    detectColumnType,
    sortRows,
    sortRowsWithIndices,
    createRowComparator
} = require('../out/jsonl/sorting');

// --- grouped numbers -------------------------------------------------------

assert.strictEqual(parseGroupedNumber('1234'), 1234);
assert.strictEqual(parseGroupedNumber('1,234.56'), 1234.56);      // US
assert.strictEqual(parseGroupedNumber('1.234,56'), 1234.56);      // European
assert.strictEqual(parseGroupedNumber('1,234,567.89'), 1234567.89);
assert.strictEqual(parseGroupedNumber('1.234.567'), 1234567);     // repeated dots are grouping
assert.strictEqual(parseGroupedNumber('1,234'), 1234);            // 3-digit group
assert.strictEqual(parseGroupedNumber('1,23'), 1.23);             // decimal comma
assert.strictEqual(parseGroupedNumber('12.5'), 12.5);
assert.strictEqual(parseGroupedNumber('abc'), null);
assert.strictEqual(parseGroupedNumber('12,34,567'), 1234567);     // Indian grouping
// Repeated separators that aren't three-digit groups are not numbers
assert.strictEqual(parseGroupedNumber('1.2.3'), null);            // a version
assert.strictEqual(parseGroupedNumber('10.0.0.1'), null);         // an IP address
assert.strictEqual(parseGroupedNumber('1,2,3'), null);
assert.strictEqual(parseGroupedNumber('1,23.4'), null);

// --- currency --------------------------------------------------------------

assert.strictEqual(parseCurrency('$1,234.56'), 1234.56);
assert.strictEqual(parseCurrency('$99'), 99);
assert.strictEqual(parseCurrency('1.234,56 €'), 1234.56);
assert.strictEqual(parseCurrency('€1.234,56'), 1234.56);
assert.strictEqual(parseCurrency('£0.99'), 0.99);
assert.strictEqual(parseCurrency('¥1200'), 1200);
assert.strictEqual(parseCurrency('₹45,000'), 45000);
assert.strictEqual(parseCurrency('USD 1,234.56'), 1234.56);
assert.strictEqual(parseCurrency('1234.56 USD'), 1234.56);
assert.strictEqual(parseCurrency('R$ 1.500,00'), 1500);
assert.strictEqual(parseCurrency('-$42.50'), -42.5);
assert.strictEqual(parseCurrency('$-42.50'), -42.5);
assert.strictEqual(parseCurrency('($1,234.00)'), -1234);          // accounting negative
assert.strictEqual(parseCurrency('1 234,56 €'.replace(' ', ' ')), 1234.56); // NBSP separator
// Not currency: no marker, or a marker on something that isn't a number
assert.strictEqual(parseCurrency('1234.56'), null);
assert.strictEqual(parseCurrency('KEY 123'), null);
assert.strictEqual(parseCurrency('$'), null);
assert.strictEqual(parseCurrency('$abc'), null);

// --- plain numbers ---------------------------------------------------------

assert.strictEqual(parseNumericString('42'), 42);
assert.strictEqual(parseNumericString('-3.5'), -3.5);
assert.strictEqual(parseNumericString('+7'), 7);
assert.strictEqual(parseNumericString('1.5e3'), 1500);
assert.strictEqual(parseNumericString('45%'), 45);
assert.strictEqual(parseNumericString('1,234'), 1234);
assert.strictEqual(parseNumericString('not a number'), null);
assert.strictEqual(parseNumericString('2024-01-15'), null);

// --- timestamps ------------------------------------------------------------

assert.strictEqual(parseTimestamp('2024-01-15T10:30:00Z'), Date.parse('2024-01-15T10:30:00Z'));
assert.strictEqual(parseTimestamp('2024-01-15'), Date.parse('2024-01-15'));
// No offset reads as UTC, like the ISO date-only form (see "every timezone" below)
assert.strictEqual(parseTimestamp('2024-01-15 10:30:00'), Date.parse('2024-01-15T10:30:00Z'));
assert.strictEqual(parseTimestamp('2024-01-15T10:30:00.123456Z'), Date.parse('2024-01-15T10:30:00.123Z'));
assert.strictEqual(parseTimestamp('2024-01-15T10:30:00+01:00'), Date.parse('2024-01-15T10:30:00+01:00'));
assert.ok(parseTimestamp('01/15/2024') !== null);
assert.ok(parseTimestamp('01/15/2024 10:30 PM') !== null);
assert.ok(parseTimestamp('15 Jan 2024') !== null);
assert.ok(parseTimestamp('Jan 15, 2024') !== null);
assert.ok(parseTimestamp('Mon, 15 Jan 2024 10:30:00 GMT') !== null);
// The guard must reject strings Date.parse would otherwise accept
assert.strictEqual(parseTimestamp('5'), null);
assert.strictEqual(parseTimestamp('2024'), null);
assert.strictEqual(parseTimestamp('hello'), null);
assert.strictEqual(parseTimestamp(''), null);

// --- value / column type detection ----------------------------------------

assert.strictEqual(detectValueType(null), 'empty');
assert.strictEqual(detectValueType(undefined), 'empty');
assert.strictEqual(detectValueType('   '), 'empty');
assert.strictEqual(detectValueType(true), 'boolean');
assert.strictEqual(detectValueType(12), 'number');
assert.strictEqual(detectValueType('12'), 'number');
assert.strictEqual(detectValueType('$12'), 'currency');
assert.strictEqual(detectValueType('2024-01-15'), 'timestamp');
assert.strictEqual(detectValueType('hello'), 'string');
assert.strictEqual(detectValueType({ a: 1 }), 'string');

const timestampRows = [
    { ts: '2024-03-01T09:00:00Z' },
    { ts: '2024-01-15T10:30:00Z' },
    { ts: '2024-02-20T23:59:59Z' }
];
assert.strictEqual(detectColumnType(timestampRows, 'ts'), 'timestamp');

const priceRows = [{ price: '$1,200.00' }, { price: '$99.00' }, { price: '$450.50' }];
assert.strictEqual(detectColumnType(priceRows, 'price'), 'currency');

// Numbers mixed with currency still sort as money
const mixedMoneyRows = [{ amt: '$1,200.00' }, { amt: 99 }, { amt: '450.50' }];
assert.strictEqual(detectColumnType(mixedMoneyRows, 'amt'), 'currency');

assert.strictEqual(detectColumnType([{ n: 1 }, { n: 2 }, { n: 3 }], 'n'), 'number');
assert.strictEqual(detectColumnType([{ b: true }, { b: false }], 'b'), 'boolean');
assert.strictEqual(detectColumnType([{ s: 'a' }, { s: 'b' }], 's'), 'string');
assert.strictEqual(detectColumnType([{ x: null }, { x: '' }], 'x'), 'string');
// Too mixed to trust any one type
assert.strictEqual(detectColumnType([{ m: 'abc' }, { m: 1 }, { m: '2024-01-15' }], 'm'), 'string');
// Nested paths
assert.strictEqual(detectColumnType([{ user: { age: 30 } }, { user: { age: 41 } }], 'user.age'), 'number');

// --- sorting ---------------------------------------------------------------

// Timestamps sort chronologically, not lexicographically
const logRows = [
    { ts: '2024-03-01T09:00:00Z', id: 'c' },
    { ts: '2024-01-15T10:30:00Z', id: 'a' },
    { ts: '2024-02-20T23:59:59Z', id: 'b' }
];
assert.deepStrictEqual(sortRows(logRows, 'ts', 'asc').map(r => r.id), ['a', 'b', 'c']);
assert.deepStrictEqual(sortRows(logRows, 'ts', 'desc').map(r => r.id), ['c', 'b', 'a']);

// Mixed timestamp formats in one column still order correctly
const mixedDateRows = [
    { when: '2024-03-01', id: 'c' },
    { when: 1705315800, id: 'a' },              // epoch seconds: 2024-01-15
    { when: '2024-02-20T23:59:59Z', id: 'b' }
];
assert.deepStrictEqual(sortRows(mixedDateRows, 'when', 'asc').map(r => r.id), ['a', 'b', 'c']);

// Currency sorts by amount, not by string
const money = [
    { price: '$99.00', id: 'small' },
    { price: '$1,200.00', id: 'large' },
    { price: '$450.50', id: 'mid' }
];
assert.deepStrictEqual(sortRows(money, 'price', 'asc').map(r => r.id), ['small', 'mid', 'large']);
assert.deepStrictEqual(sortRows(money, 'price', 'desc').map(r => r.id), ['large', 'mid', 'small']);

// Numbers, including negatives
const numbers = [{ n: 10 }, { n: -5 }, { n: 2 }];
assert.deepStrictEqual(sortRows(numbers, 'n', 'asc').map(r => r.n), [-5, 2, 10]);
assert.deepStrictEqual(sortRows(numbers, 'n', 'desc').map(r => r.n), [10, 2, -5]);

// Booleans: false before true
assert.deepStrictEqual(sortRows([{ b: true }, { b: false }], 'b', 'asc').map(r => r.b), [false, true]);

// Versions and addresses are text, so natural ordering applies, not a
// "thousands-grouped" reading that made 1.10.0 the number 1100
const versions = [{ v: '1.10.0' }, { v: '1.2.3' }, { v: '2.0.1' }, { v: '1.9.12' }];
assert.strictEqual(detectColumnType(versions, 'v'), 'string');
assert.deepStrictEqual(sortRows(versions, 'v', 'asc').map(r => r.v), ['1.2.3', '1.9.12', '1.10.0', '2.0.1']);
const addresses = [{ ip: '10.0.1.1' }, { ip: '10.0.0.10' }, { ip: '9.9.9.9' }, { ip: '10.0.0.2' }];
assert.deepStrictEqual(sortRows(addresses, 'ip', 'asc').map(r => r.ip), ['9.9.9.9', '10.0.0.2', '10.0.0.10', '10.0.1.1']);

// Text uses natural ordering, so item2 precedes item10
const names = [{ s: 'item10' }, { s: 'item2' }, { s: 'item1' }];
assert.deepStrictEqual(sortRows(names, 's', 'asc').map(r => r.s), ['item1', 'item2', 'item10']);

// Blank and missing cells sort last in BOTH directions
const withBlanks = [
    { v: 5, id: 'five' },
    { v: null, id: 'null' },
    { v: 1, id: 'one' },
    { id: 'missing' },
    { v: '', id: 'blank' }
];
assert.deepStrictEqual(
    sortRows(withBlanks, 'v', 'asc').slice(0, 2).map(r => r.id),
    ['one', 'five']
);
assert.deepStrictEqual(
    sortRows(withBlanks, 'v', 'desc').slice(0, 2).map(r => r.id),
    ['five', 'one']
);
['asc', 'desc'].forEach(direction => {
    const tail = sortRows(withBlanks, 'v', direction).slice(2).map(r => r.id);
    assert.deepStrictEqual(tail.slice().sort(), ['blank', 'missing', 'null']);
});

// Values that don't match the column type rank below ones that do, above blanks
const dirty = [
    { v: 'n/a', id: 'bad' },
    { v: 20, id: 'twenty' },
    { v: null, id: 'empty' },
    { v: 3, id: 'three' }
];
assert.deepStrictEqual(sortRows(dirty, 'v', 'asc').map(r => r.id), ['three', 'twenty', 'bad', 'empty']);
assert.deepStrictEqual(sortRows(dirty, 'v', 'desc').map(r => r.id), ['twenty', 'three', 'bad', 'empty']);

// Stability: equal keys keep their original relative order
const ties = [
    { k: 1, id: 'first' },
    { k: 1, id: 'second' },
    { k: 1, id: 'third' }
];
assert.deepStrictEqual(sortRows(ties, 'k', 'asc').map(r => r.id), ['first', 'second', 'third']);
assert.deepStrictEqual(sortRows(ties, 'k', 'desc').map(r => r.id), ['first', 'second', 'third']);

// Nested column paths
const nested = [{ user: { age: 41 } }, { user: { age: 30 } }];
assert.deepStrictEqual(sortRows(nested, 'user.age', 'asc').map(r => r.user.age), [30, 41]);

// --- index mapping ---------------------------------------------------------

// Row indices travel with the rows, so display sorting keeps edits pointed at
// the right line in the file.
const indexed = [
    { n: 30, id: 'a' },
    { n: 10, id: 'b' },
    { n: 20, id: 'c' }
];
const ascending = sortRowsWithIndices(indexed, [0, 1, 2], 'n', 'asc');
assert.deepStrictEqual(ascending.sortedRows.map(r => r.id), ['b', 'c', 'a']);
assert.deepStrictEqual(ascending.sortedIndices, [1, 2, 0]);

// A filtered subset carries its original file indices through the sort
const filtered = sortRowsWithIndices(indexed, [4, 7, 9], 'n', 'desc');
assert.deepStrictEqual(filtered.sortedRows.map(r => r.id), ['a', 'c', 'b']);
assert.deepStrictEqual(filtered.sortedIndices, [4, 9, 7]);

// Search and display sort compose: after filtering then sorting, every displayed
// row still maps back to its own line in the file. This is the invariant that
// keeps cell edits, deletes and inserts pointed at the right row while sorted.
const { filterRowsWithIndices } = require('../out/jsonl/rowMapping');
const searchable = [
    { name: 'alpha', ts: '2024-03-01' },
    { name: 'beta', ts: '2024-01-15' },
    { name: 'alpha two', ts: '2024-02-20' },
    { name: 'gamma', ts: '2024-01-01' }
];
const searched = filterRowsWithIndices(searchable, 'alpha');
['asc', 'desc'].forEach(direction => {
    const view = sortRowsWithIndices(searched.filteredRows, searched.filteredRowIndices, 'ts', direction);
    assert.strictEqual(view.sortedRows.length, 2);
    view.sortedRows.forEach((row, position) => {
        assert.strictEqual(searchable[view.sortedIndices[position]], row,
            'displayed row must map back to its own index in the full row set');
    });
});
assert.deepStrictEqual(
    sortRowsWithIndices(searched.filteredRows, searched.filteredRowIndices, 'ts', 'asc').sortedIndices,
    [2, 0]
);

// Sorting must never reorder its inputs in place. The display sort is handed
// the provider's own rows/indices arrays, so an in-place sort would silently
// reorder the file's in-memory representation and corrupt what gets written.
const sourceRows = [{ n: 30, id: 'a' }, { n: 10, id: 'b' }, { n: 20, id: 'c' }];
const sourceIndices = [0, 1, 2];
const sorted = sortRowsWithIndices(sourceRows, sourceIndices, 'n', 'asc');
assert.deepStrictEqual(sourceRows.map(row => row.id), ['a', 'b', 'c'], 'input rows must not be reordered');
assert.deepStrictEqual(sourceIndices, [0, 1, 2], 'input indices must not be reordered');
assert.notStrictEqual(sorted.sortedRows, sourceRows);
assert.notStrictEqual(sorted.sortedIndices, sourceIndices);
sortRows(sourceRows, 'n', 'desc');
assert.deepStrictEqual(sourceRows.map(row => row.id), ['a', 'b', 'c'], 'sortRows must not reorder its input');

// Degenerate inputs
assert.deepStrictEqual(sortRowsWithIndices([], [], 'n', 'asc').sortedRows, []);
assert.deepStrictEqual(sortRows([{ a: 1 }], 'missing.path', 'asc'), [{ a: 1 }]);

// --- timestamps read the same in every timezone ----------------------------

// Date.parse reads an ISO date-only string as UTC but a date-time without an
// offset as local time, so "2024-01-15 20:00:00" sorted after "2024-01-16" for
// a viewer west of Greenwich, and in New York a time inside the spring-forward
// gap (02:30 on 2024-03-10 never happened there) sorted after 03:15. Node picks
// up a change to process.env.TZ at runtime, so each zone is checked in-process.
const originalTimeZone = process.env.TZ;
try {
    ['UTC', 'America/Los_Angeles', 'America/New_York', 'Europe/Berlin', 'Asia/Kolkata', 'Pacific/Kiritimati', 'Pacific/Pago_Pago'].forEach(zone => {
        process.env.TZ = zone;

        const days = [
            { when: '2024-01-16', id: 'jan16' },
            { when: '2024-01-15 20:00:00', id: 'jan15 8pm' },
            { when: '2024-01-15T09:00:00', id: 'jan15 9am' },
            { when: '2024-01-15', id: 'jan15' }
        ];
        assert.deepStrictEqual(sortRows(days, 'when', 'asc').map(r => r.id), ['jan15', 'jan15 9am', 'jan15 8pm', 'jan16'], zone);
        assert.deepStrictEqual(sortRows(days, 'when', 'desc').map(r => r.id), ['jan16', 'jan15 8pm', 'jan15 9am', 'jan15'], zone);

        const springForward = [
            { ts: '2024-03-10 03:15:00', id: 'B' },
            { ts: '2024-03-10 02:30:00', id: 'A' },
            { ts: '2024-03-10 03:45:00', id: 'C' }
        ];
        assert.deepStrictEqual(sortRows(springForward, 'ts', 'asc').map(r => r.id), ['A', 'B', 'C'], zone);

        [
            // Every recognized shape without an offset reads its wall-clock time as UTC...
            ['2024-01-15', '2024-01-15T00:00:00Z'],
            ['2024-01-15 10:30:00', '2024-01-15T10:30:00Z'],
            ['2024-01-15T10:30', '2024-01-15T10:30:00Z'],
            ['2024-01-15 9:30:00.5', '2024-01-15T09:30:00.500Z'],
            ['2024-03-10 02:30:00', '2024-03-10T02:30:00Z'],
            ['2024/01/15', '2024-01-15T00:00:00Z'],
            ['2024/01/15 10:30', '2024-01-15T10:30:00Z'],
            ['01/15/2024', '2024-01-15T00:00:00Z'],
            ['01/15/2024 10:30 PM', '2024-01-15T22:30:00Z'],
            ['15 Jan 2024', '2024-01-15T00:00:00Z'],
            ['Jan 15, 2024', '2024-01-15T00:00:00Z'],
            ['Jan 15, 2024 10:30 PM', '2024-01-15T22:30:00Z'],
            ['January 15 2024 10:30:00', '2024-01-15T10:30:00Z'],
            ['Mon, 15 Jan 2024 10:30:00', '2024-01-15T10:30:00Z'],
            ['Mon, 15 Jan 2024 10:30:00 PM', '2024-01-15T22:30:00Z'],
            // ...and one that names an offset or zone keeps meaning what it says
            ['2024-01-15T10:30:00Z', '2024-01-15T10:30:00Z'],
            ['2024-01-15 10:30:00+01:00', '2024-01-15T09:30:00Z'],
            ['2024-01-15T10:30:00-0500', '2024-01-15T15:30:00Z'],
            ['January 15 2024 10:30:00 GMT', '2024-01-15T10:30:00Z'],
            ['Jan 15 2024 10:30 -0500', '2024-01-15T15:30:00Z'],
            ['Mon, 15 Jan 2024 10:30:00 +0100', '2024-01-15T09:30:00Z'],
            ['Mon, 15 Jan 2024 10:30:00 EST', '2024-01-15T15:30:00Z']
        ].forEach(([text, utc]) => {
            assert.strictEqual(parseTimestamp(text), Date.parse(utc), `${text} in ${zone}`);
        });
    });
} finally {
    if (originalTimeZone === undefined) {
        delete process.env.TZ;
    } else {
        process.env.TZ = originalTimeZone;
    }
}

// --- integers too large for a double ---------------------------------------

// IDs past 2^53 held as strings compare exactly. As doubles these four all
// rounded to the same value, tied, and stayed in file order in both directions.
const bigIds = ['1790123456789012349', '1790123456789012341', '1790123456789012345', '1790123456789012343'].map(id => ({ id }));
assert.strictEqual(detectColumnType(bigIds, 'id'), 'number');
assert.deepStrictEqual(sortRows(bigIds, 'id', 'asc').map(r => r.id),
    ['1790123456789012341', '1790123456789012343', '1790123456789012345', '1790123456789012349']);
assert.deepStrictEqual(sortRows(bigIds, 'id', 'desc').map(r => r.id),
    ['1790123456789012349', '1790123456789012345', '1790123456789012343', '1790123456789012341']);

// They interleave correctly with ordinary numbers, signs and grouping...
const magnitudes = [
    { n: '9007199254740993' }, // 2^53 + 1, which no double holds
    { n: 9007199254740994 },
    { n: '1,000,000,000,000,000,001' },
    { n: 9007199254740992 },
    { n: '-9007199254740995' },
    { n: 12.5 },
    { n: '-5' }
];
assert.deepStrictEqual(sortRows(magnitudes, 'n', 'asc').map(r => r.n),
    ['-9007199254740995', '-5', 12.5, 9007199254740992, '9007199254740993', 9007199254740994, '1,000,000,000,000,000,001']);
// ...and as amounts of money
const bigAmounts = [{ amt: '$12,345,678,901,234,567,891' }, { amt: '$12,345,678,901,234,567,890' }];
assert.deepStrictEqual(sortRows(bigAmounts, 'amt', 'asc').map(r => r.amt),
    ['$12,345,678,901,234,567,890', '$12,345,678,901,234,567,891']);

// --- decimal-comma columns -------------------------------------------------

// "1.500" is fifteen hundred in a column whose other values show it writes
// decimal commas ("1.234,56", "2.000.000", "12,50"), not one and a half
const euros = [{ p: '1.500 €' }, { p: '999 €' }, { p: '1.234,56 €' }, { p: '2.000.000 €' }, { p: '12,50 €' }];
assert.strictEqual(detectColumnType(euros, 'p'), 'currency');
assert.deepStrictEqual(sortRows(euros, 'p', 'asc').map(r => r.p), ['12,50 €', '999 €', '1.234,56 €', '1.500 €', '2.000.000 €']);
assert.deepStrictEqual(sortRows(euros, 'p', 'desc').map(r => r.p), ['2.000.000 €', '1.500 €', '1.234,56 €', '999 €', '12,50 €']);
const column = values => values.map(v => ({ v }));
// The same goes for plain numbers, where a lone "1,250" is then a decimal comma too
assert.deepStrictEqual(sortRows(column(['1.500', '999', '1.234.567']), 'v', 'asc').map(r => r.v), ['999', '1.500', '1.234.567']);
assert.deepStrictEqual(sortRows(column(['1,250', '1,5', '2,75']), 'v', 'asc').map(r => r.v), ['1,250', '1,5', '2,75']);
// A US column is read the US way: "1,500" is fifteen hundred
assert.deepStrictEqual(sortRows(column(['1,500', '1,500.25', '999.10', '12.5']), 'v', 'asc').map(r => r.v),
    ['12.5', '999.10', '1,500', '1,500.25']);
// With nothing to go on, a single dot stays a decimal point...
assert.deepStrictEqual(sortRows(column(['999', '1.500']), 'v', 'asc').map(r => r.v), ['1.500', '999']);
// ...and so it does when the column contradicts itself
assert.deepStrictEqual(sortRows(column(['1.234,56', '999', '1.500', '1,234.56']), 'v', 'asc').map(r => r.v),
    ['1.500', '999', '1.234,56', '1,234.56']);

// --- two-part versions -----------------------------------------------------

// "3.10" next to "3.9" is a version: nobody writing decimals pads one value
// with a trailing zero and leaves the next at one place. Such a column sorts as
// text, whose natural ordering compares 3.9 < 3.10 part by part.
const pythons = column(['3.9', '3.12', '3.10', '3.11', '3.8']);
assert.strictEqual(detectColumnType(pythons, 'v'), 'string');
assert.deepStrictEqual(sortRows(pythons, 'v', 'asc').map(r => r.v), ['3.8', '3.9', '3.10', '3.11', '3.12']);
assert.deepStrictEqual(sortRows(pythons, 'v', 'desc').map(r => r.v), ['3.12', '3.11', '3.10', '3.9', '3.8']);
// Even when the caller already settled on 'number' (a sampled detection can
// miss the telltale values in a long column), the sort spots them itself
assert.deepStrictEqual(sortRows(pythons, 'v', 'asc', 'number').map(r => r.v), ['3.8', '3.9', '3.10', '3.11', '3.12']);
// Prices and other decimals keep sorting as amounts: consistently padded...
const prices = column(['3.10', '12.50', '3.99', '3.05']);
assert.strictEqual(detectColumnType(prices, 'v'), 'number');
assert.deepStrictEqual(sortRows(prices, 'v', 'asc').map(r => r.v), ['3.05', '3.10', '3.99', '12.50']);
// ...not padded at all...
assert.deepStrictEqual(sortRows(column(['0.5', '0.25', '0.125']), 'v', 'asc').map(r => r.v), ['0.125', '0.25', '0.5']);
// ...or with a leading-zero fraction, which no version has
assert.deepStrictEqual(sortRows(column(['3.5', '3.10', '3.05']), 'v', 'asc').map(r => r.v), ['3.05', '3.10', '3.5']);
// ...and real JSON numbers are never versions
assert.deepStrictEqual(sortRows(column([3.9, '3.10', 3.8]), 'v', 'asc').map(r => r.v), ['3.10', 3.8, 3.9]);

// --- numbers in a text column ----------------------------------------------

// A column too mixed to call numeric still holds real numbers. They compare as
// numbers, ahead of the words as in a spreadsheet, instead of as their digits,
// which put -5 before -10 and 2.5 before 2.25.
const readings = [-5, 'n/a', 2.5, 'n/a', -10, 'n/a', 2.25, 'n/a'].map((t, id) => ({ t, id }));
assert.strictEqual(detectColumnType(readings, 't'), 'string');
assert.deepStrictEqual(sortRows(readings, 't', 'asc').map(r => r.t), [-10, -5, 2.25, 2.5, 'n/a', 'n/a', 'n/a', 'n/a']);
// Descending is the reverse, with ties still in file order
assert.deepStrictEqual(sortRows(readings, 't', 'desc').map(r => r.id), [1, 3, 5, 7, 2, 6, 0, 4]);
// Blank and missing cells stay last both ways
const sparse = [{ t: 'b' }, { t: null }, { t: 10 }, {}, { t: 'a' }, { t: '' }, { t: 9 }];
assert.deepStrictEqual(sortRows(sparse, 't', 'asc', 'string').map(r => r.t).slice(0, 4), [9, 10, 'a', 'b']);
assert.deepStrictEqual(sortRows(sparse, 't', 'desc', 'string').map(r => r.t).slice(0, 4), ['b', 'a', 10, 9]);
// Stray numbers in a column of another type compare as numbers too
assert.deepStrictEqual(sortRows([{ b: true }, { b: -5 }, { b: false }, { b: -10 }], 'b', 'asc', 'boolean').map(r => r.b),
    [false, true, -10, -5]);

// --- the comparator is a strict weak order ---------------------------------

// Array.prototype.sort only promises a sorted result for a consistent
// comparator: never both a < b and b < a, and both "sorts before" and "ties
// with" transitive. Mixed columns are where that is easiest to break - numbers
// beside words, values that aren't the column's type, blanks - so check the
// axioms over random columns, for every column type in both directions, and
// check that sortRows agrees with the comparator and keeps ties in file order.
function seededRandom(seed) {
    // mulberry32
    return () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const BLANKS = [null, undefined, '', '   '];
const VALUE_POOLS = {
    numbers: [0, -0, 1, -1, 2.5, 2.25, -10, -5, 0.1, 1e21, -1e-7, 9007199254740992, 1705315800, 1705315800000],
    numericText: ['12', '-3.5', '+7', '1.5e3', '45%', '1,234', '1,234.56', '999.10', '0.500', '1790123456789012349',
        '-1790123456789012349', '9007199254740993', '9007199254740992', '1,000,000,000,000,000,001'],
    commaDecimals: ['1.234,56', '1.500', '2.000.000', '12,50', '1,250', '999', '0,5', '1.500 €', '12,50 €', '€ 3,10'],
    currency: ['$99.00', '$1,200.00', '($1,234.00)', 'USD 12', '£0.99', '$-42.50', '$12,345,678,901,234,567,891'],
    timestamps: ['2024-01-15', '2024-01-16', '2024-01-15 20:00:00', '2024-03-10T02:30:00', '2024-01-15T10:30:00+01:00',
        '01/15/2024 10:30 PM', 'Jan 15, 2024', 'Mon, 15 Jan 2024 10:30:00 GMT'],
    versions: ['3.9', '3.10', '3.12', '3.8', '10.1', '10.20'],
    words: ['n/a', 'apple', 'Apple', 'item2', 'item10', 'é', 'é', 'ß', 'ss', '١٢', '½', '🦌', '1.10.0', '10.0.0.1', '-'],
    other: [true, false, { a: 1 }, [1, 2], []]
};
const POOL_MIXES = [
    Object.keys(VALUE_POOLS), // anything goes
    ['numbers', 'words'], // the text-column case
    ['numbers', 'numericText'],
    ['commaDecimals', 'words'], // decimal-comma evidence, uncontradicted
    ['versions'],
    ['currency', 'numbers', 'words'],
    ['timestamps', 'numbers', 'words'],
    ['other', 'numbers']
];
const random = seededRandom(20241014);
const pick = list => list[Math.floor(random() * list.length)];
const isBlank = value => value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
const signOf = n => (n > 0 ? 1 : n < 0 ? -1 : 0);

POOL_MIXES.forEach(mix => {
    for (let round = 0; round < 2; round++) {
        const rows = [];
        for (let id = 0; id < 30; id++) {
            const value = random() < 0.12 ? pick(BLANKS) : pick(VALUE_POOLS[pick(mix)]);
            rows.push(value === undefined ? { id } : { v: value, id });
        }
        [undefined, 'string', 'number', 'currency', 'timestamp', 'boolean'].forEach(columnType => {
            const effectiveType = columnType || detectColumnType(rows, 'v');
            const matrices = {};
            ['asc', 'desc'].forEach(direction => {
                const label = `${mix.join('+')} #${round}, ${columnType || 'detected ' + effectiveType}, ${direction}`;
                const compare = createRowComparator(rows, 'v', direction, columnType);
                const c = rows.map(a => rows.map(b => signOf(compare(a, b))));
                matrices[direction] = c;
                const n = rows.length;
                for (let i = 0; i < n; i++) {
                    assert.strictEqual(c[i][i], 0, `irreflexive: ${label}`);
                    for (let j = 0; j < n; j++) {
                        const [a, b] = [rows[i].v, rows[j].v];
                        assert.ok(c[i][j] === -c[j][i], `antisymmetric: ${label}: ${JSON.stringify([a, b])}`);
                        for (let k = 0; k < n; k++) {
                            if (c[i][j] <= 0 && c[j][k] <= 0 && c[i][k] !== (c[i][j] < 0 || c[j][k] < 0 ? -1 : 0)) {
                                assert.fail(`transitive: ${label}: ${JSON.stringify([a, b, rows[k].v])}`);
                            }
                        }
                        if (isBlank(a) && !isBlank(b)) {
                            assert.strictEqual(c[j][i], -1, `blanks last: ${label}: ${JSON.stringify([b, a])}`);
                        }
                        // A timestamp column reads numbers as epoch seconds or
                        // milliseconds by size, so only there may they reorder
                        if (effectiveType !== 'timestamp' && typeof a === 'number' && typeof b === 'number' && a < b) {
                            assert.strictEqual(c[i][j], direction === 'asc' ? -1 : 1, `numeric order: ${label}: ${a} vs ${b}`);
                        }
                    }
                }
                const sorted = sortRows(rows, 'v', direction, columnType);
                for (let p = 0; p + 1 < sorted.length; p++) {
                    const order = signOf(compare(sorted[p], sorted[p + 1]));
                    assert.ok(order < 0 || (order === 0 && sorted[p].id < sorted[p + 1].id), `sortRows agrees: ${label} at ${p}`);
                }
            });
            rows.forEach((_, i) => rows.forEach((__, j) => {
                assert.strictEqual(matrices.asc[i][j] === 0, matrices.desc[i][j] === 0, 'a tie is a tie in both directions');
            }));
        });
    }
});

console.log('sorting tests passed');
