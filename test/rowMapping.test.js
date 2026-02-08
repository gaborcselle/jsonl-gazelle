const assert = require('assert');
const { filterRowsWithIndices } = require('../out/jsonl/rowMapping');

const rows = [
    { name: 'alpha', value: 1 },
    { name: 'beta', value: 2 },
    { name: 'alpha beta', value: 3 }
];

const allResult = filterRowsWithIndices(rows, '');
assert.strictEqual(allResult.filteredRows.length, 3);
assert.deepStrictEqual(allResult.filteredRowIndices, [0, 1, 2]);

const alphaResult = filterRowsWithIndices(rows, 'alpha');
assert.strictEqual(alphaResult.filteredRows.length, 2);
assert.deepStrictEqual(alphaResult.filteredRowIndices, [0, 2]);
assert.strictEqual(alphaResult.filteredRows[0].name, 'alpha');
assert.strictEqual(alphaResult.filteredRows[1].name, 'alpha beta');

const betaResult = filterRowsWithIndices(rows, 'beta');
assert.strictEqual(betaResult.filteredRows.length, 2);
assert.deepStrictEqual(betaResult.filteredRowIndices, [1, 2]);

console.log('rowMapping tests passed');
