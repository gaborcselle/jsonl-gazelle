/**
 * Shared type definitions for JSONL Gazelle
 */

export interface JsonRow {
    [key: string]: any;
}

export interface ParsedLine {
    data: JsonRow | null;
    lineNumber: number;
    rawLine: string;
    error?: string;
}

export interface ColumnInfo {
    path: string;
    displayName: string;
    visible: boolean;
    isExpanded?: boolean;
    parentPath?: string;
    isManuallyAdded?: boolean;  // Flag for manually added columns
    insertPosition?: 'before' | 'after';  // Position relative to reference
    insertReferenceColumn?: string;  // Reference column for insertion
}
