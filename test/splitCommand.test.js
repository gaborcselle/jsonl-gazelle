const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { install } = require('./helpers/fakeVscode');

// The "Split Large File into Parts" command (jsonl-gazelle.openLargeFile),
// run through activate() against an in-memory `vscode` and a real folder.

const fake = install();
const { vscode } = fake;

// What activate() registers beyond what the provider tests need
const commands = new Map();
vscode.commands.registerCommand = (id, handler) => {
    commands.set(id, handler);
    return { dispose() {} };
};
vscode.workspace.onWillSaveTextDocument = () => ({ dispose() {} });
vscode.window.registerFileDecorationProvider = () => ({ dispose() {} });
vscode.window.tabGroups = { activeTabGroup: { activeTab: undefined } };
vscode.TabInputCustom = class {};
vscode.TabInputText = class {};

// Record every argument, so the modal flag and the buttons can be checked
const shown = { warn: [], error: [], info: [] };
let warningAnswer;
vscode.window.showWarningMessage = async (message, ...rest) => {
    shown.warn.push({ message, options: rest[0], items: rest.slice(1) });
    return warningAnswer === undefined ? undefined : warningAnswer(rest.slice(1));
};
vscode.window.showErrorMessage = async message => { shown.error.push(message); };
vscode.window.showInformationMessage = async message => { shown.info.push(message); };

const { activate } = require('../out/extension');
activate(fake.createContext());
const splitCommand = commands.get('jsonl-gazelle.openLargeFile');
assert.ok(splitCommand, 'the split command is registered');

// Every file counts as large; parts of PART_BYTES bytes
const PART_BYTES = 100;
fake.config['largeFile.splitThresholdMB'] = 0;
fake.config['largeFile.partSizeMB'] = PART_BYTES / (1024 * 1024);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-split-command-'));

function folderWith(input) {
    const dir = fs.mkdtempSync(path.join(root, 'f-'));
    const inputPath = path.join(dir, 'events.jsonl');
    fs.writeFileSync(inputPath, input);
    return { dir, inputPath };
}

function listing(dir) {
    return Object.fromEntries(fs.readdirSync(dir).sort().map(name => {
        const full = path.join(dir, name);
        return [name, fs.statSync(full).isDirectory() ? '<dir>' : fs.readFileSync(full, 'utf8')];
    }));
}

function eventsParts(dir) {
    return fs.readdirSync(dir)
        .filter(name => /^events_part[1-9]\d*\.jsonl$/.test(name))
        .sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
}

let text = '';
for (let i = 0; i < 100; i++) {
    text += JSON.stringify({ i }) + '\n';
}

const run = inputPath => splitCommand(vscode.Uri.file(inputPath));

const tests = [];
const test = (name, body) => tests.push({ name, body });

test('a first split asks nothing and writes the parts', async () => {
    const { dir, inputPath } = folderWith(text);
    await run(inputPath);
    assert.deepStrictEqual(shown.warn, []);
    assert.deepStrictEqual(shown.error, []);
    const parts = eventsParts(dir);
    assert.ok(parts.length >= 9);
    assert.strictEqual(parts.map(name => fs.readFileSync(path.join(dir, name), 'utf8')).join(''), text);
});

test('splitting again replaces the earlier parts only after a modal warning that counts them', async () => {
    const { dir, inputPath } = folderWith(text);
    await run(inputPath);
    const firstCount = eventsParts(dir).length;
    // Files that only look like parts are somebody else's
    const bystanders = ['events_part01.jsonl', 'events_part1.jsonl.bak', 'other_part1.jsonl', 'events_partial.jsonl', 'events.part1.jsonl'];
    bystanders.forEach(name => fs.writeFileSync(path.join(dir, name), `{"keep":"${name}"}\n`));

    // Fewer, bigger parts this time: the old parts 2.. must not linger beside them
    fake.config['largeFile.partSizeMB'] = 10 * PART_BYTES / (1024 * 1024);
    warningAnswer = items => items[0];
    try {
        await run(inputPath);
    } finally {
        fake.config['largeFile.partSizeMB'] = PART_BYTES / (1024 * 1024);
    }

    assert.strictEqual(shown.warn.length, 1, 'one warning before anything is replaced');
    const [warning] = shown.warn;
    assert.strictEqual(warning.options && warning.options.modal, true, 'the warning is modal');
    assert.match(warning.message, new RegExp(`\\b${firstCount} part files\\b`));
    assert.deepStrictEqual(shown.error, []);

    const parts = eventsParts(dir);
    assert.ok(parts.length < firstCount);
    assert.strictEqual(parts.map(name => fs.readFileSync(path.join(dir, name), 'utf8')).join(''), text,
        'the parts on disk hold each row once');
    bystanders.forEach(name => assert.strictEqual(fs.readFileSync(path.join(dir, name), 'utf8'), `{"keep":"${name}"}\n`));
});

test('cancelling the warning leaves every file as it was', async () => {
    const { dir, inputPath } = folderWith(text);
    await run(inputPath);
    // The user has been working in a part since
    fs.writeFileSync(path.join(dir, 'events_part1.jsonl'), '{"edited":true}\n');
    const before = listing(dir);

    warningAnswer = undefined;
    fake.config['largeFile.partSizeMB'] = 10 * PART_BYTES / (1024 * 1024);
    try {
        await run(inputPath);
    } finally {
        fake.config['largeFile.partSizeMB'] = PART_BYTES / (1024 * 1024);
    }

    assert.strictEqual(shown.warn.length, 1, 'the user was asked');
    assert.deepStrictEqual(listing(dir), before);
});

test('a split that fails removes the parts it wrote and reports the error', async () => {
    const { dir, inputPath } = folderWith(text);
    // A folder where part 2 would go: no part file, so nothing to ask about, but the split can't finish
    fs.mkdirSync(path.join(dir, 'events_part2.jsonl'));
    await run(inputPath);
    assert.deepStrictEqual(shown.warn, []);
    assert.strictEqual(shown.error.length, 1);
    assert.match(shown.error[0], /events_part2\.jsonl/);
    assert.deepStrictEqual(listing(dir), { 'events.jsonl': text, 'events_part2.jsonl': '<dir>' });
});

(async () => {
    const failed = [];
    for (const { name, body } of tests) {
        shown.warn.length = 0;
        shown.error.length = 0;
        shown.info.length = 0;
        warningAnswer = undefined;
        try {
            await body();
        } catch (error) {
            failed.push(name);
            process.stderr.write(`FAILED: ${name}\n  ${(error && error.stack) || error}\n`);
        }
    }
    fs.rmSync(root, { recursive: true, force: true });
    if (failed.length > 0) {
        process.stderr.write(`${failed.length} of ${tests.length} split command tests failed\n`);
        process.exit(1);
    }
    console.log(`split command tests passed (${tests.length})`);
})();
