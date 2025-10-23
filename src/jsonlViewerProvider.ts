import * as vscode from 'vscode';
import * as path from 'path';

interface JsonRow {
    [key: string]: any;
}

interface ParsedLine {
    data: JsonRow | null;
    lineNumber: number;
    rawLine: string;
    error?: string;
}

interface ColumnInfo {
    path: string;
    displayName: string;
    visible: boolean;
    isExpanded?: boolean;
    parentPath?: string;
    isManuallyAdded?: boolean;  // Flag for manually added columns
    insertPosition?: 'before' | 'after';  // Position relative to reference
    insertReferenceColumn?: string;  // Reference column for insertion
}

export class JsonlViewerProvider implements vscode.CustomTextEditorProvider {
    private static readonly viewType = 'jsonl-gazelle.jsonlViewer';
    private rows: JsonRow[] = [];
    private filteredRows: JsonRow[] = [];
    private columns: ColumnInfo[] = [];
    private searchTerm: string = '';
    private isIndexing: boolean = false;
    private parsedLines: ParsedLine[] = [];
    private rawContent: string = '';
    private errorCount: number = 0;

    // Chunked loading properties
    private readonly CHUNK_SIZE = 100; // Lines per chunk
    private readonly INITIAL_CHUNKS = 3; // Load first 3 chunks immediately
    private readonly MAX_MEMORY_ROWS = 50000; // Maximum rows to keep in memory for very large files
    private readonly CHUNKED_LOADING_THRESHOLD = 1000; // Only use chunked loading for files with more than 1000 lines
    private loadingChunks: boolean = false;
    private totalLines: number = 0;
    private loadedLines: number = 0;
    private pathCounts: { [key: string]: number } = {};
    private currentWebviewPanel: vscode.WebviewPanel | null = null;
    private memoryOptimized: boolean = false;
    private isUpdating: boolean = false; // Flag to prevent recursive updates
    private pendingSaveTimeout: NodeJS.Timeout | null = null; // For debouncing saves
    private manualColumnsPerFile: Map<string, ColumnInfo[]> = new Map(); // Store manual columns per file

    constructor(private readonly context: vscode.ExtensionContext) {}

    public static register(context: vscode.ExtensionContext): vscode.Disposable {
        const provider = new JsonlViewerProvider(context);
        const viewProvider = vscode.window.registerCustomEditorProvider(JsonlViewerProvider.viewType, provider);
        return viewProvider;
    }

    public async resolveCustomTextEditor(
        document: vscode.TextDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        try {
            this.currentWebviewPanel = webviewPanel;
            webviewPanel.webview.options = {
                enableScripts: true,
                enableCommandUris: true
            };

            webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);

            // Handle messages from the webview
            webviewPanel.webview.onDidReceiveMessage(
                async (message) => {
                    try {
                        switch (message.type) {
                            case 'search':
                                this.searchTerm = message.searchTerm;
                                this.filterRows();
                                this.updateWebview(webviewPanel);
                                break;
                            case 'removeColumn':
                                await this.removeColumn(message.columnPath, webviewPanel, document);
                                break;
                            case 'updateCell':
                                await this.updateCell(message.rowIndex, message.columnPath, message.value, webviewPanel, document);
                                break;
                            case 'expandColumn':
                                this.expandColumn(message.columnPath);
                                this.updateWebview(webviewPanel);
                                break;
                            case 'collapseColumn':
                                this.collapseColumn(message.columnPath);
                                this.updateWebview(webviewPanel);
                                break;
                            case 'openUrl':
                                vscode.env.openExternal(vscode.Uri.parse(message.url));
                                break;
                            case 'documentChanged':
                                await this.handleDocumentChange(message.rowIndex, message.newData, webviewPanel, document);
                                break;
                            case 'rawContentChanged':
                                await this.handleRawContentChange(message.newContent, webviewPanel, document);
                                break;
                            case 'unstringifyColumn':
                                await this.handleUnstringifyColumn(message.columnPath, webviewPanel, document);
                                break;
                            case 'deleteRow':
                                await this.handleDeleteRow(message.rowIndex, webviewPanel, document);
                                break;
                            case 'insertRow':
                                await this.handleInsertRow(message.rowIndex, message.position, webviewPanel, document);
                                break;
                            case 'copyRow':
                                await this.handleCopyRow(message.rowIndex, webviewPanel);
                                break;
                            case 'duplicateRow':
                                await this.handleDuplicateRow(message.rowIndex, webviewPanel, document);
                                break;
                            case 'pasteRow':
                                await this.handlePasteRow(message.rowIndex, message.position, webviewPanel, document);
                                break;
                            case 'validateClipboard':
                                await this.handleValidateClipboard(webviewPanel);
                                break;
                            case 'reorderColumns':
                                await this.reorderColumns(message.fromIndex, message.toIndex, webviewPanel, document);
                                break;
                            case 'toggleColumnVisibility':
                                this.toggleColumnVisibility(message.columnPath);
                                this.updateWebview(webviewPanel);
                                break;
                            case 'addColumn':
                                await this.handleAddColumn(message.columnName, message.position, message.referenceColumn, webviewPanel, document);
                                break;
                            case 'addAIColumn':
                                await this.handleAddAIColumn(message.columnName, message.promptTemplate, message.position, message.referenceColumn, webviewPanel, document);
                                break;
                            case 'getSettings':
                                await this.handleGetSettings(webviewPanel);
                                break;
                            case 'checkAPIKey':
                                await this.handleCheckAPIKey(webviewPanel);
                                break;
                            case 'showAPIKeyWarning':
                                vscode.window.showWarningMessage('OpenAI API key is required for AI features. Please configure it in settings.');
                                break;
                            case 'saveSettings':
                                await this.handleSaveSettings(message.settings);
                                break;
                            case 'generateAIRows':
                                await this.handleGenerateAIRows(message.rowIndex, message.contextRowCount, message.rowCount, message.promptTemplate, webviewPanel, document);
                                break;
                        }
                    } catch (error) {
                        console.error('Error handling webview message:', error);
                    }
                }
            );

            // Handle document changes
            const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument(e => {
                if (e.document.uri.toString() === document.uri.toString()) {
                    // Skip reload if we're currently updating the document
                    if (!this.isUpdating) {
                        // Only reload if the content actually changed
                        const newContent = e.document.getText();
                        if (newContent !== this.rawContent) {
                            this.loadJsonlFile(document);
                        }
                    }
                }
            });

            // Store subscription for cleanup
            webviewPanel.onDidDispose(() => {
                changeDocumentSubscription.dispose();
            });

            // Load and parse the JSONL file
            await this.loadJsonlFile(document);
            
            // Always send an initial update to ensure webview gets data
            this.updateWebview(webviewPanel);
        } catch (error) {
            console.error('Error in resolveCustomTextEditor:', error);
            // Send error message to webview
            try {
                webviewPanel.webview.postMessage({
                    type: 'update',
                    data: {
                        rows: [],
                        columns: [],
                        isIndexing: false,
                        searchTerm: '',
                        parsedLines: [{
                            data: null,
                            lineNumber: 1,
                            rawLine: '',
                            error: `Extension error: ${error instanceof Error ? error.message : 'Unknown error'}`
                        }],
                        rawContent: '',
                        errorCount: 1,
                        loadingProgress: {
                            loadedLines: 0,
                            totalLines: 0,
                            loadingChunks: false,
                            progressPercent: 100,
                            memoryOptimized: false,
                            displayedRows: 0
                        }
                    }
                });
            } catch (postError) {
                console.error('Error posting error message to webview:', postError);
            }
        }
    }

    private async loadJsonlFile(document: vscode.TextDocument) {
        try {
            this.isIndexing = true;
            const text = document.getText();
            this.rawContent = text;
            const lines = text.split('\n');
            
            this.totalLines = lines.length;
            this.loadedLines = 0;
            this.rows = [];
            this.parsedLines = [];
            
            // Get file URI for per-file column storage
            const fileUri = document.uri.toString();
            
            // Save currently displayed manual columns to file-specific storage
            const currentManualColumns = this.columns.filter(col => col.isManuallyAdded);
            if (currentManualColumns.length > 0) {
                this.manualColumnsPerFile.set(fileUri, currentManualColumns);
            }
            
            this.columns = []; // Clear columns
            
            this.errorCount = 0;
            this.pathCounts = {};
            this.memoryOptimized = false;
            
            // Handle empty files
            if (this.totalLines === 0 || (this.totalLines === 1 && lines[0].trim() === '')) {
                this.isIndexing = false;
                this.filteredRows = [];
                if (this.currentWebviewPanel) {
                    this.updateWebview(this.currentWebviewPanel);
                }
                return;
            }
        
        // For small files, load everything at once (no chunked loading)
        if (this.totalLines <= this.CHUNKED_LOADING_THRESHOLD) {
            this.processChunk(lines, 0);
            this.loadedLines = this.totalLines;
            this.updateColumns();
            
            // Restore manually added columns to their original positions
            const savedManualColumns = this.manualColumnsPerFile.get(fileUri) || [];
            if (savedManualColumns.length > 0) {
                this.restoreManualColumns(savedManualColumns);
            }
            
            this.filteredRows = this.rows; // Point to same array for small files
            this.isIndexing = false;
            
            if (this.currentWebviewPanel) {
                this.updateWebview(this.currentWebviewPanel);
            }
            return;
        }
        
        // Determine if we need memory optimization for very large files
        if (this.totalLines > this.MAX_MEMORY_ROWS) {
            this.memoryOptimized = true;
            console.log(`Large file detected (${this.totalLines} lines). Using memory optimization.`);
        }
        
        // Load initial chunks immediately
        const initialChunkSize = this.CHUNK_SIZE * this.INITIAL_CHUNKS;
        const initialLines = lines.slice(0, Math.min(initialChunkSize, this.totalLines));
        
        this.processChunk(initialLines, 0);
        this.loadedLines = initialLines.length;
        
        // Update UI with initial data
        this.updateColumns();
        
        // Restore manually added columns to their original positions
        const savedManualColumns = this.manualColumnsPerFile.get(fileUri) || [];
        if (savedManualColumns.length > 0) {
            this.restoreManualColumns(savedManualColumns);
        }
        
        this.filteredRows = this.rows; // Point to same array initially
        this.isIndexing = false;
        
        if (this.currentWebviewPanel) {
            this.updateWebview(this.currentWebviewPanel);
        }
        
        // Continue loading remaining chunks in background
        if (this.loadedLines < this.totalLines) {
            this.loadRemainingChunks(lines);
        }
        } catch (error) {
            console.error('Error loading JSONL file:', error);
            this.isIndexing = false;
            this.errorCount = 1;
            this.parsedLines = [{
                data: null,
                lineNumber: 1,
                rawLine: '',
                error: `Error loading file: ${error instanceof Error ? error.message : 'Unknown error'}`
            }];
            if (this.currentWebviewPanel) {
                this.updateWebview(this.currentWebviewPanel);
            }
        }
    }
    
    private async loadRemainingChunks(lines: string[]) {
        this.loadingChunks = true;
        
        for (let startIndex = this.loadedLines; startIndex < this.totalLines; startIndex += this.CHUNK_SIZE) {
            const endIndex = Math.min(startIndex + this.CHUNK_SIZE, this.totalLines);
            const chunkLines = lines.slice(startIndex, endIndex);
            
            this.processChunk(chunkLines, startIndex);
            this.loadedLines = endIndex;
            
            // Memory optimization: keep only recent rows for very large files
            if (this.memoryOptimized && this.rows.length > this.MAX_MEMORY_ROWS) {
                const keepRows = Math.floor(this.MAX_MEMORY_ROWS * 0.8); // Keep 80% of max
                const oldLength = this.rows.length;
                this.rows = this.rows.slice(-keepRows);
                this.parsedLines = this.parsedLines.slice(-keepRows);
                
                // Recalculate path counts for remaining rows
                this.pathCounts = {};
                this.rows.forEach(row => {
                    if (row && typeof row === 'object') {
                        this.countPaths(row, '', this.pathCounts);
                    }
                });
                
                console.log(`Memory optimization: Kept ${this.rows.length} most recent rows (removed ${oldLength - this.rows.length} rows)`);
            }
            
            // Update columns progressively - only add new columns, don't re-expand
            this.addNewColumnsOnly();
            
            // Only copy array if there's an active search, otherwise point to same array
            if (this.searchTerm) {
                this.filteredRows = [...this.rows];
            } else {
                this.filteredRows = this.rows; // Much faster - no copying
            }
            
            // Update UI less frequently (every 5 chunks = every 500 lines)
            if ((startIndex / this.CHUNK_SIZE) % 5 === 0 && this.currentWebviewPanel) {
                this.updateWebview(this.currentWebviewPanel);
            }
            
            // Yield control to prevent blocking the UI
            await new Promise(resolve => setTimeout(resolve, 0));
        }
        
        this.loadingChunks = false;
        
        // Final update
        if (this.currentWebviewPanel) {
            this.updateWebview(this.currentWebviewPanel);
        }
    }
    
    private processChunk(lines: string[], startIndex: number) {
        lines.forEach((line, index) => {
            const globalIndex = startIndex + index;
            const trimmedLine = line.trim();
            
            if (trimmedLine) {
                try {
                    const obj = JSON.parse(trimmedLine);
                    this.rows.push(obj);
                    this.parsedLines.push({
                        data: obj,
                        lineNumber: globalIndex + 1,
                        rawLine: line
                    });
                    
                    // Count paths for column detection - with error handling
                    try {
                        this.countPaths(obj, '', this.pathCounts);
                    } catch (countError) {
                        console.warn(`Error counting paths for line ${globalIndex + 1}:`, countError);
                        // Continue processing even if path counting fails
                    }
                } catch (error) {
                    this.errorCount++;
                    this.parsedLines.push({
                        data: null,
                        lineNumber: globalIndex + 1,
                        rawLine: line,
                        error: error instanceof Error ? error.message : 'Parse error'
                    });
                    console.error(`Error parsing JSON line ${globalIndex + 1}:`, error);
                }
            } else {
                // Empty line
                this.parsedLines.push({
                    data: null,
                    lineNumber: globalIndex + 1,
                    rawLine: line
                });
            }
        });
    }
    
    private updateColumns() {
        const totalRows = this.rows.length;
        const threshold = Math.max(1, Math.floor(totalRows * 0.1)); // At least 10% of rows
        
        // If we already have columns (e.g., after adding manually), just add missing ones
        if (this.columns.length > 0) {
            this.addNewColumnsOnly();
            return;
        }
        
        // Detect column order from first row to preserve file order
        const columnOrderMap = new Map<string, number>();
        if (this.rows.length > 0 && typeof this.rows[0] === 'object') {
            Object.keys(this.rows[0]).forEach((key, index) => {
                columnOrderMap.set(key, index);
            });
        }
        
        // Create auto-detected columns
        const newColumns: ColumnInfo[] = [];
        for (const [path, count] of Object.entries(this.pathCounts)) {
            if (count >= threshold) {
                newColumns.push({
                    path,
                    displayName: this.getDisplayName(path),
                    visible: true,
                    isExpanded: false
                });
            }
        }
        
        // Sort columns by their order in the first row, then alphabetically for nested
        newColumns.sort((a, b) => {
            if (a.path === '(value)') return -1;
            if (b.path === '(value)') return 1;
            
            const orderA = columnOrderMap.get(a.path);
            const orderB = columnOrderMap.get(b.path);
            
            // Both have order from first row - use that order
            if (orderA !== undefined && orderB !== undefined) {
                return orderA - orderB;
            }
            // One has order, other doesn't - prioritize the one with order
            if (orderA !== undefined) return -1;
            if (orderB !== undefined) return 1;
            // Neither has order - sort alphabetically
            return a.path.localeCompare(b.path);
        });
        
        this.columns = newColumns;
    }
    
    private addNewColumnsOnly() {
        const totalRows = this.rows.length;
        const threshold = Math.max(1, Math.floor(totalRows * 0.1)); // At least 10% of rows
        
        // Create a set of existing column paths to avoid duplicates
        const existingPaths = new Set(this.columns.map(col => col.path));
        
        const newColumns: ColumnInfo[] = [];
        for (const [path, count] of Object.entries(this.pathCounts)) {
            if (count >= threshold && !existingPaths.has(path)) {
                newColumns.push({
                    path,
                    displayName: this.getDisplayName(path),
                    visible: true,
                    isExpanded: false
                });
            }
        }
        
        // Sort only new auto-detected columns
        newColumns.sort((a, b) => {
            if (a.path === '(value)') return -1;
            if (b.path === '(value)') return 1;
            return a.path.localeCompare(b.path);
        });
        
        // Add new columns while preserving manually added ones
        this.columns.push(...newColumns);
    }

    private countPaths(obj: any, prefix: string, counts: { [key: string]: number }) {
        // Handle null/undefined objects
        if (obj === null || obj === undefined) {
            return;
        }
        
        // Handle case where the entire JSON line is just a string value
        if (typeof obj === 'string' && !prefix) {
            counts['(value)'] = (counts['(value)'] || 0) + 1;
            return;
        }
        
        // Handle case where the entire JSON line is a number, boolean, or null
        if ((typeof obj === 'number' || typeof obj === 'boolean' || obj === null) && !prefix) {
            counts['(value)'] = (counts['(value)'] || 0) + 1;
            return;
        }
        
        // Handle arrays at the root level
        if (Array.isArray(obj) && !prefix) {
            counts['(value)'] = (counts['(value)'] || 0) + 1;
            return;
        }
        
        // Handle objects with key-value pairs
        if (typeof obj === 'object' && obj !== null) {
            try {
                for (const [key, value] of Object.entries(obj)) {
                    const fullPath = prefix ? `${prefix}.${key}` : key;
                    
                    if (value !== null && value !== undefined) {
                        // Only count top-level fields initially
                        // Subcolumns will be created through expansion
                        if (!prefix) {
                            counts[fullPath] = (counts[fullPath] || 0) + 1;
                        }
                        
                        // Recursively count nested objects (but limit depth to avoid too many columns)
                        if (typeof value === 'object' && !Array.isArray(value) && prefix.split('.').length < 2) {
                            this.countPaths(value, fullPath, counts);
                        }
                    }
                }
            } catch (error) {
                console.warn('Error counting paths for object:', error);
                // If there's an error with Object.entries, treat as primitive value
                if (!prefix) {
                    counts['(value)'] = (counts['(value)'] || 0) + 1;
                }
            }
        }
    }

    private getDisplayName(path: string): string {
        // For nested paths, return the full path to avoid conflicts with expanded columns
        // For top-level paths, return just the field name
        const parts = path.split('.');
        if (parts.length > 1) {
            return path; // Return full path for nested fields
        }
        return parts[parts.length - 1]; // Return just the field name for top-level
    }

    private filterRows() {
        if (!this.searchTerm) {
            // If no search term, point to the same array (much faster than copying)
            this.filteredRows = this.rows;
            return;
        }

        this.filteredRows = this.rows.filter(row => {
            const searchText = JSON.stringify(row).toLowerCase();
            const term = this.searchTerm.toLowerCase();
            return searchText.includes(term);
        });
    }


    private async removeColumn(columnPath: string, webviewPanel: vscode.WebviewPanel, document: vscode.TextDocument) {
        try {
            // Remove column from columns array
            this.columns = this.columns.filter(col => col.path !== columnPath);
            
            // Actually remove the field from all rows
            this.rows.forEach(row => {
                this.deleteNestedProperty(row, columnPath);
            });
            
            // Update filtered rows if search is active
            this.filterRows();
            
            // Update parsedLines to reflect the changes
            this.parsedLines = this.rows.map((row, index) => ({
                data: row,
                lineNumber: index + 1,
                rawLine: JSON.stringify(row)
            }));
            
            // Update raw content
            this.rawContent = this.rows.map(row => JSON.stringify(row)).join('\n');
            
            // Update the document content
            const edit = new vscode.WorkspaceEdit();
            edit.replace(
                document.uri,
                new vscode.Range(0, 0, document.lineCount, 0),
                this.rawContent
            );
            await vscode.workspace.applyEdit(edit);
            
            // Update the webview to reflect changes
            this.updateWebview(webviewPanel);
            
            vscode.window.showInformationMessage(`Column "${columnPath}" deleted successfully`);
        } catch (error) {
            console.error('Error removing column:', error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage('Failed to delete column: ' + errorMessage);
        }
    }
    
    private deleteNestedProperty(obj: any, path: string): void {
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

    private expandColumn(columnPath: string) {
        const column = this.columns.find(col => col.path === columnPath);
        if (!column) return;

        // Check if this column contains objects or arrays
        const sampleValue = this.getSampleValue(columnPath);
        if (!sampleValue || (typeof sampleValue !== 'object')) return;

        // Mark the parent column as expanded and hide it
        column.isExpanded = true;
        column.visible = false;

        const columnIndex = this.columns.indexOf(column);
        const newColumns: ColumnInfo[] = [];

        if (Array.isArray(sampleValue)) {
            // For arrays, create columns for each element
            const maxLength = this.getMaxArrayLength(columnPath);
            for (let i = 0; i < maxLength; i++) {
                const newPath = `${columnPath}[${i}]`;
                if (!this.columns.find(col => col.path === newPath)) {
                    newColumns.push({
                        path: newPath,
                        displayName: `${columnPath}[${i}]`,
                        visible: true,
                        isExpanded: false,
                        parentPath: columnPath
                    });
                }
            }
        } else {
            // For objects, create columns for each property
            const allKeys = this.getAllObjectKeys(columnPath);
            allKeys.forEach(key => {
                const newPath = `${columnPath}.${key}`;
                if (!this.columns.find(col => col.path === newPath)) {
                    newColumns.push({
                        path: newPath,
                        displayName: `${columnPath}.${key}`,
                        visible: true,
                        isExpanded: false,
                        parentPath: columnPath
                    });
                }
            });
        }

        // Insert new columns right after the current column
        this.columns.splice(columnIndex + 1, 0, ...newColumns);
    }

    private collapseColumn(columnPath: string) {
        const column = this.columns.find(col => col.path === columnPath);
        if (!column) return;

        // Mark the parent column as collapsed and show it again
        column.isExpanded = false;
        column.visible = true;

        // Remove all child columns
        this.columns = this.columns.filter(col => !col.parentPath || col.parentPath !== columnPath);
    }

    private async reorderColumns(fromIndex: number, toIndex: number, webviewPanel?: vscode.WebviewPanel, document?: vscode.TextDocument) {
        // Validate indices
        if (fromIndex < 0 || fromIndex >= this.columns.length || 
            toIndex < 0 || toIndex >= this.columns.length ||
            fromIndex === toIndex) {
            return;
        }

        // Remove the column from its current position
        const [movedColumn] = this.columns.splice(fromIndex, 1);
        
        // Insert it at the new position
        this.columns.splice(toIndex, 0, movedColumn);
        
        // Update position info for ALL manually added columns based on current order
        if (document) {
            this.columns.forEach((col, index) => {
                if (col.isManuallyAdded) {
                    // Find the previous non-manual column
                    let refColumn = null;
                    for (let i = index - 1; i >= 0; i--) {
                        if (!this.columns[i].isManuallyAdded) {
                            refColumn = this.columns[i].path;
                            break;
                        }
                    }
                    
                    if (refColumn) {
                        col.insertReferenceColumn = refColumn;
                        col.insertPosition = 'after';
                    } else if (index < this.columns.length - 1) {
                        // No previous non-manual column, use next one with 'before'
                        for (let i = index + 1; i < this.columns.length; i++) {
                            if (!this.columns[i].isManuallyAdded) {
                                col.insertReferenceColumn = this.columns[i].path;
                                col.insertPosition = 'before';
                                break;
                            }
                        }
                    }
                }
            });
            
            // Save updated manual columns
            const fileUri = document.uri.toString();
            const manualColumns = this.columns.filter(col => col.isManuallyAdded);
            this.manualColumnsPerFile.set(fileUri, manualColumns);
        }
        
        // If document is provided, reorder keys in JSON and save
        if (document && webviewPanel) {
            try {
                // Get new column order
                const columnOrder = this.columns.map(col => col.path);
                
                // Reorder keys in all rows
                this.rows.forEach(row => {
                    if (typeof row !== 'object' || row === null) return;
                    
                    const newRow: JsonRow = {};
                    
                    // Add keys in new column order
                    for (const colPath of columnOrder) {
                        if (row.hasOwnProperty(colPath)) {
                            newRow[colPath] = row[colPath];
                        }
                    }
                    
                    // Add any remaining keys not in columns (shouldn't happen, but just in case)
                    for (const key of Object.keys(row)) {
                        if (!newRow.hasOwnProperty(key)) {
                            newRow[key] = row[key];
                        }
                    }
                    
                    // Replace row contents with reordered version
                    Object.keys(row).forEach(key => delete row[key]);
                    Object.assign(row, newRow);
                });
                
                // Update parsedLines and rawContent
                this.parsedLines = this.rows.map((row, index) => ({
                    data: row,
                    lineNumber: index + 1,
                    rawLine: JSON.stringify(row)
                }));
                
                this.rawContent = this.rows.map(row => JSON.stringify(row)).join('\n');
                
                // Save to document
                this.isUpdating = true;
                const edit = new vscode.WorkspaceEdit();
                edit.replace(
                    document.uri,
                    new vscode.Range(0, 0, document.lineCount, 0),
                    this.rawContent
                );
                await vscode.workspace.applyEdit(edit);
                setTimeout(() => { this.isUpdating = false; }, 100);
                
                // Update webview after save
                this.updateWebview(webviewPanel);
            } catch (error) {
                console.error('Error reordering columns:', error);
            }
        }
    }

    private toggleColumnVisibility(columnPath: string) {
        const column = this.columns.find(col => col.path === columnPath);
        if (!column) return;

        // Toggle the visibility
        column.visible = !column.visible;
    }

    private restoreManualColumns(savedColumns: ColumnInfo[]) {
        // Only restore manual columns that actually exist in the data
        const validSavedColumns = savedColumns.filter(col => {
            // Check if this column exists in any row
            return this.rows.some(row => row.hasOwnProperty(col.path));
        });
        
        // Insert saved manual columns back at their positions
        for (const col of validSavedColumns) {
            // If we have position info, use it
            if (col.insertReferenceColumn && col.insertPosition) {
                const refIndex = this.columns.findIndex(c => c.path === col.insertReferenceColumn);
                if (refIndex !== -1) {
                    const insertAt = col.insertPosition === 'before' ? refIndex : refIndex + 1;
                    this.columns.splice(insertAt, 0, col);
                    continue;
                }
            }
            
            // Otherwise add at the end
            this.columns.push(col);
        }
    }

    private async handleAddColumn(
        columnName: string,
        position: 'before' | 'after',
        referenceColumn: string,
        webviewPanel: vscode.WebviewPanel,
        document: vscode.TextDocument
    ) {
        try {
            // Validate column name length
            if (columnName.length > 100) {
                vscode.window.showErrorMessage('Column name is too long. Maximum length is 100 characters.');
                return;
            }
            
            // Check if data contains objects (not primitives)
            if (this.rows.length > 0 && typeof this.rows[0] !== 'object') {
                vscode.window.showErrorMessage('Cannot add columns to primitive values. File must contain JSON objects.');
                return;
            }

            // Check if column with this name already exists in the columns list
            const existingColumnIndex = this.columns.findIndex(col => col.path === columnName);

            // If column exists but has no data (from a previous failed attempt), clean it up
            const hasDataInRows = this.rows.some(row => row.hasOwnProperty(columnName) && row[columnName] !== null);

            if (existingColumnIndex !== -1 && hasDataInRows) {
                // Column exists and has real data - don't allow duplicate
                vscode.window.showErrorMessage(`Column "${columnName}" already exists in this file.`);
                return;
            }

            // Clean up any remnants from previous failed attempts
            if (existingColumnIndex !== -1) {
                // Remove from columns list
                this.columns.splice(existingColumnIndex, 1);
            }

            // Remove from rows if present
            if (this.rows.some(row => row.hasOwnProperty(columnName))) {
                this.rows.forEach(row => {
                    delete row[columnName];
                });
            }

            // Remove from manualColumnsPerFile to prevent restoration
            {
                const fileUri = document.uri.toString();
                const savedManualColumns = this.manualColumnsPerFile.get(fileUri) || [];
                const filteredColumns = savedManualColumns.filter(col => col.path !== columnName);
                if (filteredColumns.length > 0) {
                    this.manualColumnsPerFile.set(fileUri, filteredColumns);
                } else {
                    this.manualColumnsPerFile.delete(fileUri);
                }
            }

            // Find the reference column
            const refColumnIndex = this.columns.findIndex(col => col.path === referenceColumn);
            if (refColumnIndex === -1) return;

            // Create new column with position info
            const newColumn: ColumnInfo = {
                path: columnName,
                displayName: columnName,
                visible: true,
                isExpanded: false,
                isManuallyAdded: true,  // Mark as manually added
                insertPosition: position,  // 'before' or 'after'
                insertReferenceColumn: referenceColumn  // Which column to insert relative to
            };

            // Insert column at the right position
            const insertIndex = position === 'before' ? refColumnIndex : refColumnIndex + 1;
            this.columns.splice(insertIndex, 0, newColumn);

            // Add null values to all rows for the new column at the correct position
            this.rows.forEach(row => {
                // Create new object with keys in the right order
                const newRow: JsonRow = {};
                let inserted = false;
                
                for (const key of Object.keys(row)) {
                    // Insert new column before or after reference column
                    if (key === referenceColumn && position === 'before' && !inserted) {
                        newRow[columnName] = null;
                        inserted = true;
                    }
                    
                    newRow[key] = row[key];
                    
                    if (key === referenceColumn && position === 'after' && !inserted) {
                        newRow[columnName] = null;
                        inserted = true;
                    }
                }
                
                // If column wasn't inserted (shouldn't happen), add at end
                if (!inserted) {
                    newRow[columnName] = null;
                }
                
                // Replace row contents with ordered keys
                Object.keys(row).forEach(key => delete row[key]);
                Object.assign(row, newRow);
            });

            // Update filtered rows
            this.filterRows();

            // Update parsedLines to reflect the changes
            this.parsedLines = this.rows.map((row, index) => ({
                data: row,
                lineNumber: index + 1,
                rawLine: JSON.stringify(row)
            }));

            // Update raw content
            this.rawContent = this.rows.map(row => JSON.stringify(row)).join('\n');

            // Update the document content (set flag to prevent reload)
            this.isUpdating = true;
            const edit = new vscode.WorkspaceEdit();
            edit.replace(
                document.uri,
                new vscode.Range(0, 0, document.lineCount, 0),
                this.rawContent
            );
            await vscode.workspace.applyEdit(edit);
            
            // Wait a bit for the edit to complete, then reset flag
            setTimeout(() => { this.isUpdating = false; }, 100);

            // Update webview
            this.updateWebview(webviewPanel);
            
            // Save manual columns for this file
            const fileUri = document.uri.toString();
            const manualColumns = this.columns.filter(col => col.isManuallyAdded);
            this.manualColumnsPerFile.set(fileUri, manualColumns);

            vscode.window.showInformationMessage(`Column "${columnName}" added successfully`);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to add column: ${error instanceof Error ? error.message : 'Unknown error'}`);
            console.error('Error adding column:', error);
        }
    }

    private async handleAddAIColumn(
        columnName: string,
        promptTemplate: string,
        position: 'before' | 'after',
        referenceColumn: string,
        webviewPanel: vscode.WebviewPanel,
        document: vscode.TextDocument
    ) {
        // Set isUpdating flag at the very start to prevent any reloads
        this.isUpdating = true;

        try {
            // Validate column name length
            if (columnName.length > 100) {
                vscode.window.showErrorMessage('Column name is too long. Maximum length is 100 characters.');
                this.isUpdating = false;
                return;
            }

            // Check if data contains objects (not primitives)
            if (this.rows.length > 0 && typeof this.rows[0] !== 'object') {
                vscode.window.showErrorMessage('Cannot add columns to primitive values. File must contain JSON objects.');
                this.isUpdating = false;
                return;
            }

            // Check if column with this name already exists in the columns list
            const existingColumnIndex = this.columns.findIndex(col => col.path === columnName);

            // If column exists but has no data (from a previous failed attempt), clean it up
            const hasDataInRows = this.rows.some(row => row.hasOwnProperty(columnName) && row[columnName] !== null);

            if (existingColumnIndex !== -1 && hasDataInRows) {
                // Column exists and has real data - don't allow duplicate
                vscode.window.showErrorMessage(`Column "${columnName}" already exists in this file.`);
                this.isUpdating = false;
                return;
            }

            // Clean up any remnants from previous failed attempts
            if (existingColumnIndex !== -1) {
                // Remove from columns list
                this.columns.splice(existingColumnIndex, 1);
            }

            // Remove from rows if present
            if (this.rows.some(row => row.hasOwnProperty(columnName))) {
                this.rows.forEach(row => {
                    delete row[columnName];
                });
            }

            // Remove from manualColumnsPerFile to prevent restoration
            {
                const fileUri = document.uri.toString();
                const savedManualColumns = this.manualColumnsPerFile.get(fileUri) || [];
                const filteredColumns = savedManualColumns.filter(col => col.path !== columnName);
                if (filteredColumns.length > 0) {
                    this.manualColumnsPerFile.set(fileUri, filteredColumns);
                } else {
                    this.manualColumnsPerFile.delete(fileUri);
                }
            }

            // Find the reference column
            const refColumnIndex = this.columns.findIndex(col => col.path === referenceColumn);
            if (refColumnIndex === -1) {
                this.isUpdating = false;
                return;
            }

            // Create new column with position info
            const newColumn: ColumnInfo = {
                path: columnName,
                displayName: columnName,
                visible: true,
                isExpanded: false,
                isManuallyAdded: true,
                insertPosition: position,
                insertReferenceColumn: referenceColumn
            };

            // Insert column at the right position
            const insertIndex = position === 'before' ? refColumnIndex : refColumnIndex + 1;
            this.columns.splice(insertIndex, 0, newColumn);

            // Add null values to all rows for the new column (will be filled by AI)
            this.rows.forEach(row => {
                const newRow: JsonRow = {};
                let inserted = false;

                for (const key of Object.keys(row)) {
                    if (key === referenceColumn && position === 'before' && !inserted) {
                        newRow[columnName] = null;
                        inserted = true;
                    }

                    newRow[key] = row[key];

                    if (key === referenceColumn && position === 'after' && !inserted) {
                        newRow[columnName] = null;
                        inserted = true;
                    }
                }

                if (!inserted) {
                    newRow[columnName] = null;
                }

                Object.keys(row).forEach(key => delete row[key]);
                Object.assign(row, newRow);
            });

            // Update webview to show the column with null values
            this.updateWebview(webviewPanel);

            // Now fill the column with AI-generated content
            await this.fillColumnWithAI(columnName, promptTemplate, webviewPanel, document);

        } catch (error) {
            // Rollback: Remove the column that was just added
            const columnIndex = this.columns.findIndex(col => col.path === columnName);
            if (columnIndex !== -1) {
                this.columns.splice(columnIndex, 1);
            }

            // Remove the column from all rows
            this.rows.forEach(row => {
                delete row[columnName];
            });

            // Remove from manualColumnsPerFile
            const fileUri = document.uri.toString();
            const savedManualColumns = this.manualColumnsPerFile.get(fileUri) || [];
            const filteredColumns = savedManualColumns.filter(col => col.path !== columnName);
            if (filteredColumns.length > 0) {
                this.manualColumnsPerFile.set(fileUri, filteredColumns);
            } else {
                this.manualColumnsPerFile.delete(fileUri);
            }

            // Update the webview to reflect the rollback
            this.updateWebview(webviewPanel);

            // Show user-friendly error message
            const errorMsg = error instanceof Error ? error.message : 'Unknown error';
            if (errorMsg.includes('quota') || errorMsg.includes('limit') || errorMsg.includes('allowance')) {
                vscode.window.showErrorMessage(`AI quota exceeded: ${errorMsg}`);
            } else {
                vscode.window.showErrorMessage(`Failed to add AI column: ${errorMsg}`);
            }
            console.error('Error adding AI column:', error);
        } finally {
            // Always reset the flag when done
            this.isUpdating = false;
        }
    }

    private async fillColumnWithAI(
        columnName: string,
        promptTemplate: string,
        webviewPanel: vscode.WebviewPanel,
        document: vscode.TextDocument
    ) {
        const totalRows = this.rows.length;

        // Note: isUpdating flag is already set by handleAddAIColumn
        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Generating AI content for column "${columnName}"`,
                cancellable: false
            }, async (progress) => {
                progress.report({ increment: 0, message: `Processing ${totalRows.toLocaleString()} rows...` });

                // Process rows in parallel batches
                const batchSize = 10; // Process 10 rows concurrently
                let processedCount = 0;

            for (let i = 0; i < totalRows; i += batchSize) {
                const endIndex = Math.min(i + batchSize, totalRows);
                const batch = [];

                for (let j = i; j < endIndex; j++) {
                    batch.push(this.generateAIValueForRow(j, promptTemplate, totalRows));
                }

                // Wait for all promises in the batch to resolve
                const results = await Promise.all(batch);

                // Assign results to rows
                for (let j = 0; j < results.length; j++) {
                    const rowIndex = i + j;
                    const row = this.rows[rowIndex];

                    // Maintain column order when setting the value
                    const newRow: JsonRow = {};
                    for (const key of Object.keys(row)) {
                        newRow[key] = key === columnName ? results[j] : row[key];
                    }
                    Object.keys(row).forEach(key => delete row[key]);
                    Object.assign(row, newRow);
                }

                processedCount = endIndex;
                const progressPercent = Math.round((processedCount / totalRows) * 100);
                progress.report({
                    increment: (batchSize / totalRows) * 100,
                    message: `Processed ${processedCount.toLocaleString()} of ${totalRows.toLocaleString()} rows (${progressPercent}%)`
                });

                // Update webview periodically
                if (processedCount % 50 === 0 || processedCount === totalRows) {
                    this.updateWebview(webviewPanel);
                }
            }

            // Update filtered rows
            this.filterRows();

            // Update parsedLines to reflect the changes
            this.parsedLines = this.rows.map((row, index) => ({
                data: row,
                lineNumber: index + 1,
                rawLine: JSON.stringify(row)
            }));

            // Update raw content
            this.rawContent = this.rows.map(row => JSON.stringify(row)).join('\n');

            // Update the document content
            const edit = new vscode.WorkspaceEdit();
            edit.replace(
                document.uri,
                new vscode.Range(0, 0, document.lineCount, 0),
                this.rawContent
            );
            await vscode.workspace.applyEdit(edit);

            // Final webview update
            this.updateWebview(webviewPanel);

                // Save manual columns for this file
                const fileUri = document.uri.toString();
                const manualColumns = this.columns.filter(col => col.isManuallyAdded);
                this.manualColumnsPerFile.set(fileUri, manualColumns);

                vscode.window.showInformationMessage(`AI column "${columnName}" generated successfully for ${totalRows} rows`);
            });
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to generate AI content: ${error instanceof Error ? error.message : 'Unknown error'}`);
            console.error('Error generating AI content:', error);
            throw error; // Re-throw so parent can handle
        }
    }

    private async generateAIValueForRow(rowIndex: number, promptTemplate: string, totalRows: number): Promise<string> {
        const row = this.rows[rowIndex];

        // Replace template variables
        const prompt = this.replaceTemplateVariables(promptTemplate, row, rowIndex, totalRows);

        // Call the language model API (let errors bubble up)
        const result = await this.callLanguageModel(prompt);

        return result;
    }

    private replaceTemplateVariables(template: string, row: any, rowIndex: number, totalRows: number): string {
        let result = template;

        // Replace {{row}} with full JSON
        result = result.replace(/\{\{row\}\}/g, JSON.stringify(row));

        // Replace {{row.fieldname}}, {{row.fieldname[0]}}, etc.
        const fieldRegex = /\{\{row\.([a-zA-Z0-9_.\[\]]+)\}\}/g;
        result = result.replace(fieldRegex, (_match, fieldPath) => {
            try {
                const value = this.getNestedValue(row, fieldPath);
                return value !== undefined && value !== null ? String(value) : '';
            } catch {
                return '';
            }
        });

        // Replace {{row_number}} (1-based)
        result = result.replace(/\{\{row_number\}\}/g, String(rowIndex + 1));

        // Replace {{rows_before}}
        result = result.replace(/\{\{rows_before\}\}/g, String(rowIndex));

        // Replace {{rows_after}}
        result = result.replace(/\{\{rows_after\}\}/g, String(totalRows - rowIndex - 1));

        return result;
    }

    private async callLanguageModel(prompt: string): Promise<string> {
        return await this.callOpenAI(prompt);
    }

    private async callVSCodeLM(prompt: string): Promise<string> {
        const models = await vscode.lm.selectChatModels({
            vendor: 'copilot',
            family: 'gpt-4o'
        });

        if (models.length === 0) {
            throw new Error('No language model available. Please ensure GitHub Copilot is enabled.');
        }

        const model = models[0];
        const messages = [
            vscode.LanguageModelChatMessage.User(prompt)
        ];

        const response = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);

        let result = '';
        for await (const fragment of response.text) {
            result += fragment;
        }

        return result.trim();
    }

    private async callOpenAI(prompt: string): Promise<string> {
        const apiKey = await this.context.secrets.get('openaiApiKey');
        if (!apiKey) {
            throw new Error('OpenAI API key not configured. Please set it in AI Settings.');
        }

        const model = this.context.globalState.get<string>('openaiModel', 'gpt-4.1-mini');

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: model,
                messages: [
                    { role: 'user', content: prompt }
                ],
                temperature: 0.7
            })
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`OpenAI API error: ${response.status} - ${error}`);
        }

        const data = await response.json();
        return data.choices[0].message.content.trim();
    }

    private async handleGetSettings(webviewPanel: vscode.WebviewPanel) {
        try {
            const openaiKey = await this.context.secrets.get('openaiApiKey') || '';
            const openaiModel = this.context.globalState.get<string>('openaiModel', 'gpt-4.1-mini');

            webviewPanel.webview.postMessage({
                type: 'settingsLoaded',
                settings: {
                    openaiKey,
                    openaiModel
                }
            });
        } catch (error) {
            console.error('Error loading settings:', error);
        }
    }

    private async handleCheckAPIKey(webviewPanel: vscode.WebviewPanel) {
        try {
            const openaiKey = await this.context.secrets.get('openaiApiKey');
            const hasAPIKey = !!openaiKey;

            webviewPanel.webview.postMessage({
                type: 'apiKeyCheckResult',
                hasAPIKey
            });
        } catch (error) {
            console.error('Error checking API key:', error);
            webviewPanel.webview.postMessage({
                type: 'apiKeyCheckResult',
                hasAPIKey: false
            });
        }
    }

    private async handleSaveSettings(settings: { openaiKey: string; openaiModel: string }) {
        try {
            await this.context.globalState.update('openaiModel', settings.openaiModel);

            if (settings.openaiKey) {
                await this.context.secrets.store('openaiApiKey', settings.openaiKey);
            }

            vscode.window.showInformationMessage('AI settings saved successfully');
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to save settings: ${error instanceof Error ? error.message : 'Unknown error'}`);
            console.error('Error saving settings:', error);
        }
    }

    private async handleGenerateAIRows(
        rowIndex: number,
        contextRowCount: number,
        rowCount: number,
        promptTemplate: string,
        webviewPanel: vscode.WebviewPanel,
        document: vscode.TextDocument
    ) {
        // Set isUpdating flag to prevent reload during AI generation
        this.isUpdating = true;

        try {
            // Get context rows (previous rows before the selected row)
            const startIndex = Math.max(0, rowIndex - contextRowCount + 1);
            const contextRows = this.rows.slice(startIndex, rowIndex + 1);

            // Replace template variables
            let prompt = promptTemplate;
            prompt = prompt.replace(/\{\{context_rows\}\}/g, JSON.stringify(contextRows, null, 2));
            prompt = prompt.replace(/\{\{row_count\}\}/g, String(rowCount));
            prompt = prompt.replace(/\{\{existing_count\}\}/g, String(this.rows.length));

            // Extract column names and types from context rows
            const columnNames = contextRows.length > 0 ? Object.keys(contextRows[0]) : [];
            const firstRow = contextRows.length > 0 ? contextRows[0] : {};
            const columnTypes = columnNames.map(name => {
                const value = firstRow[name];
                return `${name}: ${typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string'}`;
            });

            // Add strict instruction to return JSON array with exact structure
            prompt += `\n\nIMPORTANT INSTRUCTIONS:
                1. Return ONLY a valid JSON array of ${rowCount} objects
                2. Each object MUST have ALL these fields with correct types:
                   ${columnTypes.join('\n                   ')}
                3. Use proper JSON types: numbers without quotes, booleans as true/false, strings in quotes
                4. Do NOT omit any fields
                5. Do NOT add extra fields
                6. No explanations, no markdown formatting, just the JSON array

                Example row from context:
                ${JSON.stringify(firstRow)}`;


            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Generating ${rowCount} AI rows...`,
                cancellable: false
            }, async (progress) => {
                progress.report({ increment: 0, message: 'Calling AI model...' });

                // Call the AI model
                const result = await this.callLanguageModel(prompt);

                progress.report({ increment: 50, message: 'Parsing generated rows...' });

                // Parse the result
                let generatedRows: any[];
                try {
                    // Try to extract JSON array from the response
                    const jsonMatch = result.match(/\[[\s\S]*\]/);
                    if (jsonMatch) {
                        generatedRows = JSON.parse(jsonMatch[0]);
                    } else {
                        generatedRows = JSON.parse(result);
                    }

                    if (!Array.isArray(generatedRows)) {
                        throw new Error('AI did not return an array');
                    }

                    // Fix data types based on context rows
                    generatedRows = generatedRows.map(row => this.fixDataTypes(row, firstRow));
                } catch (parseError) {
                    throw new Error(`Failed to parse AI response as JSON: ${parseError instanceof Error ? parseError.message : 'Unknown error'}\n\nResponse: ${result}`);
                }

                progress.report({ increment: 25, message: 'Inserting rows...' });

                // Insert the generated rows after the selected row
                const insertIndex = rowIndex + 1;
                this.rows.splice(insertIndex, 0, ...generatedRows);

                // Rebuild parsedLines
                this.parsedLines = this.rows.map((row, index) => ({
                    data: row,
                    lineNumber: index + 1,
                    rawLine: JSON.stringify(row)
                }));

                // Update filtered rows
                this.filterRows();

                // Update raw content
                this.rawContent = this.rows.map(row => JSON.stringify(row)).join('\n');

                // Update the document content
                const edit = new vscode.WorkspaceEdit();
                edit.replace(
                    document.uri,
                    new vscode.Range(0, 0, document.lineCount, 0),
                    this.rawContent
                );
                await vscode.workspace.applyEdit(edit);

                progress.report({ increment: 25, message: 'Done!' });

                // Update webview
                this.updateWebview(webviewPanel);

                vscode.window.showInformationMessage(`Successfully generated and inserted ${generatedRows.length} rows`);
            });

        } catch (error) {
            // Show user-friendly error message
            const errorMsg = error instanceof Error ? error.message : 'Unknown error';
            if (errorMsg.includes('quota') || errorMsg.includes('limit') || errorMsg.includes('allowance')) {
                vscode.window.showErrorMessage(`AI quota exceeded: ${errorMsg}`);
            } else {
                vscode.window.showErrorMessage(`Failed to generate AI rows: ${errorMsg}`);
            }
            console.error('Error generating AI rows:', error);
        } finally {
            // Always reset the isUpdating flag
            this.isUpdating = false;
        }
    }

    private fixDataTypes(generatedRow: any, templateRow: any): any {
        const fixedRow: any = {};

        for (const key in templateRow) {
            if (generatedRow.hasOwnProperty(key)) {
                const templateValue = templateRow[key];
                const generatedValue = generatedRow[key];
                const templateType = typeof templateValue;

                // Convert to the correct type based on template
                if (templateType === 'number') {
                    // Convert string numbers to actual numbers
                    fixedRow[key] = typeof generatedValue === 'string' ? parseFloat(generatedValue) : Number(generatedValue);
                } else if (templateType === 'boolean') {
                    // Convert string booleans to actual booleans
                    if (typeof generatedValue === 'string') {
                        fixedRow[key] = generatedValue.toLowerCase() === 'true';
                    } else {
                        fixedRow[key] = Boolean(generatedValue);
                    }
                } else {
                    // Keep as string or original type
                    fixedRow[key] = generatedValue;
                }
            } else {
                // Field missing, use null
                fixedRow[key] = null;
            }
        }

        return fixedRow;
    }

    private getSampleValue(columnPath: string): any {
        for (const row of this.filteredRows) {
            const value = this.getNestedValue(row, columnPath);
            if (value !== undefined && value !== null) {
                return value;
            }
        }
        return null;
    }

    private getMaxArrayLength(columnPath: string): number {
        let maxLength = 0;
        for (const row of this.filteredRows) {
            const value = this.getNestedValue(row, columnPath);
            if (Array.isArray(value)) {
                maxLength = Math.max(maxLength, value.length);
            }
        }
        return maxLength;
    }

    private getAllObjectKeys(columnPath: string): string[] {
        const allKeys = new Set<string>();
        for (const row of this.filteredRows) {
            const value = this.getNestedValue(row, columnPath);
            if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
                Object.keys(value).forEach(key => allKeys.add(key));
            }
        }
        return Array.from(allKeys).sort();
    }


    private getNestedValue(obj: any, path: string): any {
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

    private async handleRawContentChange(newContent: string, webviewPanel: vscode.WebviewPanel, document: vscode.TextDocument) {
        try {
            // Update the raw content
            this.rawContent = newContent;
            
            // Update the document content
            const edit = new vscode.WorkspaceEdit();
            edit.replace(
                document.uri,
                new vscode.Range(0, 0, document.lineCount, 0),
                newContent
            );
            await vscode.workspace.applyEdit(edit);
            
            // Reload the file to update parsed data
            await this.loadJsonlFile(document);
            
            // Update the webview to reflect changes
            this.updateWebview(webviewPanel);
        } catch (error) {
            console.error('Error handling raw content change:', error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage('Failed to save raw content changes: ' + errorMessage);
        }
    }

    private async handleDocumentChange(rowIndex: number, newData: any, webviewPanel: vscode.WebviewPanel, document: vscode.TextDocument) {
        try {
            // Update the row data
            this.rows[rowIndex] = newData;

            // Update the document content
            const jsonlContent = this.rows.map(row => JSON.stringify(row)).join('\n');
            const edit = new vscode.WorkspaceEdit();
            edit.replace(
                document.uri,
                new vscode.Range(0, 0, document.lineCount, 0),
                jsonlContent
            );
            await vscode.workspace.applyEdit(edit);

            // Update the webview to reflect changes
            this.updateWebview(webviewPanel);
        } catch (error) {
            console.error('Error handling document change:', error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage('Failed to save changes: ' + errorMessage);
        }
    }

    private async handleDeleteRow(rowIndex: number, webviewPanel: vscode.WebviewPanel, document: vscode.TextDocument) {
        try {
            if (rowIndex < 0 || rowIndex >= this.rows.length) {
                vscode.window.showErrorMessage('Invalid row index');
                return;
            }

            // Ask for confirmation
            const confirm = await vscode.window.showWarningMessage(
                `Are you sure you want to delete row ${rowIndex + 1}?`,
                { modal: true },
                'Delete'
            );

            if (confirm !== 'Delete') {
                return;
            }

            // Set flag to prevent recursive updates
            this.isUpdating = true;

            // Remove the row from the arrays
            this.rows.splice(rowIndex, 1);

            // Also update parsedLines - need to rebuild from rows
            this.parsedLines = this.rows.map((row, index) => ({
                data: row,
                lineNumber: index + 1,
                rawLine: JSON.stringify(row)
            }));

            // Update filtered rows if search is active
            this.filterRows();

            // Update the raw content
            this.rawContent = this.rows.map(row => JSON.stringify(row)).join('\n');

            // Update the document content
            const edit = new vscode.WorkspaceEdit();
            edit.replace(
                document.uri,
                new vscode.Range(0, 0, document.lineCount, 0),
                this.rawContent
            );
            await vscode.workspace.applyEdit(edit);

            // Update the webview to reflect changes
            this.updateWebview(webviewPanel);

            vscode.window.showInformationMessage(`Row ${rowIndex + 1} deleted successfully`);
        } catch (error) {
            console.error('Error deleting row:', error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage('Failed to delete row: ' + errorMessage);
        } finally {
            setTimeout(() => {
                this.isUpdating = false;
            }, 100);
        }
    }

    private async handleInsertRow(rowIndex: number, position: 'above' | 'below', webviewPanel: vscode.WebviewPanel, document: vscode.TextDocument) {
        try {
            if (rowIndex < 0 || rowIndex >= this.rows.length) {
                console.error(`Invalid row index: ${rowIndex}, total rows: ${this.rows.length}`);
                vscode.window.showErrorMessage(`Invalid row index: ${rowIndex}. Please try again.`);
                return;
            }

            // Create a new row based on the structure of existing rows
            // Try to copy the structure of the clicked row with empty/null values
            const templateRow = this.rows[rowIndex];

            // If template row is undefined or null, create a basic empty object
            if (!templateRow) {
                console.error(`Template row at index ${rowIndex} is undefined`);
                vscode.window.showErrorMessage('Unable to create new row from template');
                return;
            }

            // Set flag to prevent recursive updates
            this.isUpdating = true;

            const newRow: JsonRow = this.createEmptyRow();

            // Insert the new row at the appropriate position
            const insertIndex = position === 'above' ? rowIndex : rowIndex + 1;
            this.rows.splice(insertIndex, 0, newRow);

            // Rebuild parsedLines from rows
            this.parsedLines = this.rows.map((row, index) => ({
                data: row,
                lineNumber: index + 1,
                rawLine: JSON.stringify(row)
            }));

            // Update filtered rows if search is active
            this.filterRows();

            // Update the raw content
            this.rawContent = this.rows.map(row => JSON.stringify(row)).join('\n');

            // Update the document content
            const edit = new vscode.WorkspaceEdit();
            edit.replace(
                document.uri,
                new vscode.Range(0, 0, document.lineCount, 0),
                this.rawContent
            );
            await vscode.workspace.applyEdit(edit);

            // Update the webview to reflect changes
            this.updateWebview(webviewPanel);

            vscode.window.showInformationMessage(`New row inserted ${position} row ${rowIndex + 1}`);
        } catch (error) {
            console.error('Error inserting row:', error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage('Failed to insert row: ' + errorMessage);
        } finally {
            setTimeout(() => {
                this.isUpdating = false;
            }, 100);
        }
    }

    private async handleCopyRow(rowIndex: number, webviewPanel: vscode.WebviewPanel) {
        try {
            if (rowIndex < 0 || rowIndex >= this.rows.length) {
                vscode.window.showErrorMessage('Invalid row index');
                return;
            }

            const rowData = this.rows[rowIndex];
            const jsonString = JSON.stringify(rowData, null, 2);
            
            await vscode.env.clipboard.writeText(jsonString);
            vscode.window.showInformationMessage(`Row ${rowIndex + 1} copied to clipboard`);
        } catch (error) {
            console.error('Error copying row:', error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage('Failed to copy row: ' + errorMessage);
        }
    }

    private async handleDuplicateRow(rowIndex: number, webviewPanel: vscode.WebviewPanel, document: vscode.TextDocument) {
        try {
            if (rowIndex < 0 || rowIndex >= this.rows.length) {
                vscode.window.showErrorMessage('Invalid row index');
                return;
            }

            // Set flag to prevent recursive updates
            this.isUpdating = true;

            // Deep clone the row to duplicate it
            const originalRow = this.rows[rowIndex];
            const duplicatedRow = JSON.parse(JSON.stringify(originalRow));

            // Insert the duplicated row right after the original
            this.rows.splice(rowIndex + 1, 0, duplicatedRow);

            // Rebuild parsedLines from rows
            this.parsedLines = this.rows.map((row, index) => ({
                data: row,
                lineNumber: index + 1,
                rawLine: JSON.stringify(row)
            }));

            // Update filtered rows if search is active
            this.filterRows();

            // Update the raw content
            this.rawContent = this.rows.map(row => JSON.stringify(row)).join('\n');

            // Update the document content
            const edit = new vscode.WorkspaceEdit();
            edit.replace(
                document.uri,
                new vscode.Range(0, 0, document.lineCount, 0),
                this.rawContent
            );
            await vscode.workspace.applyEdit(edit);

            // Update the webview to reflect changes
            this.updateWebview(webviewPanel);

            vscode.window.showInformationMessage(`Row ${rowIndex + 1} duplicated`);
        } catch (error) {
            console.error('Error duplicating row:', error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage('Failed to duplicate row: ' + errorMessage);
        } finally {
            setTimeout(() => {
                this.isUpdating = false;
            }, 100);
        }
    }

    private async handlePasteRow(rowIndex: number, position: 'above' | 'below', webviewPanel: vscode.WebviewPanel, document: vscode.TextDocument) {
        try {
            if (rowIndex < 0 || rowIndex >= this.rows.length) {
                vscode.window.showErrorMessage('Invalid row index');
                return;
            }

            // Get clipboard content
            const clipboardText = await vscode.env.clipboard.readText();
            
            // Try to parse as JSON
            let parsedData: any;
            try {
                parsedData = JSON.parse(clipboardText);
            } catch (parseError) {
                vscode.window.showErrorMessage('Clipboard does not contain valid JSON');
                return;
            }

            // Set flag to prevent recursive updates
            this.isUpdating = true;

            // Insert the pasted row at the appropriate position
            const insertIndex = position === 'above' ? rowIndex : rowIndex + 1;
            this.rows.splice(insertIndex, 0, parsedData);

            // Rebuild parsedLines from rows
            this.parsedLines = this.rows.map((row, index) => ({
                data: row,
                lineNumber: index + 1,
                rawLine: JSON.stringify(row)
            }));

            // Update filtered rows if search is active
            this.filterRows();

            // Update the raw content
            this.rawContent = this.rows.map(row => JSON.stringify(row)).join('\n');

            // Update the document content
            const edit = new vscode.WorkspaceEdit();
            edit.replace(
                document.uri,
                new vscode.Range(0, 0, document.lineCount, 0),
                this.rawContent
            );
            await vscode.workspace.applyEdit(edit);

            // Update the webview to reflect changes
            this.updateWebview(webviewPanel);

            vscode.window.showInformationMessage(`Row pasted ${position} row ${rowIndex + 1}`);
        } catch (error) {
            console.error('Error pasting row:', error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage('Failed to paste row: ' + errorMessage);
        } finally {
            setTimeout(() => {
                this.isUpdating = false;
            }, 100);
        }
    }

    private async handleValidateClipboard(webviewPanel: vscode.WebviewPanel) {
        try {
            const clipboardText = await vscode.env.clipboard.readText();
            let isValidJson = false;
            
            if (clipboardText) {
                try {
                    JSON.parse(clipboardText);
                    isValidJson = true;
                } catch (parseError) {
                    isValidJson = false;
                }
            }
            
            // Send validation result back to webview
            webviewPanel.webview.postMessage({
                type: 'clipboardValidationResult',
                isValidJson: isValidJson
            });
        } catch (error) {
            console.error('Error validating clipboard:', error);
            // Send false result on error
            webviewPanel.webview.postMessage({
                type: 'clipboardValidationResult',
                isValidJson: false
            });
        }
    }

    private createEmptyRow(): JsonRow {
        // Return an empty object - user can fill in values as needed
        return {};
    }

    private updateWebview(webviewPanel: vscode.WebviewPanel) {
        try {
            // Ensure data consistency before sending to webview
            if (!this.rows || !this.columns) {
                console.warn('updateWebview: rows or columns not initialized');
                return;
            }

            // Create a mapping of filtered rows to their actual indices
            const rowIndices = this.filteredRows.map(row => {
                const index = this.rows.indexOf(row);
                return index >= 0 ? index : this.filteredRows.indexOf(row);
            });

            webviewPanel.webview.postMessage({
                type: 'update',
                data: {
                    rows: this.filteredRows || [],
                    rowIndices: rowIndices, // Map filtered rows to actual indices
                    allRows: this.rows || [], // Send the full array for index mapping
                    columns: this.columns || [],
                    isIndexing: this.isIndexing,
                    searchTerm: this.searchTerm,
                    parsedLines: this.parsedLines || [],
                    rawContent: this.rawContent || '',
                    errorCount: this.errorCount,
                    loadingProgress: {
                        loadedLines: this.loadedLines,
                        totalLines: this.totalLines,
                        loadingChunks: this.loadingChunks,
                        progressPercent: this.totalLines > 0 ? Math.round((this.loadedLines / this.totalLines) * 100) : 100,
                        memoryOptimized: this.memoryOptimized,
                        displayedRows: this.rows.length
                    }
                }
            });
        } catch (error) {
            console.error('Error in updateWebview:', error);
        }
    }

    private getHtmlForWebview(webview: vscode.Webview): string {
        const gazelleIconUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'gazelle.svg')
        );

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>JSONL Gazelle</title>
    <script src="https://cdn.jsdelivr.net/npm/monaco-editor@0.44.0/min/vs/loader.js"></script>
    <style>
        html, body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            margin: 0;
            padding: 0;
            height: 100%;
            overflow: hidden;
        }
        
        body {
            display: flex;
            flex-direction: column;
        }
        
        .main-content {
            flex: 1;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }
        
        .header {
            display: flex;
            align-items: center;
            padding: 10px;
            background-color: var(--vscode-editor-background);
            border-bottom: 1px solid var(--vscode-panel-border);
            gap: 10px;
        }
        
        .logo {
            width: 32px;
            height: 32px;
            margin-right: 10px;
        }
        
        .logo.loading {
            animation: spin 2s linear infinite;
        }
        
        .loading-state {
            display: flex;
            align-items: center;
            gap: 10px;
            flex: 1;
            justify-content: center;
            font-size: 14px;
            color: var(--vscode-descriptionForeground);
        }
        
        .loading-progress {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
        }
        
        .controls-hidden {
            display: none !important;
        }
        
        .search-container {
            display: flex;
            align-items: center;
            gap: 5px;
            flex: 1;
        }
        
        .search-input {
            flex: 1;
            padding: 5px 10px;
            border: 1px solid var(--vscode-input-border);
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border-radius: 3px;
        }
        
        .search-input:focus {
            outline: none;
            border-color: var(--vscode-focusBorder);
        }
        
        .search-icon {
            color: var(--vscode-foreground);
            display: flex;
            align-items: center;
        }
        
        .search-icon svg {
            width: 16px;
            height: 16px;
        }
        
        .replace-container {
            display: flex;
            align-items: center;
            gap: 5px;
        }
        
        .replace-toggle {
            padding: 5px 10px;
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: 1px solid var(--vscode-button-border);
            border-radius: 3px;
            cursor: pointer;
            font-size: 12px;
        }
        
        .replace-toggle:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        
        .replace-input {
            padding: 5px 10px;
            border: 1px solid var(--vscode-input-border);
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border-radius: 3px;
            width: 200px;
            display: none;
        }
        
        .replace-input.expanded {
            display: block;
        }
        
        .checkbox-container {
            display: flex;
            align-items: center;
            gap: 5px;
            font-size: 12px;
        }
        
        .checkbox {
            accent-color: var(--vscode-checkbox-background);
        }
        
        .button {
            padding: 5px 10px;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 3px;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 5px;
        }
        
        .button svg {
            width: 16px;
            height: 16px;
            flex-shrink: 0;
        }
        
        .button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        
        .ai-container {
            display: flex;
            align-items: center;
            gap: 5px;
            margin-left: 10px;
        }
        
        .ai-input {
            padding: 5px 10px;
            border: 1px solid var(--vscode-input-border);
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border-radius: 3px;
            width: 300px;
        }
        
        .model-select {
            padding: 5px 10px;
            border: 1px solid var(--vscode-input-border);
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border-radius: 3px;
        }
        
        .table-container {
            flex: 1;
            overflow: auto;
            min-height: 0;
        }
        
        .view-container {
            height: 100%;
            overflow: visible;
        }
        
        .view-container.isolated {
            position: relative;
            z-index: 10;
        }
        
        #rawViewContainer {
            height: 100%;
            overflow: auto;
        }
        
        table {
            width: 100%;
            border-collapse: collapse;
            font-size: 12px;
            font-family: var(--vscode-editor-font-family);
        }
        
        th {
            background-color: var(--vscode-editor-background);
            color: var(--vscode-foreground);
            padding: 8px;
            text-align: left;
            border-bottom: 1px solid var(--vscode-panel-border);
            position: sticky;
            top: 0;
            z-index: 10;
            cursor: pointer;
            user-select: none;
            position: relative;
            min-width: 50px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        
        .resize-handle {
            position: absolute;
            top: 0;
            right: 0;
            width: 4px;
            height: 100%;
            background-color: transparent;
            cursor: col-resize;
            z-index: 20;
        }
        
        .resize-handle:hover {
            background-color: var(--vscode-focusBorder);
        }
        
        .resizing {
            cursor: col-resize !important;
        }
        
        th:hover {
            background-color: var(--vscode-list-hoverBackground);
        }

        .row-header {
            background-color: var(--vscode-editor-background);
            color: var(--vscode-descriptionForeground);
            padding: 6px 8px;
            text-align: center;
            border-bottom: 1px solid var(--vscode-panel-border);
            border-right: 2px solid var(--vscode-panel-border);
            cursor: context-menu;
            user-select: none;
            min-width: 40px;
            font-weight: normal;
            position: sticky;
            left: 0;
            z-index: 5;
        }

        .row-header:hover {
            background-color: var(--vscode-list-hoverBackground);
        }

        td {
            padding: 6px 8px;
            border-bottom: 1px solid var(--vscode-panel-border);
            max-width: 200px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            cursor: pointer;
            position: relative;
            user-select: none;
        }
        
        td.editing {
            padding: 0;
            overflow: visible;
        }
        
        td.editing input {
            width: 100%;
            height: 100%;
            border: none;
            outline: none;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            padding: 6px 8px;
            font-size: inherit;
            font-family: inherit;
            box-sizing: border-box;
        }
        
        tr:hover {
            background-color: var(--vscode-list-hoverBackground);
        }
        
        .indexing {
            display: flex;
            align-items: center;
            justify-content: center;
            height: 200px;
            flex-direction: column;
            gap: 10px;
        }
        
        .indexing-icon {
            width: 32px;
            height: 32px;
            animation: spin 2s linear infinite;
        }
        
        @keyframes spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
        }
        
        .context-menu {
            position: absolute;
            background-color: var(--vscode-menu-background);
            border: 1px solid var(--vscode-menu-border);
            border-radius: 3px;
            padding: 5px 0;
            z-index: 1000;
            display: none;
        }

        .context-menu-item {
            padding: 5px 15px;
            cursor: pointer;
            color: var(--vscode-menu-foreground);
        }

        .context-menu-item:hover {
            background-color: var(--vscode-menu-selectionBackground);
        }
        
        .context-menu-separator {
            height: 1px;
            background-color: var(--vscode-menu-separatorBackground, rgba(128, 128, 128, 0.35));
            margin: 5px 0;
        }

        .row-context-menu {
            position: absolute;
            background-color: var(--vscode-menu-background);
            border: 1px solid var(--vscode-menu-border);
            border-radius: 3px;
            padding: 5px 0;
            z-index: 1000;
            display: none;
            min-width: 150px;
        }

        .row-context-menu-item {
            padding: 8px 15px;
            cursor: pointer;
            color: var(--vscode-menu-foreground);
            font-size: 12px;
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .row-context-menu-item:hover {
            background-color: var(--vscode-menu-selectionBackground);
        }
        
        .row-context-menu-item.disabled {
            color: var(--vscode-disabledForeground);
            opacity: 0.6;
            cursor: not-allowed;
        }
        
        .row-context-menu-item.disabled:hover {
            background-color: transparent;
        }

        .row-context-menu-separator {
            height: 1px;
            background-color: var(--vscode-menu-separatorBackground);
            margin: 5px 0;
        }
        
        .settings-button {
            margin-left: auto;
        }
        
        .export-container {
            position: relative;
            display: inline-block;
        }
        
        .export-dropdown {
            position: absolute;
            top: 100%;
            right: 0;
            background-color: var(--vscode-menu-background);
            border: 1px solid var(--vscode-menu-border);
            border-radius: 3px;
            padding: 5px 0;
            z-index: 1000;
            min-width: 120px;
        }
        
        .export-dropdown-item {
            padding: 8px 15px;
            cursor: pointer;
            color: var(--vscode-menu-foreground);
            font-size: 12px;
        }
        
        .export-dropdown-item:hover {
            background-color: var(--vscode-menu-selectionBackground);
        }
        
        
        
        .view-controls {
            display: flex;
            align-items: center;
            gap: 10px;
            margin-bottom: 10px;
            padding: 10px;
            background-color: var(--vscode-editor-background);
            border-bottom: 1px solid var(--vscode-panel-border);
            flex-shrink: 0;
        }
        
        .segmented-control {
            display: flex;
            background-color: var(--vscode-button-secondaryBackground);
            border-radius: 5px;
            overflow: hidden;
        }
        
        .segmented-control button {
            background: none;
            border: none;
            padding: 8px 16px;
            color: var(--vscode-button-secondaryForeground);
            cursor: pointer;
            transition: background-color 0.2s;
            display: flex;
            align-items: center;
            gap: 5px;
        }
        
        .segmented-control button svg {
            width: 16px;
            height: 16px;
            flex-shrink: 0;
        }
        
        .segmented-control button.active {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        
        .segmented-control button:hover:not(.active) {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        
        .error-count {
            background-color: var(--vscode-errorForeground);
            color: var(--vscode-editor-background);
            border-radius: 50%;
            width: 20px;
            height: 20px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 12px;
            font-weight: bold;
            margin-left: 10px;
        }
        
        .raw-view {
            height: 100%;
            font-family: var(--vscode-editor-font-family);
            font-size: var(--vscode-editor-font-size);
            line-height: 1.4;
            overflow: auto;
            background-color: var(--vscode-editor-background);
            padding: 0;
        }
        
        
        .raw-content {
            font-family: var(--vscode-editor-font-family);
            font-size: var(--vscode-editor-font-size);
            line-height: 1.4;
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            padding: 10px;
            white-space: pre;
            tab-size: 4;
            min-height: 100%;
        }
        
        .raw-line {
            display: flex;
            margin-bottom: 2px;
        }
        
        .raw-line-number {
            color: var(--vscode-editorLineNumber-foreground);
            user-select: none;
            width: 50px;
            text-align: right;
            margin-right: 15px;
            flex-shrink: 0;
        }
        
        .raw-line-content {
            flex: 1;
            white-space: pre;
        }
        
        .raw-line.error {
            background-color: var(--vscode-inputValidation-errorBackground);
            color: var(--vscode-inputValidation-errorForeground);
        }
        
        .expandable-cell {
            cursor: pointer;
            position: relative;
        }
        
        .expandable-cell:hover {
            background-color: var(--vscode-list-hoverBackground);
        }
        
        .expand-icon {
            margin-left: 5px;
            font-size: 10px;
            opacity: 1;
            display: flex;
            align-items: center;
            color: var(--vscode-foreground);
        }
        
        .expand-icon svg {
            width: 12px;
            height: 12px;
            stroke: var(--vscode-foreground);
            opacity: 0.8;
        }
        
        .expand-button {
            background: none;
            border: none;
            color: var(--vscode-foreground);
            cursor: pointer;
            font-size: 12px;
            padding: 2px 4px;
            margin-left: 4px;
            border-radius: 2px;
            display: inline-block;
            vertical-align: middle;
            flex-shrink: 0;
        }
        
        .expand-button svg {
            width: 12px;
            height: 12px;
            stroke: var(--vscode-foreground);
            opacity: 1;
        }
        
        .expand-button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        
        .expand-button:not(:hover) {
            opacity: 1;
        }
        
        .collapse-button {
            background: none;
            border: none;
            color: var(--vscode-foreground);
            cursor: pointer;
            font-size: 12px;
            padding: 2px 4px;
            margin-right: 4px;
            border-radius: 2px;
            display: inline-block;
            vertical-align: middle;
            flex-shrink: 0;
        }
        
        .collapse-button svg {
            width: 12px;
            height: 12px;
            stroke: var(--vscode-foreground);
            opacity: 1;
        }
        
        .collapse-button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        
        .collapse-button:not(:hover) {
            opacity: 1;
        }
        
        .expanded-column {
            background-color: var(--vscode-textBlockQuote-background);
            border-left: 3px solid var(--vscode-textBlockQuote-border);
        }
        
        .expanded-column-header {
            background-color: var(--vscode-textBlockQuote-background);
            color: var(--vscode-textBlockQuote-foreground);
            font-weight: bold;
        }
        
        .subcolumn-header {
            background-color: var(--vscode-textBlockQuote-background);
            color: var(--vscode-textBlockQuote-foreground);
            font-weight: normal;
            font-style: italic;
        }
        
        .expanded-content {
            position: absolute;
            top: 100%;
            left: 0;
            background-color: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 3px;
            box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
            z-index: 1000;
            max-width: 400px;
            max-height: 300px;
            overflow: auto;
            padding: 10px;
        }
        
        .json-view {
            font-family: 'Courier New', monospace;
            font-size: 12px;
            line-height: 1.4;
            overflow: auto;
            background-color: var(--vscode-editor-background);
            padding: 10px;
            width: 100%;
            box-sizing: border-box;
            overflow-x: auto;
            overflow-y: auto;
        }
        
        .json-line {
            display: flex;
            margin-bottom: 2px;
            width: 100%;
            min-width: 0;
            overflow: visible;
        }
        
        .line-number {
            color: var(--vscode-editorLineNumber-foreground);
            user-select: none;
            width: 50px;
            text-align: right;
            margin-right: 15px;
            flex-shrink: 0;
        }
        
        .json-content {
            flex: 1;
            white-space: pre;
        }
        
        .json-content-editable {
            flex: 1;
            font-family: 'Courier New', monospace;
            font-size: 12px;
            line-height: 1.4;
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            border: 1px solid transparent;
            border-radius: 3px;
            padding: 4px 8px;
            resize: none;
            outline: none;
            width: 100%;
            min-width: 300px;
            white-space: pre-wrap;
            word-wrap: break-word;
            overflow-wrap: break-word;
            overflow: hidden;
            box-sizing: border-box;
            height: auto;
        }
        
        .json-content-editable:focus {
            border-color: var(--vscode-focusBorder);
            box-shadow: 0 0 0 1px var(--vscode-focusBorder);
        }
        
        .json-content-editable.json-error {
            border-color: var(--vscode-inputValidation-errorBorder);
            background-color: var(--vscode-inputValidation-errorBackground);
        }
        
        .json-content-editable.json-valid {
            border-color: var(--vscode-inputValidation-infoBorder);
        }
        
        .search-highlight {
            background-color: var(--vscode-editor-findMatchBackground);
            color: var(--vscode-editor-findMatchForeground);
            padding: 1px 2px;
            border-radius: 2px;
        }
        
        .table-highlight {
            background-color: var(--vscode-editor-findMatchBackground);
            color: var(--vscode-editor-findMatchForeground);
        }
        
        /* Column Manager Button */
        .column-manager-btn {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 8px 16px;
            border-radius: 5px;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 13px;
        }
        
        .column-manager-btn:first-of-type {
            margin-left: auto;
        }
        
        .column-manager-btn:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        
        .column-manager-btn svg {
            flex-shrink: 0;
        }
        
        /* Wrap Text Control */
        .wrap-text-control {
            display: flex;
            align-items: center;
            gap: 8px;
            cursor: pointer;
            padding: 8px 12px;
            border-radius: 5px;
            font-size: 13px;
            user-select: none;
            transition: background-color 0.2s;
        }
        
        .wrap-text-control:hover {
            background-color: var(--vscode-list-hoverBackground);
        }
        
        .wrap-text-control input[type="checkbox"] {
            cursor: pointer;
            width: 16px;
            height: 16px;
        }
        
        .wrap-text-control span {
            color: var(--vscode-foreground);
        }
        
        /* Column Manager Modal */
        .column-manager-modal {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background-color: rgba(0, 0, 0, 0.5);
            z-index: 10000;
            align-items: center;
            justify-content: center;
        }
        
        .column-manager-modal.show {
            display: flex;
        }
        
        .modal-content {
            background-color: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            width: 400px;
            max-height: 80vh;
            display: flex;
            flex-direction: column;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        }
        
        .add-column-modal {
            width: 450px;
        }

        .ai-column-modal {
            width: 580px;
            max-width: 90vw;
        }

        .settings-modal {
            width: 500px;
            max-width: 90vw;
        }

        .ai-prompt-textarea {
            width: 100%;
            min-height: 180px;
            padding: 8px 12px;
            font-size: 13px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            outline: none;
            font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
            resize: vertical;
            line-height: 1.5;
            box-sizing: border-box;
        }

        .ai-prompt-textarea:focus {
            border-color: var(--vscode-focusBorder);
        }

        .ai-prompt-textarea::placeholder {
            color: var(--vscode-input-placeholderForeground);
            opacity: 0.6;
        }

        .modal-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 16px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        
        .modal-header h3 {
            margin: 0;
            font-size: 16px;
            font-weight: 600;
        }
        
        .modal-header-buttons {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        
        .modal-info-btn {
            background: none;
            border: none;
            color: var(--vscode-textLink-foreground);
            cursor: pointer;
            font-size: 16px;
            font-weight: bold;
            padding: 4px 8px;
            border-radius: 4px;
            transition: background-color 0.2s;
        }
        
        .modal-info-btn:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        
        .label-with-info {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-top: 16px;
            margin-bottom: 8px;
        }
        
        .ai-info-panel code {
            background-color: var(--vscode-textCodeBlock-background);
            color: var(--vscode-textPreformat-foreground);
            padding: 2px 4px;
            border-radius: 3px;
            font-family: var(--vscode-editor-font-family);
            font-size: 11px;
        }
        
        .modal-close {
            background: none;
            border: none;
            color: var(--vscode-foreground);
            font-size: 24px;
            cursor: pointer;
            padding: 0;
            width: 24px;
            height: 24px;
            display: flex;
            align-items: center;
            justify-content: center;
            opacity: 0.7;
        }
        
        .modal-close:hover {
            opacity: 1;
        }
        
        .modal-body {
            padding: 16px;
            overflow-y: auto;
            overflow-x: hidden;
            flex: 1;
            box-sizing: border-box;
        }

        .modal-body * {
            box-sizing: border-box;
        }
        
        .modal-hint {
            padding: 12px;
            background-color: var(--vscode-textBlockQuote-background);
            border-left: 3px solid var(--vscode-focusBorder);
            border-radius: 4px;
            margin-bottom: 16px;
            font-size: 13px;
            color: var(--vscode-foreground);
            opacity: 0.9;
        }
        
        .column-list {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        
        .column-item {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 10px;
            background-color: var(--vscode-list-inactiveSelectionBackground);
            border-radius: 4px;
            cursor: grab;
            border: 1px solid transparent;
        }
        
        .column-item:hover {
            background-color: var(--vscode-list-hoverBackground);
        }
        
        .column-item.dragging {
            opacity: 0.5;
            cursor: grabbing;
        }
        
        .column-item.drag-over {
            border-top: 2px solid var(--vscode-focusBorder);
        }
        
        .column-drag-handle {
            cursor: grab;
            color: var(--vscode-foreground);
            opacity: 0.5;
            display: flex;
            align-items: center;
        }
        
        .column-item:active .column-drag-handle {
            cursor: grabbing;
        }
        
        .column-checkbox {
            margin: 0;
            cursor: pointer;
        }
        
        .column-name {
            flex: 1;
            font-size: 13px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        
        /* Drag and Drop for Table Headers */
        th.dragging-header {
            opacity: 0.5;
        }
        
        th.drag-over-header {
            border-left: 3px solid var(--vscode-focusBorder);
        }
        
        th {
            cursor: grab;
        }
        
        th:active {
            cursor: grabbing;
        }
        
        /* Text Wrapping */
        #dataTable.text-wrap td {
            white-space: pre-wrap;
            word-wrap: break-word;
            word-break: break-word;
            overflow-wrap: break-word;
            vertical-align: top;
        }
        
        #dataTable:not(.text-wrap) td {
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        
        /* Add Column Modal Styles */
        .column-name-input {
            width: 100%;
            padding: 8px 12px;
            font-size: 13px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            outline: none;
            font-family: var(--vscode-font-family);
            margin-bottom: 16px;
            box-sizing: border-box;
        }
        
        .column-name-input:focus {
            border-color: var(--vscode-focusBorder);
        }
        
        .modal-actions {
            display: flex;
            gap: 10px;
            justify-content: flex-end;
            margin-top: 8px;
        }
        
        .modal-button {
            padding: 8px 16px;
            border: none;
            border-radius: 4px;
            font-size: 13px;
            cursor: pointer;
            font-family: var(--vscode-font-family);
        }
        
        .modal-button-primary {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        
        .modal-button-primary:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        
        .modal-button-secondary {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        
        .modal-button-secondary:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        
    </style>
</head>
<body>
    <div class="header">
        <img src="${gazelleIconUri}" class="logo" alt="JSONL Gazelle" id="logo" title="JSONL Gazelle" style="cursor: pointer;">
        <div class="loading-state" id="loadingState" style="display: none;">
            <div>Loading large file...</div>
            <div class="loading-progress" id="loadingProgress"></div>
        </div>
        <div class="search-container" id="searchContainer">
            <span class="search-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.35-4.35"></path></svg></span>
            <input type="text" class="search-input" id="searchInput" placeholder="Find...">
        </div>
    </div>
    
    <div class="main-content">
        <div class="view-controls">
            <div class="segmented-control">
                <button class="active" data-view="table"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="9" y1="3" x2="9" y2="21"></line><line x1="15" y1="3" x2="15" y2="21"></line><line x1="3" y1="9" x2="21" y2="9"></line><line x1="3" y1="15" x2="21" y2="15"></line></svg> Table</button>
                <button data-view="json"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="6" x2="20" y2="6"></line><line x1="8" y1="10" x2="20" y2="10"></line><line x1="12" y1="14" x2="20" y2="14"></line><line x1="8" y1="18" x2="20" y2="18"></line></svg> Pretty Print</button>
                <button data-view="raw"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg> Raw</button>
                <div class="error-count" id="errorCount" style="display: none;"></div>
            </div>
            <button class="column-manager-btn" id="columnManagerBtn" title="Show/hide columns and reorder them">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3h7a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-7m0-18H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h7m0-18v18"></path></svg>
                Columns
            </button>
            <button class="column-manager-btn" id="settingsBtn" title="AI Settings">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1 1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
            </button>
            <label class="wrap-text-control" title="Wrap text in table cells">
                <input type="checkbox" id="wrapTextCheckbox">
                <span>Wrap Text</span>
            </label>
        </div>
        
        <div class="table-container" id="tableContainer">
            <div class="indexing" id="indexingDiv">
                <img src="${gazelleIconUri}" class="indexing-icon" alt="Indexing...">
                <div>Indexing JSONL file...</div>
            </div>
            <!-- Table View Container -->
            <div class="view-container" id="tableViewContainer">
                <table id="dataTable" style="display: none;">
                    <colgroup id="tableColgroup"></colgroup>
                    <thead id="tableHead"></thead>
                    <tbody id="tableBody"></tbody>
                </table>
            </div>
            
            <!-- Pretty Print View Container -->
            <div class="view-container" id="jsonViewContainer" style="display: none;">
                <div class="json-view" id="jsonView"></div>
            </div>
            
            <!-- Raw View Container -->
            <div class="view-container" id="rawViewContainer" style="display: none;">
                <div class="raw-view" id="rawView">
                    <div id="rawEditor" style="height: 100%; width: 100%;"></div>
                </div>
            </div>
        </div>
    </div>
    
    <div class="context-menu" id="contextMenu">
        <div class="context-menu-item" data-action="hideColumn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>
            Hide Column
        </div>
        <div class="context-menu-separator"></div>
        <div class="context-menu-item" data-action="insertBefore">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
            Insert Column Before
        </div>
        <div class="context-menu-item" data-action="insertAfter">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
            Insert Column After
        </div>
        <div class="context-menu-separator"></div>
        <div class="context-menu-item" data-action="insertAIColumnBefore">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
            Insert Column with AI Before
        </div>
        <div class="context-menu-item" data-action="insertAIColumnAfter">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
            Insert Column with AI After
        </div>
        <div class="context-menu-separator"></div>
        <div class="context-menu-item" data-action="unstringify" id="unstringifyMenuItem" style="display: none;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1"/><path d="M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"/></svg>
            Unstringify JSON in Column
        </div>
        <div class="context-menu-item" data-action="remove" style="color: var(--vscode-errorForeground);">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
            Delete Column
        </div>
    </div>

    <div class="row-context-menu" id="rowContextMenu">
        <div class="row-context-menu-item" data-action="copyRow">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
            Copy
        </div>
        <div class="row-context-menu-separator"></div>
        <div class="row-context-menu-item" data-action="insertAbove">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
            Insert Above
        </div>
        <div class="row-context-menu-item" data-action="insertBelow">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
            Insert Below
        </div>
        <div class="row-context-menu-item" data-action="duplicateRow">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path><path d="M9 9h6v6"></path></svg>
            Duplicate
        </div>
        <div class="row-context-menu-separator"></div>
        <div class="row-context-menu-item" data-action="insertAIRows">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
            Insert Rows with AI
        </div>
        <div class="row-context-menu-separator"></div>
        <div class="row-context-menu-item" data-action="pasteAbove" id="pasteAboveMenuItem">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path></svg>
            Paste Above
        </div>
        <div class="row-context-menu-item" data-action="pasteBelow" id="pasteBelowMenuItem">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path></svg>
            Paste Below
        </div>
        <div class="row-context-menu-separator"></div>
        <div class="row-context-menu-item" data-action="deleteRow" style="color: var(--vscode-errorForeground);">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
            Delete
        </div>
    </div>

    <div class="column-manager-modal" id="columnManagerModal">
        <div class="modal-content">
            <div class="modal-header">
                <h3>Manage Columns</h3>
                <button class="modal-close" id="modalCloseBtn">&times;</button>
            </div>
            <div class="modal-body">
                <div class="modal-hint">
                    💡 Check/uncheck to show/hide columns. Drag items to reorder.
                </div>
                <div class="column-list" id="columnList"></div>
            </div>
        </div>
    </div>

    <div class="column-manager-modal" id="addColumnModal">
        <div class="modal-content add-column-modal">
            <div class="modal-header">
                <h3>Add New Column</h3>
                <button class="modal-close" id="addColumnCloseBtn">&times;</button>
            </div>
            <div class="modal-body">
                <label for="newColumnName" style="display: block; margin-bottom: 8px; font-weight: 500;">Column Name:</label>
                <input type="text" id="newColumnName" class="column-name-input" placeholder="e.g., status, total, category" />
                <div class="modal-actions">
                    <button class="modal-button modal-button-primary" id="addColumnConfirmBtn">Add Column</button>
                    <button class="modal-button modal-button-secondary" id="addColumnCancelBtn">Cancel</button>
                </div>
            </div>
        </div>
    </div>

    <div class="column-manager-modal" id="aiColumnModal">
        <div class="modal-content ai-column-modal">
            <div class="modal-header">
                <h3>Insert Column with AI</h3>
                <button class="modal-close" id="aiColumnCloseBtn">&times;</button>
            </div>
            <div class="modal-body">
                <label for="aiColumnName" style="display: block; margin-bottom: 8px; font-weight: 500;">Column Name:</label>
                <input type="text" id="aiColumnName" class="column-name-input" placeholder="e.g., summary, category, score" />

                <div class="label-with-info">
                    <label for="aiPrompt" style="display: inline-block; margin-top: 16px; margin-bottom: 8px; font-weight: 500;">AI Prompt Template:</label>
                    <button class="modal-info-btn" id="aiColumnInfoBtn">ℹ</button>
                </div>
                <textarea id="aiPrompt" class="ai-prompt-textarea" rows="10" placeholder="Example: Categorize this item: {{row.name}} with price {{row.price}}

Available variables:
- {{row}} - entire row as JSON
- {{row.fieldname}} - specific field value
- {{row.fieldname[0]}} - array element
- {{row_number}} - current row number
- {{rows_before}} - number of rows before this one
- {{rows_after}} - number of rows after this one"></textarea>

                <div class="ai-info-panel" id="aiInfoPanel" style="display: none; margin-top: 12px; padding: 12px; background: rgba(255, 255, 255, 0.05); border-radius: 6px; font-size: 12px; color: #888;">
                    <strong>Example:</strong> Categorize this item: {{row.name}} with price {{row.price}}<br><br>
                    <strong>Available variables:</strong><br>
                    • <code>{{row}}</code> - entire row as JSON<br>
                    • <code>{{row.fieldname}}</code> - specific field value<br>
                    • <code>{{row.fieldname[0]}}</code> - array element<br>
                    • <code>{{row_number}}</code> - current row number<br>
                    • <code>{{rows_before}}</code> - number of rows before this one<br>
                    • <code>{{rows_after}}</code> - number of rows after this one
                </div>


                <div class="modal-actions" style="margin-top: 16px;">
                    <button class="modal-button modal-button-primary" id="aiColumnConfirmBtn">Generate Column</button>
                    <button class="modal-button modal-button-secondary" id="aiColumnCancelBtn">Cancel</button>
                </div>
            </div>
        </div>
    </div>

    <div class="column-manager-modal" id="settingsModal">
        <div class="modal-content settings-modal">
            <div class="modal-header">
                <h3>AI Settings</h3>
                <button class="modal-close" id="settingsCloseBtn">&times;</button>
            </div>
            <div class="modal-body">
                <div id="openaiSettings">
                    <label for="openaiKey" style="display: block; margin-bottom: 8px; font-weight: 500;">OpenAI API Key:</label>
                    <input type="text" id="openaiKey" class="column-name-input" placeholder="sk-..." />

                    <label for="openaiModel" style="display: block; margin-bottom: 8px; font-weight: 500;">Model:</label>
                    <select id="openaiModel" class="settings-select" style="width: 100%; padding: 8px 12px; font-size: 13px; background-color: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; outline: none; margin-bottom: 16px; box-sizing: border-box;">
                        <option value="gpt-4.1-nano">gpt-4.1-nano</option>
                        <option value="gpt-4.1-mini">gpt-4.1-mini</option>
                        <option value="gpt-4.1">gpt-4.1</option>
                        <option value="gpt-5-nano">gpt-5-nano</option>
                        <option value="gpt-5-mini">gpt-5-mini</option>
                        <option value="gpt-5">gpt-5</option>
                    </select>
                </div>

                <div class="ai-info-box" style="margin-top: 12px; padding: 12px; background: rgba(255, 255, 255, 0.05); border-radius: 6px; font-size: 12px; color: #888;">
                    <strong>Note:</strong> Your API key is stored securely in VS Code's secret storage. It will never be shared or transmitted outside of API requests to OpenAI.
                </div>

                <div class="modal-actions" style="margin-top: 16px;">
                    <button class="modal-button modal-button-primary" id="settingsSaveBtn">Save Settings</button>
                    <button class="modal-button modal-button-secondary" id="settingsCancelBtn">Cancel</button>
                </div>
            </div>
        </div>
    </div>

    <div class="column-manager-modal" id="aiRowsModal">
        <div class="modal-content ai-column-modal">
            <div class="modal-header">
                <h3>Insert Rows with AI</h3>
                <button class="modal-close" id="aiRowsCloseBtn">&times;</button>
            </div>
            <div class="modal-body">
                <label for="contextRowCount" style="display: block; margin-bottom: 8px; font-weight: 500;">Number of Context Rows:</label>
                <input type="number" id="contextRowCount" class="column-name-input" value="10" min="1" max="100" placeholder="10" />

                <label for="rowCount" style="display: block; margin-top: 16px; margin-bottom: 8px; font-weight: 500;">Number of Rows to Generate:</label>
                <input type="number" id="rowCount" class="column-name-input" value="5" min="1" max="50" placeholder="5" />

                <label for="aiRowsPrompt" style="display: block; margin-top: 16px; margin-bottom: 8px; font-weight: 500;">AI Prompt:</label>
                <textarea id="aiRowsPrompt" class="ai-prompt-textarea" rows="8" placeholder="Generate more rows like these, but make them different from the lines below.

                Available variables:
                - {{context_rows}} - JSON array of previous rows
                - {{row_count}} - number of rows to generate
                - {{existing_count}} - total existing rows">Generate more rows like these, but make them different from the lines below.</textarea>

                <div class="ai-info-box" style="margin-top: 12px; padding: 12px; background: rgba(255, 255, 255, 0.05); border-radius: 6px; font-size: 12px; color: #888;">
                    <strong>Note:</strong> The AI will use the specified number of previous rows as context to generate new similar rows. The generated rows will be inserted below the selected row.
                </div>

                <div class="modal-actions" style="margin-top: 16px;">
                    <button class="modal-button modal-button-primary" id="aiRowsGenerateBtn">Generate Rows</button>
                    <button class="modal-button modal-button-secondary" id="aiRowsCancelBtn">Cancel</button>
                </div>
            </div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        
        function escapeRegex(str) {
            return str.replace(/[\\x2E\\x2A\\x2B\\x3F\\x5E\\x24\\x7B\\x7D\\x28\\x29\\x7C\\x5B\\x5D\\x5C]/g, '\\\\$&');
        }
        
        let currentData = {
            rows: [],
            rowIndices: [], // Mapping of filtered row index to actual row index
            allRows: [], // Full array for index mapping
            columns: [],
            isIndexing: true,
            searchTerm: '',
            parsedLines: [],
            rawContent: '',
            errorCount: 0
        };
        
        let contextMenuColumn = null;
        let contextMenuRow = null;
        let currentView = 'table';
        let isResizing = false;
        let resizeData = null;
        let isNavigating = false; // Flag to prevent re-render during navigation
        let scrollPositions = {
            table: 0,
            json: 0,
            raw: 0
        };
        let savedColumnWidths = {}; // Store column widths by column path
        const TABLE_CHUNK_SIZE = 200;
        const JSON_CHUNK_SIZE = 30;
        const tableRenderState = {
            renderedRows: 0,
            totalRows: 0,
            isRendering: false
        };
        const jsonRenderState = {
            renderedRows: 0,
            totalRows: 0,
            isRendering: false
        };
        const rawRenderState = {
            renderedLines: 0,
            totalLines: 0,
            isRendering: false
        };
        const RAW_CHUNK_SIZE = 100;
        let containerScrollListenerAttached = false;
        
        // Column resize functionality
        function startResize(e, th, columnPath) {
            e.preventDefault();
            e.stopPropagation();
            
            // Enable fixed layout when user starts resizing
            const table = document.getElementById('dataTable');
            if (table.style.tableLayout !== 'fixed') {
                // Freeze all current widths before switching to fixed layout
                const colgroup = document.getElementById('tableColgroup');
                const thead = table.querySelector('thead tr');
                if (colgroup && thead) {
                    const headers = thead.querySelectorAll('th');
                    const cols = colgroup.querySelectorAll('col');
                    headers.forEach((header, index) => {
                        if (cols[index] && !cols[index].style.width) {
                            const width = header.getBoundingClientRect().width;
                            cols[index].style.width = width + 'px';
                            
                            // Save width for persistence
                            const columnPath = cols[index].dataset.columnPath;
                            if (columnPath) {
                                savedColumnWidths[columnPath] = width + 'px';
                            }
                        }
                    });
                }
                table.style.tableLayout = 'fixed';
            }
            
            isResizing = true;
            resizeData = {
                th: th,
                columnPath: columnPath,
                startX: e.clientX,
                startWidth: th.offsetWidth
            };
            
            document.body.classList.add('resizing');
            document.addEventListener('mousemove', handleResize);
            document.addEventListener('mouseup', stopResize);
        }
        
        function handleResize(e) {
            if (!isResizing || !resizeData) return;
            
            const deltaX = e.clientX - resizeData.startX;
            const newWidth = Math.max(50, resizeData.startWidth + deltaX);
            
            // Update the column width
            resizeData.th.style.width = newWidth + 'px';
            
            // Update the corresponding col element in colgroup (if exists)
            const columnIndex = Array.from(resizeData.th.parentNode.children).indexOf(resizeData.th);
            const table = document.getElementById('dataTable');
            const colgroup = document.getElementById('tableColgroup');
            
            if (colgroup) {
                const cols = colgroup.querySelectorAll('col');
                if (cols[columnIndex]) {
                    cols[columnIndex].style.width = newWidth + 'px';
                    
                    // Save this width for persistence
                    const columnPath = cols[columnIndex].dataset.columnPath;
                    if (columnPath) {
                        savedColumnWidths[columnPath] = newWidth + 'px';
                    }
                }
            }
            
            // Update all cells in this column (if not using fixed layout)
            const rows = table.querySelectorAll('tr');
            
            rows.forEach(row => {
                const cell = row.children[columnIndex];
                if (cell) {
                    cell.style.width = newWidth + 'px';
                }
            });
        }
        
        function stopResize() {
            if (!isResizing) return;
            
            isResizing = false;
            resizeData = null;
            document.body.classList.remove('resizing');
            document.removeEventListener('mousemove', handleResize);
            document.removeEventListener('mouseup', stopResize);
        }
        
        
        
        // Column Manager Modal
        document.getElementById('columnManagerBtn').addEventListener('click', openColumnManager);
        document.getElementById('modalCloseBtn').addEventListener('click', closeColumnManager);
        document.getElementById('columnManagerModal').addEventListener('click', (e) => {
            if (e.target.id === 'columnManagerModal') {
                closeColumnManager();
            }
        });
        
        // Wrap Text Toggle
        document.getElementById('wrapTextCheckbox').addEventListener('change', (e) => {
            const table = document.getElementById('dataTable');
            const colgroup = document.getElementById('tableColgroup');
            const thead = table.querySelector('thead tr');
            
            if (e.target.checked) {
                // Freeze current column widths before applying wrap
                if (colgroup && thead) {
                    const headers = thead.querySelectorAll('th');
                    const cols = colgroup.querySelectorAll('col');
                    
                    // Measure and freeze ALL column widths
                    headers.forEach((th, index) => {
                        if (cols[index]) {
                            // Always set width to current actual width
                            const width = th.getBoundingClientRect().width;
                            cols[index].style.width = width + 'px';
                            
                            // Save width for persistence
                            const columnPath = cols[index].dataset.columnPath;
                            if (columnPath) {
                                savedColumnWidths[columnPath] = width + 'px';
                            }
                        }
                    });
                }
                
                // Apply fixed layout to prevent recalculation
                table.style.tableLayout = 'fixed';
                
                // Add wrap class
                table.classList.add('text-wrap');
            } else {
                // Remove wrap but KEEP widths and fixed layout
                table.classList.remove('text-wrap');
                // Note: We intentionally do NOT remove table-layout or col widths
                // so the column sizes remain stable
            }
        });
        
        function openColumnManager() {
            const modal = document.getElementById('columnManagerModal');
            const columnList = document.getElementById('columnList');
            columnList.innerHTML = '';
            
            currentData.columns.forEach((column, index) => {
                const columnItem = document.createElement('div');
                columnItem.className = 'column-item';
                columnItem.draggable = true;
                columnItem.dataset.columnIndex = index;
                columnItem.dataset.columnPath = column.path;
                
                // Drag handle
                const dragHandle = document.createElement('div');
                dragHandle.className = 'column-drag-handle';
                dragHandle.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" y1="8" x2="20" y2="8"></line><line x1="4" y1="16" x2="20" y2="16"></line></svg>';
                
                // Checkbox
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.className = 'column-checkbox';
                checkbox.checked = column.visible;
                checkbox.addEventListener('change', () => {
                    vscode.postMessage({
                        type: 'toggleColumnVisibility',
                        columnPath: column.path
                    });
                });
                
                // Column name
                const columnName = document.createElement('span');
                columnName.className = 'column-name';
                columnName.textContent = column.displayName;
                columnName.title = column.displayName;
                
                columnItem.appendChild(dragHandle);
                columnItem.appendChild(checkbox);
                columnItem.appendChild(columnName);
                
                // Drag events for modal
                columnItem.addEventListener('dragstart', handleModalDragStart);
                columnItem.addEventListener('dragend', handleModalDragEnd);
                columnItem.addEventListener('dragover', handleModalDragOver);
                columnItem.addEventListener('drop', handleModalDrop);
                
                columnList.appendChild(columnItem);
            });
            
            modal.classList.add('show');
        }
        
        function closeColumnManager() {
            const modal = document.getElementById('columnManagerModal');
            modal.classList.remove('show');
        }
        
        // Add Column Modal
        let addColumnPosition = null;
        let addColumnReferenceColumn = null;
        
        function openAddColumnModal(position, referenceColumn) {
            addColumnPosition = position;
            addColumnReferenceColumn = referenceColumn;
            
            const modal = document.getElementById('addColumnModal');
            const input = document.getElementById('newColumnName');
            input.value = '';
            modal.classList.add('show');
            
            // Focus input
            setTimeout(() => input.focus(), 100);
        }
        
        function closeAddColumnModal() {
            const modal = document.getElementById('addColumnModal');
            modal.classList.remove('show');
            addColumnPosition = null;
            addColumnReferenceColumn = null;
        }
        
        function confirmAddColumn() {
            const input = document.getElementById('newColumnName');
            const columnName = input.value.trim();
            
            if (!columnName) {
                return; // Don't add empty column name
            }
            
            vscode.postMessage({
                type: 'addColumn',
                columnName: columnName,
                position: addColumnPosition,
                referenceColumn: addColumnReferenceColumn
            });
            
            closeAddColumnModal();
        }
        
        // Add Column Modal event listeners
        document.getElementById('addColumnCloseBtn').addEventListener('click', closeAddColumnModal);
        document.getElementById('addColumnCancelBtn').addEventListener('click', closeAddColumnModal);
        document.getElementById('addColumnConfirmBtn').addEventListener('click', confirmAddColumn);
        document.getElementById('addColumnModal').addEventListener('click', (e) => {
            if (e.target.id === 'addColumnModal') {
                closeAddColumnModal();
            }
        });
        document.getElementById('newColumnName').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                confirmAddColumn();
            } else if (e.key === 'Escape') {
                closeAddColumnModal();
            }
        });

        // AI Column Modal
        let aiColumnPosition = null;
        let aiColumnReferenceColumn = null;

        function openAIColumnModal(position, referenceColumn) {
            aiColumnPosition = position;
            aiColumnReferenceColumn = referenceColumn;

            const modal = document.getElementById('aiColumnModal');
            const nameInput = document.getElementById('aiColumnName');
            const promptInput = document.getElementById('aiPrompt');
            nameInput.value = '';
            promptInput.value = '';
            modal.classList.add('show');

            // Focus name input
            setTimeout(() => nameInput.focus(), 100);
        }

        function closeAIColumnModal() {
            const modal = document.getElementById('aiColumnModal');
            modal.classList.remove('show');
            aiColumnPosition = null;
            aiColumnReferenceColumn = null;
        }

        function confirmAIColumn() {
            const nameInput = document.getElementById('aiColumnName');
            const promptInput = document.getElementById('aiPrompt');
            const columnName = nameInput.value.trim();
            const promptTemplate = promptInput.value.trim();

            if (!columnName || !promptTemplate) {
                return; // Don't proceed without both inputs
            }

            vscode.postMessage({
                type: 'addAIColumn',
                columnName: columnName,
                promptTemplate: promptTemplate,
                position: aiColumnPosition,
                referenceColumn: aiColumnReferenceColumn
            });

            closeAIColumnModal();
        }

        // AI Column Modal event listeners
        document.getElementById('aiColumnCloseBtn').addEventListener('click', closeAIColumnModal);
        document.getElementById('aiColumnCancelBtn').addEventListener('click', closeAIColumnModal);
        document.getElementById('aiColumnConfirmBtn').addEventListener('click', confirmAIColumn);
        document.getElementById('aiColumnInfoBtn').addEventListener('click', () => {
            const infoPanel = document.getElementById('aiInfoPanel');
            infoPanel.style.display = infoPanel.style.display === 'none' ? 'block' : 'none';
        });
        document.getElementById('aiColumnModal').addEventListener('click', (e) => {
            if (e.target.id === 'aiColumnModal') {
                closeAIColumnModal();
            }
        });
        document.getElementById('aiColumnName').addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                closeAIColumnModal();
            }
        });
        document.getElementById('aiPrompt').addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                closeAIColumnModal();
            }
        });

        // Settings Modal
        function openSettingsModal() {
            const modal = document.getElementById('settingsModal');

            // Request current settings from backend
            vscode.postMessage({ type: 'getSettings' });

            modal.classList.add('show');
        }

        function checkAPIKeyAndOpenModal(modalFunction, ...args) {
            vscode.postMessage({ type: 'checkAPIKey' });
            
            // Listen for API key check response
            const checkAPIKeyListener = (event) => {
                const message = event.data;
                if (message.type === 'apiKeyCheckResult') {
                    window.removeEventListener('message', checkAPIKeyListener);
                    clearTimeout(timeoutId);
                    
                    if (message.hasAPIKey) {
                        modalFunction(...args);
                    } else {
                        // Send message to backend to show warning and open settings
                        vscode.postMessage({ 
                            type: 'showAPIKeyWarning' 
                        });
                        openSettingsModal();
                    }
                }
            };
            
            // Timeout after 5 seconds if no response
            const timeoutId = setTimeout(() => {
                window.removeEventListener('message', checkAPIKeyListener);
                console.error('API key check timed out');
                // Fallback: open settings modal
                vscode.postMessage({ 
                    type: 'showAPIKeyWarning' 
                });
                openSettingsModal();
            }, 5000);
            
            window.addEventListener('message', checkAPIKeyListener);
        }

        function closeSettingsModal() {
            const modal = document.getElementById('settingsModal');
            modal.classList.remove('show');
        }

        function saveSettings() {
            const openaiKey = document.getElementById('openaiKey').value;
            const openaiModel = document.getElementById('openaiModel').value;

            vscode.postMessage({
                type: 'saveSettings',
                settings: {
                    openaiKey: openaiKey,
                    openaiModel: openaiModel
                }
            });

            closeSettingsModal();
        }

        // Settings Modal event listeners
        document.getElementById('settingsBtn').addEventListener('click', openSettingsModal);
        document.getElementById('settingsCloseBtn').addEventListener('click', closeSettingsModal);
        document.getElementById('settingsCancelBtn').addEventListener('click', closeSettingsModal);
        document.getElementById('settingsSaveBtn').addEventListener('click', saveSettings);
        document.getElementById('settingsModal').addEventListener('click', (e) => {
            if (e.target.id === 'settingsModal') {
                closeSettingsModal();
            }
        });


        // AI Rows Modal
        let aiRowsReferenceRow = null;

        function openAIRowsModal(rowIndex) {
            aiRowsReferenceRow = rowIndex;

            const modal = document.getElementById('aiRowsModal');
            const contextRowCountInput = document.getElementById('contextRowCount');
            const rowCountInput = document.getElementById('rowCount');
            const promptInput = document.getElementById('aiRowsPrompt');

            // Set defaults
            contextRowCountInput.value = '10';
            rowCountInput.value = '5';
            if (!promptInput.value || promptInput.value === promptInput.placeholder) {
                promptInput.value = 'Based on these example rows:\\n{{context_rows}}\\n\\nGenerate {{row_count}} new unique rows with the EXACT same structure and all the same fields. Make the data realistic and different from the examples above.';
            }

            modal.classList.add('show');

            // Focus context row count input
            setTimeout(() => contextRowCountInput.focus(), 100);
        }

        function closeAIRowsModal() {
            const modal = document.getElementById('aiRowsModal');
            modal.classList.remove('show');
            aiRowsReferenceRow = null;
        }

        function generateAIRows() {
            const contextRowCount = parseInt(document.getElementById('contextRowCount').value) || 10;
            const rowCount = parseInt(document.getElementById('rowCount').value) || 5;
            const promptTemplate = document.getElementById('aiRowsPrompt').value.trim();

            if (!promptTemplate) {
                return;
            }

            vscode.postMessage({
                type: 'generateAIRows',
                rowIndex: aiRowsReferenceRow,
                contextRowCount: contextRowCount,
                rowCount: rowCount,
                promptTemplate: promptTemplate
            });

            closeAIRowsModal();
        }

        // AI Rows Modal event listeners
        document.getElementById('aiRowsCloseBtn').addEventListener('click', closeAIRowsModal);
        document.getElementById('aiRowsCancelBtn').addEventListener('click', closeAIRowsModal);
        document.getElementById('aiRowsGenerateBtn').addEventListener('click', generateAIRows);
        document.getElementById('aiRowsModal').addEventListener('click', (e) => {
            if (e.target.id === 'aiRowsModal') {
                closeAIRowsModal();
            }
        });

        // Modal drag and drop
        let draggedModalItem = null;
        
        function handleModalDragStart(e) {
            draggedModalItem = e.target;
            e.target.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
        }
        
        function handleModalDragEnd(e) {
            e.target.classList.remove('dragging');
            document.querySelectorAll('.column-item').forEach(item => {
                item.classList.remove('drag-over');
            });
        }
        
        function handleModalDragOver(e) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            
            const target = e.target.closest('.column-item');
            if (target && target !== draggedModalItem) {
                document.querySelectorAll('.column-item').forEach(item => {
                    item.classList.remove('drag-over');
                });
                target.classList.add('drag-over');
            }
        }
        
        function handleModalDrop(e) {
            e.preventDefault();
            
            const target = e.target.closest('.column-item');
            if (target && target !== draggedModalItem) {
                const fromIndex = parseInt(draggedModalItem.dataset.columnIndex);
                const toIndex = parseInt(target.dataset.columnIndex);
                
                vscode.postMessage({
                    type: 'reorderColumns',
                    fromIndex: fromIndex,
                    toIndex: toIndex
                });
                
                // Visual reorder
                const columnList = document.getElementById('columnList');
                if (fromIndex < toIndex) {
                    columnList.insertBefore(draggedModalItem, target.nextSibling);
                } else {
                    columnList.insertBefore(draggedModalItem, target);
                }
                
                // Update indices
                Array.from(columnList.children).forEach((item, index) => {
                    item.dataset.columnIndex = index;
                });
            }
            
            target.classList.remove('drag-over');
        }
        
        function handleSearch() {
            const searchTerm = document.getElementById('searchInput').value;
            
            // Perform search in current view with highlighting
            if (currentView === 'table') {
                vscode.postMessage({
                    type: 'search',
                    searchTerm: searchTerm
                });
                highlightTableResults(searchTerm);
            } else if (currentView === 'json') {
                highlightJsonResults(searchTerm);
            } else if (currentView === 'raw') {
                highlightRawResults(searchTerm);
            }
        }
        
        function highlightTableResults(searchTerm) {
            document.querySelectorAll('.table-highlight').forEach(el => {
                el.classList.remove('table-highlight');
            });
            
            if (!searchTerm) return;
            
            const cells = document.querySelectorAll('#dataTable td');
            cells.forEach(cell => {
                const text = cell.textContent;
                const matches = text.toLowerCase().includes(searchTerm.toLowerCase());
                
                if (matches) {
                    cell.classList.add('table-highlight');
                }
            });
        }
        
        function highlightJsonResults(searchTerm) {
            const jsonLines = document.querySelectorAll('.json-content-editable');
            jsonLines.forEach(textarea => {
                // For textareas, we can't easily highlight within the text
                // Instead, we'll add a visual indicator if the content matches
                const content = textarea.value;
                let hasMatch = false;
                
                if (searchTerm) {
                    hasMatch = content.toLowerCase().includes(searchTerm.toLowerCase());
                }
                
                if (hasMatch) {
                    textarea.style.borderColor = 'var(--vscode-editor-findMatchBackground)';
                    textarea.style.boxShadow = '0 0 0 2px var(--vscode-editor-findMatchBackground)';
                } else {
                    textarea.style.borderColor = '';
                    textarea.style.boxShadow = '';
                }
            });
        }
        
        
        function highlightRawResults(searchTerm) {
            const rawLines = document.querySelectorAll('.raw-line-content');
            rawLines.forEach(lineContent => {
                // Remove existing highlights
                lineContent.classList.remove('search-highlight');
                
                if (!searchTerm) return;
                
                const text = lineContent.textContent;
                const matches = text.toLowerCase().includes(searchTerm.toLowerCase());
                
                if (matches) {
                    lineContent.classList.add('search-highlight');
                }
            });
        }
        
        
        
        
        
        
        function showContextMenu(event, columnPath) {
            event.preventDefault();
            contextMenuColumn = columnPath;
            
            const menu = document.getElementById('contextMenu');
            const unstringifyMenuItem = document.getElementById('unstringifyMenuItem');
            
            // Check if this column contains stringified JSON
            const hasStringifiedJson = checkColumnForStringifiedJson(columnPath);
            unstringifyMenuItem.style.display = hasStringifiedJson ? 'block' : 'none';
            
            menu.style.display = 'block';
            menu.style.left = event.pageX + 'px';
            menu.style.top = event.pageY + 'px';
        }
        
        function checkColumnForStringifiedJson(columnPath) {
            // Check a sample of rows to see if they contain stringified JSON
            const sampleSize = Math.min(20, currentData.rows.length);
            for (let i = 0; i < sampleSize; i++) {
                const value = getNestedValue(currentData.rows[i], columnPath);
                if (isStringifiedJson(value)) {
                    return true;
                }
            }
            return false;
        }
        
        function isStringifiedJson(value) {
            if (typeof value !== 'string') {
                return false;
            }
            
            const trimmed = value.trim();
            // Check if it starts with "[" or "{" and looks like JSON
            return (trimmed.startsWith('[') || trimmed.startsWith('{')) && 
                   (trimmed.endsWith(']') || trimmed.endsWith('}'));
        }
        
        function hideContextMenu() {
            document.getElementById('contextMenu').style.display = 'none';
            document.getElementById('rowContextMenu').style.display = 'none';
            contextMenuColumn = null;
            contextMenuRow = null;
        }
        
        function handleContextMenu(event) {
            const action = event.target.closest('.context-menu-item')?.dataset.action;
            if (!action || !contextMenuColumn) return;

            switch (action) {
                case 'hideColumn':
                    vscode.postMessage({
                        type: 'toggleColumnVisibility',
                        columnPath: contextMenuColumn
                    });
                    break;
                case 'insertBefore':
                    openAddColumnModal('before', contextMenuColumn);
                    break;
                case 'insertAfter':
                    openAddColumnModal('after', contextMenuColumn);
                    break;
                case 'insertAIColumnBefore':
                    checkAPIKeyAndOpenModal(openAIColumnModal, 'before', contextMenuColumn);
                    break;
                case 'insertAIColumnAfter':
                    checkAPIKeyAndOpenModal(openAIColumnModal, 'after', contextMenuColumn);
                    break;
                case 'remove':
                    vscode.postMessage({
                        type: 'removeColumn',
                        columnPath: contextMenuColumn
                    });
                    break;
                case 'unstringify':
                    vscode.postMessage({
                        type: 'unstringifyColumn',
                        columnPath: contextMenuColumn
                    });
                    break;
            }

            hideContextMenu();
        }

        function showRowContextMenu(event, rowIndex) {
            event.preventDefault();
            contextMenuRow = rowIndex;

            const menu = document.getElementById('rowContextMenu');
            const pasteAboveMenuItem = document.getElementById('pasteAboveMenuItem');
            const pasteBelowMenuItem = document.getElementById('pasteBelowMenuItem');
            
            // Initially show paste options as disabled while validating
            pasteAboveMenuItem.style.display = 'block';
            pasteBelowMenuItem.style.display = 'block';
            pasteAboveMenuItem.classList.add('disabled');
            pasteBelowMenuItem.classList.add('disabled');
            
            // Request clipboard validation from backend
            vscode.postMessage({
                type: 'validateClipboard'
            });

            menu.style.display = 'block';
            menu.style.left = event.pageX + 'px';
            menu.style.top = event.pageY + 'px';
        }

        function handleRowContextMenu(event) {
            const action = event.target.closest('.row-context-menu-item')?.dataset.action;
            if (!action || contextMenuRow === null) return;

            // Check if the clicked item is disabled
            const clickedItem = event.target.closest('.row-context-menu-item');
            if (clickedItem && clickedItem.classList.contains('disabled')) {
                return; // Don't execute action for disabled items
            }

            console.log('handleRowContextMenu - action:', action, 'rowIndex:', contextMenuRow, 'total rows:', currentData.allRows.length);

            switch (action) {
                case 'copyRow':
                    vscode.postMessage({
                        type: 'copyRow',
                        rowIndex: contextMenuRow
                    });
                    break;
                case 'insertAbove':
                    vscode.postMessage({
                        type: 'insertRow',
                        rowIndex: contextMenuRow,
                        position: 'above'
                    });
                    break;
                case 'insertBelow':
                    vscode.postMessage({
                        type: 'insertRow',
                        rowIndex: contextMenuRow,
                        position: 'below'
                    });
                    break;
                case 'duplicateRow':
                    vscode.postMessage({
                        type: 'duplicateRow',
                        rowIndex: contextMenuRow
                    });
                    break;
                case 'insertAIRows':
                    checkAPIKeyAndOpenModal(openAIRowsModal, contextMenuRow);
                    break;
                case 'pasteAbove':
                    vscode.postMessage({
                        type: 'pasteRow',
                        rowIndex: contextMenuRow,
                        position: 'above'
                    });
                    break;
                case 'pasteBelow':
                    vscode.postMessage({
                        type: 'pasteRow',
                        rowIndex: contextMenuRow,
                        position: 'below'
                    });
                    break;
                case 'deleteRow':
                    // Send delete request directly - backend will handle confirmation if needed
                    vscode.postMessage({
                        type: 'deleteRow',
                        rowIndex: contextMenuRow
                    });
                    break;
            }

            hideContextMenu();
        }
        
        function updateTable(data) {
            // Validate data structure before processing
            if (!data || typeof data !== 'object') {
                console.error('updateTable: Invalid data received');
                return;
            }
            
            // Ensure required arrays exist
            if (!Array.isArray(data.rows)) {
                console.warn('updateTable: data.rows is not an array, initializing');
                data.rows = [];
            }
            if (!Array.isArray(data.columns)) {
                console.warn('updateTable: data.columns is not an array, initializing');
                data.columns = [];
            }
            if (!Array.isArray(data.rowIndices)) {
                console.warn('updateTable: data.rowIndices is not an array, initializing');
                data.rowIndices = data.rows.map((_, index) => index);
            }
            
            currentData = data;
            
            // Handle loading state in header
            const logo = document.getElementById('logo');
            const loadingState = document.getElementById('loadingState');
            const loadingProgress = document.getElementById('loadingProgress');
            const searchContainer = document.getElementById('searchContainer');
            
            if (data.isIndexing) {
                // Initial loading - show spinning logo and hide controls
                logo.classList.add('loading');
                loadingState.style.display = 'flex';
                searchContainer.classList.add('controls-hidden');
                
                // Don't show the indexing div since we have header loading state
                document.getElementById('indexingDiv').style.display = 'none';
                document.getElementById('dataTable').style.display = 'none';
                return;
            }
            
            // Show loading progress if chunks are still loading
            if (data.loadingProgress && data.loadingProgress.loadingChunks) {
                logo.classList.add('loading');
                loadingState.style.display = 'flex';
                searchContainer.classList.add('controls-hidden');
                
                const memoryInfo = data.loadingProgress.memoryOptimized ? 
                    \`<div style="font-size: 11px; color: var(--vscode-warningForeground); margin-top: 5px;">
                        Memory optimized: Showing \${data.loadingProgress.displayedRows.toLocaleString()} of \${data.loadingProgress.loadedLines.toLocaleString()} loaded rows
                    </div>\` : '';
                
                loadingProgress.innerHTML = \`
                    <div>\${data.loadingProgress.loadedLines.toLocaleString()} / \${data.loadingProgress.totalLines.toLocaleString()} lines (\${data.loadingProgress.progressPercent}%)</div>
                    \${memoryInfo}
                \`;
                
                // Don't show the indexing div since we have header loading state
                document.getElementById('indexingDiv').style.display = 'none';
                document.getElementById('dataTable').style.display = 'table';
            } else {
                // Loading complete - show controls and stop spinning logo
                logo.classList.remove('loading');
                loadingState.style.display = 'none';
                searchContainer.classList.remove('controls-hidden');
                
                document.getElementById('indexingDiv').style.display = 'none';
                document.getElementById('dataTable').style.display = 'table';
            }
            
            // Update search inputs
            document.getElementById('searchInput').value = data.searchTerm;
            
            // Update error count
            const errorCountElement = document.getElementById('errorCount');
            if (data.errorCount > 0) {
                errorCountElement.textContent = data.errorCount;
                errorCountElement.style.display = 'flex';
                // Default to raw view if there are errors
                if (currentView === 'table') {
                    switchView('raw');
                }
            } else {
                errorCountElement.style.display = 'none';
            }
            
            // Build table header and defer row rendering via virtualization
            buildTableHeader(data);
            renderTableChunk(true);

            // Reset JSON rendering state when data updates
            if (currentView === 'json') {
                renderJsonChunk(true);
                requestAnimationFrame(() => restoreScrollPosition('json'));
            } else {
                resetJsonRenderingState();
            }

            // Reset Raw rendering state when data updates
            if (currentView === 'raw') {
                renderRawChunk(true);
                requestAnimationFrame(() => restoreScrollPosition('raw'));
            } else {
                resetRawRenderingState();
            }

            attachScrollListener();

            if (currentView === 'table') {
                requestAnimationFrame(ensureTableViewportFilled);
            } else if (currentView === 'json') {
                requestAnimationFrame(ensureJsonViewportFilled);
            } else if (currentView === 'raw') {
                requestAnimationFrame(ensureRawViewportFilled);
            }
        }

        function buildTableHeader(data) {
            const thead = document.getElementById('tableHead');
            const colgroup = document.getElementById('tableColgroup');
            if (!thead) return;

            thead.innerHTML = '';
            if (colgroup) colgroup.innerHTML = '';
            
            const headerRow = document.createElement('tr');

            // Add col for row number column
            if (colgroup) {
                const col = document.createElement('col');
                col.style.width = '40px';
                colgroup.appendChild(col);
            }

            // Add row number header
            const rowNumHeader = document.createElement('th');
            rowNumHeader.textContent = '#';
            rowNumHeader.style.minWidth = '40px';
            rowNumHeader.style.textAlign = 'center';
            rowNumHeader.classList.add('row-header');
            headerRow.appendChild(rowNumHeader);

            // Data columns
            data.columns.forEach(column => {
                if (!column.visible) {
                    return;
                }

                // Add col element for this column
                if (colgroup) {
                    const col = document.createElement('col');
                    col.dataset.columnPath = column.path;
                    colgroup.appendChild(col);
                }

                const th = document.createElement('th');
                const headerContent = document.createElement('span');
                headerContent.style.display = 'inline-block';
                headerContent.style.whiteSpace = 'nowrap';
                headerContent.style.overflow = 'hidden';
                headerContent.style.textOverflow = 'ellipsis';
                headerContent.style.maxWidth = '100%';

                if (column.parentPath) {
                    const collapseButton = document.createElement('button');
                    collapseButton.className = 'collapse-button';
                    collapseButton.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15,18 9,12 15,6"></polyline></svg>';
                    collapseButton.title = 'Collapse to ' + column.parentPath;
                    collapseButton.addEventListener('click', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        vscode.postMessage({
                            type: 'collapseColumn',
                            columnPath: column.parentPath
                        });
                    });
                    headerContent.appendChild(collapseButton);
                    headerContent.appendChild(document.createTextNode(column.displayName));

                    const value = getSampleValue(data.rows, column.path);
                    if (typeof value === 'object' && value !== null && !column.isExpanded) {
                        const expandButton = document.createElement('button');
                        expandButton.className = 'expand-button';
                        expandButton.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6,9 12,15 18,9"></polyline></svg>';
                        expandButton.title = 'Expand';
                        expandButton.addEventListener('click', (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            vscode.postMessage({
                                type: 'expandColumn',
                                columnPath: column.path
                            });
                        });
                        headerContent.appendChild(expandButton);
                    }

                    th.classList.add('subcolumn-header');
                } else {
                    headerContent.appendChild(document.createTextNode(column.displayName));

                    const value = getSampleValue(data.rows, column.path);
                    if (typeof value === 'object' && value !== null) {
                        const button = document.createElement('button');
                        button.className = 'expand-button';
                        button.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6,9 12,15 18,9"></polyline></svg>';
                        button.title = 'Expand';
                        button.addEventListener('click', (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            vscode.postMessage({
                                type: 'expandColumn',
                                columnPath: column.path
                            });
                        });
                        headerContent.appendChild(button);
                    }
                }

                th.appendChild(headerContent);

                const resizeHandle = document.createElement('div');
                resizeHandle.className = 'resize-handle';
                resizeHandle.addEventListener('mousedown', (e) => startResize(e, th, column.path));
                th.appendChild(resizeHandle);

                th.addEventListener('contextmenu', (e) => showContextMenu(e, column.path));
                
                // Add drag and drop for column reordering
                th.draggable = true;
                th.dataset.columnPath = column.path;
                th.title = 'Drag to reorder • Right-click for options';
                th.addEventListener('dragstart', handleHeaderDragStart);
                th.addEventListener('dragend', handleHeaderDragEnd);
                th.addEventListener('dragover', handleHeaderDragOver);
                th.addEventListener('drop', handleHeaderDrop);
                
                headerRow.appendChild(th);
            });

            thead.appendChild(headerRow);
            
            // Restore saved column widths after rebuilding table
            if (colgroup && Object.keys(savedColumnWidths).length > 0) {
                const cols = colgroup.querySelectorAll('col');
                cols.forEach(col => {
                    const columnPath = col.dataset.columnPath;
                    if (columnPath && savedColumnWidths[columnPath]) {
                        col.style.width = savedColumnWidths[columnPath];
                    }
                });
                
                // Restore table layout if widths were saved
                const table = document.getElementById('dataTable');
                if (table) {
                    table.style.tableLayout = 'fixed';
                }
            }
        }
        
        // Table header drag and drop
        let draggedHeader = null;
        let draggedHeaderIndex = null;
        
        function handleHeaderDragStart(e) {
            const th = e.target.closest('th');
            if (!th || th.classList.contains('row-header')) return;
            
            draggedHeader = th;
            th.classList.add('dragging-header');
            e.dataTransfer.effectAllowed = 'move';
            
            // Find the index of this column (excluding row header)
            const headers = Array.from(th.parentNode.children).filter(el => !el.classList.contains('row-header'));
            draggedHeaderIndex = headers.indexOf(th);
        }
        
        function handleHeaderDragEnd(e) {
            const th = e.target.closest('th');
            if (th) {
                th.classList.remove('dragging-header');
            }
            document.querySelectorAll('th').forEach(header => {
                header.classList.remove('drag-over-header');
            });
            draggedHeader = null;
            draggedHeaderIndex = null;
        }
        
        function handleHeaderDragOver(e) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            
            const th = e.target.closest('th');
            if (th && !th.classList.contains('row-header') && th !== draggedHeader) {
                document.querySelectorAll('th').forEach(header => {
                    header.classList.remove('drag-over-header');
                });
                th.classList.add('drag-over-header');
            }
        }
        
        function handleHeaderDrop(e) {
            e.preventDefault();
            
            const targetTh = e.target.closest('th');
            if (!targetTh || targetTh.classList.contains('row-header') || targetTh === draggedHeader) {
                return;
            }
            
            // Find the index of target column (excluding row header)
            const headers = Array.from(targetTh.parentNode.children).filter(el => !el.classList.contains('row-header'));
            const targetIndex = headers.indexOf(targetTh);
            
            if (draggedHeaderIndex !== null && draggedHeaderIndex !== targetIndex) {
                vscode.postMessage({
                    type: 'reorderColumns',
                    fromIndex: draggedHeaderIndex,
                    toIndex: targetIndex
                });
            }
            
            targetTh.classList.remove('drag-over-header');
        }

        function createTableRow(row, rowIndex) {
            const tr = document.createElement('tr');

            // Get the actual index from the pre-computed mapping
            // rowIndex here is the filtered index (0-based position in currentData.rows)
            const actualRowIndex = currentData.rowIndices && currentData.rowIndices[rowIndex] !== undefined 
                ? currentData.rowIndices[rowIndex] 
                : rowIndex; // Fallback to filtered index if mapping is unavailable

            // Add row number cell
            const rowNumCell = document.createElement('td');
            // Display sequential number (1, 2, 3...) for visual ordering
            rowNumCell.textContent = (rowIndex + 1).toString();
            rowNumCell.classList.add('row-header');
            // Tooltip shows the actual row number in the file
            rowNumCell.title = 'Row ' + (actualRowIndex + 1) + ' in file';
            rowNumCell.addEventListener('contextmenu', (e) => showRowContextMenu(e, actualRowIndex));
            tr.appendChild(rowNumCell);

            // Data cells
            currentData.columns.forEach(column => {
                if (!column.visible) {
                    return;
                }

                const td = document.createElement('td');
                const value = getNestedValue(row, column.path);
                const valueStr = value !== undefined ? JSON.stringify(value) : '';

                if (column.isExpanded) {
                    td.classList.add('expanded-column');
                }

                if (typeof value === 'object' && value !== null && !column.isExpanded) {
                    td.classList.add('expandable-cell');
                    td.textContent = valueStr;
                    td.title = valueStr;
                    td.addEventListener('click', (e) => expandCell(e, td, actualRowIndex, column.path));
                    td.addEventListener('dblclick', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        vscode.postMessage({
                            type: 'expandColumn',
                            columnPath: column.path
                        });
                    });
                } else {
                    td.textContent = valueStr;
                    td.title = valueStr;
                    td.addEventListener('dblclick', (e) => editCell(e, td, actualRowIndex, column.path));
                }

                tr.appendChild(td);
            });

            return tr;
        }

        function renderTableChunk(reset = false) {
            const tbody = document.getElementById('tableBody');
            if (!tbody) return;

            if (reset) {
                tableRenderState.totalRows = currentData.rows ? currentData.rows.length : 0;
                tableRenderState.renderedRows = 0;
                tableRenderState.isRendering = false;
                tbody.innerHTML = '';
            }

            if (tableRenderState.isRendering) return;
            if (tableRenderState.renderedRows >= tableRenderState.totalRows) return;
            if (!currentData.rows || currentData.rows.length === 0) return;

            tableRenderState.isRendering = true;

            const fragment = document.createDocumentFragment();
            const start = tableRenderState.renderedRows;
            const end = Math.min(start + TABLE_CHUNK_SIZE, currentData.rows.length);

            for (let rowIndex = start; rowIndex < end; rowIndex++) {
                const row = currentData.rows[rowIndex];
                if (row) { // Ensure row exists before creating table row
                    fragment.appendChild(createTableRow(row, rowIndex));
                }
            }

            tbody.appendChild(fragment);
            tableRenderState.renderedRows = end;
            tableRenderState.isRendering = false;

            const searchTerm = document.getElementById('searchInput').value;
            if (searchTerm) {
                highlightTableResults(searchTerm);
            }

            if (currentView === 'table') {
                requestAnimationFrame(ensureTableViewportFilled);
            }
        }

        function ensureTableViewportFilled() {
            if (currentView !== 'table') return;

            const tableContainer = document.getElementById('tableContainer');
            if (!tableContainer) return;

            if (tableRenderState.renderedRows >= tableRenderState.totalRows) return;

            if (tableContainer.scrollHeight <= tableContainer.clientHeight + 50) {
                renderTableChunk();
            }
        }

        function ensureTableScrollCapacity(targetScroll) {
            const tableContainer = document.getElementById('tableContainer');
            if (!tableContainer) return;

            if (tableRenderState.renderedRows >= tableRenderState.totalRows) return;

            const maxScroll = tableContainer.scrollHeight - tableContainer.clientHeight;
            if (targetScroll > maxScroll - 50) {
                renderTableChunk();
                requestAnimationFrame(() => ensureTableScrollCapacity(targetScroll));
            }
        }

        function resetJsonRenderingState() {
            jsonRenderState.totalRows = currentData.rows.length;
            jsonRenderState.renderedRows = 0;
            jsonRenderState.isRendering = false;

            if (currentView !== 'json') {
                const jsonView = document.getElementById('jsonView');
                if (jsonView) {
                    jsonView.innerHTML = '';
                }
            }
        }

        function renderJsonChunk(reset = false) {
            const jsonView = document.getElementById('jsonView');
            if (!jsonView) return;

            if (reset) {
                jsonRenderState.totalRows = currentData.rows.length;
                jsonRenderState.renderedRows = 0;
                jsonRenderState.isRendering = false;
                jsonView.innerHTML = '';
            }

            if (jsonRenderState.isRendering) return;
            if (jsonRenderState.renderedRows >= jsonRenderState.totalRows) return;

            jsonRenderState.isRendering = true;

            const fragment = document.createDocumentFragment();
            const start = jsonRenderState.renderedRows;
            const end = Math.min(start + JSON_CHUNK_SIZE, currentData.rows.length);

            for (let index = start; index < end; index++) {
                const row = currentData.rows[index];
                const lineDiv = document.createElement('div');
                lineDiv.className = 'json-line';

                const lineNumber = document.createElement('div');
                lineNumber.className = 'line-number';
                lineNumber.textContent = (index + 1).toString().padStart(4, ' ');

                const jsonContent = document.createElement('textarea');
                jsonContent.className = 'json-content-editable';
                const jsonString = JSON.stringify(row, null, 2);
                jsonContent.value = jsonString;
                jsonContent.setAttribute('data-row-index', index);

                function autoResize(textarea) {
                    textarea.style.height = 'auto';
                    textarea.style.height = textarea.scrollHeight + 'px';
                }

                setTimeout(() => {
                    autoResize(jsonContent);
                }, 10);

                setTimeout(() => {
                    if (jsonContent.scrollHeight > jsonContent.offsetHeight) {
                        jsonContent.style.height = jsonContent.scrollHeight + 'px';
                    }
                }, 100);

                jsonContent.addEventListener('input', function() {
                    autoResize(this);
                    try {
                        const parsed = JSON.parse(this.value);
                        this.classList.remove('json-error');
                        this.classList.add('json-valid');
                    } catch (e) {
                        this.classList.remove('json-valid');
                        this.classList.add('json-error');
                    }
                });

                jsonContent.addEventListener('blur', function() {
                    const rowIndex = parseInt(this.getAttribute('data-row-index'));
                    try {
                        const parsed = JSON.parse(this.value);
                        currentData.rows[rowIndex] = parsed;

                        vscode.postMessage({
                            type: 'documentChanged',
                            rowIndex: rowIndex,
                            newData: parsed
                        });

                        this.classList.remove('json-error');
                        this.classList.add('json-valid');
                    } catch (e) {
                        console.error('Invalid JSON on line', rowIndex + 1, ':', e.message);
                    }
                });

                lineDiv.addEventListener('dblclick', function(e) {
                    e.stopPropagation();
                });

                lineDiv.addEventListener('click', function(e) {
                    e.stopPropagation();
                });

                lineNumber.addEventListener('dblclick', function(e) {
                    e.stopPropagation();
                });

                lineNumber.addEventListener('click', function(e) {
                    e.stopPropagation();
                });

                jsonContent.addEventListener('dblclick', function(e) {
                    e.stopPropagation();
                });

                // Add cursor-based navigation for JSON textareas
                jsonContent.addEventListener('keydown', function(e) {
                    // Only handle arrow keys when not in the middle of editing
                    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                        const cursorPosition = this.selectionStart;
                        const textLength = this.value.length;
                        
                        // Check if cursor is at the beginning (for Up arrow) or end (for Down arrow)
                        const isAtBeginning = cursorPosition === 0;
                        const isAtEnd = cursorPosition === textLength;
                        
                        if ((e.key === 'ArrowUp' && isAtBeginning) || (e.key === 'ArrowDown' && isAtEnd)) {
                            e.preventDefault();
                            
                            const currentRowIndex = parseInt(this.getAttribute('data-row-index'));
                            console.log('Navigation triggered:', e.key, 'from row', currentRowIndex);
                            
                            // Temporarily disable navigation flag to test focus
                            // isNavigating = true;
                            
                            const jsonView = document.getElementById('jsonView');
                            
                            let targetRowIndex;
                            if (e.key === 'ArrowUp') {
                                // Go to previous row
                                targetRowIndex = Math.max(0, currentRowIndex - 1);
                            } else {
                                // Go to next row
                                targetRowIndex = Math.min(currentData.rows.length - 1, currentRowIndex + 1);
                            }
                            
                            console.log('Target row index:', targetRowIndex);
                            
                            // Find the target textarea by its data-row-index attribute
                            const targetTextarea = jsonView.querySelector('.json-content-editable[data-row-index="' + targetRowIndex + '"]');
                            
                            console.log('Target textarea found:', !!targetTextarea);
                            
                            if (targetTextarea) {
                                console.log('Focusing target textarea');
                                
                                // Try multiple focus methods to ensure it works
                                setTimeout(() => {
                                    // Method 1: Standard focus
                                    targetTextarea.focus();
                                    
                                    // Method 2: Force focus with click simulation
                                    targetTextarea.click();
                                    
                                    // Method 3: Set focus with explicit tabIndex
                                    targetTextarea.tabIndex = 0;
                                    targetTextarea.focus();
                                    
                                    // Position cursor at the beginning for Up arrow, end for Down arrow
                                    if (e.key === 'ArrowUp') {
                                        targetTextarea.setSelectionRange(targetTextarea.value.length, targetTextarea.value.length);
                                    } else {
                                        targetTextarea.setSelectionRange(0, 0);
                                    }
                                    
                                    console.log('Focus completed, cursor position:', targetTextarea.selectionStart);
                                    console.log('Active element:', document.activeElement);
                                    console.log('Target element:', targetTextarea);
                                    console.log('Are they the same?', document.activeElement === targetTextarea);
                                    
                                    // Simple scroll to make sure target is visible
                                    targetTextarea.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                                }, 10);
                                
                                // Temporarily disable navigation flag clearing
                                // setTimeout(() => {
                                //     isNavigating = false;
                                // }, 100);
                            } else {
                                console.log('Target not found, trying fallback rendering');
                                // Target row not rendered yet, ensure it's rendered and try again
                                const jsonView = document.getElementById('jsonView');
                                
                                // Force render more chunks to ensure target row is available
                                while (jsonRenderState.renderedRows <= targetRowIndex && jsonRenderState.renderedRows < jsonRenderState.totalRows) {
                                    renderJsonChunk();
                                }
                                
                                console.log('Rendered rows after fallback:', jsonRenderState.renderedRows);
                                
                                // Use requestAnimationFrame for better timing with DOM updates
                                requestAnimationFrame(() => {
                                    const updatedTargetTextarea = jsonView.querySelector('.json-content-editable[data-row-index="' + targetRowIndex + '"]');
                                    
                                    console.log('Fallback target textarea found:', !!updatedTargetTextarea);
                                    
                                    if (updatedTargetTextarea) {
                                        // Temporarily disable navigation flag clearing
                                        // isNavigating = false;
                                        
                                        console.log('Focusing fallback target textarea');
                                        // Focus the textarea
                                        updatedTargetTextarea.focus();
                                        
                                        // Position cursor at the beginning for Up arrow, end for Down arrow
                                        if (e.key === 'ArrowUp') {
                                            updatedTargetTextarea.setSelectionRange(updatedTargetTextarea.value.length, updatedTargetTextarea.value.length);
                                        } else {
                                            updatedTargetTextarea.setSelectionRange(0, 0);
                                        }
                                        
                                        // Only scroll if the target is not visible in the viewport
                                        const targetRect = updatedTargetTextarea.parentElement.getBoundingClientRect();
                                        const jsonViewRect = jsonView.getBoundingClientRect();
                                        
                                        if (targetRect.top < jsonViewRect.top || targetRect.bottom > jsonViewRect.bottom) {
                                            // Target is not visible, scroll it into view gently
                                            updatedTargetTextarea.parentElement.scrollIntoView({
                                                behavior: 'smooth',
                                                block: 'nearest',
                                                inline: 'nearest'
                                            });
                                        }
                                    } else {
                                        // If still not found, try one more time
                                        // isNavigating = false;
                                        console.warn('Target textarea not found after rendering for row', targetRowIndex);
                                    }
                                });
                            }
                        }
                    }
                });

                jsonContent.addEventListener('click', function(e) {
                    e.stopPropagation();
                });

                // Add context menu support for Pretty Print view
                lineDiv.addEventListener('contextmenu', function(e) {
                    e.preventDefault();
                    e.stopPropagation();
                    showRowContextMenu(e, index);
                });

                lineDiv.appendChild(lineNumber);
                lineDiv.appendChild(jsonContent);
                fragment.appendChild(lineDiv);
            }

            jsonView.appendChild(fragment);
            jsonRenderState.renderedRows = end;
            jsonRenderState.isRendering = false;

            const searchTerm = document.getElementById('searchInput').value;
            if (searchTerm) {
                highlightJsonResults(searchTerm);
            }

            if (currentView === 'json') {
                requestAnimationFrame(ensureJsonViewportFilled);
            }
        }

        function ensureJsonViewportFilled() {
            if (currentView !== 'json') return;

            const tableContainer = document.getElementById('tableContainer');
            if (!tableContainer) return;

            if (jsonRenderState.renderedRows >= jsonRenderState.totalRows) return;

            if (tableContainer.scrollHeight <= tableContainer.clientHeight + 50) {
                renderJsonChunk();
            }
        }

        function ensureJsonScrollCapacity(targetScroll) {
            const tableContainer = document.getElementById('tableContainer');
            if (!tableContainer) return;

            if (jsonRenderState.renderedRows >= jsonRenderState.totalRows) return;

            const maxScroll = tableContainer.scrollHeight - tableContainer.clientHeight;
            if (targetScroll > maxScroll - 50) {
                renderJsonChunk();
                requestAnimationFrame(() => ensureJsonScrollCapacity(targetScroll));
            }
        }

        function resetRawRenderingState() {
            rawRenderState.totalLines = currentData.parsedLines ? currentData.parsedLines.length : 0;
            rawRenderState.renderedLines = 0;
            rawRenderState.isRendering = false;

            if (currentView !== 'raw') {
                const rawContent = document.getElementById('rawContent');
                if (rawContent) {
                    rawContent.innerHTML = '';
                }
            }
        }

        function renderRawChunk(reset = false) {
            const rawContent = document.getElementById('rawContent');
            if (!rawContent) return;

            if (reset) {
                rawRenderState.totalLines = currentData.parsedLines ? currentData.parsedLines.length : 0;
                rawRenderState.renderedLines = 0;
                rawRenderState.isRendering = false;
                rawContent.innerHTML = '';
            }

            if (rawRenderState.isRendering) return;
            if (rawRenderState.renderedLines >= rawRenderState.totalLines) return;

            rawRenderState.isRendering = true;

            const fragment = document.createDocumentFragment();
            const start = rawRenderState.renderedLines;
            const end = Math.min(start + RAW_CHUNK_SIZE, rawRenderState.totalLines);

            for (let index = start; index < end; index++) {
                const line = currentData.parsedLines[index];
                const lineDiv = document.createElement('div');
                lineDiv.className = 'raw-line';
                
                if (line.error) {
                    lineDiv.classList.add('error');
                }

                const lineNumber = document.createElement('div');
                lineNumber.className = 'raw-line-number';
                lineNumber.textContent = line.lineNumber.toString().padStart(4, ' ');

                const lineContent = document.createElement('div');
                lineContent.className = 'raw-line-content';
                lineContent.textContent = line.rawLine || '';

                // Add context menu support for Raw view
                lineDiv.addEventListener('contextmenu', function(e) {
                    e.preventDefault();
                    e.stopPropagation();
                    showRowContextMenu(e, index);
                });

                lineDiv.appendChild(lineNumber);
                lineDiv.appendChild(lineContent);
                fragment.appendChild(lineDiv);
            }

            rawContent.appendChild(fragment);
            rawRenderState.renderedLines = end;
            rawRenderState.isRendering = false;

            const searchTerm = document.getElementById('searchInput').value;
            if (searchTerm) {
                highlightRawResults(searchTerm);
            }

            if (currentView === 'raw') {
                requestAnimationFrame(ensureRawViewportFilled);
            }
        }

        function ensureRawViewportFilled() {
            if (currentView !== 'raw') return;

            const tableContainer = document.getElementById('tableContainer');
            if (!tableContainer) return;

            if (rawRenderState.renderedLines >= rawRenderState.totalLines) return;

            if (tableContainer.scrollHeight <= tableContainer.clientHeight + 50) {
                renderRawChunk();
            }
        }

        function ensureRawScrollCapacity(targetScroll) {
            const tableContainer = document.getElementById('tableContainer');
            if (!tableContainer) return;

            if (rawRenderState.renderedLines >= rawRenderState.totalLines) return;

            const maxScroll = tableContainer.scrollHeight - tableContainer.clientHeight;
            if (targetScroll > maxScroll - 50) {
                renderRawChunk();
                requestAnimationFrame(() => ensureRawScrollCapacity(targetScroll));
            }
        }

        function attachScrollListener() {
            if (containerScrollListenerAttached) return;

            const tableContainer = document.getElementById('tableContainer');
            if (!tableContainer) return;

            tableContainer.addEventListener('scroll', handleContainerScroll);
            containerScrollListenerAttached = true;
        }

        function handleContainerScroll() {
            const tableContainer = document.getElementById('tableContainer');
            if (!tableContainer) return;

            scrollPositions[currentView] = tableContainer.scrollTop;

            // Don't trigger re-render during navigation
            if (isNavigating) return;

            const nearBottom = tableContainer.scrollTop + tableContainer.clientHeight >= tableContainer.scrollHeight - 200;
            if (!nearBottom) return;

            if (currentView === 'table') {
                renderTableChunk();
            } else if (currentView === 'json') {
                renderJsonChunk();
            } else if (currentView === 'raw') {
                renderRawChunk();
            }
        }

        function restoreScrollPosition(viewType) {
            const tableContainer = document.getElementById('tableContainer');
            if (!tableContainer) return;

            const targetScroll = scrollPositions[viewType] || 0;
            tableContainer.scrollTop = targetScroll;

            if (viewType === 'table') {
                ensureTableScrollCapacity(targetScroll);
            } else if (viewType === 'json') {
                ensureJsonScrollCapacity(targetScroll);
            } else if (viewType === 'raw') {
                ensureRawScrollCapacity(targetScroll);
            }
        }

        function getNestedValue(obj, path) {
            if (!obj || !path) return undefined;
            
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
                    if (isNaN(index)) return undefined;
                    current = current[key];
                    if (Array.isArray(current)) {
                        current = current[index];
                    } else {
                        return undefined;
                    }
                } else {
                    current = current[part];
                }
                
                if (current === undefined || current === null) break;
            }
            
            return current;
        }
        
        function getSampleValue(rows, columnPath) {
            for (const row of rows) {
                const value = getNestedValue(row, columnPath);
                if (value !== undefined && value !== null) {
                    return value;
                }
            }
            return null;
        }
        
        function editCell(event, td, rowIndex, columnPath) {
            // Prevent any default behavior
            event.preventDefault();
            event.stopPropagation();
            
            const originalValue = td.textContent;
            
            // Create input element
            const input = document.createElement('input');
            input.value = originalValue;
            input.style.width = '100%';
            input.style.height = '100%';
            input.style.border = 'none';
            input.style.outline = 'none';
            input.style.backgroundColor = 'var(--vscode-input-background)';
            input.style.color = 'var(--vscode-input-foreground)';
            input.style.padding = '6px 8px';
            input.style.fontSize = 'inherit';
            input.style.fontFamily = 'inherit';
            input.style.boxSizing = 'border-box';
            
            // Replace cell content with input
            td.innerHTML = '';
            td.appendChild(input);
            td.classList.add('editing');
            
            // Focus and select text
            input.focus();
            input.select();
            
            // Handle save on blur or enter
            function saveEdit() {
                const newValue = input.value;
                td.classList.remove('editing');
                td.textContent = newValue;
                td.title = newValue;
                
                // Send update message
                vscode.postMessage({
                    type: 'updateCell',
                    rowIndex: rowIndex,
                    columnPath: columnPath,
                    value: newValue
                });
            }
            
            // Handle cancel on escape
            function cancelEdit() {
                td.classList.remove('editing');
                td.textContent = originalValue;
                td.title = originalValue;
            }
            
            input.addEventListener('blur', saveEdit);
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    saveEdit();
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    cancelEdit();
                }
            });
        }
        
        // Listen for messages from the extension
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.type) {
                case 'update':
                    updateTable(message.data);
                    break;
                case 'clipboardValidationResult':
                    const pasteAboveMenuItem = document.getElementById('pasteAboveMenuItem');
                    const pasteBelowMenuItem = document.getElementById('pasteBelowMenuItem');
                    if (message.isValidJson) {
                        pasteAboveMenuItem.classList.remove('disabled');
                        pasteBelowMenuItem.classList.remove('disabled');
                    } else {
                        pasteAboveMenuItem.classList.add('disabled');
                        pasteBelowMenuItem.classList.add('disabled');
                    }
                    break;
                case 'settingsLoaded':
                    const openaiKey = document.getElementById('openaiKey');
                    const openaiModel = document.getElementById('openaiModel');

                    openaiKey.value = message.settings.openaiKey || '';
                    openaiModel.value = message.settings.openaiModel || 'gpt-4.1-mini';
                    break;
            }
        });
        
        // Fallback: if no message is received within 5 seconds, show error
        setTimeout(() => {
            if (currentData.isIndexing) {
                updateTable({
                    rows: [],
                    columns: [],
                    isIndexing: false,
                    searchTerm: '',
                    useRegex: false,
                    parsedLines: [{
                        data: null,
                        lineNumber: 1,
                        rawLine: '',
                        error: 'Extension failed to load data. Please try reloading the file.'
                    }],
                    rawContent: '',
                    errorCount: 1,
                    loadingProgress: {
                        loadedLines: 0,
                        totalLines: 0,
                        loadingChunks: false,
                        progressPercent: 100,
                        memoryOptimized: false,
                        displayedRows: 0
                    }
                });
            }
        }, 5000);
        
        // View control functions
        function switchView(viewType) {
            // Don't switch if already on the same view
            if (currentView === viewType) {
                return;
            }
            
            // Save current scroll position
            const tableContainer = document.getElementById('tableContainer');
            if (tableContainer) {
                scrollPositions[currentView] = tableContainer.scrollTop;
            }
            
            currentView = viewType;
            
            // Show spinning gazelle during view switch
            const logo = document.getElementById('logo');
            const loadingState = document.getElementById('loadingState');
            const searchContainer = document.getElementById('searchContainer');
            logo.classList.add('loading');
            loadingState.style.display = 'flex';
            loadingState.innerHTML = '<div>Switching view...</div>';
            
            // Hide search container during view switch
            searchContainer.classList.add('controls-hidden');
            
            // Update segmented control
            document.querySelectorAll('.segmented-control button').forEach(button => {
                button.classList.toggle('active', button.dataset.view === viewType);
            });
            
            // Hide all view containers
            document.getElementById('tableViewContainer').style.display = 'none';
            document.getElementById('jsonViewContainer').style.display = 'none';
            document.getElementById('rawViewContainer').style.display = 'none';
            
            // Show/hide column manager and wrap text controls based on view
            const columnManagerBtn = document.getElementById('columnManagerBtn');
            const wrapTextControl = document.querySelector('.wrap-text-control');
            
            // Show selected view container
            switch (viewType) {
                case 'table':
                    document.getElementById('tableViewContainer').style.display = 'block';
                    document.getElementById('dataTable').style.display = 'table';
                    // Show column controls for table view
                    columnManagerBtn.style.display = 'flex';
                    wrapTextControl.style.display = 'flex';
                    // Hide loading state immediately for table view (already rendered)
                    logo.classList.remove('loading');
                    loadingState.style.display = 'none';
                    searchContainer.classList.remove('controls-hidden');
                    requestAnimationFrame(ensureTableViewportFilled);
                    break;
                case 'json':
                    document.getElementById('jsonViewContainer').style.display = 'block';
                    document.getElementById('jsonViewContainer').classList.add('isolated');
                    // Hide column controls for json view
                    columnManagerBtn.style.display = 'none';
                    wrapTextControl.style.display = 'none';
                    
                    // Add event isolation to prevent bubbling
                    const jsonContainer = document.getElementById('jsonViewContainer');
                    jsonContainer.addEventListener('dblclick', function(e) {
                        e.stopPropagation();
                    });
                    jsonContainer.addEventListener('click', function(e) {
                        e.stopPropagation();
                    });
                    
                    // Use setTimeout to allow the loading animation to show before rendering
                    // Longer delay for larger datasets to ensure smooth animation
                    const jsonDelay = currentData.rows.length > 1000 ? 100 : 50;
                    setTimeout(() => {
                        updateJsonView();
                        // Hide loading state after JSON view is rendered
                        logo.classList.remove('loading');
                        loadingState.style.display = 'none';
                        searchContainer.classList.remove('controls-hidden');
                    }, jsonDelay);
                    break;
                case 'raw':
                    document.getElementById('rawViewContainer').style.display = 'block';
                    // Hide column controls for raw view
                    columnManagerBtn.style.display = 'none';
                    wrapTextControl.style.display = 'none';
                    // Use setTimeout to allow the loading animation to show before rendering
                    // Longer delay for larger datasets to ensure smooth animation
                    const rawDelay = currentData.rawContent && currentData.rawContent.length > 100000 ? 100 : 50;
                    setTimeout(() => {
                        updateRawView();
                        // Hide loading state after raw view is rendered
                        logo.classList.remove('loading');
                        loadingState.style.display = 'none';
                        searchContainer.classList.remove('controls-hidden');
                        
                        // Автоматически открыть файл в редакторе VS Code
                        vscode.postMessage({
                            type: 'openInEditor'
                        });
                    }, rawDelay);
                    break;
            }
            
            // Restore scroll position
            setTimeout(() => {
                restoreScrollPosition(viewType);
            }, 0);
        }
        
        function updateJsonView() {
            renderJsonChunk(true);
            requestAnimationFrame(() => {
                ensureJsonViewportFilled();
                restoreScrollPosition('json');
            });
        }
        
        let rawEditor = null;
        
        function updateRawView() {
            const editorContainer = document.getElementById('rawEditor');
            if (!editorContainer) return;
            
            // Инициализировать Monaco Editor
            require.config({ paths: { 'vs': 'https://cdn.jsdelivr.net/npm/monaco-editor@0.44.0/min/vs' } });
            require(['vs/editor/editor.main'], function () {
                if (rawEditor) {
                    rawEditor.dispose();
                }
                
                rawEditor = monaco.editor.create(editorContainer, {
                    value: currentData.rawContent || '',
                    language: 'json',
                    theme: 'vs-dark',
                    automaticLayout: true,
                    scrollBeyondLastLine: false,
                    minimap: { enabled: false },
                    wordWrap: 'on',
                    lineNumbers: 'on',
                    folding: true,
                    fontSize: 14,
                    fontFamily: 'Consolas, "Courier New", monospace'
                });
                
                // Обработчик изменений
                rawEditor.onDidChangeModelContent(() => {
                    clearTimeout(window.rawEditTimeout);
                    window.rawEditTimeout = setTimeout(() => {
                        vscode.postMessage({
                            type: 'rawContentChanged',
                            newContent: rawEditor.getValue()
                        });
                    }, 500);
                });
                
                // Обработчик Ctrl+S
                rawEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
                    vscode.postMessage({
                        type: 'rawContentChanged',
                        newContent: rawEditor.getValue()
                    });
                });
            });
        }
        
        
        function expandCell(event, td, rowIndex, columnPath) {
            event.preventDefault();
            event.stopPropagation();

            const value = getNestedValue(currentData.allRows[rowIndex], columnPath);
            if (typeof value !== 'object' || value === null) return;
            
            // Create expanded content
            const expandedContent = document.createElement('div');
            expandedContent.className = 'expanded-content';
            
            if (Array.isArray(value)) {
                value.forEach((item, index) => {
                    const div = document.createElement('div');
                    const strong = document.createElement('strong');
                    strong.textContent = index + ':';
                    div.appendChild(strong);
                    div.appendChild(document.createTextNode(' ' + JSON.stringify(item)));
                    expandedContent.appendChild(div);
                });
            } else {
                Object.entries(value).forEach(([key, val]) => {
                    const div = document.createElement('div');
                    const strong = document.createElement('strong');
                    strong.textContent = key + ':';
                    div.appendChild(strong);
                    div.appendChild(document.createTextNode(' ' + JSON.stringify(val)));
                    expandedContent.appendChild(div);
                });
            }
            
            // Position and show
            td.appendChild(expandedContent);
            
            // Hide on click outside
            setTimeout(() => {
                document.addEventListener('click', function hideExpanded() {
                    expandedContent.remove();
                    document.removeEventListener('click', hideExpanded);
                });
            }, 0);
        }
        
        // Add event listeners for view controls
        document.querySelectorAll('.segmented-control button').forEach(button => {
            button.addEventListener('click', (e) => switchView(e.target.dataset.view));
        });
        
    </script>
</body>
</html>`;
    }

    
    private async updateCell(rowIndex: number, columnPath: string, value: string, webviewPanel: vscode.WebviewPanel, document: vscode.TextDocument) {
        if (rowIndex < 0 || rowIndex >= this.rows.length) {
            console.error(`Invalid row index for updateCell: ${rowIndex}, total rows: ${this.rows.length}`);
            return;
        }

        try {
            // Try to parse as JSON first
            let parsedValue: any = value;
            if (value.trim() !== '') {
                try {
                    parsedValue = JSON.parse(value);
                } catch {
                    // If not valid JSON, treat as string
                    parsedValue = value;
                }
            } else {
                parsedValue = null;
            }

            // Update the row in the main array
            this.setNestedValue(this.rows[rowIndex], columnPath, parsedValue);

            // Rebuild parsedLines
            this.parsedLines = this.rows.map((row, index) => ({
                data: row,
                lineNumber: index + 1,
                rawLine: JSON.stringify(row)
            }));

            // Update filtered rows
            this.filterRows();

            // Update raw content
            this.rawContent = this.rows.map(row => JSON.stringify(row)).join('\n');

            // Debounce the save operation
            if (this.pendingSaveTimeout) {
                clearTimeout(this.pendingSaveTimeout);
            }

            this.pendingSaveTimeout = setTimeout(async () => {
                try {
                    this.isUpdating = true;

                    const fullRange = new vscode.Range(
                        document.positionAt(0),
                        document.positionAt(document.getText().length)
                    );

                    const edit = new vscode.WorkspaceEdit();
                    edit.replace(document.uri, fullRange, this.rawContent);

                    const success = await vscode.workspace.applyEdit(edit);

                    if (!success) {
                        console.error('Failed to apply workspace edit');
                        vscode.window.showErrorMessage('Failed to save changes');
                    }
                } catch (saveError) {
                    console.error('Error saving cell update:', saveError);
                } finally {
                    setTimeout(() => {
                        this.isUpdating = false;
                    }, 200);
                }
            }, 300); // Debounce for 300ms

            // Update the webview immediately to show the change
            this.updateWebview(webviewPanel);
        } catch (error) {
            console.error('Error updating cell:', error);
            vscode.window.showErrorMessage('Failed to update cell value');
        }
    }
    
    private setNestedValue(obj: any, path: string, value: any) {
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

    private isStringifiedJson(value: any): boolean {
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

    private async handleUnstringifyColumn(columnPath: string, webviewPanel: vscode.WebviewPanel, document: vscode.TextDocument) {
        try {
            // First, check if the column contains stringified JSON
            let hasStringifiedJson = false;
            const totalRows = this.rows.length;
            const isRootLevelString = columnPath === '(value)';

            // Check a sample of rows to see if they contain stringified JSON
            const sampleSize = Math.min(100, totalRows);
            for (let i = 0; i < sampleSize; i++) {
                const value = isRootLevelString ? this.rows[i] : this.getNestedValue(this.rows[i], columnPath);
                if (this.isStringifiedJson(value)) {
                    hasStringifiedJson = true;
                    break;
                }
            }

            if (!hasStringifiedJson) {
                vscode.window.showWarningMessage(`Column "${columnPath}" does not appear to contain stringified JSON data.`);
                return;
            }

            // Process rows in chunks to avoid blocking the UI
            const chunkSize = 100;
            let successCount = 0;
            let errorCount = 0;
            
            if (totalRows > 1000) {
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: `Unstringifying JSON in column "${columnPath}"`,
                    cancellable: false
                }, async (progress) => {
                    progress.report({ increment: 0, message: `Processing ${totalRows.toLocaleString()} rows...` });
                    
                    for (let i = 0; i < totalRows; i += chunkSize) {
                        const endIndex = Math.min(i + chunkSize, totalRows);

                        for (let j = i; j < endIndex; j++) {
                            const row = this.rows[j];
                            const value = isRootLevelString ? row : this.getNestedValue(row, columnPath);

                            if (this.isStringifiedJson(value)) {
                                try {
                                    const parsedValue = JSON.parse(value as string);
                                    if (isRootLevelString) {
                                        // Replace the entire row with the parsed object
                                        this.rows[j] = parsedValue;
                                    } else {
                                        this.setNestedValue(row, columnPath, parsedValue);
                                    }
                                    successCount++;
                                } catch (error) {
                                    errorCount++;
                                    console.warn(`Failed to parse JSON in row ${j + 1}, column "${columnPath}":`, error);
                                }
                            }
                        }
                        
                        // Update progress for large files
                        const progressPercent = Math.round((endIndex / totalRows) * 100);
                        progress.report({ 
                            increment: 0, 
                            message: `Processed ${endIndex.toLocaleString()} of ${totalRows.toLocaleString()} rows (${progressPercent}%)` 
                        });
                        
                        // Yield control to prevent blocking the UI
                        if (i % (chunkSize * 10) === 0) {
                            await new Promise(resolve => setTimeout(resolve, 0));
                        }
                    }
                });
            } else {
                for (let i = 0; i < totalRows; i += chunkSize) {
                    const endIndex = Math.min(i + chunkSize, totalRows);
                    
                    for (let j = i; j < endIndex; j++) {
                        const row = this.rows[j];
                        const value = isRootLevelString ? row : this.getNestedValue(row, columnPath);

                        if (this.isStringifiedJson(value)) {
                            try {
                                const parsedValue = JSON.parse(value as string);
                                if (isRootLevelString) {
                                    // Replace the entire row with the parsed object
                                    this.rows[j] = parsedValue;
                                } else {
                                    this.setNestedValue(row, columnPath, parsedValue);
                                }
                                successCount++;
                            } catch (error) {
                                errorCount++;
                                console.warn(`Failed to parse JSON in row ${j + 1}, column "${columnPath}":`, error);
                            }
                        }
                    }
                    
                    // Yield control to prevent blocking the UI
                    if (i % (chunkSize * 10) === 0) {
                        await new Promise(resolve => setTimeout(resolve, 0));
                    }
                }
            }

            // If we unstringified root-level strings, we need to recalculate columns
            if (isRootLevelString && successCount > 0) {
                // Recalculate path counts for the new object structure
                this.pathCounts = {};
                this.rows.forEach(row => {
                    if (row && typeof row === 'object') {
                        this.countPaths(row, '', this.pathCounts);
                    }
                });

                // Update columns to reflect the new structure
                this.updateColumns();
            }

            // Update raw content and save changes
            this.rawContent = this.rows.map(row => JSON.stringify(row)).join('\n');

            // Save the changes to the file
            const fullRange = new vscode.Range(
                document.positionAt(0),
                document.positionAt(document.getText().length)
            );

            const edit = new vscode.WorkspaceEdit();
            edit.replace(document.uri, fullRange, this.rawContent);

            const success = await vscode.workspace.applyEdit(edit);
            if (!success) {
                vscode.window.showErrorMessage('Failed to save unstringified changes to file.');
                return;
            }

            // Update the webview to reflect changes
            this.updateWebview(webviewPanel);
            
            // Show completion message
            const message = `Successfully unstringified ${successCount.toLocaleString()} JSON values in column "${columnPath}".`;
            if (errorCount > 0) {
                vscode.window.showWarningMessage(`${message} ${errorCount.toLocaleString()} values could not be parsed.`);
            } else {
                vscode.window.showInformationMessage(message);
            }
            
        } catch (error) {
            console.error('Error unstringifying column:', error);
            vscode.window.showErrorMessage(`Failed to unstringify column "${columnPath}": ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

}
