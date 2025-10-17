import * as vscode from 'vscode';
import * as path from 'path';
import axios from 'axios';

interface JsonRow {
    [key: string]: any;
    _aiResponse?: string;
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
    private useRegex: boolean = false;
    private replaceTerm: string = '';
    private useReplaceRegex: boolean = false;
    private isIndexing: boolean = false;
    private parsedLines: ParsedLine[] = [];
    private rawContent: string = '';
    private errorCount: number = 0;
    
    // Chunked loading properties
    private readonly CHUNK_SIZE = 100; // Lines per chunk
    private readonly INITIAL_CHUNKS = 3; // Load first 3 chunks immediately
    private readonly MAX_MEMORY_ROWS = 50000; // Maximum rows to keep in memory for very large files
    private loadingChunks: boolean = false;
    private totalLines: number = 0;
    private loadedLines: number = 0;
    private pathCounts: { [key: string]: number } = {};
    private currentWebviewPanel: vscode.WebviewPanel | null = null;
    private memoryOptimized: boolean = false;

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
        this.currentWebviewPanel = webviewPanel;
        webviewPanel.webview.options = {
            enableScripts: true,
        };

        webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);

        // Handle messages from the webview
        webviewPanel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.type) {
                    case 'search':
                        this.searchTerm = message.searchTerm;
                        this.useRegex = message.useRegex;
                        this.filterRows();
                        this.updateWebview(webviewPanel);
                        break;
                    case 'replace':
                        this.replaceTerm = message.replaceTerm;
                        this.useReplaceRegex = message.useReplaceRegex;
                        this.performReplace();
                        this.updateWebview(webviewPanel);
                        break;
                    case 'toggleColumn':
                        this.toggleColumnVisibility(message.columnPath);
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
                    case 'askAI':
                        await this.askAI(message.question, message.model);
                        this.updateWebview(webviewPanel);
                        break;
                    case 'exportCSV':
                        this.performCSVExport();
                        break;
                    case 'exportJSONL':
                        this.performJSONLExport();
                        break;
                    case 'getApiKey':
                        this.sendApiKey(webviewPanel);
                        break;
                    case 'saveApiKey':
                        this.saveApiKey(message.apiKey);
                        break;
                    case 'updateCell':
                        this.updateCell(message.rowIndex, message.columnPath, message.value);
                        this.updateWebview(webviewPanel);
                        break;
                    case 'expandColumn':
                        this.expandColumn(message.columnPath);
                        this.updateWebview(webviewPanel);
                        break;
                    case 'collapseColumn':
                        this.collapseColumn(message.columnPath);
                        this.updateWebview(webviewPanel);
                        break;
                }
            }
        );

        // Load and parse the JSONL file
        await this.loadJsonlFile(document);
        this.updateWebview(webviewPanel);
    }

    private async loadJsonlFile(document: vscode.TextDocument) {
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
        this.filteredRows = [...this.rows];
        this.isIndexing = false;
        
        if (this.currentWebviewPanel) {
            this.updateWebview(this.currentWebviewPanel);
        }
        
        // Continue loading remaining chunks in background
        if (this.loadedLines < this.totalLines) {
            this.loadRemainingChunks(lines);
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
                this.rows = this.rows.slice(-keepRows);
                this.parsedLines = this.parsedLines.slice(-keepRows);
                
                // Recalculate path counts for remaining rows
                this.pathCounts = {};
                this.rows.forEach(row => this.countPaths(row, '', this.pathCounts));
            }
            
            // Update columns progressively - only add new columns, don't re-expand
            this.addNewColumnsOnly();
            this.filteredRows = [...this.rows];
            
            // Update UI periodically (every 2 chunks to avoid too frequent updates)
            if ((startIndex / this.CHUNK_SIZE) % 2 === 0 && this.currentWebviewPanel) {
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
                // Only count paths that are either:
                // 1. Top-level fields (no prefix)
                // 2. Leaf values (not objects/arrays)
                // 3. Objects/arrays that are 2 levels deep (to show expandable columns)
                const isTopLevel = !prefix;
                const isLeaf = typeof value !== 'object' || Array.isArray(value);
                const isTwoLevelsDeep = prefix && prefix.split('.').length === 1;
                
                if (isTopLevel || isLeaf || isTwoLevelsDeep) {
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
            this.filteredRows = [...this.rows];
            return;
        }

        this.filteredRows = this.rows.filter(row => {
            const searchText = JSON.stringify(row).toLowerCase();
            const term = this.searchTerm.toLowerCase();
            
            if (this.useRegex) {
                try {
                    const regex = new RegExp(term, 'i');
                    return regex.test(searchText);
                } catch (error) {
                    return searchText.includes(term);
                }
            } else {
                return searchText.includes(term);
            }
        });
    }

    private performReplace() {
        if (!this.replaceTerm) return;

        let replaceCount = 0;
        this.filteredRows.forEach(row => {
            const jsonString = JSON.stringify(row);
            let newString: string;
            
            if (this.useReplaceRegex) {
                try {
                    const regex = new RegExp(this.searchTerm, 'gi');
                    newString = jsonString.replace(regex, this.replaceTerm);
                } catch (error) {
                    newString = jsonString.replace(new RegExp(this.searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), this.replaceTerm);
                }
            } else {
                newString = jsonString.replace(new RegExp(this.searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), this.replaceTerm);
            }
            
            if (newString !== jsonString) {
                try {
                    const newRow = JSON.parse(newString);
                    Object.assign(row, newRow);
                    replaceCount++;
                } catch (error) {
                    console.error('Error parsing replaced JSON:', error);
                }
            }
        });

        if (replaceCount > 0) {
            vscode.window.showInformationMessage(`Replaced ${replaceCount} occurrences`);
        }
    }

    private toggleColumnVisibility(columnPath: string) {
        const column = this.columns.find(col => col.path === columnPath);
        if (column) {
            column.visible = !column.visible;
        }
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

    private async askAI(question: string, model: string = 'gpt-4o-mini') {
        const config = vscode.workspace.getConfiguration('jsonl-gazelle');
        const apiKey = config.get<string>('openaiApiKey');
        
        if (!apiKey) {
            vscode.window.showErrorMessage('OpenAI API key not configured. Please set it in settings.');
            return;
        }

        try {
            for (const row of this.filteredRows) {
                let processedQuestion = question;
                
                // Replace field references like {{fieldname.subname[0]}}
                processedQuestion = processedQuestion.replace(/\{\{([^}]+)\}\}/g, (match, fieldPath) => {
                    const value = this.getNestedValue(row, fieldPath.trim());
                    return value !== undefined ? JSON.stringify(value) : match;
                });

                const response = await axios.post('https://api.openai.com/v1/chat/completions', {
                    model: model,
                    messages: [
                        {
                            role: 'user',
                            content: processedQuestion
                        }
                    ],
                    max_tokens: 500,
                    temperature: 0.7
                }, {
                    headers: {
                        'Authorization': `Bearer ${apiKey}`,
                        'Content-Type': 'application/json'
                    }
                });

                row._aiResponse = response.data.choices[0].message.content;
            }
        } catch (error) {
            vscode.window.showErrorMessage(`AI request failed: ${error}`);
        }
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

    private performCSVExport() {
        if (this.filteredRows.length === 0) {
            vscode.window.showInformationMessage('No data to export');
            return;
        }

        const csvContent = this.generateCSV();
        const fileName = `export_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.csv`;
        
        vscode.workspace.fs.writeFile(
            vscode.Uri.file(path.join(this.context.extensionPath, fileName)),
            Buffer.from(csvContent, 'utf8')
        ).then(() => {
            vscode.window.showInformationMessage(`CSV exported to ${fileName}`);
        });
    }
    
    private performJSONLExport() {
        if (this.filteredRows.length === 0) {
            vscode.window.showInformationMessage('No data to export');
            return;
        }

        const jsonlContent = this.filteredRows.map(row => JSON.stringify(row)).join('\n');
        const fileName = `export_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.jsonl`;
        
        vscode.workspace.fs.writeFile(
            vscode.Uri.file(path.join(this.context.extensionPath, fileName)),
            Buffer.from(jsonlContent, 'utf8')
        ).then(() => {
            vscode.window.showInformationMessage(`JSONL exported to ${fileName}`);
        });
    }

    private generateCSV(): string {
        const headers = ['AI Response', ...this.columns.filter(col => col.visible).map(col => col.displayName)];
        const rows = this.filteredRows.map(row => {
            const values = [
                row._aiResponse || '',
                ...this.columns.filter(col => col.visible).map(col => {
                    const value = this.getNestedValue(row, col.path);
                    return value !== undefined ? JSON.stringify(value) : '';
                })
            ];
            return values.map(val => `"${val.toString().replace(/"/g, '""')}"`).join(',');
        });

        return [headers.map(h => `"${h}"`).join(','), ...rows].join('\n');
    }

    private updateWebview(webviewPanel: vscode.WebviewPanel) {
        webviewPanel.webview.postMessage({
            type: 'update',
            data: {
                rows: this.filteredRows,
                columns: this.columns,
                isIndexing: this.isIndexing,
                searchTerm: this.searchTerm,
                useRegex: this.useRegex,
                parsedLines: this.parsedLines,
                rawContent: this.rawContent,
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
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            margin: 0;
            padding: 0;
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
            overflow: auto;
            height: calc(100vh - 60px);
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
        
        .settings-panel {
            position: absolute;
            top: 50px;
            right: 10px;
            background-color: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 5px;
            padding: 15px;
            box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
            z-index: 1000;
            display: none;
            min-width: 300px;
        }
        
        .settings-panel.expanded {
            display: block;
        }
        
        .settings-section {
            margin-bottom: 15px;
        }
        
        .settings-label {
            display: block;
            margin-bottom: 5px;
            font-weight: bold;
            color: var(--vscode-foreground);
        }
        
        .settings-input {
            width: 100%;
            padding: 8px;
            border: 1px solid var(--vscode-input-border);
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border-radius: 3px;
            box-sizing: border-box;
        }
        
        .settings-description {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            margin-top: 5px;
        }
        
        .ai-response-column {
            background-color: var(--vscode-textBlockQuote-background);
            border-left: 3px solid var(--vscode-textBlockQuote-border);
            font-style: italic;
            max-width: 300px;
            white-space: normal;
            word-wrap: break-word;
        }
        
        .ai-response-header {
            background-color: var(--vscode-textBlockQuote-background);
            color: var(--vscode-textBlockQuote-foreground);
            font-weight: bold;
        }
        
        .view-controls {
            display: flex;
            align-items: center;
            gap: 10px;
            margin-bottom: 10px;
            padding: 10px;
            background-color: var(--vscode-editor-background);
            border-bottom: 1px solid var(--vscode-panel-border);
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
            font-family: var(--vscode-editor-font-family);
            font-size: var(--vscode-editor-font-size);
            line-height: 1.4;
            overflow: auto;
            background-color: var(--vscode-editor-background);
            padding: 10px;
            height: calc(100vh - 120px);
        }
        
        .raw-content {
            white-space: pre-wrap;
            word-wrap: break-word;
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
            opacity: 0.7;
        }
        
        .expand-button {
            background: none;
            border: none;
            color: var(--vscode-button-foreground);
            cursor: pointer;
            font-size: 12px;
            padding: 2px 4px;
            margin-left: 5px;
            border-radius: 2px;
        }
        
        .expand-button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        
        .collapse-button {
            background: none;
            border: none;
            color: var(--vscode-button-foreground);
            cursor: pointer;
            font-size: 12px;
            padding: 2px 4px;
            margin: 0;
            border-radius: 2px;
        }
        
        .collapse-button:hover {
            background-color: var(--vscode-button-hoverBackground);
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
        }
        
        .json-line {
            display: flex;
            margin-bottom: 2px;
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
        
        .detail-view {
            display: none;
        }
        
        .detail-view.active {
            display: block;
        }
        
        .detail-navigation {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 10px;
            background-color: var(--vscode-editor-background);
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        
        .detail-content {
            padding: 20px;
        }
        
        .detail-row {
            display: flex;
            margin-bottom: 10px;
            align-items: center;
        }
        
        .detail-label {
            min-width: 200px;
            font-weight: bold;
            margin-right: 10px;
        }
        
        .detail-value {
            flex: 1;
            padding: 5px 10px;
            border: 1px solid var(--vscode-input-border);
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border-radius: 3px;
            cursor: pointer;
        }
        
        .detail-value:hover {
            background-color: var(--vscode-input-hoverBackground);
        }
        
        .detail-value.editing {
            cursor: text;
        }
    </style>
</head>
<body>
    <div class="header">
        <img src="${gazelleIconUri}" class="logo" alt="JSONL Gazelle" id="logo">
        <div class="loading-state" id="loadingState" style="display: none;">
            <div>Loading large file...</div>
            <div class="loading-progress" id="loadingProgress"></div>
        </div>
        <div class="search-container" id="searchContainer">
            <span class="search-icon">🔍</span>
            <input type="text" class="search-input" id="searchInput" placeholder="Search...">
            <div class="checkbox-container">
                <input type="checkbox" class="checkbox" id="regexCheckbox">
                <label for="regexCheckbox">Regex</label>
            </div>
        </div>
        
        <div class="replace-container" id="replaceContainer">
            <button class="replace-toggle" id="replaceToggle">Replace</button>
            <input type="text" class="replace-input" id="replaceInput" placeholder="Replace with...">
            <div class="checkbox-container replace-checkbox" style="display: none;">
                <input type="checkbox" class="checkbox" id="replaceRegexCheckbox">
                <label for="replaceRegexCheckbox">Regex</label>
            </div>
            <button class="button" id="replaceButton" style="display: none;">Replace</button>
        </div>
        
        <div class="ai-container" id="aiContainer">
            <input type="text" class="ai-input" id="aiInput" placeholder="Prompt to run against lines...">
            <button class="button" id="askAIButton">▶️ AI</button>
        </div>
        
        <button class="button settings-button" id="settingsButton" title="Settings">⚙️</button>
        <div class="export-container" id="exportContainer">
            <button class="button export-button" id="exportButton" title="Export">📤</button>
            <div class="export-dropdown" id="exportDropdown" style="display: none;">
                <div class="export-dropdown-item" data-action="csv">Export CSV</div>
                <div class="export-dropdown-item" data-action="jsonl">Export JSONL</div>
            </div>
        </div>
    </div>
    
    <div class="view-controls">
        <div class="segmented-control">
            <button class="active" data-view="table">📊 Table</button>
            <button data-view="detail">📋 Detail</button>
            <button data-view="json">📄 JSONL</button>
            <button data-view="raw">📝 Raw</button>
            <div class="error-count" id="errorCount" style="display: none;"></div>
        </div>
    </div>
    
    <div class="table-container" id="tableContainer">
        <div class="indexing" id="indexingDiv">
            <img src="${gazelleIconUri}" class="indexing-icon" alt="Indexing...">
            <div>Indexing JSONL file...</div>
        </div>
        <table id="dataTable" style="display: none;">
            <thead id="tableHead"></thead>
            <tbody id="tableBody"></tbody>
        </table>
        
        <div class="json-view" id="jsonView" style="display: none;"></div>
        
        <div class="detail-view" id="detailView">
            <div class="detail-navigation">
                <button class="button" id="prevDetailButton">← Previous</button>
                <span id="detailCounter">1 of 1</span>
                <button class="button" id="nextDetailButton">Next →</button>
            </div>
            <div class="detail-content" id="detailContent"></div>
        </div>
        
        <div class="raw-view" id="rawView" style="display: none;">
            <div class="raw-content" id="rawContent"></div>
        </div>
    </div>
    
    <div class="context-menu" id="contextMenu">
        <div class="context-menu-item" data-action="toggle">Toggle Column</div>
        <div class="context-menu-item" data-action="add">Add Column</div>
        <div class="context-menu-item" data-action="remove">Remove Column</div>
    </div>
    
    <div class="settings-panel" id="settingsPanel">
        <div class="settings-section">
            <label class="settings-label" for="openaiKeyInput">OpenAI API Key</label>
            <input type="password" class="settings-input" id="openaiKeyInput" placeholder="sk-...">
            <div class="settings-description">Your OpenAI API key for AI features. This is stored locally and not shared.</div>
        </div>
        <div class="settings-section">
            <label class="settings-label" for="modelSelect">AI Model</label>
            <select class="settings-input" id="modelSelect">
                <option value="gpt-4o-mini">GPT-4o Mini</option>
                <option value="gpt-4o">GPT-4o</option>
                <option value="gpt-4-turbo">GPT-4 Turbo</option>
                <option value="gpt-3.5-turbo">GPT-3.5 Turbo</option>
            </select>
            <div class="settings-description">Select the AI model to use for processing prompts.</div>
        </div>
        <div class="settings-section">
            <button class="button" id="saveSettingsButton">Save Settings</button>
            <button class="button" id="closeSettingsButton" style="margin-left: 10px;">Close</button>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        
        function escapeRegex(str) {
            return str.replace(/[\\x2E\\x2A\\x2B\\x3F\\x5E\\x24\\x7B\\x7D\\x28\\x29\\x7C\\x5B\\x5D\\x5C]/g, '\\\\$&');
        }
        
        let currentData = {
            rows: [],
            columns: [],
            isIndexing: true,
            searchTerm: '',
            useRegex: false,
            parsedLines: [],
            rawContent: '',
            errorCount: 0
        };
        
        let contextMenuColumn = null;
        let currentView = 'table';
        let currentDetailIndex = 0;
        let isResizing = false;
        let resizeData = null;
        
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
        document.getElementById('regexCheckbox').addEventListener('change', handleSearch);
        document.getElementById('replaceToggle').addEventListener('click', toggleReplace);
        document.getElementById('replaceButton').addEventListener('click', handleReplace);
        document.getElementById('askAIButton').addEventListener('click', handleAskAI);
        document.getElementById('settingsButton').addEventListener('click', toggleSettings);
        document.getElementById('saveSettingsButton').addEventListener('click', saveSettings);
        document.getElementById('closeSettingsButton').addEventListener('click', closeSettings);
        document.getElementById('exportButton').addEventListener('click', toggleExportDropdown);
        document.getElementById('exportDropdown').addEventListener('click', handleExportAction);
        
        // Context menu
        document.addEventListener('click', hideContextMenu);
        document.getElementById('contextMenu').addEventListener('click', handleContextMenu);
        
        function handleSearch() {
            const searchTerm = document.getElementById('searchInput').value;
            const useRegex = document.getElementById('regexCheckbox').checked;
            
            // Perform search in current view with highlighting
            if (currentView === 'table') {
                vscode.postMessage({
                    type: 'search',
                    searchTerm: searchTerm,
                    useRegex: useRegex
                });
                highlightTableResults(searchTerm, useRegex);
            } else if (currentView === 'json') {
                highlightJsonResults(searchTerm, useRegex);
            } else if (currentView === 'detail') {
                highlightDetailResults(searchTerm, useRegex);
            } else if (currentView === 'raw') {
                highlightRawResults(searchTerm, useRegex);
            }
        }
        
        function highlightTableResults(searchTerm, useRegex) {
            document.querySelectorAll('.table-highlight').forEach(el => {
                el.classList.remove('table-highlight');
            });
            
            if (!searchTerm) return;
            
            const cells = document.querySelectorAll('#dataTable td');
            cells.forEach(cell => {
                const text = cell.textContent;
                const matches = useRegex ? 
                    new RegExp(searchTerm, 'i').test(text) : 
                    text.toLowerCase().includes(searchTerm.toLowerCase());
                
                if (matches) {
                    cell.classList.add('table-highlight');
                }
            });
        }
        
        function highlightJsonResults(searchTerm, useRegex) {
            const jsonLines = document.querySelectorAll('.json-content');
            jsonLines.forEach(line => {
                const originalText = line.textContent;
                line.innerHTML = '';
                
                if (!searchTerm) {
                    line.textContent = originalText;
                    return;
                }
                
                try {
                    const regex = useRegex ? 
                        new RegExp('(' + searchTerm + ')', 'gi') : 
                        new RegExp('(' + escapeRegex(searchTerm) + ')', 'gi');
                    
                    const parts = originalText.split(regex);
                    parts.forEach((part, i) => {
                        if (i % 2 === 1) {
                            const highlight = document.createElement('span');
                            highlight.className = 'search-highlight';
                            highlight.textContent = part;
                            line.appendChild(highlight);
                        } else {
                            line.appendChild(document.createTextNode(part));
                        }
                    });
                } catch (e) {
                    line.textContent = originalText;
                }
            });
        }
        
        function highlightDetailResults(searchTerm, useRegex) {
            const detailValues = document.querySelectorAll('.detail-value');
            detailValues.forEach(value => {
                const originalText = value.textContent;
                value.innerHTML = '';
                
                if (!searchTerm) {
                    value.textContent = originalText;
                    return;
                }
                
                try {
                    const regex = useRegex ? 
                        new RegExp('(' + searchTerm + ')', 'gi') : 
                        new RegExp('(' + escapeRegex(searchTerm) + ')', 'gi');
                    
                    const parts = originalText.split(regex);
                    parts.forEach((part, i) => {
                        if (i % 2 === 1) {
                            const highlight = document.createElement('span');
                            highlight.className = 'search-highlight';
                            highlight.textContent = part;
                            value.appendChild(highlight);
                        } else {
                            value.appendChild(document.createTextNode(part));
                        }
                    });
                } catch (e) {
                    value.textContent = originalText;
                }
            });
        }
        
        function highlightRawResults(searchTerm, useRegex) {
            const rawLines = document.querySelectorAll('.raw-line-content');
            rawLines.forEach(line => {
                const originalText = line.textContent;
                line.innerHTML = '';
                
                if (!searchTerm) {
                    line.textContent = originalText;
                    return;
                }
                
                try {
                    const regex = useRegex ? 
                        new RegExp('(' + searchTerm + ')', 'gi') : 
                        new RegExp('(' + escapeRegex(searchTerm) + ')', 'gi');
                    
                    const parts = originalText.split(regex);
                    parts.forEach((part, i) => {
                        if (i % 2 === 1) {
                            const highlight = document.createElement('span');
                            highlight.className = 'search-highlight';
                            highlight.textContent = part;
                            line.appendChild(highlight);
                        } else {
                            line.appendChild(document.createTextNode(part));
                        }
                    });
                } catch (e) {
                    line.textContent = originalText;
                }
            });
        }
        
        function toggleReplace() {
            const replaceInput = document.getElementById('replaceInput');
            const replaceCheckbox = document.querySelector('.replace-checkbox');
            const replaceButton = document.getElementById('replaceButton');
            const replaceToggle = document.getElementById('replaceToggle');
            
            if (replaceInput.classList.contains('expanded')) {
                replaceInput.classList.remove('expanded');
                replaceCheckbox.style.display = 'none';
                replaceButton.style.display = 'none';
                replaceToggle.textContent = 'Replace';
            } else {
                replaceInput.classList.add('expanded');
                replaceCheckbox.style.display = 'flex';
                replaceButton.style.display = 'block';
                replaceToggle.textContent = 'Hide';
                replaceInput.focus();
            }
        }
        
        function handleReplace() {
            const searchTerm = document.getElementById('searchInput').value;
            const replaceTerm = document.getElementById('replaceInput').value;
            const useReplaceRegex = document.getElementById('replaceRegexCheckbox').checked;
            
            vscode.postMessage({
                type: 'replace',
                searchTerm: searchTerm,
                replaceTerm: replaceTerm,
                useReplaceRegex: useReplaceRegex
            });
        }
        
        function handleAskAI() {
            const question = document.getElementById('aiInput').value;
            const model = document.getElementById('modelSelect').value;
            
            if (!question.trim()) {
                alert('Please enter a question');
                return;
            }
            
            vscode.postMessage({
                type: 'askAI',
                question: question,
                model: model
            });
        }
        
        function toggleSettings() {
            const settingsPanel = document.getElementById('settingsPanel');
            if (settingsPanel.classList.contains('expanded')) {
                closeSettings();
            } else {
                openSettings();
            }
        }
        
        function openSettings() {
            const settingsPanel = document.getElementById('settingsPanel');
            settingsPanel.classList.add('expanded');
            
            // Load current API key
            vscode.postMessage({
                type: 'getApiKey'
            });
        }
        
        function closeSettings() {
            const settingsPanel = document.getElementById('settingsPanel');
            settingsPanel.classList.remove('expanded');
        }
        
        function saveSettings() {
            const apiKey = document.getElementById('openaiKeyInput').value;
            vscode.postMessage({
                type: 'saveApiKey',
                apiKey: apiKey
            });
            closeSettings();
        }
        
        function exportCSV() {
            vscode.postMessage({
                type: 'exportCSV'
            });
        }
        
        function toggleExportDropdown() {
            const dropdown = document.getElementById('exportDropdown');
            const isVisible = dropdown.style.display === 'block';
            dropdown.style.display = isVisible ? 'none' : 'block';
            
            // Hide on click outside
            if (!isVisible) {
                setTimeout(() => {
                    document.addEventListener('click', function hideExportDropdown() {
                        dropdown.style.display = 'none';
                        document.removeEventListener('click', hideExportDropdown);
                    });
                }, 0);
            }
        }
        
        function handleExportAction(event) {
            const action = event.target.dataset.action;
            if (!action) return;
            
            switch (action) {
                case 'csv':
                    vscode.postMessage({
                        type: 'exportCSV'
                    });
                    break;
                case 'jsonl':
                    vscode.postMessage({
                        type: 'exportJSONL'
                    });
                    break;
            }
            
            document.getElementById('exportDropdown').style.display = 'none';
        }
        
        function showContextMenu(event, columnPath) {
            event.preventDefault();
            contextMenuColumn = columnPath;
            
            const menu = document.getElementById('contextMenu');
            menu.style.display = 'block';
            menu.style.left = event.pageX + 'px';
            menu.style.top = event.pageY + 'px';
        }
        
        function hideContextMenu() {
            document.getElementById('contextMenu').style.display = 'none';
            contextMenuColumn = null;
        }
        
        function handleContextMenu(event) {
            const action = event.target.dataset.action;
            if (!action || !contextMenuColumn) return;
            
            switch (action) {
                case 'toggle':
                    vscode.postMessage({
                        type: 'toggleColumn',
                        columnPath: contextMenuColumn
                    });
                    break;
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
            }
            
            hideContextMenu();
        }
        
        function updateTable(data) {
            currentData = data;
            
            // Handle loading state in header
            const logo = document.getElementById('logo');
            const loadingState = document.getElementById('loadingState');
            const loadingProgress = document.getElementById('loadingProgress');
            const searchContainer = document.getElementById('searchContainer');
            const replaceContainer = document.getElementById('replaceContainer');
            const aiContainer = document.getElementById('aiContainer');
            const settingsButton = document.getElementById('settingsButton');
            const exportContainer = document.getElementById('exportContainer');
            
            if (data.isIndexing) {
                // Initial loading - show spinning logo and hide controls
                logo.classList.add('loading');
                loadingState.style.display = 'flex';
                searchContainer.classList.add('controls-hidden');
                replaceContainer.classList.add('controls-hidden');
                aiContainer.classList.add('controls-hidden');
                settingsButton.classList.add('controls-hidden');
                exportContainer.classList.add('controls-hidden');
                
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
                replaceContainer.classList.add('controls-hidden');
                aiContainer.classList.add('controls-hidden');
                settingsButton.classList.add('controls-hidden');
                exportContainer.classList.add('controls-hidden');
                
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
                replaceContainer.classList.remove('controls-hidden');
                aiContainer.classList.remove('controls-hidden');
                settingsButton.classList.remove('controls-hidden');
                exportContainer.classList.remove('controls-hidden');
                
                document.getElementById('indexingDiv').style.display = 'none';
                document.getElementById('dataTable').style.display = 'table';
            }
            
            // Update search inputs
            document.getElementById('searchInput').value = data.searchTerm;
            document.getElementById('regexCheckbox').checked = data.useRegex;
            
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
            
            // Build table
            const thead = document.getElementById('tableHead');
            const tbody = document.getElementById('tableBody');
            
            // Clear existing content
            thead.innerHTML = '';
            tbody.innerHTML = '';
            
            // Create header
            const headerRow = document.createElement('tr');
            
            // AI Response column - only show if there are AI responses
            const hasAiResponses = data.rows.some(row => row._aiResponse && row._aiResponse.trim() !== '');
            if (hasAiResponses) {
                const aiHeader = document.createElement('th');
                aiHeader.textContent = 'AI Response';
                aiHeader.className = 'ai-response-header';
                
                // Add resize handle for AI Response column
                const aiResizeHandle = document.createElement('div');
                aiResizeHandle.className = 'resize-handle';
                aiResizeHandle.addEventListener('mousedown', (e) => startResize(e, aiHeader, '_aiResponse'));
                aiHeader.appendChild(aiResizeHandle);
                
                aiHeader.addEventListener('contextmenu', (e) => showContextMenu(e, '_aiResponse'));
                headerRow.appendChild(aiHeader);
            }
            
            // Data columns
            data.columns.forEach(column => {
                if (column.visible) {
                    const th = document.createElement('th');
                    
                    // Add collapse button for subcolumns (columns with parentPath)
                    if (column.parentPath) {
                        const collapseButton = document.createElement('button');
                        collapseButton.className = 'collapse-button';
                        collapseButton.textContent = '▶';
                        collapseButton.title = 'Collapse';
                        collapseButton.addEventListener('click', (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            vscode.postMessage({
                                type: 'collapseColumn',
                                columnPath: column.parentPath
                            });
                        });
                        th.appendChild(collapseButton);
                        th.appendChild(document.createTextNode(column.displayName));
                        
                        // Check if this subcolumn can be further expanded
                        const value = getSampleValue(data.rows, column.path);
                        if (typeof value === 'object' && value !== null && !column.isExpanded) {
                            const expandButton = document.createElement('button');
                            expandButton.className = 'expand-button';
                            expandButton.textContent = '▼';
                            expandButton.title = 'Expand';
                            expandButton.addEventListener('click', (e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                vscode.postMessage({
                                    type: 'expandColumn',
                                    columnPath: column.path
                                });
                            });
                            th.appendChild(expandButton);
                        }
                        
                        th.classList.add('subcolumn-header');
                    } else {
                        th.textContent = column.displayName;
                        // Add expand button for parent columns (objects and arrays)
                        const value = getSampleValue(data.rows, column.path);
                        if (typeof value === 'object' && value !== null) {
                            const button = document.createElement('button');
                            button.className = 'expand-button';
                            button.textContent = '▼';
                            button.title = 'Expand';
                            button.addEventListener('click', (e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                vscode.postMessage({
                                    type: 'expandColumn',
                                    columnPath: column.path
                                });
                            });
                            th.appendChild(button);
                        }
                    }
                    
                    // Add resize handle
                    const resizeHandle = document.createElement('div');
                    resizeHandle.className = 'resize-handle';
                    resizeHandle.addEventListener('mousedown', (e) => startResize(e, th, column.path));
                    th.appendChild(resizeHandle);
                    
                    th.addEventListener('contextmenu', (e) => showContextMenu(e, column.path));
                    headerRow.appendChild(th);
                }
            });
            
            thead.appendChild(headerRow);
            
            // Create rows
            data.rows.forEach((row, rowIndex) => {
                const tr = document.createElement('tr');
                
                // AI Response cell - only show if there are AI responses
                if (hasAiResponses) {
                    const aiCell = document.createElement('td');
                    aiCell.textContent = row._aiResponse || '';
                    aiCell.title = aiCell.textContent;
                    aiCell.className = 'ai-response-column';
                    aiCell.addEventListener('dblclick', (e) => editCell(e, aiCell, rowIndex, '_aiResponse'));
                    tr.appendChild(aiCell);
                }
                
                // Data cells
                data.columns.forEach(column => {
                    if (column.visible) {
                        const td = document.createElement('td');
                        const value = getNestedValue(row, column.path);
                        const valueStr = value !== undefined ? JSON.stringify(value) : '';
                        
                        // Add styling for expanded columns
                        if (column.isExpanded) {
                            td.classList.add('expanded-column');
                        }
                        
                        // Add expand functionality for objects and arrays (only if not expanded)
                        if (typeof value === 'object' && value !== null && !column.isExpanded) {
                            td.classList.add('expandable-cell');
                            td.textContent = valueStr;
                            const expandIcon = document.createElement('span');
                            expandIcon.className = 'expand-icon';
                            expandIcon.textContent = ' ▼';
                            td.appendChild(expandIcon);
                            td.title = valueStr;
                            td.addEventListener('click', (e) => expandCell(e, td, rowIndex, column.path));
                        } else {
                            td.textContent = valueStr;
                            td.title = valueStr;
                            td.addEventListener('dblclick', (e) => editCell(e, td, rowIndex, column.path));
                        }
                        
                        tr.appendChild(td);
                    }
                });
                
                tbody.appendChild(tr);
            });
        }
        
        function getNestedValue(obj, path) {
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
                case 'apiKeyLoaded':
                    document.getElementById('openaiKeyInput').value = message.apiKey;
                    break;
            }
        });
        
        // View control functions
        function switchView(viewType) {
            currentView = viewType;
            
            // Update segmented control
            document.querySelectorAll('.segmented-control button').forEach(button => {
                button.classList.toggle('active', button.dataset.view === viewType);
            });
            
            // Hide all views
            document.getElementById('dataTable').style.display = 'none';
            document.getElementById('jsonView').style.display = 'none';
            document.getElementById('detailView').style.display = 'none';
            document.getElementById('rawView').style.display = 'none';
            
            // Show selected view
            switch (viewType) {
                case 'table':
                    document.getElementById('dataTable').style.display = 'table';
                    break;
                case 'json':
                    document.getElementById('jsonView').style.display = 'block';
                    updateJsonView();
                    break;
                case 'detail':
                    document.getElementById('detailView').style.display = 'block';
                    updateDetailView();
                    break;
                case 'raw':
                    document.getElementById('rawView').style.display = 'block';
                    updateRawView();
                    break;
            }
        }
        
        function updateJsonView() {
            const jsonView = document.getElementById('jsonView');
            jsonView.innerHTML = '';
            
            currentData.rows.forEach((row, index) => {
                const lineDiv = document.createElement('div');
                lineDiv.className = 'json-line';
                
                const lineNumber = document.createElement('div');
                lineNumber.className = 'line-number';
                lineNumber.textContent = (index + 1).toString().padStart(4, ' ');
                
                const jsonContent = document.createElement('div');
                jsonContent.className = 'json-content';
                jsonContent.textContent = JSON.stringify(row, null, 2);
                
                lineDiv.appendChild(lineNumber);
                lineDiv.appendChild(jsonContent);
                jsonView.appendChild(lineDiv);
            });
        }
        
        function updateRawView() {
            const rawView = document.getElementById('rawContent');
            rawView.innerHTML = '';
            
            // Filter out empty lines and only show lines with content or errors
            const filteredLines = currentData.parsedLines.filter(line => 
                line.rawLine.trim() !== '' || line.error
            );
            
            filteredLines.forEach((line) => {
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
                lineContent.textContent = line.rawLine;
                
                lineDiv.appendChild(lineNumber);
                lineDiv.appendChild(lineContent);
                rawView.appendChild(lineDiv);
            });
        }
        
        function updateDetailView() {
            if (currentData.rows.length === 0) return;
            
            const currentRow = currentData.rows[currentDetailIndex];
            const detailContent = document.getElementById('detailContent');
            const detailCounter = document.getElementById('detailCounter');
            
            detailCounter.textContent = (currentDetailIndex + 1) + ' of ' + currentData.rows.length;
            
            // Clear existing content
            detailContent.innerHTML = '';
            
            // Add AI Response if exists
            if (currentRow._aiResponse) {
                const aiRow = document.createElement('div');
                aiRow.className = 'detail-row';
                const aiLabel = document.createElement('div');
                aiLabel.className = 'detail-label';
                aiLabel.textContent = 'AI Response';
                const aiValue = document.createElement('div');
                aiValue.className = 'detail-value';
                aiValue.dataset.path = '_aiResponse';
                aiValue.textContent = currentRow._aiResponse;
                aiRow.appendChild(aiLabel);
                aiRow.appendChild(aiValue);
                detailContent.appendChild(aiRow);
            }
            
            // Add all other fields
            Object.keys(currentRow).forEach(key => {
                if (key === '_aiResponse') return;
                
                const value = currentRow[key];
                const valueStr = typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
                
                const row = document.createElement('div');
                row.className = 'detail-row';
                const label = document.createElement('div');
                label.className = 'detail-label';
                label.textContent = key;
                const valueDiv = document.createElement('div');
                valueDiv.className = 'detail-value';
                valueDiv.dataset.path = key;
                valueDiv.textContent = valueStr;
                row.appendChild(label);
                row.appendChild(valueDiv);
                detailContent.appendChild(row);
            });
            
            // Add event listeners for editing
            detailContent.querySelectorAll('.detail-value').forEach(element => {
                element.addEventListener('dblclick', (e) => editDetailValue(e.target));
            });
        }
        
        function navigateDetail(direction) {
            const newIndex = currentDetailIndex + direction;
            if (newIndex >= 0 && newIndex < currentData.rows.length) {
                currentDetailIndex = newIndex;
                updateDetailView();
            }
        }
        
        function editDetailValue(element) {
            const originalValue = element.textContent;
            const path = element.dataset.path;
            
            const input = document.createElement('input');
            input.value = originalValue;
            input.style.width = '100%';
            input.style.border = 'none';
            input.style.outline = 'none';
            input.style.backgroundColor = 'var(--vscode-input-background)';
            input.style.color = 'var(--vscode-input-foreground)';
            input.style.padding = '5px 10px';
            input.style.fontSize = 'inherit';
            input.style.fontFamily = 'inherit';
            input.style.boxSizing = 'border-box';
            
            element.innerHTML = '';
            element.appendChild(input);
            element.classList.add('editing');
            
            input.focus();
            input.select();
            
            function saveEdit() {
                const newValue = input.value;
                element.classList.remove('editing');
                element.textContent = newValue;
                
                // Update the data
                const currentRow = currentData.rows[currentDetailIndex];
                try {
                    let parsedValue = newValue;
                    if (newValue.trim() !== '') {
                        try {
                            parsedValue = JSON.parse(newValue);
                        } catch {
                            parsedValue = newValue;
                        }
                    } else {
                        parsedValue = null;
                    }
                    currentRow[path] = parsedValue;
                    
                    // Send update message
                    vscode.postMessage({
                        type: 'updateCell',
                        rowIndex: currentDetailIndex,
                        columnPath: path,
                        value: newValue
                    });
                } catch (error) {
                    console.error('Error updating detail value:', error);
                }
            }
            
            function cancelEdit() {
                element.classList.remove('editing');
                element.textContent = originalValue;
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
        
        function expandCell(event, td, rowIndex, columnPath) {
            event.preventDefault();
            event.stopPropagation();
            
            const value = getNestedValue(currentData.rows[rowIndex], columnPath);
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
        
        // Add event listeners for detail navigation
        document.getElementById('prevDetailButton').addEventListener('click', () => navigateDetail(-1));
        document.getElementById('nextDetailButton').addEventListener('click', () => navigateDetail(1));
    </script>
</body>
</html>`;
    }

    private sendApiKey(webviewPanel: vscode.WebviewPanel) {
        const config = vscode.workspace.getConfiguration('jsonl-gazelle');
        const apiKey = config.get<string>('openaiApiKey') || '';
        
        webviewPanel.webview.postMessage({
            type: 'apiKeyLoaded',
            apiKey: apiKey
        });
    }
    
    private saveApiKey(apiKey: string) {
        const config = vscode.workspace.getConfiguration('jsonl-gazelle');
        config.update('openaiApiKey', apiKey, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage('OpenAI API key saved successfully');
    }
    
    private updateCell(rowIndex: number, columnPath: string, value: string) {
        if (rowIndex >= 0 && rowIndex < this.filteredRows.length) {
            const row = this.filteredRows[rowIndex];
            
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
                
                this.setNestedValue(row, columnPath, parsedValue);
                
                // Also update the original row in the main array
                const originalIndex = this.rows.findIndex(r => r === row);
                if (originalIndex >= 0) {
                    this.setNestedValue(this.rows[originalIndex], columnPath, parsedValue);
                }
            } catch (error) {
                console.error('Error updating cell:', error);
                vscode.window.showErrorMessage('Failed to update cell value');
            }
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

    public openSettings() {
        vscode.commands.executeCommand('workbench.action.openSettings', 'jsonl-gazelle');
    }
}
