import * as fs from 'fs';
import * as path from 'path';
import { Writable } from 'stream';

/**
 * Split a JSONL file into `<name>_part1.jsonl`, `<name>_part2.jsonl`, ... of at
 * most `maxBytes` each, never cutting a line (a single line longer than the
 * limit gets a part of its own). Every line in the parts ends with a newline.
 *
 * One sequential pass: the reader waits whenever a part is being written out,
 * and a part is fully flushed before the next one is opened. (The previous
 * callback-driven version kept reading during part switches and closed the
 * last part on a 100 ms timer; on a slow disk the two raced, duplicating
 * lines and writing oversized parts. It also reported success when a write
 * failed.)
 */
export async function splitJsonlFile(
    inputPath: string,
    maxBytes: number,
    createWriteStream: (partPath: string) => Writable = partPath => fs.createWriteStream(partPath)
): Promise<string[]> {
    const dir = path.dirname(inputPath);
    const ext = path.extname(inputPath);
    const base = path.basename(inputPath, ext);
    const parts: string[] = [];

    let out: Writable;
    let outError: Error | null = null;
    let currentSize = 0;

    const openPart = () => {
        const partPath = path.join(dir, `${base}_part${parts.length + 1}${ext}`);
        parts.push(partPath);
        const stream = createWriteStream(partPath);
        stream.on('error', error => { outError = outError || error; });
        currentSize = 0;
        return stream;
    };

    const settle = (stream: Writable, event: 'drain' | 'finish') => new Promise<void>((resolve, reject) => {
        if (outError) {
            reject(outError);
            return;
        }
        const done = () => { stream.off('error', failed); resolve(); };
        const failed = (error: Error) => { stream.off(event, done); reject(error); };
        stream.once(event, done);
        stream.once('error', failed);
        if (event === 'finish') {
            stream.end();
        }
    });

    const writeLine = async (text: string) => {
        const size = Buffer.byteLength(text, 'utf8');
        if (currentSize > 0 && currentSize + size > maxBytes) {
            await settle(out, 'finish');
            out = openPart();
        }
        currentSize += size;
        if (!out.write(text)) {
            await settle(out, 'drain');
        }
        if (outError) {
            throw outError;
        }
    };

    out = openPart();
    try {
        let partialLine = '';
        const input = fs.createReadStream(inputPath, { encoding: 'utf8', highWaterMark: 64 * 1024 });
        // Async iteration pauses the read stream while each chunk is written
        for await (const chunk of input) {
            const lines = (partialLine + chunk).split('\n');
            partialLine = lines.pop() || '';
            for (const line of lines) {
                await writeLine(line + '\n');
            }
        }
        if (partialLine) {
            await writeLine(partialLine + '\n');
        }
        await settle(out, 'finish');
    } catch (error) {
        out.destroy();
        throw error;
    }
    return parts;
}
