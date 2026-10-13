const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { install } = require('./helpers/fakeVscode');

// "Diff with Git HEAD" reads the committed version with git. Run it against a
// real throwaway repository.

install();
const { getGitHeadContent } = require('../out/jsonlDiffProvider');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-git-'));
const git = (...args) => execFileSync('git', args, { cwd: path.join(root, 'repo'), stdio: 'pipe' });

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

    fs.rmSync(root, { recursive: true, force: true });
    console.log('gitHead tests passed');
})().catch(error => {
    fs.rmSync(root, { recursive: true, force: true });
    console.error(error);
    process.exit(1);
});
