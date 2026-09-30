const assert = require('assert');
const { findPrettyRecordStarts } = require('../out/jsonl/prettyLineNumbers');
const { scripts } = require('../out/webview/scripts');

// The webview cannot import from src/jsonl, so it carries a copy of the scanner.
// Pull that copy out of the script string and run every case against both.
const START = '// --- shared:pretty-line-numbers';
const END = '// --- end shared:pretty-line-numbers';
const startIndex = scripts.indexOf(START);
const endIndex = scripts.indexOf(END);
assert.ok(startIndex !== -1 && endIndex > startIndex, 'webview scripts must contain the shared:pretty-line-numbers block');

const webviewSource = scripts.slice(scripts.indexOf('\n', startIndex), endIndex);
const webviewImpl = new Function(webviewSource + '\nreturn findPrettyRecordStarts;')();

const pretty = (...rows) => rows.map(r => JSON.stringify(r, null, 2)).join('\n').split('\n');

const cases = [
    { name: 'empty editor', lines: [''], expected: [] },
    {
        name: 'each pretty-printed object starts a record',
        lines: pretty({ a: 1, b: { c: 2 } }, { a: 2 }, { a: 3, list: [1, 2] }),
        // { / "a" / "b": { / "c" / } / }  then { / "a" / }  then {
        expected: [0, 6, 9]
    },
    {
        // The reported bug: deleting a folded object removes all its lines at
        // once, and every later record must be renumbered from its new line
        name: 'deleting a whole record moves the later starts up',
        lines: pretty({ a: 1, b: { c: 2 } }, { a: 3 }),
        expected: [0, 6]
    },
    {
        name: 'a record on a single line (as pasted from JSONL)',
        lines: ['{"a":1,"b":{"c":2}}', '{', '  "a": 2', '}'],
        expected: [0, 1]
    },
    {
        name: 'top-level arrays',
        lines: pretty([1, 2], [{ x: 1 }]),
        expected: [0, 4]
    },
    {
        name: 'bare values are one record per line',
        lines: ['0', 'false', '""', 'null', '"text"'],
        expected: [0, 1, 2, 3, 4]
    },
    {
        name: 'blank lines between records are not records',
        lines: ['{', '  "a": 1', '}', '', '   ', '{', '  "a": 2', '}'],
        expected: [0, 5]
    },
    {
        name: 'brackets inside strings do not change depth',
        lines: pretty({ s: '{[' }, { s: '}]', t: 'a \\"} b' }, { a: 1 }),
        expected: [0, 3, 7]
    },
    {
        name: 'an escaped quote does not end a string',
        lines: ['{', '  "s": "say \\"{\\" please"', '}', '{', '}'],
        expected: [0, 3]
    },
    {
        // Mid-edit: an unclosed object swallows what follows until it closes,
        // which is also how the save path would read the text
        name: 'an unclosed object owns the following lines',
        lines: ['{', '  "a": 1', '{', '  "a": 2', '}'],
        expected: [0]
    },
    {
        name: 'a stray closing bracket does not hide later records',
        lines: ['}', '{', '  "a": 1', '}', '{', '}'],
        expected: [0, 1, 4]
    }
];

let failures = 0;
for (const testCase of cases) {
    for (const [label, impl] of [['src/jsonl', findPrettyRecordStarts], ['webview', webviewImpl]]) {
        try {
            assert.deepStrictEqual(impl(testCase.lines), testCase.expected);
        } catch (error) {
            failures++;
            console.error(`FAIL [${label}] ${testCase.name}: got ${JSON.stringify(impl(testCase.lines))}, expected ${JSON.stringify(testCase.expected)}`);
        }
    }
}

if (failures > 0) {
    process.exit(1);
}
console.log(`prettyLineNumbers: ${cases.length} cases passed in both implementations`);
