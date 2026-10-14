const assert = require('assert');
const { install, settle } = require('./helpers/fakeVscode');

// JsonlViewerProvider driven end to end against an in-memory `vscode`: real
// document text in, real document text out.

const fake = install();
const { JsonlViewerProvider } = require('../out/jsonlViewerProvider');

// The provider logs every unparseable line; keep the test output readable
const logged = [];
console.error = (...args) => logged.push(args);
console.warn = () => {};
console.log = (...args) => logged.push(args);
const report = message => process.stdout.write(message + '\n');

async function open(provider, path, text) {
    const document = fake.createDocument(path, text);
    const panel = fake.createPanel();
    await provider.resolveCustomTextEditor(document, panel, {});
    return { document, panel };
}

const DEBOUNCE = 400; // updateCell writes after a 300 ms debounce

const tests = [];
const test = (name, run) => tests.push({ name, run });

// --- table edits change only what they touch ----------------------------------

const MESSY = '{"id":12345678901234567890,"v":1.50,"name":"a"}\r\n{bad json}\r\n\r\n{"id":2,"v":1e3,"name":"\\u00e9"}\r\n';

test('a cell edit rewrites one line, keeping invalid lines, number spellings and CRLF', async () => {
    const provider = new JsonlViewerProvider(fake.createContext());
    const { document, panel } = await open(provider, '/t/cell.jsonl', MESSY);
    await panel.send({ type: 'updateCell', rowIndex: 1, columnPath: 'name', value: '"b"' });
    await settle(DEBOUNCE);
    assert.strictEqual(document.getText(),
        '{"id":12345678901234567890,"v":1.50,"name":"a"}\r\n{bad json}\r\n\r\n{"id":2,"v":1000,"name":"b"}\r\n');
    assert.strictEqual(panel.lastUpdate().errorCount, 1);
});

const rowWrites = [
    ['deleteRow', { type: 'deleteRow', rowIndex: 1 }, text => !text.includes('"id":2')],
    ['insertRow', { type: 'insertRow', rowIndex: 1, position: 'below' }, text => text.includes('{}')],
    ['duplicateRow', { type: 'duplicateRow', rowIndex: 0 }, text => text.split('12345678901234567890').length === 3],
    ['pasteRow', { type: 'pasteRow', rowIndex: 0, position: 'above' }, text => text.startsWith('{"pasted":true}')],
    ['reorderRows', { type: 'reorderRows', fromIndex: 1, toIndex: 0 }, text => text.indexOf('"id":2') < text.indexOf('"id":12345678901234567890')],
    ['addColumn', { type: 'addColumn', columnName: 'added', position: 'after', referenceColumn: 'name' }, text => text.includes('"added":null')],
    ['removeColumn', { type: 'removeColumn', columnPath: 'v' }, text => !text.includes('"v"')],
    ['reorderColumns', { type: 'reorderColumns', fromIndex: 2, toIndex: 0 }, text => text.startsWith('{"name":"a","id":')]
];

for (const [name, message, check] of rowWrites) {
    test(`${name} keeps lines it doesn't touch`, async () => {
        const provider = new JsonlViewerProvider(fake.createContext());
        const { document, panel } = await open(provider, `/t/${name}.jsonl`, MESSY);
        fake.answers.warn = 'Delete';
        fake.vscode.env.clipboard.text = '{"pasted":true}';
        await panel.send(message);
        await settle(150);
        const text = document.getText();
        assert.ok(check(text), `${name} did its job: ${JSON.stringify(text)}`);
        assert.ok(text.includes('\r\n{bad json}\r\n'), `${name} kept the invalid line: ${JSON.stringify(text)}`);
        assert.ok(text.endsWith('\r\n'), `${name} kept the trailing newline`);
        assert.ok(!/[^\r]\n/.test(text), `${name} kept CRLF line endings: ${JSON.stringify(text)}`);
        if (name !== 'removeColumn' && name !== 'reorderColumns' && name !== 'addColumn') {
            assert.ok(text.includes('12345678901234567890'), `${name} kept the big integer`);
        }
        assert.strictEqual(panel.lastUpdate().errorCount, 1, `${name} still reports the invalid line`);
    });
}

// IDs beyond 2^53 a few apart parse to the same double; each row must keep its own
const SNOWFLAKES =
    '{"user_id":1700000000000000001,"event":"login"}\n' +
    '{"user_id":1700000000000000002,"event":"login"}\n' +
    '{"user_id":1700000000000000003,"event":"login"}\n' +
    '{"user_id":42,"event":"admin"}\n';
const snowflakeLines = SNOWFLAKES.split('\n');

for (const [name, message, expected] of [
    ['dragging another row past them', { type: 'reorderRows', fromIndex: 3, toIndex: 0 }, [3, 0, 1, 2]],
    ['a permanent sort', { type: 'sortRows', columnPath: 'event', direction: 'asc' }, [3, 0, 1, 2]],
    ['reversing them by drag', { type: 'reorderRows', fromIndex: 2, toIndex: 0 }, [2, 0, 1, 3]],
    ['duplicating one', { type: 'duplicateRow', rowIndex: 2 }, [0, 1, 2, 2, 3]]
]) {
    test(`big IDs that parse alike keep their own lines through ${name}`, async () => {
        const provider = new JsonlViewerProvider(fake.createContext());
        const { document, panel } = await open(provider, `/t/snow-${message.type}.jsonl`, SNOWFLAKES);
        await panel.send(message);
        await settle(150);
        assert.strictEqual(document.getText(), expected.map(i => snowflakeLines[i]).join('\n') + '\n');
    });
}

test('big IDs keep their own lines through two moves in a row', async () => {
    const provider = new JsonlViewerProvider(fake.createContext());
    const { document, panel } = await open(provider, '/t/snow-twice.jsonl', SNOWFLAKES);
    await panel.send({ type: 'reorderRows', fromIndex: 2, toIndex: 0 });
    await settle(150);
    await panel.send({ type: 'reorderRows', fromIndex: 3, toIndex: 0 });
    await settle(150);
    assert.strictEqual(document.getText(), [3, 2, 0, 1].map(i => snowflakeLines[i]).join('\n') + '\n');
});

test('editing a flat dotted key edits that key', async () => {
    const provider = new JsonlViewerProvider(fake.createContext());
    const { document, panel } = await open(provider, '/t/dotted.jsonl', '{"user.name":"ann","log.level":"info"}\n{"log.level":"warn"}\n');
    assert.deepStrictEqual(panel.lastUpdate().columns.map(col => col.path), ['user.name', 'log.level']);
    await panel.send({ type: 'updateCell', rowIndex: 0, columnPath: 'user.name', value: '"zed"' });
    // A row without the key gets the key, not a nested object
    await panel.send({ type: 'updateCell', rowIndex: 1, columnPath: 'user.name', value: '"bob"' });
    await settle(DEBOUNCE);
    assert.strictEqual(document.getText(), '{"user.name":"zed","log.level":"info"}\n{"log.level":"warn","user.name":"bob"}\n');
});

test('editing a bare value replaces the row', async () => {
    const provider = new JsonlViewerProvider(fake.createContext());
    const { document, panel } = await open(provider, '/t/bare.jsonl', '0\n"text"\nfalse\n');
    await panel.send({ type: 'updateCell', rowIndex: 0, columnPath: '(value)', value: '5' });
    await panel.send({ type: 'updateCell', rowIndex: 2, columnPath: '(value)', value: 'true' });
    await settle(DEBOUNCE);
    assert.strictEqual(document.getText(), '5\n"text"\ntrue\n');
});

test('updateCells applies a batch in one edit and skips malformed entries', async () => {
    const provider = new JsonlViewerProvider(fake.createContext());
    const { document, panel } = await open(provider, '/t/batch.jsonl', '{"a":"x"}\n{"a":"y"}\n');
    await panel.send({
        type: 'updateCells',
        edits: [
            { rowIndex: 0, columnPath: 'a', value: '"1"' },
            { rowIndex: 1, columnPath: 'a', value: '2' },
            { rowIndex: 7, columnPath: 'a', value: '3' },
            { rowIndex: 0, value: 'no column' }
        ]
    });
    await settle(DEBOUNCE);
    assert.strictEqual(document.getText(), '{"a":"1"}\n{"a":2}\n');
});

// --- a cell edit is in the document as soon as it is made -------------------------

test('a cell edit is in the document before a save right after it', async () => {
    const provider = new JsonlViewerProvider(fake.createContext());
    const { document, panel } = await open(provider, '/t/save-now.jsonl', '{"id":1,"price":10}\n{"id":2,"price":20}\n');
    await panel.send({ type: 'updateCell', rowIndex: 0, columnPath: 'price', value: '99' });
    // Ctrl+S straight after Enter
    await document.save();
    assert.strictEqual(document.getText(), '{"id":1,"price":99}\n{"id":2,"price":20}\n');
});

test('closing the editor right after a cell edit keeps the edit', async () => {
    const provider = new JsonlViewerProvider(fake.createContext());
    const { document, panel } = await open(provider, '/t/close-now.jsonl', '{"id":1,"price":10}\n');
    await panel.send({ type: 'updateCell', rowIndex: 0, columnPath: 'price', value: '99' });
    panel.dispose();
    await settle(DEBOUNCE);
    assert.strictEqual(document.getText(), '{"id":1,"price":99}\n');
    assert.strictEqual(document.isDirty, true, 'an unsaved edit leaves the document dirty, so closing asks to save');
});

// --- sorting uses what the column holds now ---------------------------------------

test('a column filled with numbers by editing sorts as numbers', async () => {
    const provider = new JsonlViewerProvider(fake.createContext());
    const { document, panel } = await open(provider, '/t/retype.jsonl',
        '{"item":"a","price":"tbd"}\n{"item":"b","price":"tbd"}\n{"item":"c","price":"tbd"}\n{"item":"d","price":"tbd"}\n');
    assert.strictEqual(panel.lastUpdate().columnTypes.price, 'string');
    await panel.send({ type: 'updateCells', edits: [
        { rowIndex: 0, columnPath: 'price', value: '2.5' }, { rowIndex: 1, columnPath: 'price', value: '-3' },
        { rowIndex: 2, columnPath: 'price', value: '2.25' }, { rowIndex: 3, columnPath: 'price', value: '-20' }
    ] });
    await settle(DEBOUNCE);
    assert.strictEqual(panel.lastUpdate().columnTypes.price, 'number');

    await panel.send({ type: 'setDisplaySort', columnPath: 'price', direction: 'asc' });
    assert.deepStrictEqual(panel.lastUpdate().rows.map(row => row.price), [-20, -3, 2.25, 2.5]);

    await panel.send({ type: 'sortRows', columnPath: 'price', direction: 'asc' });
    await settle(150);
    assert.strictEqual(document.getText(),
        '{"item":"d","price":-20}\n{"item":"b","price":-3}\n{"item":"c","price":2.25}\n{"item":"a","price":2.5}\n');
});

// --- adding a column never touches values that are already there ----------------

function sparseNotes() {
    // One row in twenty has notes: under the 10% it takes to be shown as a column
    const lines = [];
    for (let i = 1; i <= 20; i++) {
        lines.push(i === 7 ? `{"id":${i},"notes":"refund approved"}` : `{"id":${i}}`);
    }
    return lines.join('\n') + '\n';
}

test('adding a column named like a field the table does not show is refused', async () => {
    const provider = new JsonlViewerProvider(fake.createContext());
    const text = sparseNotes();
    const { document, panel } = await open(provider, '/t/sparse.jsonl', text);
    assert.deepStrictEqual(panel.lastUpdate().columns.map(col => col.path), ['id']);
    await panel.send({ type: 'addColumn', columnName: 'notes', position: 'after', referenceColumn: 'id' });
    await settle(150);
    assert.strictEqual(document.getText(), text);
    assert.ok(fake.messages.error.some(message => message.includes('"notes" already exists')), JSON.stringify(fake.messages.error));
});

test('adding a column named like a nested field is refused', async () => {
    const provider = new JsonlViewerProvider(fake.createContext());
    const text = '{"id":1,"user":{"name":"Ann"}}\n{"id":2,"user":{"name":"Bob"}}\n';
    const { document, panel } = await open(provider, '/t/nested-add.jsonl', text);
    await panel.send({ type: 'addColumn', columnName: 'user.name', position: 'after', referenceColumn: 'id' });
    await settle(150);
    assert.strictEqual(document.getText(), text);
});

test('adding a column again where it only holds nulls still works', async () => {
    const provider = new JsonlViewerProvider(fake.createContext());
    const { document, panel } = await open(provider, '/t/nulls.jsonl', '{"id":1,"tag":null}\n{"id":2,"tag":null}\n');
    await panel.send({ type: 'addColumn', columnName: 'tag', position: 'before', referenceColumn: 'id' });
    await settle(150);
    assert.strictEqual(document.getText(), '{"tag":null,"id":1}\n{"tag":null,"id":2}\n');
});

test('adding a column skips rows that are not objects', async () => {
    const provider = new JsonlViewerProvider(fake.createContext());
    const { document, panel } = await open(provider, '/t/mixed-add.jsonl', '{"id":1}\nnull\n"text"\n{"id":2}\n');
    await panel.send({ type: 'addColumn', columnName: 'tag', position: 'after', referenceColumn: 'id' });
    await settle(150);
    assert.strictEqual(document.getText(), '{"id":1,"tag":null}\nnull\n"text"\n{"id":2,"tag":null}\n');
});

test('a file that starts with a bare null still reloads after a column was added', async () => {
    const provider = new JsonlViewerProvider(fake.createContext());
    const { document, panel } = await open(provider, '/t/null-first.jsonl', '{"id":1}\n{"id":2}\n');
    await panel.send({ type: 'addColumn', columnName: 'tag', position: 'after', referenceColumn: 'id' });
    await settle(250);
    fake.changeExternally(document, 'null\n{"id":1,"tag":null}\n{"id":2,"tag":"x"}\n');
    await settle(20);
    const update = panel.lastUpdate();
    assert.deepStrictEqual(update.rows, [null, { id: 1, tag: null }, { id: 2, tag: 'x' }]);
    assert.strictEqual(update.errorCount, 0);
    assert.ok(update.columns.some(col => col.path === 'tag'));
});

// --- expanding and collapsing columns ---------------------------------------------

const visiblePaths = panel => panel.lastUpdate().columns.filter(col => col.visible).map(col => col.path);

test('collapsing a column also collapses the columns expanded inside it', async () => {
    const provider = new JsonlViewerProvider(fake.createContext());
    const { panel } = await open(provider, '/t/collapse.jsonl',
        '{"id":1,"user":{"name":"ann","address":{"city":"Oslo","zip":"0150"}}}\n' +
        '{"id":2,"user":{"name":"bob","address":{"city":"Rome","zip":"00100"}}}\n');
    await panel.send({ type: 'expandColumn', columnPath: 'user' });
    await panel.send({ type: 'expandColumn', columnPath: 'user.address' });
    assert.deepStrictEqual(visiblePaths(panel), ['id', 'user.address.city', 'user.address.zip', 'user.name']);
    await panel.send({ type: 'collapseColumn', columnPath: 'user' });
    assert.deepStrictEqual(visiblePaths(panel), ['id', 'user']);
    assert.deepStrictEqual(panel.lastUpdate().columns.map(col => col.path), ['id', 'user']);
    await panel.send({ type: 'expandColumn', columnPath: 'user' });
    assert.deepStrictEqual(visiblePaths(panel), ['id', 'user.address', 'user.name']);
});

test('a column of empty arrays or objects is not expanded into nothing', async () => {
    const provider = new JsonlViewerProvider(fake.createContext());
    const { panel } = await open(provider, '/t/empty-expand.jsonl', '{"id":1,"tags":[],"meta":{}}\n{"id":2,"tags":[],"meta":{}}\n');
    await panel.send({ type: 'expandColumn', columnPath: 'tags' });
    await panel.send({ type: 'expandColumn', columnPath: 'meta' });
    assert.deepStrictEqual(visiblePaths(panel), ['id', 'tags', 'meta']);
    assert.ok(panel.lastUpdate().columns.every(col => !col.isExpanded));
});

test('expanding while searching makes a column for every field, not just the matches\'', async () => {
    const provider = new JsonlViewerProvider(fake.createContext());
    const { panel } = await open(provider, '/t/expand-search.jsonl',
        '{"lvl":"error","meta":{"code":500}}\n{"lvl":"info","meta":{"user":"ann","ms":12}}\n');
    await panel.send({ type: 'search', searchTerm: 'error' });
    await panel.send({ type: 'expandColumn', columnPath: 'meta' });
    await panel.send({ type: 'search', searchTerm: '' });
    assert.deepStrictEqual(visiblePaths(panel), ['lvl', 'meta.code', 'meta.ms', 'meta.user']);
});

test('a column that was expanded comes back visible when the file is reopened', async () => {
    const context = fake.createContext();
    const text = '{"id":1,"note":"x","meta":{"a":1}}\n{"id":2,"note":"y","meta":{"a":2}}\n';
    const first = await open(new JsonlViewerProvider(context), '/t/prefs.jsonl', text);
    await first.panel.send({ type: 'expandColumn', columnPath: 'meta' });
    await first.panel.send({ type: 'toggleColumnVisibility', columnPath: 'note' });
    assert.deepStrictEqual(visiblePaths(first.panel), ['id', 'meta.a']);

    const again = await open(new JsonlViewerProvider(context), '/t/prefs.jsonl', text);
    assert.deepStrictEqual(visiblePaths(again.panel), ['id', 'meta']);
});

// --- Pretty Print edits merge into the document ---------------------------------

test('a Pretty Print edit keeps invalid lines and untouched rows as written', async () => {
    const provider = new JsonlViewerProvider(fake.createContext());
    const text = '{"id": 12345678901234567890}\n{oops\n{"id": 2}\n';
    const { document, panel } = await open(provider, '/t/pretty.jsonl', text);
    const pretty = panel.lastUpdate().prettyContent.replace('"id": 2', '"id": 3');
    await panel.send({ type: 'prettyContentChanged', newContent: pretty });
    assert.strictEqual(document.getText(), '{"id": 12345678901234567890}\n{oops\n{"id":3}\n');
});

test('a Pretty Print edit built from a partly loaded file is refused', async () => {
    const provider = new JsonlViewerProvider(fake.createContext());
    const { document, panel } = await open(provider, '/t/partial.jsonl', '{"a":1}\n{"a":2}\n');
    await panel.send({ type: 'prettyContentChanged', newContent: '{"a":1}', partial: true });
    assert.strictEqual(document.getText(), '{"a":1}\n{"a":2}\n');
    assert.ok(fake.messages.warn.some(message => message.includes('finished loading')));
});

// --- several open editors share one provider -------------------------------------

test('each editor works on its own document', async () => {
    const provider = new JsonlViewerProvider(fake.createContext());
    const a = await open(provider, '/t/A.jsonl', '{"a":1}\n{"a":2}\n{"a":3}\n');
    await a.panel.send({ type: 'search', searchTerm: '2' });
    const b = await open(provider, '/t/B.jsonl', '{"secret":"bbb"}\n{"secret":"2"}\n');
    // B starts without A's search
    assert.strictEqual(b.panel.lastUpdate().rows.length, 2);

    // Back in A: edit, then edit B before A's debounced save has run
    await a.panel.send({ type: 'updateCell', rowIndex: 1, columnPath: 'a', value: '200' });
    await b.panel.send({ type: 'updateCell', rowIndex: 0, columnPath: 'secret', value: '"ccc"' });
    await settle(DEBOUNCE);
    assert.strictEqual(a.document.getText(), '{"a":1}\n{"a":200}\n{"a":3}\n');
    assert.strictEqual(b.document.getText(), '{"secret":"ccc"}\n{"secret":"2"}\n');

    fake.answers.warn = 'Delete';
    await a.panel.send({ type: 'deleteRow', rowIndex: 0 });
    await settle(150);
    assert.strictEqual(a.document.getText(), '{"a":200}\n{"a":3}\n');
    assert.strictEqual(b.document.getText(), '{"secret":"ccc"}\n{"secret":"2"}\n');
    // A kept its search
    assert.deepStrictEqual(a.panel.lastUpdate().rows, [{ a: 200 }]);

    // B changed on disk while A was in use: focusing B's tab reloads it
    fake.changeExternally(b.document, '{"secret":"zzz"}\n');
    await b.panel.focus();
    await settle(20);
    assert.deepStrictEqual(b.panel.lastUpdate().rows, [{ secret: 'zzz' }]);
    // ...and A's view was never sent B's rows
    assert.ok(a.panel.posted.every(m => m.type !== 'update' || !JSON.stringify(m.data.rows).includes('secret')));
});

// --- background chunk loading ---------------------------------------------------

function bigFile(count, prefix) {
    let text = '';
    for (let i = 0; i < count; i++) {
        text += JSON.stringify({ id: i, tag: prefix + i }) + '\n';
    }
    return text;
}

test('an edit made while the file is still loading keeps the rest of the file', async () => {
    const provider = new JsonlViewerProvider(fake.createContext());
    const text = bigFile(5000, 'r');
    const { document, panel } = await open(provider, '/t/loading.jsonl', text);
    assert.ok(panel.lastUpdate().loadingProgress.loadingChunks, 'still loading after the first chunks');
    await panel.send({ type: 'updateCell', rowIndex: 0, columnPath: 'tag', value: '"edited"' });
    await settle(DEBOUNCE + 200);
    const lines = document.getText().split('\n');
    assert.strictEqual(lines.length, 5001);
    assert.strictEqual(lines[0], '{"id":0,"tag":"edited"}');
    assert.strictEqual(lines[4999], '{"id":4999,"tag":"r4999"}');
});

test('a reload during background loading does not mix in the old lines', async () => {
    const provider = new JsonlViewerProvider(fake.createContext());
    const { document, panel } = await open(provider, '/t/reload.jsonl', bigFile(5000, 'old'));
    fake.changeExternally(document, bigFile(4000, 'new'));
    await settle(500);
    const update = panel.lastUpdate();
    assert.strictEqual(update.loadingProgress.loadingChunks, false);
    assert.strictEqual(update.rows.length, 4000);
    assert.ok(update.rows.every((row, i) => row.tag === 'new' + i));
});

test('a search made during loading covers the rows loaded after it', async () => {
    const provider = new JsonlViewerProvider(fake.createContext());
    // 4950 rows: the last stretch loads after the final progress update
    const { panel } = await open(provider, '/t/search.jsonl', bigFile(4950, 'r'));
    await panel.send({ type: 'search', searchTerm: '"r49' });
    await settle(500);
    // r49, r490-r499, r4900-r4949
    assert.strictEqual(panel.lastUpdate().rows.length, 1 + 10 + 50);
});

test('a search survives the file changing on disk', async () => {
    const provider = new JsonlViewerProvider(fake.createContext());
    const { document, panel } = await open(provider, '/t/follow.jsonl', '{"lvl":"info"}\n{"lvl":"error"}\n');
    await panel.send({ type: 'search', searchTerm: 'error' });
    fake.changeExternally(document, '{"lvl":"info"}\n{"lvl":"error"}\n{"lvl":"error","n":2}\n');
    await settle(20);
    assert.strictEqual(panel.lastUpdate().rows.length, 2);
});

(async () => {
    for (const { name, run } of tests) {
        fake.messages.warn.length = 0;
        try {
            await run();
        } catch (error) {
            report('FAILED: ' + name);
            logged.forEach(args => report('  log: ' + args.map(String).join(' ')));
            throw error;
        }
        logged.length = 0;
    }
    report(`provider tests passed (${tests.length})`);
})().catch(error => {
    process.stderr.write((error && error.stack) || String(error));
    process.stderr.write('\n');
    process.exit(1);
});
