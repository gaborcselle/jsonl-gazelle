import * as fs from 'fs';
import * as path from 'path';
import { Writable } from 'stream';
import { promisify } from 'util';

const openFile = promisify(fs.open);
const closeFile = promisify(fs.close);

const NEWLINE = 0x0A;

/** Where a split of `inputPath` writes part `n` (1-based): `<name>_part<n><ext>` beside it. */
function partFilePath(inputPath: string, n: number): string {
    const ext = path.extname(inputPath);
    return path.join(path.dirname(inputPath), `${path.basename(inputPath, ext)}_part${n}${ext}`);
}

/**
 * The names in `fileNames` that a split of `inputPath` writes, in part order:
 * exactly `<name>_part<n><ext>`, with `n` spelled the way the splitter spells
 * it. Anything else is somebody's file, however close its name
 * (`events_part01.jsonl`, `events_part1.jsonl.bak`).
 */
export function matchPartFileNames(inputPath: string, fileNames: string[]): string[] {
    const ext = path.extname(inputPath);
    const prefix = `${path.basename(inputPath, ext)}_part`;
    const partNumber = (name: string) => name.slice(prefix.length, name.length - ext.length);
    return fileNames
        .filter(name => name.length > prefix.length + ext.length
            && name.startsWith(prefix) && name.endsWith(ext)
            && /^[1-9][0-9]*$/.test(partNumber(name)))
        .sort((a, b) => {
            const m = partNumber(a);
            const n = partNumber(b);
            return m.length - n.length || (m < n ? -1 : m > n ? 1 : 0);
        });
}

/** The part files an earlier split of `inputPath` left in its folder, as full paths in part order. */
export async function findExistingParts(inputPath: string): Promise<string[]> {
    const dir = path.dirname(inputPath);
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    // A folder that happens to have a part's name is not a part, and not ours to remove
    const names = entries.filter(entry => !entry.isDirectory()).map(entry => entry.name);
    return matchPartFileNames(inputPath, names).map(name => path.join(dir, name));
}

/** Remove `files`, returning the ones that couldn't be removed. One that is already gone counts as removed. */
export async function removeFiles(files: string[]): Promise<string[]> {
    const results = await Promise.allSettled(files.map(file => fs.promises.rm(file, { force: true })));
    return files.filter((_, i) => results[i].status === 'rejected');
}

/** `a.jsonl`, `a.jsonl and b.jsonl`, `a.jsonl, b.jsonl and 7 more`: file names for a message. */
export function describeFiles(files: string[]): string {
    const names = files.map(file => path.basename(file));
    if (names.length <= 3) {
        return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    }
    return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}

/** A split that failed, after it removed the parts it had created. `leftoverParts` are the ones it couldn't. */
export class SplitError extends Error {
    constructor(readonly cause: unknown, readonly createdParts: string[], readonly leftoverParts: string[]) {
        super(SplitError.describe(cause, createdParts, leftoverParts));
        this.name = 'SplitError';
    }

    private static describe(cause: unknown, created: string[], leftover: string[]): string {
        const reason = cause instanceof Error ? cause.message : String(cause);
        if (leftover.length > 0) {
            return `${reason}. Could not remove ${describeFiles(leftover)}, written before the error; delete ${leftover.length === 1 ? 'it' : 'them'} by hand.`;
        }
        if (created.length > 0) {
            return `${reason}. Removed the ${created.length === 1 ? 'part file' : `${created.length} part files`} created before the error.`;
        }
        return reason;
    }
}

/** A part's stream: the file itself, closing the descriptor when done. */
function writeToPartFile(partPath: string, fd: number): Writable {
    return fs.createWriteStream(partPath, { fd });
}

/**
 * Split a JSONL file into `<name>_part1.jsonl`, `<name>_part2.jsonl`, ... of at
 * most `maxBytes` each, never cutting a line (a single line longer than the
 * limit gets a part of its own).
 *
 * The parts are consecutive byte ranges of the file, so put back together
 * they are the file exactly: its line endings, its final newline or lack of
 * one, and any bytes that aren't UTF-8. Lines are found by their 0x0A byte,
 * which UTF-8 never uses inside a character, so nothing is decoded. (Decoding
 * as UTF-8 turned Latin-1 bytes into U+FFFD and mangled UTF-16 files.)
 *
 * Nothing is overwritten. The split refuses to start while parts of an
 * earlier split are in the folder, since a split into fewer parts would leave
 * the rest beside the new ones and every row in them on disk twice; the caller
 * removes them first (findExistingParts, removeFiles). Each part is created
 * with 'wx', so a file that turns up under a part's name meanwhile is an error
 * rather than lost. If the split fails, the parts it created are removed
 * before the error is thrown (a SplitError, which names any it couldn't
 * remove).
 *
 * One sequential pass: the reader waits whenever a part is being written out,
 * and a part is fully flushed and closed before the next one is opened. (The
 * previous callback-driven version kept reading during part switches and
 * closed the last part on a 100 ms timer; on a slow disk the two raced,
 * duplicating lines and writing oversized parts. It also reported success when
 * a write failed.)
 *
 * `createWriteStream` turns the descriptor of a freshly created part into the
 * stream its bytes go to, and owns the descriptor from then on.
 */
export async function splitJsonlFile(
    inputPath: string,
    maxBytes: number,
    createWriteStream: typeof writeToPartFile = writeToPartFile,
    readChunkSize = 64 * 1024
): Promise<string[]> {
    const existing = await findExistingParts(inputPath);
    if (existing.length > 0) {
        const one = existing.length === 1;
        throw new Error(`${describeFiles(existing)} already ${one ? 'exists' : 'exist'} beside ${path.basename(inputPath)}; remove ${one ? 'it' : 'them'} before splitting`);
    }

    // Every part this run created, in order
    const parts: string[] = [];

    let out: Writable | undefined;
    let outClosed: Promise<void> = Promise.resolve();
    let outError: Error | null = null;
    let partSize = 0;

    const openPart = async () => {
        const partPath = partFilePath(inputPath, parts.length + 1);
        const fd = await openFile(partPath, 'wx');
        // Created by this run, so this run's to remove if the split fails
        parts.push(partPath);
        let stream: Writable;
        try {
            stream = createWriteStream(partPath, fd);
        } catch (error) {
            await closeFile(fd).catch(() => undefined);
            throw error;
        }
        stream.on('error', error => { outError = outError || error; });
        // Listen now: a stream that fails closes on its own, before anyone waits for it
        outClosed = new Promise(resolve => stream.once('close', () => resolve()));
        out = stream;
        partSize = 0;
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

    const write = async (bytes: Buffer) => {
        if (bytes.length === 0) {
            return;
        }
        if (!out!.write(bytes)) {
            await settle(out!, 'drain');
        }
        if (outError) {
            throw outError;
        }
    };

    const finishPart = async () => {
        await settle(out!, 'finish');
        // The descriptor closes after 'finish'; wait for it, so a finished part
        // is complete on disk and can be removed (Windows won't delete an open file)
        await outClosed;
        if (outError) {
            throw outError;
        }
    };

    // The line being read when a chunk runs out. Once it is known which part
    // it belongs to, its bytes go straight out (`lineStreaming`); until then
    // they wait in `held`. That is only while the current part has room for
    // what has been read of it, so `held` never outgrows a part.
    let held: Buffer[] = [];
    let lineSize = 0;
    let lineStreaming = false;

    const writeHeld = async () => {
        for (const bytes of held) {
            await write(bytes);
        }
        held = [];
    };

    try {
        await openPart();
        const input = fs.createReadStream(inputPath, { highWaterMark: readChunkSize });
        // Async iteration pauses the read stream while each chunk is written
        for await (const chunk of input as AsyncIterable<Buffer>) {
            // chunk[runStart, pos) belongs to the current part but isn't written
            // yet, so a run of lines goes out in one write
            let runStart = 0;
            let heldFrom = chunk.length;
            let pos = 0;
            while (pos < chunk.length) {
                const newline = chunk.indexOf(NEWLINE, pos);
                const end = newline === -1 ? chunk.length : newline + 1;
                lineSize += end - pos;
                if (lineStreaming) {
                    partSize += end - pos;
                } else {
                    if (partSize > 0 && partSize + lineSize > maxBytes) {
                        // The line doesn't fit in what is left of this part, and only grows
                        await write(chunk.subarray(runStart, pos));
                        runStart = pos;
                        await finishPart();
                        await openPart();
                    }
                    if (newline === -1 && partSize > 0) {
                        // Unfinished, and it may yet outgrow this part: wait and see
                        heldFrom = pos;
                    } else {
                        // Finished and fits, or the first line of a part, which takes it
                        // at any length. Held bytes can only belong to the chunk's first
                        // line, so they go out before the run, which starts here.
                        await writeHeld();
                        partSize += lineSize;
                        lineStreaming = newline === -1;
                    }
                }
                if (newline !== -1) {
                    lineSize = 0;
                    lineStreaming = false;
                }
                pos = end;
            }
            await write(chunk.subarray(runStart, heldFrom));
            if (heldFrom < chunk.length) {
                held.push(chunk.subarray(heldFrom));
            }
        }
        // A last line without a newline ends with the file. If it is still held,
        // all of it was read without outgrowing the part, so it fits.
        await writeHeld();
        await finishPart();
    } catch (error) {
        if (out) {
            out.destroy();
            await outClosed;
        }
        throw new SplitError(error, parts, await removeFiles(parts));
    }
    return parts;
}
