const assert = require('assert');
const { rebuildJsonlText, splitDocumentLines, detectEol } = require('../out/jsonl/documentText');

const parseRows = text => splitDocumentLines(text)
    .map(line => line.trim())
    .filter(Boolean)
    .reduce((rows, line) => {
        try { rows.push(JSON.parse(line)); } catch { /* not a row */ }
        return rows;
    }, []);

// --- line splitting ----------------------------------------------------------

assert.deepStrictEqual(splitDocumentLines(''), []);
assert.deepStrictEqual(splitDocumentLines('a\nb\n'), ['a', 'b', '']);
assert.deepStrictEqual(splitDocumentLines('a\r\nb\r\n'), ['a', 'b', '']);
assert.strictEqual(detectEol('a\r\nb'), '\r\n');
assert.strictEqual(detectEol('a\nb'), '\n');

// --- an unchanged row list reproduces the file exactly ----------------------

const messy = '{"id":12345678901234567890, "v":1.50}\r\n{bad json}\r\n\r\n  {"s":"\\u00e9\\/"}  \r\n0\r\nfalse\r\n""\r\nnull\r\n';
assert.strictEqual(rebuildJsonlText(messy, parseRows(messy)).text, messy);

// --- one cell edit touches one line ------------------------------------------

{
    const text = '{"id":12345678901234567890,"v":1.50,"name":"a"}\r\n{bad json}\r\n\r\n{"id":2,"v":1e3,"name":"\\u00e9"}\r\n';
    const rows = parseRows(text);
    rows[1].name = 'b';
    const result = rebuildJsonlText(text, rows);
    assert.strictEqual(
        result.text,
        '{"id":12345678901234567890,"v":1.50,"name":"a"}\r\n{bad json}\r\n\r\n{"id":2,"v":1000,"name":"b"}\r\n'
    );
    assert.strictEqual(result.errorCount, 1);
    assert.deepStrictEqual(result.lines.map(line => line.rowIndex), [0, null, null, 1, null]);
    assert.ok(result.lines[1].error);
}

// --- deleting rows -----------------------------------------------------------

{
    const text = '{"a":1}\n# not json\n{"a":2}\n{"a":3}\n';
    const rows = parseRows(text);
    assert.strictEqual(rebuildJsonlText(text, rows.filter((_, i) => i !== 1)).text, '{"a":1}\n# not json\n{"a":3}\n');
    assert.strictEqual(rebuildJsonlText(text, rows.slice(1)).text, '# not json\n{"a":2}\n{"a":3}\n');
    assert.strictEqual(rebuildJsonlText(text, rows.slice(0, 2)).text, '{"a":1}\n# not json\n{"a":2}\n');
    assert.strictEqual(rebuildJsonlText(text, []).text, '# not json\n');
}

// --- inserting rows ----------------------------------------------------------

{
    const text = '{"a":1}\n{"a":2}\n';
    const rows = parseRows(text);
    assert.strictEqual(rebuildJsonlText(text, [{}, ...rows]).text, '{}\n{"a":1}\n{"a":2}\n');
    assert.strictEqual(rebuildJsonlText(text, [rows[0], {}, rows[1]]).text, '{"a":1}\n{}\n{"a":2}\n');
    // Appending keeps the trailing newline at the end of the file
    assert.strictEqual(rebuildJsonlText(text, [...rows, {}]).text, '{"a":1}\n{"a":2}\n{}\n');
    // ...and doesn't invent one where there was none
    assert.strictEqual(rebuildJsonlText('{"a":1}', [{ a: 1 }, {}]).text, '{"a":1}\n{}');
    assert.strictEqual(rebuildJsonlText('', [{ a: 1 }]).text, '{"a":1}');
    // A file with no valid rows yet: new rows go before the trailing blank lines
    assert.strictEqual(rebuildJsonlText('{bad\n\n', [{ a: 1 }]).text, '{bad\n{"a":1}\n\n');
}

// --- duplicated and moved rows keep their original spelling -------------------

{
    const text = '{"id": 12345678901234567890}\n{"id": 2}\n';
    const rows = parseRows(text);
    const duplicate = JSON.parse(JSON.stringify(rows[0]));
    assert.strictEqual(
        rebuildJsonlText(text, [rows[0], duplicate, rows[1]]).text,
        '{"id": 12345678901234567890}\n{"id": 12345678901234567890}\n{"id": 2}\n'
    );
    assert.strictEqual(rebuildJsonlText(text, [rows[1], rows[0]]).text, '{"id": 2}\n{"id": 12345678901234567890}\n');
}

// --- rows JSON.parse can't tell apart keep their own lines ------------------------
// IDs beyond 2^53 that are a few apart parse to the same double, so several
// lines can hold "equal" rows. Each must keep its own text, never a neighbour's.

const parseRowsWithSources = text => {
    const rows = [];
    const sources = new WeakMap();
    splitDocumentLines(text).forEach(line => {
        if (!line.trim()) return;
        try {
            const row = JSON.parse(line.trim());
            if (row !== null && typeof row === 'object') sources.set(row, line);
            rows.push(row);
        } catch { /* not a row */ }
    });
    return { rows, sourceTextOf: row => (row !== null && typeof row === 'object' ? sources.get(row) : undefined) };
};

{
    const text =
        '{"user_id":1700000000000000001,"event":"login"}\n' +
        '{"user_id":1700000000000000002,"event":"login"}\n' +
        '{"user_id":1700000000000000003,"event":"login"}\n' +
        '{"user_id":42,"event":"admin"}\n';
    const lines = text.split('\n');

    // Moving an unrelated row past them: by value alone, in their original order
    const plain = parseRows(text);
    assert.strictEqual(
        rebuildJsonlText(text, [plain[3], plain[0], plain[1], plain[2]]).text,
        [lines[3], lines[0], lines[1], lines[2], ''].join('\n')
    );

    // With the caller naming each row's line, any reordering keeps each row's own text
    const { rows, sourceTextOf } = parseRowsWithSources(text);
    assert.strictEqual(
        rebuildJsonlText(text, [rows[3], rows[2], rows[0], rows[1]], sourceTextOf).text,
        [lines[3], lines[2], lines[0], lines[1], ''].join('\n')
    );

    // A duplicate carries its original's line
    const copy = JSON.parse(JSON.stringify(rows[2]));
    const withCopy = rebuildJsonlText(text, [rows[0], rows[1], rows[2], copy, rows[3]],
        row => (row === copy ? lines[2] : sourceTextOf(row))).text;
    assert.strictEqual(withCopy, [lines[0], lines[1], lines[2], lines[2], lines[3], ''].join('\n'));

    // A new row equal to several different lines can't be one of them: it is
    // written as parsed rather than as an arbitrary neighbour's ID
    const pasted = rebuildJsonlText(text, [...rows, { user_id: 1700000000000000001, event: 'login' }], sourceTextOf).text;
    assert.strictEqual(pasted.split('\n')[4], JSON.stringify({ user_id: 1700000000000000001, event: 'login' }));

    // A hint that names some other line (a stale one) is ignored
    assert.strictEqual(
        rebuildJsonlText(text, [rows[3], rows[0], rows[1], rows[2]], () => lines[3]).text,
        [lines[3], lines[0], lines[1], lines[2], ''].join('\n')
    );
}

// --- every row changed: non-row lines stay where they were -------------------

{
    const text = '{"a":1}\n{oops\n{"a":2}\n\n{"a":3}';
    const rows = parseRows(text).map(row => Object.assign({ added: null }, row));
    assert.strictEqual(
        rebuildJsonlText(text, rows).text,
        '{"added":null,"a":1}\n{oops\n{"added":null,"a":2}\n\n{"added":null,"a":3}'
    );
}

// --- falsy bare values are rows like any other --------------------------------

{
    const text = '0\nfalse\n""\nnull\n';
    const rows = parseRows(text);
    assert.deepStrictEqual(rows, [0, false, '', null]);
    rows[1] = true;
    assert.strictEqual(rebuildJsonlText(text, rows).text, '0\ntrue\n""\nnull\n');
}

// --- randomized: output parses to exactly the new rows, and keeps every
// non-row line in order ---------------------------------------------------------

let seed = 12345;
const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
};
const pick = items => items[Math.floor(random() * items.length)];
const rowTexts = ['{"a":1}', '{"a": 1.0}', '{"id":12345678901234567890}', '{"id":12345678901234567891}', '[1,2]', '"x"', '0', 'null', '{"b":{"c":[true]}}', '{"a":1}'];
const otherTexts = ['', '   ', '{broken', 'not json', '{"a":}'];

for (let iteration = 0; iteration < 3000; iteration++) {
    const lineCount = Math.floor(random() * 8);
    const lines = [];
    for (let i = 0; i < lineCount; i++) {
        lines.push(random() < 0.7 ? pick(rowTexts) : pick(otherTexts));
    }
    const eol = random() < 0.3 ? '\r\n' : '\n';
    const text = lines.join(eol) + (random() < 0.5 ? eol : '');
    const rows = parseRows(text);

    assert.strictEqual(rebuildJsonlText(text, rows).text, text, 'identity: ' + JSON.stringify(text));

    const edited = rows.slice();
    const operation = Math.floor(random() * 5);
    const at = Math.floor(random() * (edited.length + 1));
    if (operation === 0) {
        edited.splice(at, 0, { inserted: iteration });
    } else if (operation === 1 && edited.length) {
        edited.splice(Math.min(at, edited.length - 1), 1);
    } else if (operation === 2 && edited.length) {
        edited[Math.min(at, edited.length - 1)] = { changed: iteration };
    } else if (operation === 3 && edited.length > 1) {
        const [moved] = edited.splice(Math.min(at, edited.length - 1), 1);
        edited.splice(Math.floor(random() * (edited.length + 1)), 0, moved);
    } else {
        edited.reverse();
    }

    const result = rebuildJsonlText(text, edited);
    const context = JSON.stringify({ text, edited });
    assert.deepStrictEqual(
        parseRows(result.text).map(row => JSON.stringify(row)),
        edited.map(row => JSON.stringify(row)),
        'rows: ' + context
    );
    const expectedNonRows = splitDocumentLines(text).filter(line => {
        if (!line.trim()) return true;
        try { JSON.parse(line); return false; } catch { return true; }
    });
    const keptNonRows = result.lines.filter(line => line.rowIndex === null).map(line => line.text);
    assert.deepStrictEqual(keptNonRows, expectedNonRows, 'non-row lines: ' + context);
    assert.strictEqual(result.text, result.lines.map(line => line.text).join(eol === '\r\n' && text.includes('\r\n') ? '\r\n' : '\n'), 'join: ' + context);
    assert.ok(!result.text.includes(eol === '\n' ? '\r' : '\r\r'), 'line endings: ' + context);
    result.lines.forEach((line, i) => {
        if (line.rowIndex !== null) {
            assert.strictEqual(JSON.stringify(JSON.parse(line.text)), JSON.stringify(edited[line.rowIndex]), 'mapping ' + i + ': ' + context);
        }
    });

    // Told where each row came from, every row the edit didn't change keeps
    // exactly its own line - even among rows JSON.parse can't tell apart
    const traced = parseRowsWithSources(text);
    const tracedEdited = edited.map(row => {
        const index = rows.indexOf(row);
        return index === -1 ? row : traced.rows[index];
    });
    const tracedResult = rebuildJsonlText(text, tracedEdited, traced.sourceTextOf);
    tracedResult.lines.forEach((line, i) => {
        const source = line.rowIndex === null ? undefined : traced.sourceTextOf(tracedEdited[line.rowIndex]);
        if (source !== undefined) {
            assert.strictEqual(line.text, source, 'source line ' + i + ': ' + context);
        }
    });
}

console.log('documentText tests passed');
