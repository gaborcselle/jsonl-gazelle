const assert = require('assert');
const { computeJsonlDiff, diffRowPair, canonicalStringify, splitLines, myersDiff } = require('../out/jsonl/diff');

// --- splitLines ---
assert.deepStrictEqual(splitLines(''), []);
assert.deepStrictEqual(splitLines('{"a":1}\n'), ['{"a":1}']);
assert.deepStrictEqual(splitLines('{"a":1}\r\n{"b":2}'), ['{"a":1}', '{"b":2}']);

// --- canonicalStringify: key order does not matter ---
assert.strictEqual(
    canonicalStringify({ b: 2, a: { d: 4, c: 3 } }),
    canonicalStringify({ a: { c: 3, d: 4 }, b: 2 })
);

// --- identical documents ---
{
    const text = '{"id":1,"name":"a"}\n{"id":2,"name":"b"}\n';
    const result = computeJsonlDiff(text, text);
    assert.deepStrictEqual(result.summary, { added: 0, removed: 0, modified: 0, unchanged: 2 });
}

// --- pure addition ---
{
    const oldText = '{"id":1}\n';
    const newText = '{"id":1}\n{"id":2}\n';
    const result = computeJsonlDiff(oldText, newText);
    assert.deepStrictEqual(result.summary, { added: 1, removed: 0, modified: 0, unchanged: 1 });
    const added = result.rows.find(r => r.type === 'added');
    assert.strictEqual(added.newLineNumber, 2);
    assert.strictEqual(added.oldLineNumber, null);
    assert.strictEqual(added.newText, '{"id":2}');
}

// --- pure removal ---
{
    const oldText = '{"id":1}\n{"id":2}\n{"id":3}\n';
    const newText = '{"id":1}\n{"id":3}\n';
    const result = computeJsonlDiff(oldText, newText);
    assert.deepStrictEqual(result.summary, { added: 0, removed: 1, modified: 0, unchanged: 2 });
    const removed = result.rows.find(r => r.type === 'removed');
    assert.strictEqual(removed.oldLineNumber, 2);
    assert.strictEqual(removed.newLineNumber, null);
}

// --- field edit of the same record is reported as modified with field changes ---
{
    const oldText = '{"id":1,"name":"Alice","age":30}\n{"id":2,"name":"Bob","age":25}\n';
    const newText = '{"id":1,"name":"Alicia","age":30}\n{"id":2,"name":"Bob","age":25}\n';
    const result = computeJsonlDiff(oldText, newText);
    assert.deepStrictEqual(result.summary, { added: 0, removed: 0, modified: 1, unchanged: 1 });
    const modified = result.rows.find(r => r.type === 'modified');
    assert.strictEqual(modified.oldLineNumber, 1);
    assert.strictEqual(modified.newLineNumber, 1);
    assert.deepStrictEqual(modified.fieldChanges, [
        { path: 'name', type: 'changed', oldValue: 'Alice', newValue: 'Alicia' }
    ]);
}

// --- nested and array field changes ---
{
    const oldLine = JSON.stringify({ id: 7, user: { name: 'Ann', address: { city: 'Wien' } }, tags: ['a', 'b'] });
    const newLine = JSON.stringify({ id: 7, user: { name: 'Ann', address: { city: 'Graz' } }, tags: ['a', 'b', 'c'], active: true });
    const changes = diffRowPair(oldLine, newLine);
    assert.ok(changes, 'expected the pair to be treated as modified');
    const byPath = Object.fromEntries(changes.map(c => [c.path, c]));
    assert.deepStrictEqual(byPath['user.address.city'], { path: 'user.address.city', type: 'changed', oldValue: 'Wien', newValue: 'Graz' });
    assert.deepStrictEqual(byPath['tags[2]'], { path: 'tags[2]', type: 'added', newValue: 'c' });
    assert.deepStrictEqual(byPath['active'], { path: 'active', type: 'added', newValue: true });
    assert.strictEqual(changes.length, 3);
}

// --- removed field ---
{
    const changes = diffRowPair('{"id":1,"legacy":true,"x":1}', '{"id":1,"x":1}');
    assert.deepStrictEqual(changes, [{ path: 'legacy', type: 'removed', oldValue: true }]);
}

// --- completely different records are NOT paired as modified ---
{
    const oldText = '{"id":1,"name":"Alice","age":30}\n';
    const newText = '{"id":99,"name":"Zed","age":77}\n';
    const result = computeJsonlDiff(oldText, newText);
    assert.deepStrictEqual(result.summary, { added: 1, removed: 1, modified: 0, unchanged: 0 });
}

// --- invalid JSON lines fall back to plain add/remove ---
{
    const oldText = 'not json at all\n';
    const newText = 'also not json\n';
    const result = computeJsonlDiff(oldText, newText);
    assert.deepStrictEqual(result.summary, { added: 1, removed: 1, modified: 0, unchanged: 0 });
}

// --- empty old document (e.g. file not yet in HEAD): everything added ---
{
    const result = computeJsonlDiff('', '{"id":1}\n{"id":2}\n');
    assert.deepStrictEqual(result.summary, { added: 2, removed: 0, modified: 0, unchanged: 0 });
}

// --- key reorder with equal values: raw lines differ but values equal -> add/remove (no empty modified row) ---
{
    const result = computeJsonlDiff('{"a":1,"b":2}\n', '{"b":2,"a":1}\n');
    assert.deepStrictEqual(result.summary, { added: 1, removed: 1, modified: 0, unchanged: 0 });
}

// --- interleaved edits keep line numbers consistent ---
{
    const oldText = [
        '{"id":1,"v":"keep"}',
        '{"id":2,"v":"old"}',
        '{"id":3,"v":"keep"}',
        '{"id":4,"v":"gone"}',
        '{"id":5,"v":"keep"}'
    ].join('\n') + '\n';
    const newText = [
        '{"id":1,"v":"keep"}',
        '{"id":2,"v":"new"}',
        '{"id":3,"v":"keep"}',
        '{"id":5,"v":"keep"}',
        '{"id":6,"v":"fresh"}'
    ].join('\n') + '\n';
    const result = computeJsonlDiff(oldText, newText);
    assert.deepStrictEqual(result.summary, { added: 1, removed: 1, modified: 1, unchanged: 3 });
    const modified = result.rows.find(r => r.type === 'modified');
    assert.strictEqual(modified.oldLineNumber, 2);
    assert.strictEqual(modified.newLineNumber, 2);
    const removed = result.rows.find(r => r.type === 'removed');
    assert.strictEqual(removed.oldLineNumber, 4);
    const added = result.rows.find(r => r.type === 'added');
    assert.strictEqual(added.newLineNumber, 5);
    // Rows appear in document order
    const types = result.rows.map(r => r.type);
    assert.deepStrictEqual(types, ['unchanged', 'modified', 'unchanged', 'removed', 'unchanged', 'added']);
}

// --- large input with distinct first and last lines aligns without throwing ---
{
    const oldRows = [];
    const newRows = [];
    for (let i = 0; i < 2500; i++) {
        oldRows.push(JSON.stringify({ id: i, value: 'row-' + i }));
        newRows.push(JSON.stringify({ id: i, value: i === 1250 ? 'edited' : 'row-' + i }));
    }
    // Force distinct prefix/suffix so the trimmed middle stays large
    oldRows.unshift('{"head":"old"}');
    newRows.unshift('{"head":"new"}');
    oldRows.push('{"tail":"old"}');
    newRows.push('{"tail":"new"}');
    const result = computeJsonlDiff(oldRows.join('\n') + '\n', newRows.join('\n') + '\n');
    assert.strictEqual(result.summary.unchanged, 2499);
    assert.ok(result.summary.modified >= 1);
}

// --- the O(ND) diff: a shortest edit script, checked against the DP LCS ---
{
    let seed = 7;
    const random = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
    };
    const lcsLength = (a, b) => {
        const table = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
        for (let i = 1; i <= a.length; i++) {
            for (let j = 1; j <= b.length; j++) {
                table[i][j] = a[i - 1] === b[j - 1] ? table[i - 1][j - 1] + 1 : Math.max(table[i - 1][j], table[i][j - 1]);
            }
        }
        return table[a.length][b.length];
    };
    for (let iteration = 0; iteration < 2000; iteration++) {
        const a = Int32Array.from({ length: Math.floor(random() * 12) }, () => Math.floor(random() * 4));
        const b = Int32Array.from({ length: Math.floor(random() * 12) }, () => Math.floor(random() * 4));
        const ops = myersDiff(a, b, 100);
        // Replaying the ops on a must produce b
        const rebuilt = [];
        let i = 0;
        let j = 0;
        for (const op of ops) {
            if (op === 0) {
                assert.strictEqual(a[i], b[j]);
                rebuilt.push(a[i]);
                i++;
                j++;
            } else if (op === -1) {
                i++;
            } else {
                rebuilt.push(b[j]);
                j++;
            }
        }
        assert.strictEqual(i, a.length);
        assert.deepStrictEqual(rebuilt, Array.from(b));
        assert.strictEqual(ops.filter(op => op === 0).length, lcsLength(Array.from(a), Array.from(b)), 'shortest edit script');
    }
    // Over budget: null, so the caller can fall back
    assert.strictEqual(myersDiff(Int32Array.from([1, 2, 3]), Int32Array.from([4, 5, 6]), 2), null);
}

// --- a big changed middle still aligns exactly (it used to pair by position) ---
{
    const rows = Array.from({ length: 5000 }, (_, i) => JSON.stringify({ id: i, v: 'x' + i }));
    const edited = rows.slice();
    edited.splice(5, 1);                                  // delete near the top
    edited[4000] = JSON.stringify({ id: 4001, v: 'changed' }); // edit near the bottom
    edited.push(JSON.stringify({ id: 'new' }));           // append
    const result = computeJsonlDiff(rows.join('\n') + '\n', edited.join('\n') + '\n');
    assert.deepStrictEqual(result.summary, { added: 1, removed: 1, modified: 1, unchanged: 4998 });
}

// --- a long unchanged tail is neither quadratic nor a stack overflow ---
{
    const rows = Array.from({ length: 200000 }, (_, i) => '{"i":' + i + '}');
    const edited = rows.slice();
    edited[0] = '{"i":"first"}';
    const started = Date.now();
    const result = computeJsonlDiff(rows.join('\n'), edited.join('\n'));
    assert.strictEqual(result.summary.unchanged, 199999);
    assert.ok(Date.now() - started < 5000, 'took ' + (Date.now() - started) + ' ms');
}

// --- inherited property names are ordinary keys ---
{
    const changes = diffRowPair('{"id":1,"a":1,"b":2}', '{"id":1,"a":1,"b":2,"toString":"y"}');
    assert.deepStrictEqual(changes, [{ path: 'toString', type: 'added', newValue: 'y' }]);
}

const toText = rows => rows.join('\n') + '\n';

// --- more than 2000 edits in a big file still align row by row ---
// (they used to be paired by position: nearly every row showed as modified)
{
    const rows = Array.from({ length: 100000 }, (_, i) => JSON.stringify({ id: i, name: 'user' + i, status: 'ok' }));
    const started = Date.now();
    const result = computeJsonlDiff(toText(rows), toText(rows.filter((_, i) => i % 40 !== 7)));
    assert.deepStrictEqual(result.summary, { added: 0, removed: 2500, modified: 0, unchanged: 97500 });
    assert.ok(Date.now() - started < 5000, 'took ' + (Date.now() - started) + ' ms');
}

// --- no quality cliff when the changed middle outgrows the exact LCS table ---
for (const size of [2000, 2002]) {
    const rows = Array.from({ length: size }, (_, i) => JSON.stringify({ id: i, name: 'u' + i, score: 1 }));
    const edited = rows.map((row, i) => i % 2 === 1 ? JSON.stringify({ id: i, name: 'u' + i, score: 2 }) : row);
    edited.splice(1, 0, JSON.stringify({ id: 'new', name: 'x', score: 0 }));
    const result = computeJsonlDiff(toText(rows), toText(edited));
    assert.deepStrictEqual(result.summary, { added: 1, removed: 0, modified: size / 2, unchanged: size / 2 }, 'size ' + size);
}

// --- moved rows: every line is still there, so only the unique ones can anchor the alignment ---
{
    const rows = Array.from({ length: 10000 }, (_, i) => JSON.stringify({ id: i, v: 'x' + i }));
    const moved = rows.filter((_, i) => i % 6 === 1);
    const edited = rows.filter((_, i) => i % 6 !== 1).concat(moved);
    const started = Date.now();
    const result = computeJsonlDiff(toText(rows), toText(edited));
    assert.deepStrictEqual(result.summary, { added: moved.length, removed: moved.length, modified: 0, unchanged: rows.length - moved.length });
    assert.ok(Date.now() - started < 5000, 'took ' + (Date.now() - started) + ' ms');
}

// --- every row is accounted for, in order, whatever the alignment strategy ---
{
    // mulberry32: the LCG above repeats after ~10K draws in double arithmetic
    let seed = 11;
    const random = () => {
        seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const check = (oldRows, newRows) => {
        const result = computeJsonlDiff(toText(oldRows), toText(newRows));
        let oldLine = 0;
        let newLine = 0;
        for (const row of result.rows) {
            if (row.oldLineNumber !== null) {
                assert.strictEqual(row.oldLineNumber, ++oldLine);
                assert.strictEqual(row.oldText, oldRows[oldLine - 1]);
            }
            if (row.newLineNumber !== null) {
                assert.strictEqual(row.newLineNumber, ++newLine);
                assert.strictEqual(row.newText, newRows[newLine - 1]);
            }
            if (row.type === 'unchanged') {
                assert.strictEqual(row.oldText, row.newText);
            }
        }
        assert.strictEqual(oldLine, oldRows.length);
        assert.strictEqual(newLine, newRows.length);
        return result;
    };
    // Few distinct lines (no unique anchors), many distinct lines, and a mix,
    // with edits well past what the exact strategies take on
    for (const distinct of [3, 40, 1000000]) {
        for (let iteration = 0; iteration < 3; iteration++) {
            const oldRows = Array.from({ length: 2500 + Math.floor(random() * 1000) }, () => '{"k":' + Math.floor(random() * distinct) + '}');
            const newRows = oldRows.slice();
            const edits = 500 + Math.floor(random() * 3000);
            for (let e = 0; e < edits; e++) {
                const at = Math.floor(random() * newRows.length);
                const kind = Math.floor(random() * 3);
                if (kind === 0) {
                    newRows.splice(at, 1);
                } else if (kind === 1) {
                    newRows.splice(at, 0, '{"k":' + Math.floor(random() * distinct) + '}');
                } else {
                    newRows[at] = '{"k":"e' + e + '"}';
                }
            }
            check(oldRows, newRows);
        }
    }
    // Pathological shapes stay fast: all-identical lines, swapped halves,
    // and unique lines separating long runs of repeated ones
    const started = Date.now();
    const same = Array.from({ length: 200000 }, () => '{"a":1}');
    check(same, same.slice(0, 150000).concat(['{"b":2}'], same.slice(0, 60000)));
    const half = Array.from({ length: 100000 }, (_, i) => '{"i":' + i + '}');
    check(half.concat(same.slice(0, 100000)), same.slice(0, 100000).concat(half));
    const blocks = [];
    const shuffled = [];
    for (let b = 0; b < 100; b++) {
        blocks.push('{"anchor":' + b + '}');
        shuffled.push('{"anchor":' + b + '}');
        for (let k = 0; k < 3000; k++) {
            blocks.push('{"r":' + (k % 50) + '}');
            shuffled.push('{"r":' + ((k * 7 + b) % 50) + '}');
        }
    }
    check(blocks, shuffled);
    assert.ok(Date.now() - started < 10000, 'pathological inputs took ' + (Date.now() - started) + ' ms');
}

// --- inside a changed block, rows pair with the record they are an edit of ---
{
    const rec = (id, name) => JSON.stringify({ id, name, status: 'active', role: 'user' });
    const describe = result => result.rows.map(row => [row.type, row.oldLineNumber, row.newLineNumber]);

    // Deleting a row next to an edited one
    const deleted = computeJsonlDiff(
        toText([rec(1, 'Ann'), rec(2, 'Bob'), rec(3, 'Cid'), rec(4, 'Dee')]),
        toText([rec(1, 'Ann'), rec(3, 'Cyd'), rec(4, 'Dee')]));
    assert.deepStrictEqual(describe(deleted), [['unchanged', 1, 1], ['removed', 2, null], ['modified', 3, 2], ['unchanged', 4, 3]]);
    assert.deepStrictEqual(deleted.rows[2].fieldChanges, [{ path: 'name', type: 'changed', oldValue: 'Cid', newValue: 'Cyd' }]);

    // Inserting a row before an edited one
    const inserted = computeJsonlDiff(
        toText([rec(1, 'Ann'), rec(2, 'Bob'), rec(3, 'Cid')]),
        toText([rec(1, 'Ann'), rec(9, 'Zed'), rec(2, 'Bobby'), rec(3, 'Cid')]));
    assert.deepStrictEqual(describe(inserted), [['unchanged', 1, 1], ['added', null, 2], ['modified', 2, 3], ['unchanged', 3, 4]]);
    assert.deepStrictEqual(inserted.rows[2].fieldChanges, [{ path: 'name', type: 'changed', oldValue: 'Bob', newValue: 'Bobby' }]);

    // Rows edited in place still pair up one to one
    const inPlace = computeJsonlDiff(
        toText([rec(1, 'Ann'), rec(2, 'Bob'), rec(3, 'Cid')]),
        toText([rec(1, 'Anne'), rec(2, 'Bobby'), rec(3, 'Cyd')]));
    assert.deepStrictEqual(describe(inPlace), [['modified', 1, 1], ['modified', 2, 2], ['modified', 3, 3]]);
}

// --- numbers JSON.parse cannot hold exactly are compared as written ---
{
    // What the diff view shows for a value
    const { restoreNumberLiterals = text => text } = require('../out/jsonl/diff');
    const shown = value => restoreNumberLiterals(JSON.stringify(value));
    const changesOf = (oldLine, newLine) => {
        const result = computeJsonlDiff(oldLine + '\n', newLine + '\n');
        assert.deepStrictEqual(result.summary, { added: 0, removed: 0, modified: 1, unchanged: 0 }, oldLine + ' -> ' + newLine);
        return result.rows[0].fieldChanges.map(change => [change.path, shown(change.oldValue), shown(change.newValue)]);
    };

    // Beyond 2^53 both ids round to the same double: the change went unreported
    assert.deepStrictEqual(changesOf('{"id":9007199254740993,"name":"a"}', '{"id":9007199254740992,"name":"b"}'),
        [['id', '9007199254740993', '9007199254740992'], ['name', '"a"', '"b"']]);
    // ...and with nothing else changed the row was a remove + add
    assert.deepStrictEqual(changesOf('{"id":12345678901234567891,"name":"a"}', '{"id":12345678901234567890,"name":"a"}'),
        [['id', '12345678901234567891', '12345678901234567890']]);
    // Inside nested values too, negative ones included
    assert.deepStrictEqual(changesOf('{"id":1,"big":[-1234567890123456789]}', '{"id":1,"big":[-1234567890123459999]}'),
        [['big[0]', '-1234567890123456789', '-1234567890123459999']]);
    // Out of range literals are not all null
    assert.deepStrictEqual(changesOf('{"id":1,"v":1e400}', '{"id":1,"v":1e401}'), [['v', '1e400', '1e401']]);
    // Digits inside strings are left alone
    assert.deepStrictEqual(changesOf('{"id":1,"s":"12345678901234567891","t":1}', '{"id":1,"s":"12345678901234567891","t":2}'), [['t', '1', '2']]);

    // Ordinary numbers keep comparing by value
    assert.deepStrictEqual(changesOf('{"id":1,"p":1.50,"n":"a"}', '{"id":1,"p":1.5,"n":"b"}'), [['n', '"a"', '"b"']]);
    assert.deepStrictEqual(diffRowPair('{"id":9007199254740993,"x":1}', '{"id":9007199254740993,"x":2}'),
        [{ path: 'x', type: 'changed', oldValue: 1, newValue: 2 }]);
}

// --- texts that differ only in line endings or the final newline ---
{
    const crlf = computeJsonlDiff('{"a":1}\r\n{"b":2}\r\n', '{"a":1}\n{"b":2}\n');
    assert.deepStrictEqual(crlf.summary, { added: 0, removed: 0, modified: 0, unchanged: 2 });
    assert.deepStrictEqual(crlf.lineEndingChanges, { lineEndings: true, finalNewline: false });

    const finalNewline = computeJsonlDiff('{"a":1}\n{"b":2}', '{"a":1}\n{"b":2}\n');
    assert.deepStrictEqual(finalNewline.summary, { added: 0, removed: 0, modified: 0, unchanged: 2 });
    assert.deepStrictEqual(finalNewline.lineEndingChanges, { lineEndings: false, finalNewline: true });

    const both = computeJsonlDiff('{"a":1}\r\n{"b":2}', '{"a":1}\n{"b":2}\n');
    assert.deepStrictEqual(both.lineEndingChanges, { lineEndings: true, finalNewline: true });

    // Only the final line's ending differs
    assert.deepStrictEqual(computeJsonlDiff('{"a":1}\n', '{"a":1}\r\n').lineEndingChanges, { lineEndings: true, finalNewline: false });

    // Identical texts, or real changes: nothing to explain
    assert.strictEqual(computeJsonlDiff('{"a":1}\n', '{"a":1}\n').lineEndingChanges, undefined);
    assert.strictEqual(computeJsonlDiff('{"a":1}\r\n', '{"a":2}\n').lineEndingChanges, undefined);
}

console.log('diff tests passed');
