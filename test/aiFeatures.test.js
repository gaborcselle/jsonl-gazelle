const assert = require('assert');
const { install, settle } = require('./helpers/fakeVscode');

// The AI features driven end to end: the provider builds the prompts, a stubbed
// fetch plays the model, and the document text is checked afterwards.

const fake = install();
const { JsonlViewerProvider } = require('../out/jsonlViewerProvider');

const logged = [];
console.error = (...args) => logged.push(args);
console.warn = () => {};
console.log = (...args) => logged.push(args);
const report = message => process.stdout.write(message + '\n');

function context() {
    const ctx = fake.createContext();
    ctx.secrets.get = async key => (key === 'openaiApiKey' ? 'sk-test' : undefined);
    return ctx;
}

async function open(path, text, ctx = context()) {
    const provider = new JsonlViewerProvider(ctx);
    const document = fake.createDocument(path, text);
    const panel = fake.createPanel();
    await provider.resolveCustomTextEditor(document, panel, {});
    return { provider, document, panel, ctx };
}

function response(status, body) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => text,
        json: async () => JSON.parse(text),
        clone() { return response(status, body); }
    };
}

// answer(userPrompt, callNumber) -> model text, or { status, body } for an HTTP error
function model(answer) {
    const prompts = [];
    global.fetch = async (_url, init) => {
        const body = JSON.parse(init.body);
        const prompt = body.messages.find(m => m.role === 'user').content;
        prompts.push(prompt);
        const reply = await answer(prompt, prompts.length);
        if (reply && typeof reply === 'object') {
            return response(reply.status, reply.body);
        }
        return response(200, { choices: [{ message: { content: reply } }] });
    };
    return prompts;
}

const aiColumn = (columnName, promptTemplate, extra = {}) => Object.assign(
    { type: 'addAIColumn', columnName, promptTemplate, position: 'after', referenceColumn: 'id', enumValues: null }, extra);

const tests = [];
const test = (name, run) => tests.push({ name, run });

// --- an AI column never overwrites what is there ---------------------------------

test('an AI column named like a field the table does not show is refused', async () => {
    const lines = [];
    for (let i = 1; i <= 20; i++) lines.push(i === 7 ? `{"id":${i},"notes":"keep me"}` : `{"id":${i}}`);
    const text = lines.join('\n') + '\n';
    const { document, panel } = await open('/ai/sparse.jsonl', text);
    const prompts = model(() => 'AI');
    await panel.send(aiColumn('notes', 'x'));
    assert.strictEqual(document.getText(), text);
    assert.strictEqual(prompts.length, 0, 'nothing was sent to the model');
    assert.ok(fake.messages.error.some(m => m.includes('"notes" already exists')));
});

test('an AI column named like a nested field is refused', async () => {
    const text = '{"id":1,"user":{"name":"Ann"}}\n{"id":2,"user":{"name":"Bob"}}\n';
    const { document, panel } = await open('/ai/nested.jsonl', text);
    const prompts = model(() => 'AI');
    await panel.send(aiColumn('user.name', 'x'));
    assert.strictEqual(document.getText(), text);
    assert.strictEqual(prompts.length, 0);
});

test('an AI column fills the object rows of a file that also has bare values', async () => {
    const { document, panel } = await open('/ai/mixed.jsonl', '{"id":1}\nnull\n{"id":3}\n');
    model(prompt => 'v' + prompt);
    await panel.send(aiColumn('label', '{{row.id}}'));
    assert.strictEqual(document.getText(), '{"id":1,"label":"v1"}\nnull\n{"id":3,"label":"v3"}\n');
});

// --- other changes while the model is working ---------------------------------------

test('a change from outside while an AI column is generating is kept, not overwritten', async () => {
    const { document, panel } = await open('/ai/outside.jsonl', '{"id":1}\n{"id":2}\n');
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    model(async () => { await gate; return 'AI'; });
    const pending = panel.send(aiColumn('label', 'x'));
    await settle(20);
    fake.changeExternally(document, '{"id":1}\n{"id":2,"fixed":true}\n{"id":3}\n');
    release();
    await pending;
    await settle(20);
    assert.strictEqual(document.getText(), '{"id":1}\n{"id":2,"fixed":true}\n{"id":3}\n');
    assert.deepStrictEqual(panel.lastUpdate().rows, [{ id: 1 }, { id: 2, fixed: true }, { id: 3 }]);
    assert.ok(fake.messages.warn.some(m => m.includes('changed')), JSON.stringify(fake.messages.warn));
});

test('a change from outside while AI rows are generating is kept, not overwritten', async () => {
    const { document, panel } = await open('/ai/outside-rows.jsonl', '{"id":1}\n{"id":2}\n');
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    model(async () => { await gate; return '[{"id":100}]'; });
    const pending = panel.send({ type: 'generateAIRows', rowIndex: 0, contextRowCount: 1, rowCount: 1, promptTemplate: '{{context_rows}}' });
    await settle(20);
    fake.changeExternally(document, '{"id":1}\n{"id":2,"fixed":true}\n{"id":4}\n');
    release();
    await pending;
    await settle(20);
    assert.strictEqual(document.getText(), '{"id":1}\n{"id":2,"fixed":true}\n{"id":4}\n');
});

test('table edits are turned away while an AI column is generating', async () => {
    const { document, panel } = await open('/ai/busy.jsonl', '{"id":1,"name":"r1"}\n{"id":2,"name":"r2"}\n{"id":3,"name":"r3"}\n');
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    model(async prompt => { await gate; return 'L-' + prompt; });
    const pending = panel.send(aiColumn('label', '{{row.name}}'));
    await settle(20);
    for (const message of [
        { type: 'insertRow', rowIndex: 0, position: 'above' },
        { type: 'updateCell', rowIndex: 0, columnPath: 'name', value: '"edited"' },
        { type: 'rawContentChanged', newContent: '{"id":9}\n' }
    ]) {
        await panel.send(message);
    }
    assert.ok(fake.messages.warn.some(m => m.includes('still running')), JSON.stringify(fake.messages.warn));
    release();
    await pending;
    await settle(250);
    assert.strictEqual(document.getText(),
        '{"id":1,"label":"L-r1","name":"r1"}\n{"id":2,"label":"L-r2","name":"r2"}\n{"id":3,"label":"L-r3","name":"r3"}\n');
    assert.ok(!document.getText().includes('generating'));
});

// --- failures -------------------------------------------------------------------------

test('one failed request leaves that cell empty and keeps the rest', async () => {
    const { document, panel } = await open('/ai/one-fails.jsonl', '{"id":1}\n{"id":2}\n{"id":3}\n');
    model(prompt => (prompt === '2' ? { status: 429, body: { error: { message: 'Rate limit reached' } } } : 'v' + prompt));
    fake.messages.error.length = 0;
    await panel.send(aiColumn('label', '{{row.id}}'));
    assert.strictEqual(document.getText(), '{"id":1,"label":"v1"}\n{"id":2,"label":null}\n{"id":3,"label":"v3"}\n');
    assert.strictEqual(fake.messages.error.length, 0);
    assert.strictEqual(fake.messages.warn.filter(m => m.includes('1 of 3')).length, 1, JSON.stringify(fake.messages.warn));
});

test('when every request fails nothing is added, and no placeholder lingers', async () => {
    const text = '{"id":1,"user":{"name":"Ann"}}\n{"id":2,"user":{"name":"Bob"}}\n{"id":3}\n';
    const { document, panel } = await open('/ai/all-fail.jsonl', text);
    model(() => ({ status: 401, body: { error: { message: 'Invalid API key' } } }));
    fake.messages.error.length = 0;
    await panel.send(aiColumn('user.score', 'x'));
    assert.strictEqual(document.getText(), text);
    assert.strictEqual(fake.messages.error.length, 1, JSON.stringify(fake.messages.error));
    assert.deepStrictEqual(panel.lastUpdate().rows, [{ id: 1, user: { name: 'Ann' } }, { id: 2, user: { name: 'Bob' } }, { id: 3 }]);
    // The next ordinary edit writes the rows as they were
    await panel.send({ type: 'updateCell', rowIndex: 0, columnPath: 'id', value: '10' });
    await settle(250);
    assert.strictEqual(document.getText(), '{"id":10,"user":{"name":"Ann"}}\n{"id":2,"user":{"name":"Bob"}}\n{"id":3}\n');
});

test('a failing model is not asked for every remaining row', async () => {
    const rows = [];
    for (let i = 0; i < 100; i++) rows.push(`{"id":${i}}`);
    const { panel } = await open('/ai/stop.jsonl', rows.join('\n') + '\n');
    const prompts = model(() => ({ status: 429, body: { error: { message: 'You exceeded your current quota' } } }));
    await panel.send(aiColumn('label', 'x'));
    assert.ok(prompts.length <= 10, `${prompts.length} requests`);
});

// --- prompts ------------------------------------------------------------------------

test('{{row}} shows the row as it is, without the placeholder', async () => {
    const { panel } = await open('/ai/prompt-row.jsonl', '{"id":1,"price":"$$","note":"cost $& more $\' end"}\n');
    const prompts = model(() => 'ok');
    await panel.send(aiColumn('label', 'ROW={{row}}'));
    assert.strictEqual(prompts[0], 'ROW={"id":1,"price":"$$","note":"cost $& more $\' end"}');
});

test('{{row.field}} takes any field name, and shows objects as JSON', async () => {
    const row = { id: 1, 'first-name': 'Ann', 'Full Name': 'Ann Lee', '@timestamp': 't0', user: { a: 1 }, tags: ['a', 'b'], price: '$$' };
    const { panel } = await open('/ai/prompt-fields.jsonl', JSON.stringify(row) + '\n');
    const prompts = model(() => 'ok');
    await panel.send(aiColumn('label', '{{row.first-name}}|{{row.Full Name}}|{{row.@timestamp}}|{{row.user}}|{{row.tags}}|{{row.price}}|{{row.missing}}'));
    assert.strictEqual(prompts[0], 'Ann|Ann Lee|t0|{"a":1}|["a","b"]|$$|');
});

test('{{context_rows}} keeps $ sequences', async () => {
    const { panel } = await open('/ai/prompt-context.jsonl', '{"id":1,"price":"$$$$"}\n');
    const prompts = model(() => '[{"id":2,"price":"$$"}]');
    await panel.send({ type: 'generateAIRows', rowIndex: 0, contextRowCount: 1, rowCount: 1, promptTemplate: 'CTX {{context_rows}} END' });
    assert.ok(prompts[0].startsWith('CTX [\n  {\n    "id": 1,\n    "price": "$$$$"\n  }\n] END'), prompts[0]);
});

// --- answers ---------------------------------------------------------------------------

test('an answer is only made a number when it is one', async () => {
    const answers = ['02134', '+14155550123', '12345678901234567890', '0x1F', '1e999', 'Infinity', '42', '-3.5', 'true', ' 7 '];
    const { document, panel } = await open('/ai/coerce.jsonl', answers.map((_, i) => `{"id":${i}}`).join('\n') + '\n');
    model(prompt => answers[Number(prompt)]);
    await panel.send(aiColumn('v', '{{row.id}}'));
    const values = document.getText().trim().split('\n').map(line => JSON.parse(line).v);
    assert.deepStrictEqual(values, ['02134', '+14155550123', '12345678901234567890', '0x1F', '1e999', 'Infinity', 42, -3.5, true, 7]);
});

test('generated rows keep every field the context rows have', async () => {
    const { document, panel } = await open('/ai/union.jsonl', '{"id":1}\n{"id":2,"email":"b@x.com","tags":["y"]}\n');
    model(() => '[{"id":3,"email":"c@x.com","tags":["z"],"extra":1}]');
    await panel.send({ type: 'generateAIRows', rowIndex: 1, contextRowCount: 2, rowCount: 1, promptTemplate: '{{context_rows}}' });
    assert.strictEqual(document.getText(), '{"id":1}\n{"id":2,"email":"b@x.com","tags":["y"]}\n{"id":3,"email":"c@x.com","tags":["z"]}\n');
});

test('generated rows in a file of bare values stay bare values', async () => {
    const numbers = await open('/ai/bare-numbers.jsonl', '1\n2\n3\n');
    model(() => '[4, "5"]');
    await numbers.panel.send({ type: 'generateAIRows', rowIndex: 2, contextRowCount: 3, rowCount: 2, promptTemplate: '{{context_rows}}' });
    assert.strictEqual(numbers.document.getText(), '1\n2\n3\n4\n5\n');

    const words = await open('/ai/bare-words.jsonl', '"apple"\n"pear"\n');
    model(() => '["kiwi","fig"]');
    await words.panel.send({ type: 'generateAIRows', rowIndex: 1, contextRowCount: 2, rowCount: 2, promptTemplate: '{{context_rows}}' });
    assert.strictEqual(words.document.getText(), '"apple"\n"pear"\n"kiwi"\n"fig"\n');
});

test('generated rows are found in chatty answers and in JSONL answers', async () => {
    const chatty = await open('/ai/chatty.jsonl', '{"id":1,"rating":4}\n');
    model(() => 'Here are [2] rows:\n```JSON\n[{"id":2,"rating":"n/a"},{"id":3,"rating":"5"}]\n```\nEnjoy [really].');
    await chatty.panel.send({ type: 'generateAIRows', rowIndex: 0, contextRowCount: 1, rowCount: 2, promptTemplate: '{{context_rows}}' });
    assert.strictEqual(chatty.document.getText(), '{"id":1,"rating":4}\n{"id":2,"rating":"n/a"}\n{"id":3,"rating":5}\n');

    const jsonl = await open('/ai/jsonl-answer.jsonl', '{"id":1}\n');
    model(() => '{"id":2}\n{"id":3}');
    await jsonl.panel.send({ type: 'generateAIRows', rowIndex: 0, contextRowCount: 1, rowCount: 2, promptTemplate: '{{context_rows}}' });
    assert.strictEqual(jsonl.document.getText(), '{"id":1}\n{"id":2}\n{"id":3}\n');
});

// --- the hidden reset ------------------------------------------------------------------

test('resetting the rating prompt state also clears when it was last shown', async () => {
    const ctx = context();
    await ctx.globalState.update('jsonl-gazelle.lastPromptAt', Date.now());
    await ctx.globalState.update('jsonl-gazelle.hasRated', true);
    const { panel } = await open('/ai/reset.jsonl', '{"id":1}\n', ctx);
    await panel.send({ type: 'resetSettings' });
    assert.strictEqual(ctx.globalState.get('jsonl-gazelle.lastPromptAt', 0), 0);
    assert.strictEqual(ctx.globalState.get('jsonl-gazelle.hasRated', false), false);
});

(async () => {
    for (const { name, run } of tests) {
        fake.messages.warn.length = 0;
        fake.messages.error.length = 0;
        try {
            await run();
        } catch (error) {
            report('FAILED: ' + name);
            logged.forEach(args => report('  log: ' + args.map(String).join(' ')));
            throw error;
        }
        logged.length = 0;
    }
    report(`aiFeatures tests passed (${tests.length})`);
})().catch(error => {
    process.stderr.write((error && error.stack) || String(error));
    process.stderr.write('\n');
    process.exit(1);
});
