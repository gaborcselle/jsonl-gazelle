const assert = require('assert');
const { moveGridCursor } = require('../out/jsonl/gridNavigation');
const { scripts } = require('../out/webview/scripts');

// The webview cannot import from src/jsonl, so it carries a copy of the mover.
// Pull that copy out of the script string and run every case against both.
const START = '// --- shared:grid-navigation';
const END = '// --- end shared:grid-navigation';
const startIndex = scripts.indexOf(START);
const endIndex = scripts.indexOf(END);
assert.ok(startIndex !== -1 && endIndex > startIndex, 'webview scripts must contain the shared:grid-navigation block');

const webviewSource = scripts.slice(scripts.indexOf('\n', startIndex), endIndex);
const webviewImpl = new Function(webviewSource + '\nreturn moveGridCursor;')();

const at = (row, column) => ({ row: row, column: column });

// 4 rows x 3 columns unless a case says otherwise
const cases = [
    // Arrows stop at the edges rather than wrapping - a spreadsheet does not
    // teleport you across the grid when you hold an arrow key down
    { name: 'down moves a row', from: at(0, 1), move: 'down', expected: at(1, 1) },
    { name: 'up moves a row', from: at(2, 1), move: 'up', expected: at(1, 1) },
    { name: 'up at the top stays', from: at(0, 1), move: 'up', expected: at(0, 1) },
    { name: 'down at the bottom stays', from: at(3, 1), move: 'down', expected: at(3, 1) },
    { name: 'right moves a column', from: at(1, 0), move: 'right', expected: at(1, 1) },
    { name: 'left moves a column', from: at(1, 2), move: 'left', expected: at(1, 1) },
    { name: 'left at the first column stays', from: at(1, 0), move: 'left', expected: at(1, 0) },
    { name: 'right at the last column stays', from: at(1, 2), move: 'right', expected: at(1, 2) },

    // Tab is the one move that wraps: off the end of a row into the next one
    { name: 'tab advances a column', from: at(1, 0), move: 'next', expected: at(1, 1) },
    { name: 'tab wraps to the next row', from: at(1, 2), move: 'next', expected: at(2, 0) },
    { name: 'tab at the last cell stays', from: at(3, 2), move: 'next', expected: at(3, 2) },
    { name: 'shift-tab steps back', from: at(1, 1), move: 'previous', expected: at(1, 0) },
    { name: 'shift-tab wraps to the previous row', from: at(1, 0), move: 'previous', expected: at(0, 2) },
    { name: 'shift-tab at the first cell stays', from: at(0, 0), move: 'previous', expected: at(0, 0) },

    { name: 'home goes to the first column', from: at(2, 2), move: 'rowStart', expected: at(2, 0) },
    { name: 'end goes to the last column', from: at(2, 0), move: 'rowEnd', expected: at(2, 2) },

    // Paging clamps instead of overshooting the grid
    { name: 'page down jumps by the page size', from: at(0, 1), move: 'pageDown', pageSize: 2, expected: at(2, 1) },
    { name: 'page down clamps at the last row', from: at(3, 1), move: 'pageDown', pageSize: 2, expected: at(3, 1) },
    { name: 'page up jumps by the page size', from: at(3, 1), move: 'pageUp', pageSize: 2, expected: at(1, 1) },
    { name: 'page up clamps at the first row', from: at(1, 1), move: 'pageUp', pageSize: 5, expected: at(0, 1) },
    { name: 'a missing page size falls back to one row', from: at(0, 0), move: 'pageDown', expected: at(1, 0) },

    // Entering the grid: any key lands on the first cell
    { name: 'no cursor lands on the first cell', from: null, move: 'up', expected: at(0, 0) },
    { name: 'no cursor lands on the first cell for tab too', from: undefined, move: 'next', expected: at(0, 0) },

    // A stored cursor can outlive the cell it pointed at: rows get filtered by a
    // search, columns get hidden. Clamping keeps the next keystroke sane.
    { name: 'a row that no longer exists is clamped', from: at(99, 1), move: 'up', expected: at(2, 1) },
    { name: 'a column that no longer exists is clamped', from: at(1, 99), move: 'left', expected: at(1, 1) },
    { name: 'a negative position is clamped', from: at(-4, -2), move: 'down', expected: at(1, 0) },
    { name: 'a non-numeric position is clamped', from: at(NaN, 1), move: 'down', expected: at(1, 1) },

    { name: 'an unknown move keeps the cursor where it is', from: at(1, 1), move: 'sideways', expected: at(1, 1) },

    // Single-cell and empty grids
    { name: 'one cell has nowhere to go', from: at(0, 0), move: 'next', rows: 1, columns: 1, expected: at(0, 0) },
    { name: 'no rows means no cursor', from: at(0, 0), move: 'down', rows: 0, columns: 3, expected: null },
    { name: 'no visible columns means no cursor', from: at(0, 0), move: 'right', rows: 4, columns: 0, expected: null }
];

cases.forEach(testCase => {
    const rows = testCase.rows === undefined ? 4 : testCase.rows;
    const columns = testCase.columns === undefined ? 3 : testCase.columns;
    const args = [testCase.from, testCase.move, rows, columns, testCase.pageSize];
    assert.deepStrictEqual(moveGridCursor(...args), testCase.expected, testCase.name + ' (module)');
    assert.deepStrictEqual(webviewImpl(...args), testCase.expected, testCase.name + ' (webview)');
});

// Walking Tab from the first cell to the last visits every cell exactly once,
// and Shift+Tab walks the same path backwards
const visited = [];
let cursor = at(0, 0);
for (let step = 0; step < 12; step++) {
    visited.push(cursor.row + ',' + cursor.column);
    cursor = moveGridCursor(cursor, 'next', 4, 3);
}
assert.deepStrictEqual(visited, [
    '0,0', '0,1', '0,2',
    '1,0', '1,1', '1,2',
    '2,0', '2,1', '2,2',
    '3,0', '3,1', '3,2'
], 'tab must visit every cell in reading order');
assert.deepStrictEqual(cursor, at(3, 2), 'tab must stop at the last cell');

const backwards = [];
for (let step = 0; step < 12; step++) {
    backwards.push(cursor.row + ',' + cursor.column);
    cursor = moveGridCursor(cursor, 'previous', 4, 3);
}
assert.deepStrictEqual(backwards, visited.slice().reverse(), 'shift-tab must retrace the same path');
assert.deepStrictEqual(cursor, at(0, 0), 'shift-tab must stop at the first cell');

// The mover never hands back the object it was given: the webview keeps the
// cursor in its own variables and would otherwise alias state it means to read
const original = at(1, 1);
const moved = moveGridCursor(original, 'down', 4, 3);
assert.notStrictEqual(moved, original, 'the result must be a new position object');
assert.deepStrictEqual(original, at(1, 1), 'the input position must not be mutated');

console.log('gridNavigation tests passed');
