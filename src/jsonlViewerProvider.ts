import * as vscode from 'vscode';
import * as path from 'path';
import { JsonRow, ParsedLine, ColumnInfo } from './jsonl/types';
import * as utils from './jsonl/utils';
import { getHtmlTemplate } from './webview/template';
import { styles } from './webview/styles';
import { scripts } from './webview/scripts';

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
                            case 'rawContentSave':
                                await this.handleRawContentSave(message.newContent, webviewPanel, document);
                                break;
                            case 'forceSave':
                                await document.save();
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
                                await this.handleAddAIColumn(message.columnName, message.promptTemplate, message.position, message.referenceColumn, webviewPanel, document, message.enumValues);
                                break;
                            case 'getSettings':
                                await this.handleGetSettings(webviewPanel);
                                break;
                            case 'getRecentEnumValues':
                                await this.handleGetRecentEnumValues(webviewPanel);
                                break;
                            case 'checkAPIKey':
                                await this.handleCheckAPIKey(webviewPanel);
                                break;
                            case 'showAPIKeyWarning':
                                vscode.window.showWarningMessage('OpenAI API key is required for AI features. Please configure it in settings.');
                                break;
                            case 'saveSettings':
                                await this.handleSaveSettings(message.settings, webviewPanel, message.openOriginalModal || false);
                                break;
                            case 'generateAIRows':
                                await this.handleGenerateAIRows(message.rowIndex, message.contextRowCount, message.rowCount, message.promptTemplate, webviewPanel, document);
                                break;
                            case 'requestColumnSuggestions':
                                await this.handleRequestColumnSuggestions(message.referenceColumn, webviewPanel);
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
        
        // Process all chunks without async/await in loop for maximum speed
        for (let startIndex = this.loadedLines; startIndex < this.totalLines; startIndex += this.CHUNK_SIZE) {
            const endIndex = Math.min(startIndex + this.CHUNK_SIZE, this.totalLines);
            const chunkLines = lines.slice(startIndex, endIndex);
            
            this.processChunk(chunkLines, startIndex);
            this.loadedLines = endIndex;
            
            // Update columns progressively - only add new columns, don't re-expand
            this.addNewColumnsOnly();
            
            // Update UI only every 10 chunks (much less frequent)
            if ((startIndex / this.CHUNK_SIZE) % 10 === 0 && this.currentWebviewPanel) {
                this.filteredRows = this.searchTerm ? [...this.rows] : this.rows;
                this.updateWebview(this.currentWebviewPanel);
            }
            
            // Yield only every 1000 lines to maintain responsiveness
            if (startIndex % (this.CHUNK_SIZE * 10) === 0) {
                await new Promise(resolve => setTimeout(resolve, 10));
            }
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
        if (this.rows.length > 0 && typeof this.rows[0] === 'object' && this.rows[0] !== null && !Array.isArray(this.rows[0])) {
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
        return utils.getDisplayName(path);
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
        utils.deleteNestedProperty(obj, path);
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
        document: vscode.TextDocument,
        enumValues?: string[] | null
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

            // Add "generating" values to all rows for the new column (will be filled by AI)
            this.rows.forEach(row => {
                const newRow: JsonRow = {};
                let inserted = false;

                for (const key of Object.keys(row)) {
                    if (key === referenceColumn && position === 'before' && !inserted) {
                        newRow[columnName] = "generating";
                        inserted = true;
                    }

                    newRow[key] = row[key];

                    if (key === referenceColumn && position === 'after' && !inserted) {
                        newRow[columnName] = "generating";
                        inserted = true;
                    }
                }

                if (!inserted) {
                    newRow[columnName] = "generating";
                }

                Object.keys(row).forEach(key => delete row[key]);
                Object.assign(row, newRow);
            });

            // Update webview to show the column with "generating" values
            this.updateWebview(webviewPanel);

            // Now fill the column with AI-generated content
            await this.fillColumnWithAI(columnName, promptTemplate, webviewPanel, document, enumValues || null);

            // Save recent enum values to global state
            if (enumValues && enumValues.length > 0) {
                await this.saveRecentEnumValues(enumValues);
            }

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
        document: vscode.TextDocument,
        enumValues: string[] | null = null
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
                    batch.push(this.generateAIValueForRow(j, promptTemplate, totalRows, enumValues));
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

    private async generateAIValueForRow(rowIndex: number, promptTemplate: string, totalRows: number, enumValues: string[] | null = null): Promise<string | number | boolean> {
        const row = this.rows[rowIndex];

        // Replace template variables (use empty string if template is empty)
        let prompt = promptTemplate ? this.replaceTemplateVariables(promptTemplate, row, rowIndex, totalRows) : '';

        // When using enum with Structured Outputs, do not include the options list in the prompt.
        // The JSON Schema strictly constrains allowed values; keep only row context in the prompt.
        if (enumValues && enumValues.length > 0) {
            if (!prompt) {
                prompt = `Given the following row JSON, select the single best value based on the context. Return exactly one value.\n\nRow:\n${JSON.stringify(row, null, 2)}`;
            }
        }

        // Call the language model API (let errors bubble up)
        const result = await this.callLanguageModel(prompt, enumValues);

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

    private async callLanguageModel(prompt: string, enumValues: string[] | null = null): Promise<string | number | boolean> {
        const apiKey = await this.context.secrets.get('openaiApiKey');
        if (!apiKey) {
            throw new Error('OpenAI API key not configured. Please set it in AI Settings.');
        }

        const trimmedApiKey = apiKey.trim();
        const model = this.context.globalState.get<string>('openaiModel', 'gpt-4.1-mini');

        const requestBody: any = {
            model: model,
            messages: [],
            // Lower temperature for enum selections
            temperature: enumValues && enumValues.length > 0 ? 0.1 : 0.7,
            // Add top_p for better control
            top_p: enumValues && enumValues.length > 0 ? 0.1 : 1
        };

        if (enumValues && enumValues.length > 0) {
            const buckets = this.getTypedEnumBuckets(enumValues);
            const valueSchema = this.buildEnumValueSchema(buckets);

            // Simple system prompt - enum constraints are handled by structured outputs JSON Schema
            requestBody.messages.push({
                role: 'system',
                content: `Analyze the input context and select the most appropriate value from the allowed options. Choose based on semantic matching with the context provided.`
            });

            requestBody.response_format = {
                type: 'json_schema',
                json_schema: {
                    name: 'enum_response',
                    strict: true,
                    schema: {
                        type: 'object',
                        properties: {
                            value: Object.assign({}, valueSchema, {
                                description: `Select exactly ONE value from the allowed options based on the context.`
                            })
                        },
                        required: ['value'],
                        additionalProperties: false
                    }
                }
            };

            // Add seed for reproducibility (if supported by the model)
            if (model.includes('gpt-4') || model.includes('gpt-3.5')) {
                requestBody.seed = this.generateSessionSeed();
            }
        } else {
            // For non-enum requests, add system prompt to ensure concise responses
            requestBody.messages.push({
                role: 'system',
                content: `You are a data processing assistant. Respond with ONLY the requested value or result, without any explanations, prefixes, or additional text. Return only the raw data value (number, string, boolean, etc.) that should be stored in the column.`
            });
        }

        requestBody.messages.push({ role: 'user', content: prompt });

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${trimmedApiKey}`
            },
            body: JSON.stringify(requestBody)
        });
        if (!response.ok) {
            const error = await response.text();
            throw new Error(`OpenAI API error: ${response.status} - ${error}`);
        }
        const data = await response.json();

        if (enumValues && enumValues.length > 0) {
            const content = data.choices[0].message.content.trim();

            try {
                const parsed = JSON.parse(content);
                const isAllowed = this.isValueInEnum(parsed.value, enumValues);
                if (isAllowed) {
                    return parsed.value as string | number | boolean;
                }
                throw new Error(`Returned value "${parsed.value}" is not in the allowed enum set.`);
            } catch (error) {
                throw new Error(`Failed to parse structured output: ${error instanceof Error ? error.message : 'Unknown error'}. Content: ${content.substring(0, 100)}`);
            }
        }

        // Use parseEnumValue to automatically convert string numbers/booleans to proper types
        const content = data.choices[0].message.content.trim();
        const parsed = this.parseEnumValue(content);
        return parsed.value;
    }

    // Helpers for typed enums
    private enumCache = new Map<string, { kind: 'boolean' | 'integer' | 'number' | 'string'; value: boolean | number | string }>();
    private parseEnumValue(raw: string): { kind: 'boolean' | 'integer' | 'number' | 'string'; value: boolean | number | string } {
        if (this.enumCache.has(raw)) {
            return this.enumCache.get(raw)!;
        }

        const s = raw.trim();

        // Boolean values (case-sensitive check)
        if (s === 'true') {
            const result = { kind: 'boolean' as const, value: true as const };
            this.enumCache.set(raw, result);
            return result;
        }
        if (s === 'false') {
            const result = { kind: 'boolean' as const, value: false as const };
            this.enumCache.set(raw, result);
            return result;
        }

        // Numbers — fast path via Number()
        const num = Number(s);
        if (!Number.isNaN(num) && s !== '') {
            const result = Number.isInteger(num)
                ? { kind: 'integer' as const, value: num }
                : { kind: 'number' as const, value: num };
            this.enumCache.set(raw, result);
            return result;
        }

        // Default — treat as string
        const result = { kind: 'string' as const, value: raw };
        this.enumCache.set(raw, result);
        return result;
    }

    private getTypedEnumBuckets(enumValues: string[]): { booleans: boolean[]; integers: number[]; numbers: number[]; strings: string[] } {
        const typed = enumValues.map(v => this.parseEnumValue(v));
        return {
            booleans: typed.filter(t => t.kind === 'boolean').map(t => t.value as boolean),
            integers: typed.filter(t => t.kind === 'integer').map(t => t.value as number),
            numbers: typed.filter(t => t.kind === 'number').map(t => t.value as number),
            strings: typed.filter(t => t.kind === 'string').map(t => t.value as string)
        };
    }

    private buildEnumValueSchema(buckets: { booleans: boolean[]; integers: number[]; numbers: number[]; strings: string[] }): any {
        const schemas: any[] = [];
        if (buckets.booleans.length > 0) schemas.push({ type: 'boolean', enum: buckets.booleans });
        if (buckets.integers.length > 0) schemas.push({ type: 'integer', enum: buckets.integers });
        if (buckets.numbers.length > 0) schemas.push({ type: 'number', enum: buckets.numbers });
        if (buckets.strings.length > 0) schemas.push({ type: 'string', enum: buckets.strings });
        return schemas.length === 1 ? schemas[0] : { anyOf: schemas };
    }

    private isValueInEnum(value: unknown, enumValues: string[]): boolean {
        const allowed = enumValues.map(v => this.parseEnumValue(v).value);

        // Strict type and value validation
        return allowed.some((allowedValue) => {
            if (typeof value !== typeof allowedValue) return false;

            if (typeof value === 'number' && typeof allowedValue === 'number') {
                return value === allowedValue;
            }

            return value === allowedValue;
        });
    }

    // Helper methods: randomization and seed
    private shuffleArray<T>(array: T[]): T[] {
        const shuffled = [...array];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return shuffled;
    }

    private generateSessionSeed(): number {
        return Math.floor(Math.random() * 10000);
    }

    private convertJsonlToPrettyWithLineNumbers(rows: JsonRow[]): { content: string, lineMapping: number[] } {
        if (rows.length === 0) {
            return { content: '', lineMapping: [] };
        }

        const lineMapping: number[] = [];
        let content = '';

        rows.forEach((row, index) => {
            const prettyJson = JSON.stringify(row, null, 2);
            const lines = prettyJson.split('\n');

            // Only show line number for the first line of each JSON object
            const originalLineNumber = index + 1;
            lines.forEach((line, lineIndex) => {
                if (lineIndex === 0) {
                    // First line of JSON object - show original line number
                    lineMapping.push(originalLineNumber);
                } else {
                    // Other lines - show empty string (will be handled by Monaco Editor)
                    lineMapping.push(0);
                }
            });

            if (content) {
                content += '\n' + prettyJson;
            } else {
                content = prettyJson;
            }
        });

        return { content, lineMapping };
    }

    private convertPrettyToJsonl(prettyContent: string): string {
        console.log('Converting pretty content to JSONL:', prettyContent.substring(0, 200) + '...');

        try {
            // First try to parse as a single JSON object
            const parsed = JSON.parse(prettyContent);

            // If it's an array, convert each element to a separate JSONL line
            if (Array.isArray(parsed)) {
                const result = parsed.map(item => JSON.stringify(item)).join('\n');
                console.log('Parsed as array, result:', result.substring(0, 200) + '...');
                return result;
            }

            // If it's a single object, return it as one line
            const result = JSON.stringify(parsed);
            console.log('Parsed as single object, result:', result);
            return result;
        } catch {
            // If not valid JSON, try to parse multiple JSON objects separated by empty lines
            try {
                const lines = prettyContent.split('\n');
                const jsonlLines: string[] = [];
                let currentJsonObject = '';
                let braceCount = 0;
                let inString = false;
                let escapeNext = false;

                console.log('Parsing multiple JSON objects, total lines:', lines.length);

                for (const line of lines) {
                    const trimmed = line.trim();

                    // Skip empty lines
                    if (!trimmed) {
                        if (currentJsonObject.trim()) {
                            try {
                                const parsed = JSON.parse(currentJsonObject.trim());
                                jsonlLines.push(JSON.stringify(parsed));
                                currentJsonObject = '';
                                braceCount = 0;
                            } catch {
                                console.warn('Skipping invalid JSON object:', currentJsonObject.trim());
                                currentJsonObject = '';
                                braceCount = 0;
                            }
                        }
                        continue;
                    }

                    // Add line to current JSON object
                    currentJsonObject += line + '\n';

                    // Count braces to determine when we have a complete object
                    for (let i = 0; i < line.length; i++) {
                        const char = line[i];

                        if (escapeNext) {
                            escapeNext = false;
                            continue;
                        }

                        if (char === '\\') {
                            escapeNext = true;
                            continue;
                        }

                        if (char === '"' && !escapeNext) {
                            inString = !inString;
                            continue;
                        }

                        if (!inString) {
                            if (char === '{') {
                                braceCount++;
                            } else if (char === '}') {
                                braceCount--;

                                // If we've closed all braces, we have a complete object
                                if (braceCount === 0 && currentJsonObject.trim()) {
                                    try {
                                        const parsed = JSON.parse(currentJsonObject.trim());
                                        jsonlLines.push(JSON.stringify(parsed));
                                        currentJsonObject = '';
                                    } catch {
                                        console.warn('Skipping invalid JSON object:', currentJsonObject.trim());
                                        currentJsonObject = '';
                                    }
                                }
                            }
                        }
                    }
                }

                // Handle any remaining object
                if (currentJsonObject.trim()) {
                    try {
                        const parsed = JSON.parse(currentJsonObject.trim());
                        jsonlLines.push(JSON.stringify(parsed));
                    } catch {
                        console.warn('Skipping invalid JSON object:', currentJsonObject.trim());
                    }
                }

                const result = jsonlLines.join('\n');
                console.log('Multiple JSON objects parsing result:', result.substring(0, 200) + '...');
                return result;
            } catch {
                // If all else fails, return empty string to avoid corruption
                console.error('Failed to convert pretty content to JSONL');
                return '';
            }
        }
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

    private async saveRecentEnumValues(enumValues: string[]): Promise<void> {
        try {
            const existing = this.context.globalState.get<string[]>('recentEnumValues', []);
            const enumKey = enumValues.join(',');
            
            // Remove if already exists to avoid duplicates
            const filtered = existing.filter(item => item !== enumKey);
            
            // Add to the beginning
            filtered.unshift(enumKey);
            
            // Keep only last 5
            const trimmed = filtered.slice(0, 5);
            
            await this.context.globalState.update('recentEnumValues', trimmed);
        } catch (error) {
            console.error('Error saving recent enum values:', error);
        }
    }

    private getRecentEnumValues(): string[] {
        try {
            return this.context.globalState.get<string[]>('recentEnumValues', []);
        } catch (error) {
            console.error('Error getting recent enum values:', error);
            return [];
        }
    }

    private async handleGetRecentEnumValues(webviewPanel: vscode.WebviewPanel) {
        try {
            const recentValues = this.getRecentEnumValues();

            webviewPanel.webview.postMessage({
                type: 'recentEnumValuesLoaded',
                recentValues
            });
        } catch (error) {
            console.error('Error loading recent enum values:', error);
            webviewPanel.webview.postMessage({
                type: 'recentEnumValuesLoaded',
                recentValues: []
            });
        }
    }

    private async handleCheckAPIKey(webviewPanel: vscode.WebviewPanel) {
        try {
            // Check if OpenAI API key exists
            const openaiKey = await this.context.secrets.get('openaiApiKey');
            const hasAPIKey = !!(openaiKey && openaiKey.trim());

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

    private async handleSaveSettings(settings: { openaiKey: string; openaiModel: string }, webviewPanel: vscode.WebviewPanel, openOriginalModal: boolean) {
        try {
            await this.context.globalState.update('openaiModel', settings.openaiModel);

            // Save or delete API key based on input
            let keySaved = false;
            if (typeof settings.openaiKey === 'string') {
                const trimmed = settings.openaiKey.trim();
                if (trimmed) {
                    await this.context.secrets.store('openaiApiKey', trimmed);
                    keySaved = true;
                } else {
                    // Empty input means delete stored key
                    await this.context.secrets.delete('openaiApiKey');
                }
            }

            vscode.window.showInformationMessage('AI settings saved successfully');

            // If key was saved and original modal should be opened, check key and notify webview
            if (keySaved && openOriginalModal) {
                // Verify key is stored
                const storedKey = await this.context.secrets.get('openaiApiKey');
                webviewPanel.webview.postMessage({
                    type: 'settingsSaved',
                    hasAPIKey: !!storedKey
                });
            }
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
                    // Ensure string for regex parsing
                    const resultText = typeof result === 'string' ? result : JSON.stringify(result);
                    // Try to extract JSON array from the response
                    const jsonMatch = resultText.match(/\[[\s\S]*\]/);
                    if (jsonMatch) {
                        generatedRows = JSON.parse(jsonMatch[0]);
                    } else {
                        generatedRows = JSON.parse(resultText);
                    }

                    if (!Array.isArray(generatedRows)) {
                        throw new Error('AI did not return an array');
                    }

                    // Fix data types based on context rows
                    generatedRows = generatedRows.map(row => this.fixDataTypes(row, firstRow));
                } catch (parseError) {
                    const resultText = typeof result === 'string' ? result : JSON.stringify(result);
                    throw new Error(`Failed to parse AI response as JSON: ${parseError instanceof Error ? parseError.message : 'Unknown error'}\n\nResponse: ${resultText}`);
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
        return utils.getNestedValue(obj, path);
    }

    private async handleRawContentChange(newContent: string, webviewPanel: vscode.WebviewPanel, document: vscode.TextDocument) {
        await this.updateRawContent(newContent, webviewPanel, document, false);
    }

    private async handleRawContentSave(newContent: string, webviewPanel: vscode.WebviewPanel, document: vscode.TextDocument) {
        await this.updateRawContent(newContent, webviewPanel, document, true);
    }

    private async updateRawContent(newContent: string, webviewPanel: vscode.WebviewPanel, document: vscode.TextDocument, isSave: boolean) {
        try {
            // Update the raw content
            this.rawContent = newContent;
            
            // Set updating flag to prevent document change handler from reloading (only for change events)
            if (!isSave) {
                this.isUpdating = true;
            }
            
            // Update the document content
            const edit = new vscode.WorkspaceEdit();
            edit.replace(
                document.uri,
                new vscode.Range(0, 0, document.lineCount, 0),
                newContent
            );
            const success = await vscode.workspace.applyEdit(edit);
            
            if (success) {
                // Save the document to update dirty state indicator (only for save events)
                if (isSave) {
                    await document.save();
                }
                
                // Update internal data structures for both save and content changes
                // Parse the new content to update internal data without full reload
                const lines = newContent.split('\n');
                this.totalLines = lines.length;
                this.loadedLines = 0;
                this.rows = [];
                this.parsedLines = [];
                
                // Reset path counts for accurate column detection
                this.pathCounts = {};
                
                // Parse lines to update rows and columns
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i].trim();
                    if (line) {
                        try {
                            const parsed = JSON.parse(line);
                            this.rows.push(parsed);
                            this.parsedLines.push({
                                data: parsed,
                                lineNumber: i + 1,
                                rawLine: line,
                                error: undefined
                            });
                            
                            // Count paths for column detection
                            try {
                                this.countPaths(parsed, '', this.pathCounts);
                            } catch (countError) {
                                console.warn(`Error counting paths for line ${i + 1}:`, countError);
                            }
                        } catch (error) {
                            this.parsedLines.push({
                                data: null,
                                lineNumber: i + 1,
                                rawLine: line,
                                error: error instanceof Error ? error.message : String(error)
                            });
                        }
                    }
                }
                
                this.loadedLines = this.rows.length;
                this.filteredRows = this.rows;
                
                // Update columns based on new data
                this.updateColumns();
                
                // Update the webview to reflect changes
                this.updateWebview(webviewPanel);
                
                // Show success message only for save events
                if (isSave) {
                    vscode.window.showInformationMessage('File saved successfully');
                }
            } else {
                const errorMsg = isSave ? 'Failed to save file' : 'Failed to save raw content changes';
                vscode.window.showErrorMessage(errorMsg);
            }
            
            // Reset updating flag after a short delay (only for change events)
            if (!isSave) {
                setTimeout(() => { this.isUpdating = false; }, 100);
            }
        } catch (error) {
            console.error('Error handling raw content:', error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            const errorMsg = isSave ? 'Failed to save file: ' + errorMessage : 'Failed to save raw content changes: ' + errorMessage;
            vscode.window.showErrorMessage(errorMsg);
            
            // Reset updating flag on error (only for change events)
            if (!isSave) {
                setTimeout(() => { this.isUpdating = false; }, 100);
            }
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

            // Generate pretty-printed content with line mapping
            const prettyResult = this.convertJsonlToPrettyWithLineNumbers(this.rows);

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
                    prettyContent: prettyResult.content,
                    prettyLineMapping: prettyResult.lineMapping,
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
        const gazelleAnimationUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'gazelle-animation.gif')
        );

        return getHtmlTemplate(gazelleIconUri.toString(), gazelleAnimationUri.toString(), styles, scripts);
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
        utils.setNestedValue(obj, path, value);
    }

    private isStringifiedJson(value: any): boolean {
        return utils.isStringifiedJson(value);
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

    private async handleRequestColumnSuggestions(referenceColumn: string, webviewPanel: vscode.WebviewPanel) {
        try {
            // Get sample rows (up to 10 rows for context)
            const sampleRows = this.rows.slice(0, Math.min(10, this.rows.length));
            
            if (sampleRows.length === 0) {
                webviewPanel.webview.postMessage({
                    type: 'columnSuggestions',
                    suggestions: [],
                    error: 'No data available to analyze'
                });
                return;
            }

            // Get existing column names to avoid suggesting duplicates
            const existingColumns = this.columns.map(col => col.path);

            // Build prompt for OpenAI
            const sampleDataStr = JSON.stringify(sampleRows.slice(0, 5), null, 2); // Use first 5 for the prompt
            const existingColumnsStr = existingColumns.join(', ');

            const prompt = `Analyze the following JSON data and suggest 5-8 useful new columns that could be derived or computed from this data.

Existing columns: ${existingColumnsStr}

Sample data:
${sampleDataStr}

For each suggested column, provide:
1. A descriptive column name (snake_case or camelCase)
2. A detailed prompt template that can be used with template variables like {{row.fieldname}}, {{row.fieldname[0]}}, etc.

Template variable syntax:
- {{row}} - entire row as JSON
- {{row.fieldname}} - specific field value
- {{row.fieldname[0]}} - array element
- {{row_number}} - current row number (1-based)
- {{rows_before}} - number of rows before this one
- {{rows_after}} - number of rows after this one

Return a JSON array with this structure:
[
  {
    "columnName": "descriptive_column_name",
    "prompt": "Detailed prompt template using template variables. Example: Extract the sentiment of {{row.text}} and categorize it as positive, negative, or neutral."
  },
  ...
]

Focus on:
- Columns that would add value (categorization, extraction, transformation, analysis)
- Useful aggregations or computations
- Text analysis (sentiment, keywords, summaries)
- Data enrichment possibilities
- Quality indicators or validations

Do not suggest columns that already exist. Return ONLY valid JSON array, no markdown formatting, no explanations.`;

            // Call OpenAI with structured output
            const apiKey = await this.context.secrets.get('openaiApiKey');
            if (!apiKey) {
                webviewPanel.webview.postMessage({
                    type: 'columnSuggestions',
                    suggestions: [],
                    error: 'OpenAI API key not configured. Please set it in AI Settings.'
                });
                return;
            }

            const trimmedApiKey = apiKey.trim();
            const model = this.context.globalState.get<string>('openaiModel', 'gpt-4.1-mini');

            const requestBody: any = {
                model: model,
                messages: [
                    {
                        role: 'system',
                        content: 'You are a helpful assistant that analyzes data structures and suggests useful derived columns. Always return valid JSON arrays.'
                    },
                    {
                        role: 'user',
                        content: prompt
                    }
                ],
                temperature: 0.7,
                response_format: {
                    type: 'json_schema',
                    json_schema: {
                        name: 'column_suggestions',
                        strict: true,
                        schema: {
                            type: 'object',
                            properties: {
                                suggestions: {
                                    type: 'array',
                                    items: {
                                        type: 'object',
                                        properties: {
                                            columnName: {
                                                type: 'string',
                                                description: 'The suggested column name'
                                            },
                                            prompt: {
                                                type: 'string',
                                                description: 'The prompt template for generating this column'
                                            }
                                        },
                                        required: ['columnName', 'prompt'],
                                        additionalProperties: false
                                    }
                                }
                            },
                            required: ['suggestions'],
                            additionalProperties: false
                        }
                    }
                }
            };

            const response = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${trimmedApiKey}`
                },
                body: JSON.stringify(requestBody)
            });

            if (!response.ok) {
                const error = await response.text();
                webviewPanel.webview.postMessage({
                    type: 'columnSuggestions',
                    suggestions: [],
                    error: `OpenAI API error: ${response.status} - ${error.substring(0, 200)}`
                });
                return;
            }

            const data = await response.json();
            const content = data.choices[0].message.content.trim();

            try {
                const parsed = JSON.parse(content);
                // Extract suggestions array from the response object
                const suggestions = parsed.suggestions || (Array.isArray(parsed) ? parsed : []);
                
                // Validate and filter suggestions
                const validSuggestions = Array.isArray(suggestions) 
                    ? suggestions.filter(s => 
                        s && 
                        typeof s.columnName === 'string' && 
                        typeof s.prompt === 'string' &&
                        !existingColumns.includes(s.columnName)
                      ).slice(0, 8) // Limit to 8 suggestions
                    : [];

                webviewPanel.webview.postMessage({
                    type: 'columnSuggestions',
                    suggestions: validSuggestions,
                    error: null
                });
            } catch (parseError) {
                console.error('Error parsing suggestions:', parseError);
                webviewPanel.webview.postMessage({
                    type: 'columnSuggestions',
                    suggestions: [],
                    error: `Failed to parse AI response: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`
                });
            }

        } catch (error) {
            console.error('Error requesting column suggestions:', error);
            webviewPanel.webview.postMessage({
                type: 'columnSuggestions',
                suggestions: [],
                error: error instanceof Error ? error.message : 'Unknown error occurred'
            });
        }
    }

}
