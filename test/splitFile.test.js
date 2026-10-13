const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Writable } = require('stream');
const { splitJsonlFile } = require('../out/jsonl/splitFile');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-split-'));

function writeInput(name, text) {
    const inputPath = path.join(dir, name);
    fs.writeFileSync(inputPath, text);
    return inputPath;
}

function readParts(parts) {
    return parts.map(part => fs.readFileSync(part, 'utf8'));
}

// A writer that falls behind: tiny buffer, every write finishes later
function slowWriter(partPath) {
    const fd = fs.openSync(partPath, 'w');
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

function checkSplit(text, parts, maxBytes) {
    const contents = readParts(parts);
    const expected = text.endsWith('\n') || text === '' ? text : text + '\n';
    assert.strictEqual(contents.join(''), expected, 'parts concatenate to the input');
    contents.forEach((content, i) => {
        const lines = content.split('\n').filter(Boolean);
        assert.ok(Buffer.byteLength(content) <= maxBytes || lines.length === 1,
            `part ${i + 1} is ${Buffer.byteLength(content)} bytes (limit ${maxBytes})`);
        assert.ok(content === '' || content.endsWith('\n'), `part ${i + 1} ends on a line boundary`);
    });
    parts.forEach((part, i) => assert.strictEqual(path.basename(part), path.basename(parts[0]).replace('_part1', `_part${i + 1}`)));
}

(async () => {
    // Multi-byte characters, CRLF, an oversized line, no final newline
    const lines = [];
    for (let i = 0; i < 200; i++) {
        lines.push(JSON.stringify({ i, text: 'héllo 🦌 世界 '.repeat(i % 7) }));
    }
    lines.push(JSON.stringify({ huge: 'x'.repeat(5000) }));
    const text = lines.join('\r\n') + '\r\n' + '{"last":true}';
    const input = writeInput('data.jsonl', text);

    const parts = await splitJsonlFile(input, 1000);
    assert.ok(parts.length > 5);
    checkSplit(text, parts, 1000);

    // The same file through a writer that can't keep up with the reader
    const slowInput = writeInput('slow.jsonl', text);
    const slowParts = await splitJsonlFile(slowInput, 1000, slowWriter);
    assert.strictEqual(slowParts.length, parts.length);
    checkSplit(text, slowParts, 1000);

    // Bigger than the read buffer, slow writer, many parts
    let big = '';
    for (let i = 0; i < 20000; i++) {
        big += JSON.stringify({ id: i, payload: 'p'.repeat(i % 50) }) + '\n';
    }
    const bigInput = writeInput('big.jsonl', big);
    const bigParts = await splitJsonlFile(bigInput, 64 * 1024, slowWriter);
    checkSplit(big, bigParts, 64 * 1024);

    // A failed write is an error, not a success with missing data
    const failing = writeInput('fail.jsonl', big);
    let opened = 0;
    await assert.rejects(
        splitJsonlFile(failing, 64 * 1024, partPath => {
            opened++;
            if (opened < 3) {
                return fs.createWriteStream(partPath);
            }
            return new Writable({ write(_chunk, _encoding, callback) { callback(new Error('ENOSPC: no space left on device')); } });
        }),
        /ENOSPC/
    );

    // An empty file gives one empty part
    const emptyParts = await splitJsonlFile(writeInput('empty.jsonl', ''), 1000);
    assert.deepStrictEqual(readParts(emptyParts), ['']);

    fs.rmSync(dir, { recursive: true, force: true });
    console.log('splitFile tests passed');
})().catch(error => {
    fs.rmSync(dir, { recursive: true, force: true });
    console.error(error);
    process.exit(1);
});
