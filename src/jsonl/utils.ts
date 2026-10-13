/**
 * Utility functions for JSONL data manipulation
 */

// Column paths join keys with "." and array indices with "[n]", but a key can
// contain those characters itself: logs routinely carry flat keys such as
// "user.name", "http.status" or "k8s.io/app". So a path is matched against the
// object's own keys, longest first - "user.name" is the key "user.name" when
// the object has one, and user -> name otherwise. Inherited properties
// ("constructor", "toString") never match.
//
// Keep readPath / readIndex in sync with the copy in src/webview/scripts.ts
// (the `shared:nested-path` block, which test/nestedPath.test.js extracts).

function hasOwnKey(obj: any, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(obj, key);
}

/** Positions where a path can split into a key and the rest, longest key first. */
function keyEnds(rest: string): number[] {
    const ends = [rest.length];
    for (let i = rest.length - 1; i > 0; i--) {
        if (rest[i] === '.' || rest[i] === '[') {
            ends.push(i);
        }
    }
    return ends;
}

/** The rest of a path after a key or index: drops the "." separator. */
function afterSeparator(tail: string): string {
    return tail[0] === '.' ? tail.slice(1) : tail;
}

/** Parse a leading "[n]"; null if the path doesn't start with one. */
function leadingIndex(rest: string): { index: number; tail: string } | null {
    const close = rest.indexOf(']');
    if (rest[0] !== '[' || close < 2) {
        return null;
    }
    const digits = rest.slice(1, close);
    for (const ch of digits) {
        if (ch < '0' || ch > '9') {
            return null;
        }
    }
    return { index: Number(digits), tail: afterSeparator(rest.slice(close + 1)) };
}

function readPath(current: any, rest: string): any {
    if (rest === '') {
        return current;
    }
    if (current === null) {
        return null; // A path through a null shows the null, as it always has
    }
    if (typeof current !== 'object') {
        return undefined;
    }
    if (rest[0] === '[') {
        const parsed = leadingIndex(rest);
        return parsed && Array.isArray(current) ? readPath(current[parsed.index], parsed.tail) : undefined;
    }
    for (const end of keyEnds(rest)) {
        const key = rest.slice(0, end);
        if (!hasOwnKey(current, key)) {
            continue;
        }
        const value = readPath(current[key], afterSeparator(rest.slice(end)));
        if (value !== undefined) {
            return value;
        }
    }
    return undefined;
}

function writePath(current: any, rest: string, value: any): boolean {
    if (current === null || typeof current !== 'object') {
        return false;
    }
    if (rest[0] === '[') {
        const parsed = leadingIndex(rest);
        if (!parsed || !Array.isArray(current)) {
            return false;
        }
        if (parsed.tail === '') {
            current[parsed.index] = value;
            return true;
        }
        const child = current[parsed.index];
        if (child === null || typeof child !== 'object') {
            current[parsed.index] = parsed.tail[0] === '[' ? [] : {};
        }
        return writePath(current[parsed.index], parsed.tail, value);
    }
    for (const end of keyEnds(rest)) {
        const key = rest.slice(0, end);
        if (!hasOwnKey(current, key)) {
            continue;
        }
        const tail = afterSeparator(rest.slice(end));
        if (tail === '') {
            current[key] = value;
            return true;
        }
        if (writePath(current[key], tail, value)) {
            return true;
        }
    }
    // No own key leads there: create it, splitting at the first "." or "[".
    // An existing object is never replaced - only a missing key or a value
    // that can't hold children (null, a number...) makes way for a container.
    const boundary = rest.search(/[.[]/);
    if (boundary === -1) {
        current[rest] = value;
        return true;
    }
    const key = rest.slice(0, boundary);
    const existing = current[key];
    if (hasOwnKey(current, key) && existing !== null && typeof existing === 'object') {
        return false;
    }
    const tail = afterSeparator(rest.slice(boundary));
    current[key] = tail[0] === '[' ? [] : {};
    return writePath(current[key], tail, value);
}

function deletePath(current: any, rest: string): boolean {
    if (current === null || typeof current !== 'object') {
        return false;
    }
    if (rest[0] === '[') {
        // Array elements aren't deleted: that would shift every later one
        const parsed = leadingIndex(rest);
        return !!parsed && parsed.tail !== '' && Array.isArray(current) && deletePath(current[parsed.index], parsed.tail);
    }
    for (const end of keyEnds(rest)) {
        const key = rest.slice(0, end);
        if (!hasOwnKey(current, key)) {
            continue;
        }
        const tail = afterSeparator(rest.slice(end));
        if (tail === '') {
            delete current[key];
            return true;
        }
        if (deletePath(current[key], tail)) {
            return true;
        }
    }
    return false;
}

/**
 * Get a value from a nested object using dot notation path
 * Supports array notation like "field[0]", and keys that contain dots
 *
 * @param obj - The object to get the value from
 * @param path - Dot notation path (e.g., "user.name" or "items[0].title")
 * @returns The value at the path, or undefined if not found
 */
export function getNestedValue(obj: any, path: string): any {
    // Handle null/undefined object
    if (obj === null || obj === undefined) {
        return undefined;
    }

    // Handle special case for primitive values with "(value)" path
    if (path === '(value)' && (typeof obj === 'string' || typeof obj === 'number' || typeof obj === 'boolean' || obj === null || Array.isArray(obj))) {
        return obj;
    }

    if (!path || typeof obj !== 'object') {
        return undefined;
    }
    return readPath(obj, path);
}

/**
 * Set a value in a nested object using dot notation path. Follows existing
 * keys (including keys that contain dots) and creates intermediate
 * objects/arrays as needed. Supports array notation like "field[0]".
 *
 * @param obj - The object to set the value in
 * @param path - Dot notation path (e.g., "user.name" or "items[0].title")
 * @param value - The value to set
 */
export function setNestedValue(obj: any, path: string, value: any): void {
    writePath(obj, path, value);
}

/**
 * Delete a property from a nested object using dot notation path
 *
 * @param obj - The object to delete the property from
 * @param path - Dot notation path (e.g., "user.name")
 */
export function deleteNestedProperty(obj: any, path: string): void {
    deletePath(obj, path);
}

/**
 * Get display name for a column path
 * For nested paths, returns the full path to avoid conflicts
 * For top-level paths, returns just the field name
 *
 * @param path - The column path
 * @returns The display name
 */
export function getDisplayName(path: string): string {
    // For nested paths, return the full path to avoid conflicts with expanded columns
    // For top-level paths, return just the field name
    const parts = path.split('.');
    if (parts.length > 1) {
        return path; // Return full path for nested fields
    }
    return parts[parts.length - 1]; // Return just the field name for top-level
}

/**
 * Convert Pretty Print view content (a sequence of pretty-printed top-level
 * JSON values separated by newlines) back into compact JSONL.
 *
 * Returns null if any part of the content is not valid JSON, so callers can
 * hold off applying a mid-edit state instead of corrupting the document.
 *
 * @param prettyContent - The Pretty Print editor content
 * @returns Compact JSONL (one value per line), or null if content is invalid
 */
export function convertPrettyToJsonl(prettyContent: string): string | null {
    if (!prettyContent.trim()) {
        return '';
    }

    const lines = prettyContent.split('\n');
    const jsonlLines: string[] = [];
    let buffer = '';
    let depth = 0;
    let inString = false;

    for (const line of lines) {
        buffer = buffer ? buffer + '\n' + line : line;

        // Track brace/bracket depth (string- and escape-aware) so we only
        // attempt a parse when a top-level value could be complete
        let escapeNext = false;
        for (const char of line) {
            if (escapeNext) {
                escapeNext = false;
                continue;
            }
            if (char === '\\') {
                escapeNext = inString;
                continue;
            }
            if (char === '"') {
                inString = !inString;
                continue;
            }
            if (!inString) {
                if (char === '{' || char === '[') {
                    depth++;
                } else if (char === '}' || char === ']') {
                    depth--;
                }
            }
        }

        if (inString || depth > 0) {
            continue;
        }

        const candidate = buffer.trim();
        if (!candidate) {
            buffer = '';
            continue;
        }

        try {
            jsonlLines.push(JSON.stringify(JSON.parse(candidate)));
            buffer = '';
        } catch {
            // Every bracket is closed and no string is open, so no later line
            // can make this text parse (a missing comma, a trailing comma, a
            // half-typed bare value). Give up now: accumulating instead
            // re-parsed an ever-growing buffer at every later record, which
            // froze the extension host for a minute on a large file whenever
            // an edit was mid-way.
            return null;
        }
    }

    if (buffer.trim()) {
        // Leftover content never became valid JSON
        return null;
    }

    return jsonlLines.join('\n');
}

/**
 * Check if a value is a stringified JSON object or array
 *
 * @param value - The value to check
 * @returns True if the value is a stringified JSON
 */
export function isStringifiedJson(value: any): boolean {
    if (typeof value !== 'string') {
        return false;
    }

    const trimmed = value.trim();
    // Skip empty strings
    if (trimmed === '') {
        return false;
    }
    // Check if it starts with "[" or "{" and looks like JSON
    return (trimmed.startsWith('[') || trimmed.startsWith('{')) &&
           (trimmed.endsWith(']') || trimmed.endsWith('}'));
}
