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
                            case 'addColumn':
                                this.addColumn(message.columnPath);
                                this.updateWebview(webviewPanel);
                                break;
                            case 'removeColumn':
                                this.removeColumn(message.columnPath);
                                this.updateWebview(webviewPanel);
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
                                await this.handleUnstringifyColumn(message.columnPath, webviewPanel);
                                break;
                            case 'deleteRow':
                                await this.handleDeleteRow(message.rowIndex, webviewPanel, document);
                                break;
                            case 'insertRow':
                                await this.handleInsertRow(message.rowIndex, message.position, webviewPanel, document);
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
                        this.loadJsonlFile(document);
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
            this.columns = []; // Clear columns from previous file
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
                    
                    // Count paths for column detection
                    this.countPaths(obj, '', this.pathCounts);
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
        
        // Create a set of existing column paths to avoid duplicates
        const existingPaths = new Set(this.columns.map(col => col.path));
        
        for (const [path, count] of Object.entries(this.pathCounts)) {
            if (count >= threshold && !existingPaths.has(path)) {
                this.columns.push({
                    path,
                    displayName: this.getDisplayName(path),
                    visible: true,
                    isExpanded: false
                });
            }
        }
    }
    
    private addNewColumnsOnly() {
        const totalRows = this.rows.length;
        const threshold = Math.max(1, Math.floor(totalRows * 0.1)); // At least 10% of rows
        
        // Create a set of existing column paths to avoid duplicates
        const existingPaths = new Set(this.columns.map(col => col.path));
        
        for (const [path, count] of Object.entries(this.pathCounts)) {
            if (count >= threshold && !existingPaths.has(path)) {
                this.columns.push({
                    path,
                    displayName: this.getDisplayName(path),
                    visible: true,
                    isExpanded: false
                });
            }
        }
    }

    private countPaths(obj: any, prefix: string, counts: { [key: string]: number }) {
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


    private addColumn(columnPath: string) {
        if (!this.columns.find(col => col.path === columnPath)) {
            this.columns.push({
                path: columnPath,
                displayName: this.getDisplayName(columnPath),
                visible: true,
                isExpanded: false
            });
        }
    }

    private removeColumn(columnPath: string) {
        this.columns = this.columns.filter(col => col.path !== columnPath);
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
        const parts = path.split('.');
        let current = obj;
        
        for (const part of parts) {
            if (part.includes('[') && part.includes(']')) {
                const [key, indexStr] = part.split('[');
                const index = parseInt(indexStr.replace(']', ''));
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
        </div>
        
        <div class="table-container" id="tableContainer">
            <div class="indexing" id="indexingDiv">
                <img src="${gazelleIconUri}" class="indexing-icon" alt="Indexing...">
                <div>Indexing JSONL file...</div>
            </div>
            <!-- Table View Container -->
            <div class="view-container" id="tableViewContainer">
                <table id="dataTable" style="display: none;">
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
                    <div class="raw-content" id="rawContent"></div>
                </div>
            </div>
        </div>
    </div>
    
    <div class="context-menu" id="contextMenu">
        <div class="context-menu-item" data-action="add">Add Column</div>
        <div class="context-menu-item" data-action="remove">Remove Column</div>
        <div class="context-menu-item" data-action="unstringify" id="unstringifyMenuItem" style="display: none;">Unstringify JSON in Column</div>
    </div>

    <div class="row-context-menu" id="rowContextMenu">
        <div class="row-context-menu-item" data-action="insertAbove">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
            Insert Above
        </div>
        <div class="row-context-menu-item" data-action="insertBelow">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
            Insert Below
        </div>
        <div class="row-context-menu-separator"></div>
        <div class="row-context-menu-item" data-action="deleteRow" style="color: var(--vscode-errorForeground);">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
            Delete Row
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
        let scrollPositions = {
            table: 0,
            json: 0,
            raw: 0
        };
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
            
            // Update all cells in this column
            const columnIndex = Array.from(resizeData.th.parentNode.children).indexOf(resizeData.th);
            const table = document.getElementById('dataTable');
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
        
        // Event listeners
        document.getElementById('searchInput').addEventListener('input', handleSearch);
        document.getElementById('logo').addEventListener('click', () => {
            vscode.postMessage({
                type: 'openUrl',
                url: 'https://github.com/gaborcselle/jsonl-gazelle'
            });
        });
        
        // Context menu
        document.addEventListener('click', hideContextMenu);
        document.getElementById('contextMenu').addEventListener('click', handleContextMenu);
        document.getElementById('rowContextMenu').addEventListener('click', handleRowContextMenu);
        
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
            const action = event.target.dataset.action;
            if (!action || !contextMenuColumn) return;

            switch (action) {
                case 'add':
                    const newPath = prompt('Enter column path (e.g., user.name):');
                    if (newPath) {
                        vscode.postMessage({
                            type: 'addColumn',
                            columnPath: newPath
                        });
                    }
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
            menu.style.display = 'block';
            menu.style.left = event.pageX + 'px';
            menu.style.top = event.pageY + 'px';
        }

        function handleRowContextMenu(event) {
            const action = event.target.closest('.row-context-menu-item')?.dataset.action;
            if (!action || contextMenuRow === null) return;

            console.log('handleRowContextMenu - action:', action, 'rowIndex:', contextMenuRow, 'total rows:', currentData.allRows.length);

            switch (action) {
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
            if (!thead) return;

            thead.innerHTML = '';
            const headerRow = document.createElement('tr');

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
                headerRow.appendChild(th);
            });

            thead.appendChild(headerRow);
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

                jsonContent.addEventListener('click', function(e) {
                    e.stopPropagation();
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
            
            const parts = path.split('.');
            let current = obj;
            
            for (const part of parts) {
                if (!current || typeof current !== 'object') {
                    return undefined;
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
            
            // Show selected view container
            switch (viewType) {
                case 'table':
                    document.getElementById('tableViewContainer').style.display = 'block';
                    document.getElementById('dataTable').style.display = 'table';
                    // Hide loading state immediately for table view (already rendered)
                    logo.classList.remove('loading');
                    loadingState.style.display = 'none';
                    searchContainer.classList.remove('controls-hidden');
                    requestAnimationFrame(ensureTableViewportFilled);
                    break;
                case 'json':
                    document.getElementById('jsonViewContainer').style.display = 'block';
                    document.getElementById('jsonViewContainer').classList.add('isolated');
                    
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
                    // Use setTimeout to allow the loading animation to show before rendering
                    // Longer delay for larger datasets to ensure smooth animation
                    const rawDelay = currentData.rawContent && currentData.rawContent.length > 100000 ? 100 : 50;
                    setTimeout(() => {
                        updateRawView();
                        // Hide loading state after raw view is rendered
                        logo.classList.remove('loading');
                        loadingState.style.display = 'none';
                        searchContainer.classList.remove('controls-hidden');
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
        
        function updateRawView() {
            renderRawChunk(true);
            requestAnimationFrame(() => {
                ensureRawViewportFilled();
                restoreScrollPosition('raw');
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

    private async handleUnstringifyColumn(columnPath: string, webviewPanel: vscode.WebviewPanel) {
        try {
            // First, check if the column contains stringified JSON
            let hasStringifiedJson = false;
            const totalRows = this.rows.length;
            
            // Check a sample of rows to see if they contain stringified JSON
            const sampleSize = Math.min(100, totalRows);
            for (let i = 0; i < sampleSize; i++) {
                const value = this.getNestedValue(this.rows[i], columnPath);
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
                            const value = this.getNestedValue(row, columnPath);
                            
                            if (this.isStringifiedJson(value)) {
                                try {
                                    const parsedValue = JSON.parse(value as string);
                                    this.setNestedValue(row, columnPath, parsedValue);
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
                        const value = this.getNestedValue(row, columnPath);
                        
                        if (this.isStringifiedJson(value)) {
                            try {
                                const parsedValue = JSON.parse(value as string);
                                this.setNestedValue(row, columnPath, parsedValue);
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
