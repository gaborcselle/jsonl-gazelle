const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { install } = require('./helpers/fakeVscode');

// "Diff with Git HEAD" reads the committed version with git. Run it against a
// real throwaway repository.

const { vscode, messages } = install();
const { getGitHeadContent, registerDiffCommands } = require('../out/jsonlDiffProvider');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-git-'));
const git = (...args) => execFileSync('git', args, { cwd: path.join(root, 'repo'), stdio: 'pipe' });
const originalPath = process.env.PATH;

// Enough of VS Code to run the command itself: openTextDocument rejects for a
// file that is not on disk, as VS Code's does
class Uri {
    constructor(fsPath) { this.fsPath = fsPath; this.scheme = 'file'; }
    toString() { return 'file://' + this.fsPath; }
    static file(fsPath) { return new Uri(fsPath); }
}
vscode.Uri = Uri;
vscode.ViewColumn = { Active: -1 };
const commands = {};
vscode.commands.registerCommand = (id, handler) => { commands[id] = handler; return { dispose() {} }; };
vscode.workspace.textDocuments = [];
vscode.workspace.openTextDocument = async uri => {
    const text = fs.readFileSync(uri.fsPath, 'utf8');
    return { uri, getText: () => text };
};
vscode.window.createWebviewPanel = () => {
    const panel = {
        posted: [],
        webview: {
            html: '',
            postMessage(message) { panel.posted.push(message); return Promise.resolve(true); },
            onDidReceiveMessage(handler) { panel.receive = handler; return { dispose() {} }; }
        },
        onDidDispose() { return { dispose() {} }; }
    };
    return panel;
};
registerDiffCommands({ subscriptions: [] });

// Runs "Diff with Git HEAD" from the Source Control view and returns what the panel is sent
async function diffWithHead(filePath) {
    let panel;
    const create = vscode.window.createWebviewPanel;
    vscode.window.createWebviewPanel = (...args) => (panel = create(...args));
    try {
        await commands['jsonl-gazelle.diffWithHead']({ resourceUri: Uri.file(filePath) });
    } finally {
        vscode.window.createWebviewPanel = create;
    }
    assert.ok(panel, 'expected a diff panel; errors shown: ' + JSON.stringify(messages.error));
    panel.receive({ type: 'ready' });
    return panel.posted.find(message => message.type === 'diffData').payload;
}

// A directory holding a "git" that runs the real one but speaks another
// language: same output and exit status, messages no English test could match
function translatedGit() {
    const realGit = originalPath.split(path.delimiter).map(dir => path.join(dir, 'git')).find(candidate => {
        try {
            fs.accessSync(candidate, fs.constants.X_OK);
            return fs.statSync(candidate).isFile();
        } catch {
            return false;
        }
    });
    const dir = path.join(root, 'translated-git');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'git'), [
        '#!/bin/sh',
        `'${realGit.replace(/'/g, "'\\''")}' "$@" 2>/dev/null`,
        'status=$?',
        'if [ $status -ne 0 ]; then echo "fatal: Pfad befindet sich im Dateisystem, aber nicht in HEAD" >&2; fi',
        'exit $status',
        ''
    ].join('\n'), { mode: 0o755 });
    return dir;
}

(async () => {
    fs.mkdirSync(path.join(root, 'repo', 'data'), { recursive: true });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    fs.writeFileSync(path.join(root, 'repo', 'data', 'plain.jsonl'), '{"a":1}\n');
    fs.writeFileSync(path.join(root, 'repo', 'data', 'bom.jsonl'), '﻿{"a":1}\n');
    // Stands in for Git LFS: the blob holds lower case, checkout shows upper case
    fs.writeFileSync(path.join(root, 'repo', '.gitattributes'), 'data/filtered.jsonl filter=upper\n');
    git('config', 'filter.upper.smudge', 'tr a-z A-Z');
    git('config', 'filter.upper.clean', 'tr A-Z a-z');
    fs.writeFileSync(path.join(root, 'repo', 'data', 'filtered.jsonl'), '{"b":2}\n');
    // A tracked symlink to another tracked file
    fs.writeFileSync(path.join(root, 'repo', 'data', 'target.jsonl'), '{"t":1}\n');
    fs.symlinkSync('target.jsonl', path.join(root, 'repo', 'data', 'link.jsonl'));
    // Files the tests below delete from the working tree
    fs.writeFileSync(path.join(root, 'repo', 'data', 'gone.jsonl'), '{"g":1}\n{"g":2}\n');
    fs.mkdirSync(path.join(root, 'repo', 'data', 'sub', 'deeper'), { recursive: true });
    fs.writeFileSync(path.join(root, 'repo', 'data', 'sub', 'deeper', 'x.jsonl'), '{"x":1}\n');
    fs.writeFileSync(path.join(root, 'repo', 'data', 'eol.jsonl'), '{"e":1}\n{"e":2}\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');

    const file = name => path.join(root, 'repo', 'data', name);
    assert.deepStrictEqual(await getGitHeadContent(file('plain.jsonl')), { content: '{"a":1}\n' });

    // Reached through a symlinked folder
    fs.symlinkSync(path.join(root, 'repo', 'data'), path.join(root, 'link'));
    assert.deepStrictEqual(await getGitHeadContent(path.join(root, 'link', 'plain.jsonl')), { content: '{"a":1}\n' });

    // Checkout filters (how Git LFS stores files) are applied
    assert.deepStrictEqual(await getGitHeadContent(file('filtered.jsonl')), { content: '{"B":2}\n' });

    // A byte order mark is dropped, as the editor drops it
    assert.deepStrictEqual(await getGitHeadContent(file('bom.jsonl')), { content: '{"a":1}\n' });

    // Not committed yet: everything shows as added
    fs.writeFileSync(file('new.jsonl'), '{"n":1}\n');
    const fresh = await getGitHeadContent(file('new.jsonl'));
    assert.strictEqual(fresh.content, '');
    assert.ok(fresh.note);

    // A symlinked file is compared by its target's committed content, not by
    // the link's own blob (the target's path)
    assert.deepStrictEqual(await getGitHeadContent(file('link.jsonl')), { content: '{"t":1}\n' });

    // Deleted from the working tree, as Source Control lists it: every row removed
    fs.unlinkSync(file('gone.jsonl'));
    const deleted = await diffWithHead(file('gone.jsonl'));
    assert.deepStrictEqual(deleted.summary, { added: 0, removed: 2, modified: 0, unchanged: 0 });
    assert.match(deleted.note, /deleted/);
    // ...folder and all
    fs.rmSync(path.join(root, 'repo', 'data', 'sub'), { recursive: true });
    assert.deepStrictEqual(await getGitHeadContent(file(path.join('sub', 'deeper', 'x.jsonl'))), { content: '{"x":1}\n' });
    assert.strictEqual((await diffWithHead(file(path.join('sub', 'deeper', 'x.jsonl')))).summary.removed, 1);

    // Only the line endings changed: the panel is told so
    fs.writeFileSync(file('eol.jsonl'), '{"e":1}\r\n{"e":2}\r\n');
    const eol = await diffWithHead(file('eol.jsonl'));
    assert.deepStrictEqual(eol.summary, { added: 0, removed: 0, modified: 0, unchanged: 2 });
    assert.deepStrictEqual(eol.lineEndingChanges, { lineEndings: true, finalNewline: false });

    // git speaking another language: "not in HEAD" is still recognised, for an
    // untracked file and for a repository without any commit yet
    if (process.platform !== 'win32') {
        const unborn = path.join(root, 'unborn');
        fs.mkdirSync(unborn);
        execFileSync('git', ['init', '-q'], { cwd: unborn, stdio: 'pipe' });
        fs.writeFileSync(path.join(unborn, 'a.jsonl'), '{"a":1}\n');
        process.env.PATH = translatedGit() + path.delimiter + originalPath;
        try {
            for (const untracked of [file('new.jsonl'), path.join(unborn, 'a.jsonl')]) {
                const result = await getGitHeadContent(untracked);
                assert.strictEqual(result.content, '', untracked);
                assert.ok(result.note, untracked);
            }
            assert.deepStrictEqual(await getGitHeadContent(file('plain.jsonl')), { content: '{"a":1}\n' });
        } finally {
            process.env.PATH = originalPath;
        }
    }

    // No git to run: say so, rather than blaming the repository
    const empty = path.join(root, 'empty-path');
    fs.mkdirSync(empty);
    process.env.PATH = empty;
    try {
        await assert.rejects(getGitHeadContent(file('plain.jsonl')), error => {
            assert.match(error.message, /could not run git/i);
            assert.doesNotMatch(error.message, /not inside a Git repository/);
            return true;
        });
    } finally {
        process.env.PATH = originalPath;
    }

    // Outside any repository
    fs.mkdirSync(path.join(root, 'loose'));
    fs.writeFileSync(path.join(root, 'loose', 'z.jsonl'), '{}\n');
    await assert.rejects(getGitHeadContent(path.join(root, 'loose', 'z.jsonl')), /not inside a Git repository/);

    fs.rmSync(root, { recursive: true, force: true });
    console.log('gitHead tests passed');
})().catch(error => {
    process.env.PATH = originalPath;
    fs.rmSync(root, { recursive: true, force: true });
    console.error(error);
    process.exit(1);
});
