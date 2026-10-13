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
