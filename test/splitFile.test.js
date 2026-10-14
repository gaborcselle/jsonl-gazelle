const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Writable } = require('stream');
const { splitJsonlFile, matchPartFileNames, findExistingParts } = require('../out/jsonl/splitFile');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-split-'));

function writeInput(name, content) {
    const inputPath = path.join(dir, name);
    fs.writeFileSync(inputPath, content);
    return inputPath;
}

// The files in `dir` named like parts of `base`.jsonl, in part order
function partsOnDisk(base, inDir = dir) {
    return fs.readdirSync(inDir)
        .filter(name => name.startsWith(`${base}_part`))
        .sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
}

function jsonLines(count, make = i => ({ i })) {
    let text = '';
    for (let i = 0; i < count; i++) {
        text += JSON.stringify(make(i)) + '\n';
    }
    return text;
}

// A writer that falls behind: tiny buffer, every write finishes later
function slowWriter(_partPath, fd) {
    return new Writable({
        highWaterMark: 16,
        write(chunk, _encoding, callback) {
            setTimeout(() => {
                fs.writeSync(fd, chunk);
                callback();
            }, 1);
        },
        final(callback) {
            setTimeout(() => {
                fs.closeSync(fd);
                callback();
            }, 5);
        }
    });
}

// A writer whose every write fails, the way a full disk does
function failingWriter(fd) {
    return new Writable({
        write(_chunk, _encoding, callback) { callback(new Error('ENOSPC: no space left on device')); },
        destroy(error, callback) {
            if (fd !== undefined) {
                fs.closeSync(fd);
            }
            callback(error);
        }
    });
}

// Everything a split promises about its parts, checked against the input's bytes
function checkParts(input, parts, maxBytes) {
    const contents = parts.map(part => fs.readFileSync(part));
    assert.ok(Buffer.concat(contents).equals(input), 'parts concatenate to the input byte for byte');
    if (input.length === 0) {
        assert.deepStrictEqual(contents.map(content => content.length), [0], 'an empty input gives one empty part');
        return;
    }
    const firstLineSize = content => (content.indexOf(0x0A) === -1 ? content.length : content.indexOf(0x0A) + 1);
    contents.forEach((content, i) => {
        const last = i === contents.length - 1;
        assert.ok(content.length > 0, `part ${i + 1} is not empty`);
        assert.ok(last || content[content.length - 1] === 0x0A, `part ${i + 1} ends on a line boundary`);
        assert.ok(content.length <= maxBytes || firstLineSize(content) === content.length,
            `part ${i + 1} is ${content.length} bytes (limit ${maxBytes}) and holds more than one line`);
        // A part ends only when the next line would not have fit
        if (!last) {
            const next = firstLineSize(contents[i + 1]);
            assert.ok(content.length + next > maxBytes, `part ${i + 1} ended early: ${content.length} + ${next} <= ${maxBytes}`);
        }
    });
    parts.forEach((part, i) => assert.strictEqual(path.basename(part), path.basename(parts[0]).replace('_part1', `_part${i + 1}`)));
}

const tests = [];
const test = (name, run) => tests.push({ name, run });

// --- lines, sizes and backpressure ----------------------------------------------

// Multi-byte characters, CRLF, an oversized line, no final newline
const mixedLines = [];
for (let i = 0; i < 200; i++) {
    mixedLines.push(JSON.stringify({ i, text: 'héllo 🦌 世界 '.repeat(i % 7) }));
}
mixedLines.push(JSON.stringify({ huge: 'x'.repeat(5000) }));
const MIXED = Buffer.from(mixedLines.join('\r\n') + '\r\n' + '{"last":true}');

test('parts end on line boundaries, within the limit, and add up to the file', async () => {
    const parts = await splitJsonlFile(writeInput('data.jsonl', MIXED), 1000);
    assert.ok(parts.length > 5);
    checkParts(MIXED, parts, 1000);
});

test('a writer that cannot keep up with the reader gets the same parts', async () => {
    const parts = await splitJsonlFile(writeInput('fast.jsonl', MIXED), 1000);
    const slowParts = await splitJsonlFile(writeInput('slow.jsonl', MIXED), 1000, slowWriter);
    assert.strictEqual(slowParts.length, parts.length);
    checkParts(MIXED, slowParts, 1000);
});

test('a file bigger than the read buffer, through a slow writer, into many parts', async () => {
    const big = Buffer.from(jsonLines(20000, i => ({ id: i, payload: 'p'.repeat(i % 50) })));
    const parts = await splitJsonlFile(writeInput('big.jsonl', big), 64 * 1024, slowWriter);
    checkParts(big, parts, 64 * 1024);
});

test('an empty file gives one empty part', async () => {
    const parts = await splitJsonlFile(writeInput('empty.jsonl', ''), 1000);
    checkParts(Buffer.alloc(0), parts, 1000);
});

// --- bytes come through untouched ------------------------------------------------

test('bytes that are not UTF-8 come through unchanged', async () => {
    // Latin-1 "é", a stray continuation byte, a truncated sequence, 0xFF, an encoded surrogate
    const input = Buffer.concat([
        Buffer.from('{"name":"caf'), Buffer.from([0xE9]), Buffer.from('"}\n'),
        Buffer.from('{"b":"'), Buffer.from([0x80, 0xBF, 0xC3]), Buffer.from('"}\n'),
        Buffer.from('{"c":"'), Buffer.from([0xFF, 0xFE, 0xED, 0xA0, 0x80]), Buffer.from('"}\n')
    ]);
    checkParts(input, await splitJsonlFile(writeInput('latin1.jsonl', input), 1024 * 1024), 1024 * 1024);
    checkParts(input, await splitJsonlFile(writeInput('latin1-small.jsonl', input), 16), 16);
});

test('a UTF-16 file comes through byte for byte', async () => {
    const input = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('{"a":"é"}\n{"b":2}\n', 'utf16le')]);
    const parts = await splitJsonlFile(writeInput('utf16.jsonl', input), 1024);
    assert.ok(Buffer.concat(parts.map(part => fs.readFileSync(part))).equals(input));
});

test('a final line without a newline, or ending in a lone CR, is kept as written', async () => {
    for (const [name, text] of [['nonl', '{"a":1}\n{"b":2}'], ['cr', '{"a":1}\r\n\r'], ['bom', '﻿{"a":1}\n{"b":2}']]) {
        const input = Buffer.from(text);
        checkParts(input, await splitJsonlFile(writeInput(`${name}.jsonl`, input), 1024), 1024);
        checkParts(input, await splitJsonlFile(writeInput(`${name}-small.jsonl`, input), 9), 9);
    }
});

test('a multi-byte character across a read-chunk boundary stays intact', async () => {
    const input = Buffer.from('{"s":"' + 'a'.repeat(65536 - 7) + '🦌"}\n{"b":1}\n' + jsonLines(50, i => ({ i, s: '世界🦌' })));
    checkParts(input, await splitJsonlFile(writeInput('boundary.jsonl', input), 70000), 70000);
    for (const chunkSize of [1, 2, 3, 5, 7]) {
        checkParts(input, await splitJsonlFile(writeInput(`boundary${chunkSize}.jsonl`, input), 200, undefined, chunkSize), 200);
    }
});

// --- other files are never overwritten or left mixed in --------------------------

test('a file that already has a part\'s name is never overwritten', async () => {
    const input = writeInput('events.jsonl', jsonLines(10, i => ({ i, pad: 'x'.repeat(40) })));
    const mine = path.join(dir, 'events_part1.jsonl');
    fs.writeFileSync(mine, '{"my":"hand-curated sample, not a split part"}\n');
    await assert.rejects(splitJsonlFile(input, 200), /events_part1\.jsonl/);
    assert.strictEqual(fs.readFileSync(mine, 'utf8'), '{"my":"hand-curated sample, not a split part"}\n');
    assert.deepStrictEqual(partsOnDisk('events'), ['events_part1.jsonl']);
});

test('a second split will not run among an earlier split\'s parts', async () => {
    const text = jsonLines(100);
    const input = writeInput('stale.jsonl', text);
    const first = await splitJsonlFile(input, 100);
    assert.ok(first.length >= 9);
    const before = first.map(part => fs.readFileSync(part));
    // Fewer, bigger parts would leave parts 2..9 behind, every row in them now twice on disk
    await assert.rejects(splitJsonlFile(input, 1000), /stale_part1\.jsonl, stale_part2\.jsonl and \d+ more already exist/);
    assert.deepStrictEqual(partsOnDisk('stale'), first.map(part => path.basename(part)));
    first.forEach((part, i) => assert.ok(fs.readFileSync(part).equals(before[i])));
    // With them gone it splits
    first.forEach(part => fs.unlinkSync(part));
    const second = await splitJsonlFile(input, 1000);
    assert.deepStrictEqual(partsOnDisk('stale'), second.map(part => path.basename(part)));
    checkParts(Buffer.from(text), second, 1000);
});

test('a part file that appears during the split is an error, not an overwrite', async () => {
    const input = writeInput('race.jsonl', jsonLines(40));
    const intruder = path.join(dir, 'race_part2.jsonl');
    await assert.rejects(
        splitJsonlFile(input, 100, (partPath, fd) => {
            if (path.basename(partPath) === 'race_part1.jsonl') {
                fs.writeFileSync(intruder, '{"mine":true}\n');
            }
            return fs.createWriteStream(partPath, { fd });
        }),
        /EEXIST/
    );
    assert.strictEqual(fs.readFileSync(intruder, 'utf8'), '{"mine":true}\n');
    assert.deepStrictEqual(partsOnDisk('race'), ['race_part2.jsonl'], 'the part this run wrote is removed, the other file kept');
});

// --- a failed split cleans up after itself ---------------------------------------

test('a failed write is an error, and the parts written before it are removed', async () => {
    const input = writeInput('fail.jsonl', jsonLines(20000, i => ({ id: i, payload: 'p'.repeat(i % 50) })));
    let opened = 0;
    const error = await splitJsonlFile(input, 64 * 1024, (partPath, fd) => {
        opened++;
        return opened < 3 ? fs.createWriteStream(partPath, { fd }) : failingWriter(fd);
    }).then(() => null, failure => failure);
    assert.ok(error, 'the split fails');
    assert.match(error.message, /ENOSPC/);
    assert.match(error.message, /Removed the 3 part files created before the error/);
    assert.deepStrictEqual(partsOnDisk('fail'), []);
});

test('a part that cannot be removed after a failure is named in the error', async () => {
    const input = writeInput('stuck.jsonl', jsonLines(40));
    const part1 = path.join(dir, 'stuck_part1.jsonl');
    let opened = 0;
    const error = await splitJsonlFile(input, 100, (partPath, fd) => {
        opened++;
        if (opened === 2) {
            // Stands in for a part that is locked or read-only: a folder in its
            // place can't be removed the way a file is
            fs.unlinkSync(part1);
            fs.mkdirSync(part1);
            fs.writeFileSync(path.join(part1, 'keep'), '');
            return failingWriter(fd);
        }
        return fs.createWriteStream(partPath, { fd });
    }).then(() => null, failure => failure);
    assert.ok(error, 'the split fails');
    assert.match(error.message, /ENOSPC/);
    assert.match(error.message, /stuck_part1\.jsonl/);
    assert.deepStrictEqual(error.leftoverParts, [part1]);
    assert.deepStrictEqual(partsOnDisk('stuck'), ['stuck_part1.jsonl']);
    fs.rmSync(part1, { recursive: true });
});

// --- finding an earlier split's parts --------------------------------------------

test('matchPartFileNames picks out exactly the names a split writes', () => {
    const names = [
        'events_part10.jsonl', 'events_part2.jsonl', 'events_part1.jsonl', 'events.jsonl',
        'events_part01.jsonl', 'events_part0.jsonl', 'events_part.jsonl', 'events_part1.json',
        'events_part1.jsonl.bak', 'events_part1.ndjson', 'Events_part1.jsonl', 'my_events_part1.jsonl',
        'events_part1_part1.jsonl', 'events_part-1.jsonl', 'events_part1e3.jsonl', 'events_part 1.jsonl',
        'events_partial.jsonl', 'events.part1.jsonl', 'events_part１.jsonl'
    ];
    assert.deepStrictEqual(matchPartFileNames('/d/events.jsonl', names),
        ['events_part1.jsonl', 'events_part2.jsonl', 'events_part10.jsonl']);
    // Characters a pattern would treat specially are only characters
    assert.deepStrictEqual(matchPartFileNames('/d/a+b (1).jsonl', ['a+b (1)_part3.jsonl', 'aab (1)_part3.jsonl', 'a+b 1_part3.jsonl']),
        ['a+b (1)_part3.jsonl']);
    // A file without an extension
    assert.deepStrictEqual(matchPartFileNames('/d/log', ['log_part2', 'log_part1', 'log_part1.jsonl', 'log']), ['log_part1', 'log_part2']);
    // An input that is itself a part
    assert.deepStrictEqual(matchPartFileNames('/d/x_part1.jsonl', ['x_part1.jsonl', 'x_part2.jsonl', 'x_part1_part1.jsonl']),
        ['x_part1_part1.jsonl']);
});

test('findExistingParts lists part files, but not folders with a part\'s name', async () => {
    const sub = fs.mkdtempSync(path.join(dir, 'existing-'));
    const input = path.join(sub, 'events.jsonl');
    fs.writeFileSync(input, '{}\n');
    for (const name of ['events_part1.jsonl', 'events_part3.jsonl', 'events_part01.jsonl', 'other_part1.jsonl']) {
        fs.writeFileSync(path.join(sub, name), '{}\n');
    }
    fs.mkdirSync(path.join(sub, 'events_part2.jsonl'));
    assert.deepStrictEqual(await findExistingParts(input),
        [path.join(sub, 'events_part1.jsonl'), path.join(sub, 'events_part3.jsonl')]);
});

// --- property: any bytes, any limit ----------------------------------------------

// Deterministic, so a failure names a case that can be replayed
function mulberry32(seed) {
    return () => {
        seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function randomContent(random, maxLines) {
    const int = n => Math.floor(random() * n);
    const pieces = [];
    const lineCount = int(maxLines + 1);
    for (let i = 0; i < lineCount; i++) {
        const kind = random();
        let body;
        if (kind < 0.1) {
            body = Buffer.alloc(0);
        } else if (kind < 0.2) {
            body = Buffer.alloc(100 + int(400), 'x');
        } else if (kind < 0.5) {
            body = Buffer.from(JSON.stringify({ i, s: ['héllo', '🦌', '世界', 'plain', ''][int(5)].repeat(int(6)) }));
        } else {
            // Any byte but a newline: CR, NUL, invalid and truncated UTF-8 all included
            body = Buffer.alloc(int(60));
            for (let b = 0; b < body.length; b++) {
                body[b] = int(255) + (random() < 0.5 ? 1 : 0);
                if (body[b] === 0x0A) {
                    body[b] = 0x0D;
                }
            }
        }
        const last = i === lineCount - 1;
        const ending = last && random() < 0.4 ? '' : random() < 0.7 ? '\n' : '\r\n';
        pieces.push(body, Buffer.from(ending));
    }
    return Buffer.concat(pieces);
}

test('property: random bytes split at random sizes come back whole, in line-bounded parts', async () => {
    const seed = 0x5EED;
    const random = mulberry32(seed);
    const int = n => Math.floor(random() * n);
    for (let run = 0; run < 300; run++) {
        const big = run % 50 === 0;
        const input = randomContent(random, big ? 6000 : 40);
        const maxBytes = random() < 0.1 ? int(3) : random() < 0.1 ? input.length + int(10) : 1 + int(big ? 20000 : 300);
        const chunkSize = big || random() < 0.2 ? undefined : 1 + int(40);
        const sub = fs.mkdtempSync(path.join(dir, 'prop-'));
        const inputPath = path.join(sub, 'p.jsonl');
        fs.writeFileSync(inputPath, input);
        try {
            const parts = await splitJsonlFile(inputPath, maxBytes, undefined, chunkSize);
            checkParts(input, parts, maxBytes);
            assert.deepStrictEqual(partsOnDisk('p', sub), parts.map(part => path.basename(part)), 'no other files are written');
        } catch (error) {
            error.message += ` (seed ${seed}, run ${run}, ${input.length} bytes, maxBytes ${maxBytes}, chunk ${chunkSize})`;
            throw error;
        }
        fs.rmSync(sub, { recursive: true, force: true });
    }
});

(async () => {
    const failed = [];
    for (const { name, run } of tests) {
        try {
            await run();
        } catch (error) {
            failed.push(name);
            process.stderr.write(`FAILED: ${name}\n  ${(error && error.stack) || error}\n`);
        }
    }
    fs.rmSync(dir, { recursive: true, force: true });
    if (failed.length > 0) {
        process.stderr.write(`${failed.length} of ${tests.length} splitFile tests failed\n`);
        process.exit(1);
    }
    console.log(`splitFile tests passed (${tests.length})`);
})();
