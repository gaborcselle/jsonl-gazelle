/**
 * Utility functions for JSONL data manipulation
 */

/**
 * Get a value from a nested object using dot notation path
 * Supports array notation like "field[0]"
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

    const parts = path.split('.');
    let current = obj;

    for (const part of parts) {
        if (current === null || current === undefined) {
            break;
        }

        if (part.includes('[') && part.includes(']')) {
            const [key, indexStr] = part.split('[');
            const index = parseInt(indexStr.replace(']', ''));
            if (isNaN(index)) {
                return undefined;
            }
            current = current[key]?.[index];
        } else {
            current = current[part];
        }

        if (current === undefined) break;
    }

    return current;
}

/**
 * Set a value in a nested object using dot notation path
 * Creates intermediate objects/arrays as needed
 * Supports array notation like "field[0]"
 *
 * @param obj - The object to set the value in
 * @param path - Dot notation path (e.g., "user.name" or "items[0].title")
 * @param value - The value to set
 */
export function setNestedValue(obj: any, path: string, value: any): void {
    const parts = path.split('.');
    let current = obj;

    for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];

        if (part.includes('[') && part.includes(']')) {
            const [key, indexStr] = part.split('[');
            const index = parseInt(indexStr.replace(']', ''));
            if (!current[key]) current[key] = [];
            if (!current[key][index]) current[key][index] = {};
            current = current[key][index];
        } else {
            if (!current[part]) current[part] = {};
            current = current[part];
        }
    }

    const lastPart = parts[parts.length - 1];
    if (lastPart.includes('[') && lastPart.includes(']')) {
        const [key, indexStr] = lastPart.split('[');
        const index = parseInt(indexStr.replace(']', ''));
        if (!current[key]) current[key] = [];
        current[key][index] = value;
    } else {
        current[lastPart] = value;
    }
}

/**
 * Delete a property from a nested object using dot notation path
 *
 * @param obj - The object to delete the property from
 * @param path - Dot notation path (e.g., "user.name")
 */
export function deleteNestedProperty(obj: any, path: string): void {
    const parts = path.split('.');
    if (parts.length === 1) {
        // Top-level property
        delete obj[path];
    } else {
        // Nested property
        const parentPath = parts.slice(0, -1);
        const propertyName = parts[parts.length - 1];

        let current = obj;
        for (const part of parentPath) {
            if (current && typeof current === 'object' && part in current) {
                current = current[part];
            } else {
                return; // Path doesn't exist
            }
        }

        if (current && typeof current === 'object') {
            delete current[propertyName];
        }
    }
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
