/**
 * Optional format-on-save transforms for JSONL text.
 *
 * Both work line by line on the text itself rather than re-serializing
 * parsed values, so numbers, key order and string escapes come through
 * exactly as written. A line that isn't valid JSON afterwards is left alone.
 */

export interface FormatOnSaveOptions {
    /** `{"id":123}` becomes `{ "id": 123 }` */
    spaceOut: boolean;
    /** `{'id': 'a'}` becomes `{"id": "a"}` (only on lines that aren't valid JSON) */
    convertSingleQuotes: boolean;
}

function parses(text: string): boolean {
    try {
        JSON.parse(text);
        return true;
    } catch {
        return false;
    }
}

/**
 * Turns single-quoted strings into double-quoted ones. Double-quoted strings
 * are copied untouched, so an apostrophe inside one stays an apostrophe.
 */
export function convertSingleQuotedStrings(line: string): string {
    let out = '';
    let i = 0;
    while (i < line.length) {
        const ch = line[i];
        if (ch === '"') {
            const start = i++;
            while (i < line.length && line[i] !== '"') {
                i += line[i] === '\\' ? 2 : 1;
            }
            i++;
            out += line.slice(start, i);
        } else if (ch === '\'') {
            i++;
            let content = '';
            while (i < line.length && line[i] !== '\'') {
                if (line[i] === '\\' && i + 1 < line.length) {
                    // \' needs no escape between double quotes; keep every other escape
                    content += line[i + 1] === '\'' ? '\'' : line.slice(i, i + 2);
                    i += 2;
                } else {
                    content += line[i] === '"' ? '\\"' : line[i];
                    i++;
                }
            }
            i++;
            out += '"' + content + '"';
        } else {
            out += ch;
            i++;
        }
    }
    return out;
}

/**
 * Re-spaces a valid JSON line: one space inside non-empty braces, after
 * colons and after commas, and none anywhere else outside strings.
 * Arrays get no padding inside the brackets: `[1, 2]`.
 */
export function spaceOutJson(line: string): string {
    // Strip whitespace outside strings first
    const tokens: string[] = [];
    let i = 0;
    while (i < line.length) {
        const ch = line[i];
        if (ch === '"') {
            const start = i++;
            while (i < line.length && line[i] !== '"') {
                i += line[i] === '\\' ? 2 : 1;
            }
            i++;
            tokens.push(line.slice(start, i));
        } else if (/\s/.test(ch)) {
            i++;
        } else if ('{}[],:'.includes(ch)) {
            tokens.push(ch);
            i++;
        } else {
            const start = i;
            while (i < line.length && !/[\s{}[\],:"]/.test(line[i])) {
                i++;
            }
            tokens.push(line.slice(start, i));
        }
    }

    let out = '';
    for (let t = 0; t < tokens.length; t++) {
        const token = tokens[t];
        const next = tokens[t + 1];
        out += token;
        if (token === ':' || token === ',') {
            out += ' ';
        } else if (token === '{' && next !== '}') {
            out += ' ';
        } else if (next === '}' && token !== '{') {
            out += ' ';
        }
    }
    return out;
}

function formatLine(line: string, options: FormatOnSaveOptions): string {
    if (line.trim() === '') {
        return line;
    }

    let result = line;
    if (options.convertSingleQuotes && line.includes('\'') && !parses(line)) {
        const converted = convertSingleQuotedStrings(line);
        if (parses(converted)) {
            result = converted;
        }
    }

    if (options.spaceOut && parses(result)) {
        result = spaceOutJson(result);
    }
    return result;
}

/**
 * Applies the enabled transforms to every line of a JSONL document,
 * keeping its line endings (LF or CRLF) and any trailing newline.
 */
export function formatJsonlForSave(text: string, options: FormatOnSaveOptions): string {
    if (!options.spaceOut && !options.convertSingleQuotes) {
        return text;
    }
    return text
        .split('\n')
        .map(line => {
            const cr = line.endsWith('\r') ? '\r' : '';
            const body = cr ? line.slice(0, -1) : line;
            return formatLine(body, options) + cr;
        })
        .join('\n');
}
