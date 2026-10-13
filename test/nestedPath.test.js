const assert = require('assert');
const { getNestedValue, setNestedValue, deleteNestedProperty } = require('../out/jsonl/utils');
const { scripts } = require('../out/webview/scripts');

// The webview cannot import from src/jsonl, so it carries a copy of the path
// reader. Pull that copy out of the script string and run every case against both.
const START = '// --- shared:nested-path';
const END = '// --- end shared:nested-path';
const startIndex = scripts.indexOf(START);
const endIndex = scripts.indexOf(END);
assert.ok(startIndex !== -1 && endIndex > startIndex, 'webview scripts must contain the shared:nested-path block');
const webviewGet = new Function(scripts.slice(scripts.indexOf('\n', startIndex), endIndex) + '\nreturn getNestedValue;')();

const row = {
    'user.name': 'flat',
    user: { name: 'nested', 'k8s.io/app': 'web' },
    a: { 'b.c': { d: 1 } },
    tags: ['x', { k: 2 }],
    matrix: [[1, 2], [3, 4]],
    'x[0]': 'literal brackets',
    empty: null,
    zero: 0
};

const cases = [
    // A flat key wins over walking into an object of the same prefix
    ['user.name', 'flat'],
    ['user', row.user],
    ['user.k8s.io/app', 'web'],
    ['a.b.c.d', 1],
    ['a.b.c', { d: 1 }],
    ['tags[0]', 'x'],
    ['tags[1].k', 2],
    ['matrix[1][0]', 3],
    ['x[0]', 'literal brackets'],
    ['zero', 0],
    ['empty', null],
    // A path through a null shows the null
    ['empty.deeper', null],
    ['missing', undefined],
    ['missing.deeper', undefined],
    ['tags[9]', undefined],
    ['tags[x]', undefined],
    ['user[0]', undefined],
    // Inherited properties are not data
    ['constructor', undefined],
    ['toString', undefined],
    ['user.hasOwnProperty', undefined]
];

for (const [path, expected] of cases) {
    assert.deepStrictEqual(getNestedValue(row, path), expected, 'utils: ' + path);
    assert.deepStrictEqual(webviewGet(row, path), expected, 'webview: ' + path);
}

// Bare values: the "(value)" column is the row itself, falsy ones included
for (const value of [0, false, '', 'text', [1, 2]]) {
    assert.deepStrictEqual(getNestedValue(value, '(value)'), value);
    assert.deepStrictEqual(webviewGet(value, '(value)'), value);
}
assert.strictEqual(getNestedValue('text', 'length'), undefined);
assert.strictEqual(webviewGet('text', 'length'), undefined);

// --- set ---------------------------------------------------------------------

{
    const flat = { 'user.name': 'ann', other: 1 };
    setNestedValue(flat, 'user.name', 'zed');
    assert.deepStrictEqual(flat, { 'user.name': 'zed', other: 1 });
    assert.deepStrictEqual(Object.keys(flat), ['user.name', 'other'], 'key order kept');
}
{
    const nested = { user: { name: 'ann' } };
    setNestedValue(nested, 'user.name', 'zed');
    assert.deepStrictEqual(nested, { user: { name: 'zed' } });
}
{
    const created = {};
    setNestedValue(created, 'a.b[1].c', 5);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(created)), { a: { b: [null, { c: 5 }] } });
}
{
    const arrays = { m: [[1, 2]] };
    setNestedValue(arrays, 'm[0][1]', 9);
    assert.deepStrictEqual(arrays, { m: [[1, 9]] });
}
{
    // An existing object is never replaced to make room for a path
    const keep = { tags: { first: 'a' } };
    setNestedValue(keep, 'tags[0]', 'x');
    assert.deepStrictEqual(keep, { tags: { first: 'a' } });
}

// --- delete ------------------------------------------------------------------

{
    const target = { 'a.b': 1, a: { b: 2 }, c: { d: 3, e: 4 } };
    deleteNestedProperty(target, 'a.b');
    assert.deepStrictEqual(target, { a: { b: 2 }, c: { d: 3, e: 4 } });
    deleteNestedProperty(target, 'c.d');
    assert.deepStrictEqual(target, { a: { b: 2 }, c: { e: 4 } });
    // Reaching through an inherited property must not delete anything global
    deleteNestedProperty(target, 'constructor.name');
    assert.strictEqual(Object.name, 'Object');
    deleteNestedProperty(null, 'a');
}

console.log('nestedPath tests passed');
