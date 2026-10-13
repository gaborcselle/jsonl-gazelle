const assert = require('assert');
const {
    parseGroupedNumber,
    parseCurrency,
    parseNumericString,
    parseTimestamp,
    detectValueType,
    detectColumnType,
    sortRows,
    sortRowsWithIndices
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
assert.strictEqual(parseTimestamp('2024-01-15 10:30:00'), Date.parse('2024-01-15 10:30:00'));
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

console.log('sorting tests passed');
