import * as vscode from 'vscode';
import * as path from 'path';
import { JsonRow, ParsedLine, ColumnInfo } from './jsonl/types';
import * as utils from './jsonl/utils';
import { filterRowsWithIndices } from './jsonl/rowMapping';
import { ColumnType, SortDirection, detectColumnType, sortRows, sortRowsWithIndices } from './jsonl/sorting';
import { getUnhideableColumns } from './jsonl/columns';
import { rebuildJsonlText } from './jsonl/documentText';
import { getHtmlTemplate } from './webview/template';
import { styles } from './webview/styles';
import { scripts } from './webview/scripts';
import { AIProvider, AI_PROVIDERS, AI_PROVIDER_IDS, isAIProvider, chatCompletion, fetchAvailableModels } from './aiProviders';

function getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let nonce = '';
    for (let i = 0; i < 32; i++) {
        nonce += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return nonce;
}

type ColumnPreferences = { order: string[]; visibility: { [path: string]: boolean }; updatedAt?: number };

// Everything the provider's fields hold about one open document, kept while
// another document's editor is the one being used
type DocumentState = {
    panel: vscode.WebviewPanel;
    rows: JsonRow[];
    filteredRows: JsonRow[];
    filteredRowIndices: number[];
    columns: ColumnInfo[];
    searchTerm: string;
    displaySort: { columnPath: string; direction: SortDirection } | null;
    parsedLines: ParsedLine[];
    rawContent: string;
    errorCount: number;
    totalLines: number;
    loadedLines: number;
    fileSizeBytes: number;
    pathCounts: { [key: string]: number };
    memoryOptimized: boolean;
    // False when it was saved mid-load: such a state is reloaded, not reused
    complete: boolean;
};

export class JsonlViewerProvider implements vscode.CustomTextEditorProvider {
    private static readonly viewType = 'jsonl-gazelle.jsonlViewer';
    // Messages that rewrite the document from this.rows. They wait for
    // background chunk loading to finish: before that, this.rows holds only
    // the start of the file
    private static readonly ROW_WRITE_MESSAGES = new Set([
        'removeColumn', 'updateCell', 'updateCells', 'documentChanged', 'prettyContentChanged', 'prettyContentSave',
        'unstringifyColumn', 'deleteRow', 'insertRow', 'duplicateRow', 'pasteRow', 'reorderColumns',
        'reorderRows', 'sortRows', 'addColumn', 'addAIColumn', 'generateAIRows'
    ]);
    private rows: JsonRow[] = [];
    private filteredRows: JsonRow[] = [];
    private filteredRowIndices: number[] = [];
    private columns: ColumnInfo[] = [];
    private searchTerm: string = '';
    // Display-only sort: reorders what the table shows without touching the file.
    // filteredRowIndices is permuted alongside filteredRows, so every edit path
    // keeps pointing at the right line.
    private displaySort: { columnPath: string; direction: SortDirection } | null = null;
    // Detected column types, recomputed when the row count changes
    private columnTypeCache: Map<string, ColumnType> = new Map();
    private columnTypeCacheRowCount: number = -1;
    private isIndexing: boolean = false;
    private parsedLines: ParsedLine[] = [];
    private rawContent: string = '';
    private errorCount: number = 0;

    // Chunked loading properties
    private readonly CHUNK_SIZE = 100; // Lines per chunk
    private readonly INITIAL_CHUNKS = 3; // Load first 3 chunks immediately

    // Maximum rows to keep in memory for very large files (user-configurable)
    private get MAX_MEMORY_ROWS(): number {
        return vscode.workspace.getConfiguration('jsonl-gazelle').get<number>('performance.maxMemoryRows', 50000);
    }

    // Only use chunked loading for files with more lines than this (user-configurable)
    private get CHUNKED_LOADING_THRESHOLD(): number {
        return vscode.workspace.getConfiguration('jsonl-gazelle').get<number>('performance.chunkedLoadingThreshold', 1000);
    }
    private loadingChunks: boolean = false;
    // Bumped whenever the parsed state is replaced (a reload, a raw or pretty
    // edit, switching documents). A background chunk load from an older parse
    // stops at its next yield instead of appending its lines to the new rows.
    private loadGeneration: number = 0;
    private backgroundLoad: Promise<void> | null = null;
    // Delta ('appendRows') bookkeeping for background chunk loading: how much of
    // rows/parsedLines the webview already has, and whether it holds this.rows
    // unfiltered (a prerequisite for sending append-only deltas)
    private lastSentRowCount: number = 0;
    private lastSentParsedLineCount: number = 0;
    private webviewRowsSynced: boolean = false;
    private totalLines: number = 0;
    private loadedLines: number = 0;
    private fileSizeBytes: number = 0;
    private pathCounts: { [key: string]: number } = {};
    private currentWebviewPanel: vscode.WebviewPanel | null = null;
    private memoryOptimized: boolean = false;
    // Set by Refresh: the next update tells the webview to drop editor edits
    private reloadedFromDisk: boolean = false;
    private isUpdating: boolean = false; // Flag to prevent recursive updates
    private pendingSaveTimeout: NodeJS.Timeout | null = null; // For debouncing saves
    private activeDocumentUri: string | null = null;
    private activeDocument: vscode.TextDocument | null = null;
    // Follow mode watchers, per document URI: each editor has its own toggle
    private followWatchers: Map<string, { watcher: vscode.FileSystemWatcher; debounce: NodeJS.Timeout | null }> = new Map();
    private pendingSaveDocument: vscode.TextDocument | null = null; // Target of the debounced cell save
    // One provider instance serves every open JSONL editor, but its fields hold
    // one document's rows. The others' are parked here and swapped back in by
    // activateDocument before any of their messages is handled.
    private documentStates: Map<string, DocumentState> = new Map();
    private activation: Promise<void> = Promise.resolve();
    private activeOperations: number = 0; // Messages being handled for the active document
    private idleWaiters: Array<() => void> = [];
    private manualColumnsPerFile: Map<string, ColumnInfo[]> = new Map(); // Store manual columns per file
    private columnPreferencesPerFile: Map<string, ColumnPreferences> = new Map();
    private ratingPromptCallback: (() => Promise<void>) | null = null; // Callback for rating prompt
    private readonly UI_PREFS_KEY = 'jsonl-gazelle.uiPreferences';
    private readonly COLUMN_PREFS_KEY = 'jsonl-gazelle.columnPreferences';
    private readonly MAX_COLUMN_PREF_ENTRIES = 100; // Cap stored per-file entries so global state doesn't grow unboundedly

    constructor(private readonly context: vscode.ExtensionContext) {}

    public static register(context: vscode.ExtensionContext): vscode.Disposable {
        const provider = new JsonlViewerProvider(context);
        const viewProvider = vscode.window.registerCustomEditorProvider(JsonlViewerProvider.viewType, provider);
        return viewProvider;
    }

    public setRatingPromptCallback(callback: () => Promise<void>): void {
        this.ratingPromptCallback = callback;
    }

    public async resolveCustomTextEditor(
        document: vscode.TextDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        const documentUri = document.uri.toString();
        try {
            // Follow mode is per editor session; the new webview's toggle starts off
            this.disposeFollowWatcher(documentUri);

            // Check and show rating prompt if needed
            if (this.ratingPromptCallback) {
                this.ratingPromptCallback().catch(err => {
                    console.error('Error showing rating prompt:', err);
                });
            }

            webviewPanel.webview.options = {
                enableScripts: true,
                enableCommandUris: true
            };

            webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);

            // Handle messages from the webview
            webviewPanel.webview.onDidReceiveMessage(
                async (message) => {
                    let counted = false;
                    try {
                        // Swap this editor's document in first - the fields may
                        // hold another open file's rows
                        while (this.activeDocumentUri !== documentUri) {
                            await this.activateDocument(document, webviewPanel);
                        }
                        this.currentWebviewPanel = webviewPanel;
                        this.activeOperations++;
                        counted = true;
                        if (JsonlViewerProvider.ROW_WRITE_MESSAGES.has(message.type)) {
                            await this.waitForBackgroundLoad();
                        }
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
                                await this.updateCells([{ rowIndex: message.rowIndex, columnPath: message.columnPath, value: message.value }], webviewPanel, document);
                                break;
                            case 'updateCells':
                                // Several cells at once (Replace All): one document edit, one update
                                await this.updateCells(Array.isArray(message.edits) ? message.edits : [], webviewPanel, document);
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
                            case 'prettyContentChanged':
                            case 'prettyContentSave':
                                if (message.partial) {
                                    // Built before the file finished loading, so it holds only
                                    // the first rows; merging it would delete the rest
                                    vscode.window.showWarningMessage('JSONL Gazelle: Pretty Print was opened before the file finished loading and shows only part of it, so the edit was not applied. Switch views and back to edit the whole file.');
                                    break;
                                }
                                if (message.type === 'prettyContentSave') {
                                    await this.handlePrettyContentSave(message.newContent, webviewPanel, document);
                                } else {
                                    await this.handlePrettyContentChange(message.newContent, webviewPanel, document);
                                }
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
                            case 'reorderRows':
                                await this.handleReorderRows(message.fromIndex, message.toIndex, webviewPanel, document);
                                break;
                            case 'setDisplaySort':
                                this.setDisplaySort(message.columnPath, message.direction, webviewPanel);
                                break;
                            case 'sortRows':
                                await this.handleSortRows(message.columnPath, message.direction, webviewPanel, document);
                                break;
                            case 'toggleColumnVisibility':
                                this.toggleColumnVisibility(message.columnPath, document);
                                this.updateWebview(webviewPanel);
                                break;
                            case 'showColumns':
                                this.showColumns(message.columnPaths, document);
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
                                vscode.window.showWarningMessage(`${AI_PROVIDERS[this.getActiveProvider()].label} API key is required for AI features. Please configure it in settings.`);
                                break;
                            case 'fetchModels':
                                await this.handleFetchModels(message.provider, message.apiKey, message.baseUrl, webviewPanel);
                                break;
                            case 'saveSettings':
                                await this.handleSaveSettings(message.settings, webviewPanel, message.openOriginalModal || false);
                                break;
                            case 'resetSettings':
                                await this.handleResetSettings(webviewPanel);
                                break;
                            case 'generateAIRows':
                                await this.handleGenerateAIRows(message.rowIndex, message.contextRowCount, message.rowCount, message.promptTemplate, webviewPanel, document);
                                break;
                            case 'requestColumnSuggestions':
                                await this.handleRequestColumnSuggestions(message.referenceColumn, webviewPanel);
                                break;
                            case 'refresh':
                                await this.handleRefresh(document);
                                break;
                            case 'requestFullUpdate':
                                // Webview detected it is out of sync with an appendRows delta
                                this.updateWebview(webviewPanel);
                                break;
                            case 'setFollowMode':
                                this.setFollowMode(!!message.enabled, document);
                                break;
                            case 'setViewPreference':
                                await this.updateViewPreference(message.viewType);
                                break;
                            case 'setWrapTextPreference':
                                await this.updateWrapTextPreference(message.enabled);
                                break;
                        }
                    } catch (error) {
                        console.error('Error handling webview message:', error);
                    } finally {
                        if (counted) {
                            this.endOperation();
                        }
                    }
                }
            );

            // Handle document changes
            const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument(e => {
                // A document whose state is parked is reloaded when its editor
                // is next activated (its saved text no longer matches)
                if (e.document.uri.toString() === documentUri && this.activeDocumentUri === documentUri) {
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

            // Coming back to this editor's tab brings its document's state back,
            // reloading it if the file changed while another editor was in use
            const viewStateSubscription = webviewPanel.onDidChangeViewState(e => {
                if (e.webviewPanel.active && this.activeDocumentUri !== documentUri) {
                    this.activateDocument(document, webviewPanel).catch(error => {
                        console.error('Error activating document:', error);
                    });
                }
            });

            // Store subscription for cleanup
            webviewPanel.onDidDispose(() => {
                changeDocumentSubscription.dispose();
                viewStateSubscription.dispose();
                this.disposeFollowWatcher(documentUri);
                if (this.documentStates.get(documentUri)?.panel === webviewPanel) {
                    this.documentStates.delete(documentUri);
                }

                if (this.activeDocumentUri === documentUri && this.currentWebviewPanel === webviewPanel) {
                    if (this.pendingSaveTimeout) {
                        clearTimeout(this.pendingSaveTimeout);
                        this.pendingSaveTimeout = null;
                        this.pendingSaveDocument = null;
                    }
                    this.loadGeneration++; // Nothing left to show a background load to
                    this.activeDocumentUri = null;
                    this.activeDocument = null;
                    this.currentWebviewPanel = null;
                }
            });

            // Load and parse the JSONL file, as a fresh session: no search, no sort
            await this.activateDocument(document, webviewPanel, true);

            // Always send an initial update to ensure webview gets data
            if (this.activeDocumentUri === documentUri) {
                this.updateWebview(webviewPanel);
            }
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

    public async refreshActiveEditor(): Promise<void> {
        if (this.activeDocument) {
            await this.handleRefresh(this.activeDocument);
        }
    }

    private async handleRefresh(document: vscode.TextDocument): Promise<void> {
        if (document.isClosed) {
            return;
        }

        // A debounced cell edit counts as an unsaved change, and must not land
        // after the revert
        await this.flushPendingCellSave();

        if (document.isDirty) {
            const choice = await vscode.window.showWarningMessage(
                'Refreshing will discard unsaved changes and reload the file from disk.',
                { modal: true },
                'Reload'
            );
            if (choice !== 'Reload') {
                return;
            }
        }

        try {
            // Suppress the onDidChangeTextDocument reload; we reload once, explicitly
            this.isUpdating = true;
            await vscode.commands.executeCommand('workbench.action.files.revert', document.uri);
        } catch (error) {
            console.error('Error reverting document from disk:', error);
        } finally {
            this.isUpdating = false;
        }

        this.reloadedFromDisk = true;
        await this.loadJsonlFile(document);
    }

    private setFollowMode(enabled: boolean, document: vscode.TextDocument): void {
        const documentUri = document.uri.toString();
        this.disposeFollowWatcher(documentUri);
        if (!enabled || document.uri.scheme !== 'file') {
            return;
        }

        const pattern = new vscode.RelativePattern(
            vscode.Uri.file(path.dirname(document.uri.fsPath)),
            path.basename(document.uri.fsPath)
        );
        const follow: { watcher: vscode.FileSystemWatcher; debounce: NodeJS.Timeout | null } = {
            watcher: vscode.workspace.createFileSystemWatcher(pattern),
            debounce: null
        };
        this.followWatchers.set(documentUri, follow);

        const onDiskChange = () => {
            if (follow.debounce) {
                clearTimeout(follow.debounce);
            }
            follow.debounce = setTimeout(async () => {
                follow.debounce = null;
                // Never revert while an internal edit is in flight or the user has unsaved changes
                if (this.isUpdating || document.isDirty || document.isClosed) {
                    return;
                }
                try {
                    // Reverting triggers onDidChangeTextDocument, which reloads and
                    // posts an update; the webview then scrolls to the bottom
                    await vscode.commands.executeCommand('workbench.action.files.revert', document.uri);
                } catch (error) {
                    console.error('Follow-mode reload failed:', error);
                }
            }, 300);
        };

        follow.watcher.onDidChange(onDiskChange);
        follow.watcher.onDidCreate(onDiskChange);
    }

    private disposeFollowWatcher(documentUri: string): void {
        const follow = this.followWatchers.get(documentUri);
        if (!follow) {
            return;
        }
        if (follow.debounce) {
            clearTimeout(follow.debounce);
        }
        follow.watcher.dispose();
        this.followWatchers.delete(documentUri);
    }

    /**
     * Make `document` the one whose rows, columns and search the provider's
     * fields hold, saving the previously active document's state first.
     *
     * A single provider instance serves every open JSONL editor, so this runs
     * before any message from an editor is handled. Without it, editing file A
     * after opening file B edited B's rows, and deleting a row in A wrote B's
     * rows into A. Switches are serialized, and wait for messages still being
     * handled for the outgoing document. `fresh` starts a new editor session:
     * reload, with no search or sort carried over.
     */
    private activateDocument(document: vscode.TextDocument, panel: vscode.WebviewPanel, fresh: boolean = false): Promise<void> {
        const documentUri = document.uri.toString();
        const run = async () => {
            if (this.activeDocumentUri === documentUri && !fresh) {
                return;
            }
            await this.waitForIdle();
            await this.saveActiveDocumentState();

            const saved = fresh ? undefined : this.documentStates.get(documentUri);
            this.documentStates.delete(documentUri);
            this.activeDocumentUri = documentUri;
            this.activeDocument = document;
            this.currentWebviewPanel = panel;

            if (saved && saved.complete && saved.rawContent === document.getText()) {
                this.restoreDocumentState(saved);
                return;
            }

            // Reload. Search and sort survive; columns are rebuilt from the
            // file (manually added ones and saved preferences are re-applied)
            this.searchTerm = saved ? saved.searchTerm : '';
            this.displaySort = saved ? saved.displaySort : null;
            this.columns = [];
            this.invalidateColumnTypes();
            await this.loadJsonlFile(document);
        };
        const next = this.activation.then(run, run);
        this.activation = next.catch(() => undefined);
        return next;
    }

    private async saveActiveDocumentState(): Promise<void> {
        const documentUri = this.activeDocumentUri;
        if (!documentUri || !this.activeDocument || !this.currentWebviewPanel) {
            return;
        }
        // A cell edit still waiting on its debounce belongs to this document
        await this.flushPendingCellSave();

        const manualColumns = this.columns.filter(col => col.isManuallyAdded);
        if (manualColumns.length > 0) {
            this.manualColumnsPerFile.set(documentUri, manualColumns);
        }
        this.documentStates.set(documentUri, {
            panel: this.currentWebviewPanel,
            rows: this.rows,
            filteredRows: this.filteredRows,
            filteredRowIndices: this.filteredRowIndices,
            columns: this.columns,
            searchTerm: this.searchTerm,
            displaySort: this.displaySort,
            parsedLines: this.parsedLines,
            rawContent: this.rawContent,
            errorCount: this.errorCount,
            totalLines: this.totalLines,
            loadedLines: this.loadedLines,
            fileSizeBytes: this.fileSizeBytes,
            pathCounts: this.pathCounts,
            memoryOptimized: this.memoryOptimized,
            complete: !this.isIndexing && !this.loadingChunks
        });

        // A background load of this document must stop touching the fields
        this.loadGeneration++;
        this.loadingChunks = false;
        this.backgroundLoad = null;
        this.isIndexing = false;
    }

    private restoreDocumentState(state: DocumentState): void {
        this.rows = state.rows;
        this.filteredRows = state.filteredRows;
        this.filteredRowIndices = state.filteredRowIndices;
        this.columns = state.columns;
        this.searchTerm = state.searchTerm;
        this.displaySort = state.displaySort;
        this.parsedLines = state.parsedLines;
        this.rawContent = state.rawContent;
        this.errorCount = state.errorCount;
        this.totalLines = state.totalLines;
        this.loadedLines = state.loadedLines;
        this.fileSizeBytes = state.fileSizeBytes;
        this.pathCounts = state.pathCounts;
        this.memoryOptimized = state.memoryOptimized;
        this.isIndexing = false;
        this.loadingChunks = false;
        this.invalidateColumnTypes();
        // Its webview still shows exactly this state, but no append deltas
        // can follow until a full update has been sent
        this.webviewRowsSynced = false;
    }

    private async waitForIdle(): Promise<void> {
        while (this.activeOperations > 0) {
            await new Promise<void>(resolve => this.idleWaiters.push(resolve));
        }
    }

    private endOperation(): void {
        this.activeOperations--;
        if (this.activeOperations === 0) {
            const waiters = this.idleWaiters;
            this.idleWaiters = [];
            waiters.forEach(resolve => resolve());
        }
    }

    private async loadJsonlFile(document: vscode.TextDocument) {
        const generation = ++this.loadGeneration;
        try {
            this.isIndexing = true;
            this.loadingChunks = false;
            this.backgroundLoad = null;
            const text = document.getText();
            this.rawContent = text;
            if (document.uri.scheme === 'file' && !document.isDirty) {
                try {
                    // O(1) filesystem stat for byte size
                    this.fileSizeBytes = (await vscode.workspace.fs.stat(document.uri)).size;
                } catch {
                    this.fileSizeBytes = Buffer.byteLength(text, 'utf8');
                }
            } else {
                // Unsaved edits (or a non-file scheme) make the on-disk size wrong
                this.fileSizeBytes = Buffer.byteLength(text, 'utf8');
            }
            if (generation !== this.loadGeneration) {
                return; // A newer load started while the file was being stat'ed
            }
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
            this.invalidateColumnTypes();
            this.lastSentRowCount = 0;
            this.lastSentParsedLineCount = 0;
            this.webviewRowsSynced = false;
            
            // Handle empty files
            if (this.totalLines === 0 || (this.totalLines === 1 && lines[0].trim() === '')) {
                this.isIndexing = false;
                this.filteredRows = [];
                this.filteredRowIndices = [];
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

            // Re-apply persisted column order and visibility for this file
            this.restoreColumnPreferences(fileUri);

            // Keeps sharing this.rows when no search is active; with one, the
            // reloaded rows must be filtered just like the old ones were
            this.filterRows();
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

        // Re-apply persisted column order and visibility for this file
        this.restoreColumnPreferences(fileUri);

        this.filterRows();
        this.isIndexing = false;
        // Mark background loading as active before the first update so the
        // progress banner shows from the start
        this.loadingChunks = this.loadedLines < this.totalLines;

        if (this.currentWebviewPanel) {
            this.updateWebview(this.currentWebviewPanel);
        }

        // Continue loading remaining chunks in background
        if (this.loadedLines < this.totalLines) {
            this.backgroundLoad = this.loadRemainingChunks(lines, generation);
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
    
    private async loadRemainingChunks(lines: string[], generation: number) {
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
                if (this.searchTerm || this.displaySort) {
                    // A search or display sort makes the webview's copy a
                    // permutation of this.rows, so append deltas don't apply
                    this.filterRows();
                    this.updateWebview(this.currentWebviewPanel);
                } else {
                    this.filteredRows = this.rows;
                    this.extendIdentityRowIndices();
                    if (this.webviewRowsSynced) {
                        // Send only the newly parsed rows - re-serializing the
                        // whole dataset on every progress update made loading
                        // time quadratic in file size
                        this.sendAppendedRows(this.currentWebviewPanel);
                    } else {
                        this.updateWebview(this.currentWebviewPanel);
                    }
                }
            }

            // Yield only every 1000 lines to maintain responsiveness
            if (startIndex % (this.CHUNK_SIZE * 10) === 0) {
                await new Promise(resolve => setTimeout(resolve, 10));
                if (generation !== this.loadGeneration) {
                    return; // Superseded: these lines belong to an older parse
                }
            }
        }

        this.loadingChunks = false;

        // Final update
        if (this.currentWebviewPanel) {
            if (this.displaySort || this.searchTerm) {
                // The last progress update filtered only what had loaded by then
                this.filterRows();
            } else {
                this.filteredRows = this.rows;
                this.extendIdentityRowIndices();
            }
            // appendCompatible: rows were only appended since the last update,
            // so the webview may keep its table DOM and scroll position
            this.updateWebview(this.currentWebviewPanel, { appendCompatible: true });
        }
    }

    private async waitForBackgroundLoad(): Promise<void> {
        while (this.loadingChunks && this.backgroundLoad) {
            const pending = this.backgroundLoad;
            await pending;
            if (this.backgroundLoad === pending) {
                break;
            }
        }
    }

    // During chunked loading (no search) the row mapping is the identity -
    // extend it in place instead of rebuilding the whole array on every update
    private extendIdentityRowIndices() {
        const indices = this.filteredRowIndices;
        const isIdentityPrefix = indices.length <= this.rows.length &&
            (indices.length === 0 || indices[indices.length - 1] === indices.length - 1);
        if (!isIdentityPrefix) {
            this.filteredRowIndices = this.rows.map((_, index) => index);
            return;
        }
        for (let i = indices.length; i < this.rows.length; i++) {
            indices.push(i);
        }
    }

    // Post only the rows/parsedLines added since the last webview update.
    // Only valid while the webview holds this.rows unfiltered (webviewRowsSynced)
    private sendAppendedRows(webviewPanel: vscode.WebviewPanel) {
        try {
            const message = {
                type: 'appendRows',
                data: {
                    baseRowCount: this.lastSentRowCount,
                    rows: this.rows.slice(this.lastSentRowCount),
                    parsedLines: this.parsedLines.slice(this.lastSentParsedLineCount),
                    columns: this.columns || [],
                    errorCount: this.errorCount,
                    loadingProgress: {
                        loadedLines: this.loadedLines,
                        totalLines: this.totalLines,
                        loadingChunks: this.loadingChunks,
                        progressPercent: this.totalLines > 0 ? Math.round((this.loadedLines / this.totalLines) * 100) : 100,
                        memoryOptimized: this.memoryOptimized,
                        displayedRows: this.rows.length,
                        fileSizeBytes: this.fileSizeBytes || 0
                    }
                }
            };
            this.lastSentRowCount = this.rows.length;
            this.lastSentParsedLineCount = this.parsedLines.length;
            Promise.resolve(webviewPanel.webview.postMessage(message)).then(delivered => {
                if (!delivered) {
                    // Message dropped (e.g. webview hidden) - the webview no longer
                    // matches this.rows, so fall back to full updates
                    this.webviewRowsSynced = false;
                }
            });
        } catch (error) {
            console.error('Error in sendAppendedRows:', error);
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
        const { filteredRows, filteredRowIndices } = filterRowsWithIndices(this.rows, this.searchTerm);
        this.filteredRows = filteredRows;
        this.filteredRowIndices = filteredRowIndices;
        this.applyDisplaySort();
    }

    // Permute the visible rows (and their file indices) by the active display
    // sort. No-op when nothing is sorted, so unsorted files keep sharing the
    // this.rows array and stay eligible for append-only webview updates.
    private applyDisplaySort() {
        if (!this.displaySort || this.filteredRows.length === 0) {
            return;
        }
        const { columnPath, direction } = this.displaySort;
        const { sortedRows, sortedIndices } = sortRowsWithIndices(
            this.filteredRows,
            this.filteredRowIndices,
            columnPath,
            direction,
            this.getColumnType(columnPath)
        );
        this.filteredRows = sortedRows;
        this.filteredRowIndices = sortedIndices;
    }

    // Detected types keyed by column path, for the visible columns only.
    // Skipped while rows are still arriving: the row count changes on every
    // progress update, which would invalidate the cache and re-sample every
    // visible column each time - real cost on the loading path, for a menu hint
    // that would be based on a partial file anyway. The final update fills it in.
    private getVisibleColumnTypes(): { [path: string]: ColumnType } {
        const types: { [path: string]: ColumnType } = {};
        if (this.isIndexing || this.loadingChunks || this.rows.length === 0) {
            return types;
        }
        (this.columns || []).forEach(column => {
            if (column.visible) {
                types[column.path] = this.getColumnType(column.path);
            }
        });
        return types;
    }

    private invalidateColumnTypes() {
        this.columnTypeCache.clear();
        this.columnTypeCacheRowCount = -1;
    }

    // Detected type for a column, cached until the row count changes
    private getColumnType(columnPath: string): ColumnType {
        if (this.columnTypeCacheRowCount !== this.rows.length) {
            this.columnTypeCache.clear();
            this.columnTypeCacheRowCount = this.rows.length;
        }
        const cached = this.columnTypeCache.get(columnPath);
        if (cached) {
            return cached;
        }
        const detected = detectColumnType(this.rows, columnPath);
        this.columnTypeCache.set(columnPath, detected);
        return detected;
    }


    private async removeColumn(columnPath: string, webviewPanel: vscode.WebviewPanel, document: vscode.TextDocument) {
        try {
            // Sorting by a column that no longer exists would be a no-op anyway
            if (this.displaySort && this.displaySort.columnPath === columnPath) {
                this.displaySort = null;
            }

            // Remove column from columns array
            this.columns = this.columns.filter(col => col.path !== columnPath);
            
            // Actually remove the field from all rows
            this.rows.forEach(row => {
                this.deleteNestedProperty(row, columnPath);
            });
            
            // Update filtered rows if search is active
            this.filterRows();

            // Rebuild the text from the document's own, so lines the edit didn't touch stay as they were
            this.composeDocumentText(document);
            
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
                // Check if column already exists (could be manually added)
                const existingColumn = this.columns.find(col => col.path === newPath);
                if (!existingColumn) {
                    // Only create new column if it doesn't exist
                    newColumns.push({
                        path: newPath,
                        displayName: `${columnPath}.${key}`,
                        visible: true,
                        isExpanded: false,
                        parentPath: columnPath
                    });
                } else if (existingColumn.isManuallyAdded) {
                    // If manually added column exists but doesn't have parentPath set, update it
                    if (!existingColumn.parentPath) {
                        existingColumn.parentPath = columnPath;
                    }
                    // Ensure manually added column is visible when parent is expanded
                    existingColumn.visible = true;
                }
            });
            
            // Also make visible any manually added child columns that were hidden
            this.columns.forEach(col => {
                if (col.parentPath === columnPath && col.isManuallyAdded) {
                    col.visible = true;
                }
            });
        }

        // Insert new columns right after the current column
        this.columns.splice(columnIndex + 1, 0, ...newColumns);
    }

    private collapseColumn(columnPath: string) {
        const column = this.columns.find(col => col.path === columnPath);
        if (!column) return;

        // Remember if parent was expanded before collapsing
        const wasExpanded = column.isExpanded;

        // Mark the parent column as collapsed and show it again
        column.isExpanded = false;
        column.visible = true;

        // Find all child columns (both auto-generated and manually added)
        const childColumns = this.columns.filter(col => col.parentPath === columnPath);
        
        // Hide all child columns when collapsing
        // If parent was expanded, this is normal collapse behavior
        // If parent was not expanded, this hides manually added columns that were visible
        childColumns.forEach(childCol => {
            childCol.visible = false;
        });
        
        // Remove only auto-generated child columns from the list
        // Manually added columns are kept but hidden, so they can reappear when parent is expanded again
        this.columns = this.columns.filter(col => {
            if (!col.parentPath || col.parentPath !== columnPath) {
                return true; // Keep columns that are not children of this column
            }
            // Keep manually added columns (they're hidden but preserved), remove auto-generated ones
            return col.isManuallyAdded === true;
        });
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

            // Persist the new column order for this file
            this.updateColumnPreferencesForDocument(document);
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

                // Rebuild the text from the document's own, so lines the edit didn't touch stay as they were
                this.composeDocumentText(document);
                
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

    private toggleColumnVisibility(columnPath: string, document?: vscode.TextDocument) {
        const column = this.columns.find(col => col.path === columnPath);
        if (!column) return;

        // Hiding the last visible column leaves a table of empty rows with no
        // column header to right-click. Easy to hit on files of bare JSON values,
        // which have a single "(value)" column and nothing else to fall back to.
        if (column.visible && this.columns.filter(col => col.visible).length === 1) {
            vscode.window.showWarningMessage('JSONL Gazelle: this is the only visible column, so it cannot be hidden.');
            return;
        }

        // Toggle the visibility
        column.visible = !column.visible;

        // Persist visibility preference for this file if document is provided
        if (document) {
            this.updateColumnPreferencesForDocument(document);
        }
    }

    /**
     * Make hidden columns visible again. `columnPaths` unhides exactly those columns;
     * omitting it unhides everything the user hid (see getUnhideableColumns).
     */
    private showColumns(columnPaths: string[] | undefined, document?: vscode.TextDocument) {
        const targets = Array.isArray(columnPaths)
            ? this.columns.filter(col => !col.visible && columnPaths.indexOf(col.path) !== -1)
            : getUnhideableColumns(this.columns);

        if (targets.length === 0) return;

        targets.forEach(col => { col.visible = true; });

        if (document) {
            this.updateColumnPreferencesForDocument(document);
        }
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

    private updateColumnPreferencesForDocument(document: vscode.TextDocument) {
        const fileUri = document.uri.toString();

        const order = this.columns.map(col => col.path);
        const visibility: { [path: string]: boolean } = {};

        this.columns.forEach(col => {
            visibility[col.path] = col.visible;
        });

        this.columnPreferencesPerFile.set(fileUri, { order, visibility });

        // Persist to global state so preferences survive reloads
        const existing = this.context.globalState.get<{ [uri: string]: ColumnPreferences }>(this.COLUMN_PREFS_KEY, {});

        existing[fileUri] = { order, visibility, updatedAt: Date.now() };

        // Keep only the most recently used entries
        let toStore: { [uri: string]: ColumnPreferences } = existing;
        const uris = Object.keys(existing);
        if (uris.length > this.MAX_COLUMN_PREF_ENTRIES) {
            toStore = {};
            uris
                .sort((a, b) => (existing[b].updatedAt || 0) - (existing[a].updatedAt || 0))
                .slice(0, this.MAX_COLUMN_PREF_ENTRIES)
                .forEach(uri => { toStore[uri] = existing[uri]; });
        }

        // Fire and forget; log if it fails
        const updatePromise = this.context.globalState.update(this.COLUMN_PREFS_KEY, toStore);

        updatePromise.then(undefined, (err: unknown) => {
            console.error('Error saving column preferences:', err);
        });
    }

    private restoreColumnPreferences(fileUri: string) {
        // Try in-memory cache first
        let prefs = this.columnPreferencesPerFile.get(fileUri);

        if (!prefs) {
            // Load from global state
            const allPrefs = this.context.globalState.get<{ [uri: string]: ColumnPreferences }>(this.COLUMN_PREFS_KEY, {});

            prefs = allPrefs[fileUri];

            if (prefs) {
                this.columnPreferencesPerFile.set(fileUri, prefs);
            }
        }

        if (!prefs) {
            return;
        }

        const { order, visibility } = prefs;

        // Reorder columns based on saved order, but keep only columns that still exist
        const columnMap = new Map<string, ColumnInfo>();

        this.columns.forEach(col => columnMap.set(col.path, col));

        const reordered: ColumnInfo[] = [];

        order.forEach(path => {
            const col = columnMap.get(path);

            if (col) {
                reordered.push(col);
                columnMap.delete(path);
            }
        });

        // Append any new columns that were not in saved order
        columnMap.forEach(col => reordered.push(col));

        this.columns = reordered;

        // Apply visibility preferences where available
        this.columns.forEach(col => {
            if (visibility.hasOwnProperty(col.path)) {
                col.visible = visibility[col.path];
            }
        });

        // Stored state that hides every column would open the file as a blank
        // table - rows numbered, no cells, nothing to right-click to recover.
        // Preferences persist per file, so it would come back on every load.
        // Ignore such a state rather than honouring it.
        if (this.columns.length > 0 && !this.columns.some(col => col.visible)) {
            this.columns.forEach(col => { col.visible = true; });
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

            // Rebuild the text from the document's own, so lines the edit didn't touch stay as they were
            this.composeDocumentText(document);

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

            // Determine if this is a nested column and find parent path
            const isNestedColumn = columnName.includes('.');
            let parentPath: string | undefined = undefined;
            
            if (isNestedColumn) {
                // Extract parent path (e.g., "user.id2" -> "user")
                const parts = columnName.split('.');
                parentPath = parts.slice(0, -1).join('.');
                
                // Check if parent column exists and is expanded
                const parentColumn = this.columns.find(col => col.path === parentPath);
                if (parentColumn && parentColumn.isExpanded) {
                    // Parent is expanded, so this nested column should be visible
                    // But we need to ensure parentPath is set correctly
                } else if (parentColumn && !parentColumn.isExpanded) {
                    // Parent exists but is not expanded - we should expand it or make column visible anyway
                    // For now, we'll make the nested column visible even if parent is not expanded
                    // This handles the case where user.id2 is added before user is expanded
                }
            }

            // Create new column with position info
            const newColumn: ColumnInfo = {
                path: columnName,
                displayName: columnName,
                visible: true,
                isExpanded: false,
                isManuallyAdded: true,
                insertPosition: position,
                insertReferenceColumn: referenceColumn,
                parentPath: parentPath
            };

            // Insert column at the right position
            const insertIndex = position === 'before' ? refColumnIndex : refColumnIndex + 1;
            this.columns.splice(insertIndex, 0, newColumn);

            // Add "generating" values to all rows for the new column (will be filled by AI)
            // Use setNestedValue for nested columns
            this.rows.forEach(row => {
                if (isNestedColumn) {
                    // Use setNestedValue for nested paths
                    this.setNestedValue(row, columnName, "generating");
                } else {
                    // For top-level columns, maintain order
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
                }
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

                    // Check if this is a nested column
                    const isNestedColumn = columnName.includes('.');
                    
                    if (isNestedColumn) {
                        // Use setNestedValue for nested paths (e.g., "user.id2")
                        this.setNestedValue(row, columnName, results[j]);
                    } else {
                        // For top-level columns, maintain column order when setting the value
                        const newRow: JsonRow = {};
                        for (const key of Object.keys(row)) {
                            newRow[key] = key === columnName ? results[j] : row[key];
                        }
                        Object.keys(row).forEach(key => delete row[key]);
                        Object.assign(row, newRow);
                    }
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

            // Rebuild the text from the document's own, so lines the edit didn't touch stay as they were
            this.composeDocumentText(document);

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

    private getActiveProvider(): AIProvider {
        const stored = this.context.globalState.get<string>('aiProvider', 'openai');
        return isAIProvider(stored) ? stored : 'openai';
    }

    private getLocalBaseUrl(): string {
        return this.context.globalState.get<string>('localBaseUrl', AI_PROVIDERS.local.defaultBaseUrl || '');
    }

    private async getProviderConfig(): Promise<{ provider: AIProvider; apiKey: string; model: string; baseUrl?: string }> {
        const provider = this.getActiveProvider();
        const meta = AI_PROVIDERS[provider];
        const apiKey = (await this.context.secrets.get(meta.keySecret) || '').trim();
        if (!apiKey && !meta.keyOptional) {
            throw new Error(`${meta.label} API key not configured. Please set it in AI Settings.`);
        }
        const model = this.context.globalState.get<string>(meta.modelStateKey, meta.defaultModel);
        if (!model) {
            throw new Error(`No ${meta.label} model selected. Please pick one in AI Settings.`);
        }
        const baseUrl = meta.needsBaseUrl ? this.getLocalBaseUrl() : undefined;
        return { provider, apiKey, model, baseUrl };
    }

    private async callLanguageModel(prompt: string, enumValues: string[] | null = null): Promise<string | number | boolean> {
        const { provider, apiKey, model, baseUrl } = await this.getProviderConfig();

        if (enumValues && enumValues.length > 0) {
            const buckets = this.getTypedEnumBuckets(enumValues);
            const valueSchema = this.buildEnumValueSchema(buckets);

            // Enhanced system prompt to maximize variety - use ALL enum values including extremes
            const system = `Analyze the input context and select a value from the allowed options. CRITICAL: You MUST use ALL available enum values with high variety - including extreme/minimum and extreme/maximum values. Do NOT always select middle values. Ensure a wide distribution across all possible enum values. Different rows should receive different enum values, even if they are similar.`;

            const schema = {
                type: 'object',
                properties: {
                    value: Object.assign({}, valueSchema, {
                        description: `Select exactly ONE value from the allowed options. IMPORTANT: Use maximum variety - include extreme values (minimum and maximum) frequently. Do not cluster around middle values.`
                    })
                },
                required: ['value'],
                additionalProperties: false
            };

            // Very high temperature (where the provider supports it) for enum
            // selections to maximize variety and use extreme values
            const content = (await chatCompletion(provider, apiKey, model, {
                system,
                prompt,
                schema,
                schemaName: 'enum_response',
                temperature: 1.8
            }, baseUrl)).trim();

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

        // For non-enum requests, add system prompt to ensure concise responses
        const content = (await chatCompletion(provider, apiKey, model, {
            system: `You are a data processing assistant. Respond with ONLY the requested value or result, without any explanations, prefixes, or additional text. Return only the raw data value (number, string, boolean, etc.) that should be stored in the column.`,
            prompt,
            temperature: 0.7
        }, baseUrl)).trim();

        // Use parseEnumValue to automatically convert string numbers/booleans to proper types
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

    private convertJsonlToPretty(rows: JsonRow[]): string {
        // The webview numbers the records itself, from the editor's current
        // text, so edits in Pretty Print can't leave the gutter stale
        return rows.map(row => JSON.stringify(row, null, 2)).join('\n');
    }

    private async handlePrettyContentChange(newContent: string, webviewPanel: vscode.WebviewPanel, document: vscode.TextDocument) {
        const text = this.prettyContentToDocumentText(newContent, document);
        if (text === null) {
            // Content is mid-edit and not valid JSON yet - wait until it
            // parses before touching the document to avoid losing rows
            return;
        }
        await this.updateRawContent(text, webviewPanel, document, false);
    }

    private async handlePrettyContentSave(newContent: string, webviewPanel: vscode.WebviewPanel, document: vscode.TextDocument) {
        const text = this.prettyContentToDocumentText(newContent, document);
        if (text === null) {
            vscode.window.showErrorMessage('Cannot save: content in Pretty Print view is not valid JSON');
            return;
        }
        await this.updateRawContent(text, webviewPanel, document, true);
    }

    // Pretty Print shows the rows and nothing else, so its text can't simply
    // replace the document - lines that don't parse would vanish, and every
    // row would be re-serialized. Its records are merged into the document's
    // text instead, the same way table edits are (see documentText.ts).
    private prettyContentToDocumentText(newContent: string, document: vscode.TextDocument): string | null {
        const jsonlContent = utils.convertPrettyToJsonl(newContent);
        if (jsonlContent === null) {
            return null;
        }
        const rows = jsonlContent === '' ? [] : jsonlContent.split('\n').map(line => JSON.parse(line));
        return rebuildJsonlText(document.getText(), rows).text;
    }

    private async handleGetSettings(webviewPanel: vscode.WebviewPanel) {
        try {
            const provider = this.getActiveProvider();
            const keys: { [key: string]: string } = {};
            const models: { [key: string]: string } = {};
            const availableModels: { [key: string]: string[] } = {};
            const cachedModels = this.context.globalState.get<{ [key: string]: string[] }>('aiAvailableModels', {});

            for (const id of AI_PROVIDER_IDS) {
                const meta = AI_PROVIDERS[id];
                keys[id] = await this.context.secrets.get(meta.keySecret) || '';
                models[id] = this.context.globalState.get<string>(meta.modelStateKey, meta.defaultModel);
                const cached = cachedModels[id];
                availableModels[id] = Array.isArray(cached) && cached.length > 0 ? cached : meta.fallbackModels;
            }

            webviewPanel.webview.postMessage({
                type: 'settingsLoaded',
                settings: {
                    provider,
                    keys,
                    models,
                    availableModels,
                    localBaseUrl: this.getLocalBaseUrl()
                }
            });
        } catch (error) {
            console.error('Error loading settings:', error);
        }
    }

    private async handleFetchModels(provider: any, apiKey: string | undefined, baseUrl: string | undefined, webviewPanel: vscode.WebviewPanel) {
        if (!isAIProvider(provider)) {
            return;
        }
        const meta = AI_PROVIDERS[provider];
        try {
            const key = (apiKey || await this.context.secrets.get(meta.keySecret) || '').trim();
            if (!key && !meta.keyOptional) {
                throw new Error(`Enter your ${meta.label} API key first.`);
            }
            const models = await fetchAvailableModels(provider, key, baseUrl !== undefined ? baseUrl : (meta.needsBaseUrl ? this.getLocalBaseUrl() : undefined));
            if (models.length === 0) {
                throw new Error(`No chat models found for ${meta.label}.`);
            }

            // Cache the fetched list so future sessions see it without refetching
            const cachedModels = this.context.globalState.get<{ [key: string]: string[] }>('aiAvailableModels', {});
            cachedModels[provider] = models;
            await this.context.globalState.update('aiAvailableModels', cachedModels);

            webviewPanel.webview.postMessage({
                type: 'modelsLoaded',
                provider,
                models,
                error: null
            });
        } catch (error) {
            webviewPanel.webview.postMessage({
                type: 'modelsLoaded',
                provider,
                models: null,
                error: error instanceof Error ? error.message : 'Unknown error'
            });
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
            // Check if the active provider's API key exists (key-optional
            // providers like local servers always count as configured)
            const meta = AI_PROVIDERS[this.getActiveProvider()];
            const apiKey = await this.context.secrets.get(meta.keySecret);
            const hasAPIKey = !!meta.keyOptional || !!(apiKey && apiKey.trim());

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

    private async handleSaveSettings(settings: { provider?: string; keys?: { [key: string]: string }; models?: { [key: string]: string }; localBaseUrl?: string }, webviewPanel: vscode.WebviewPanel, openOriginalModal: boolean) {
        try {
            if (isAIProvider(settings.provider)) {
                await this.context.globalState.update('aiProvider', settings.provider);
            }

            if (typeof settings.localBaseUrl === 'string') {
                const baseUrl = settings.localBaseUrl.trim().replace(/\/+$/, '');
                await this.context.globalState.update('localBaseUrl', baseUrl || AI_PROVIDERS.local.defaultBaseUrl);
            }

            for (const id of AI_PROVIDER_IDS) {
                const meta = AI_PROVIDERS[id];

                const model = settings.models?.[id];
                if (typeof model === 'string' && model) {
                    await this.context.globalState.update(meta.modelStateKey, model);
                }

                // Save or delete API key based on input
                const key = settings.keys?.[id];
                if (typeof key === 'string') {
                    const trimmed = key.trim();
                    if (trimmed) {
                        await this.context.secrets.store(meta.keySecret, trimmed);
                    } else {
                        // Empty input means delete stored key
                        await this.context.secrets.delete(meta.keySecret);
                    }
                }
            }

            vscode.window.showInformationMessage('AI settings saved successfully');

            // If the original modal should be reopened, check the active provider's key and notify webview
            if (openOriginalModal) {
                const activeMeta = AI_PROVIDERS[this.getActiveProvider()];
                const storedKey = await this.context.secrets.get(activeMeta.keySecret);
                if (activeMeta.keyOptional || (storedKey && storedKey.trim())) {
                    webviewPanel.webview.postMessage({
                        type: 'settingsSaved',
                        hasAPIKey: true
                    });
                }
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to save settings: ${error instanceof Error ? error.message : 'Unknown error'}`);
            console.error('Error saving settings:', error);
        }
    }

    private async handleResetSettings(webviewPanel: vscode.WebviewPanel) {
        try {
            await this.context.globalState.update('jsonl-gazelle.openCount', 0);
            await this.context.globalState.update('jsonl-gazelle.lastPromptedCount', 0);
            await this.context.globalState.update('jsonl-gazelle.hasRated', false);
            vscode.window.showInformationMessage('Settings reset successfully');
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to reset settings: ${error instanceof Error ? error.message : 'Unknown error'}`);
            console.error('Error resetting settings:', error);
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


                // Update filtered rows
                this.filterRows();

                // Rebuild the text from the document's own, so lines the edit didn't touch stay as they were
                this.composeDocumentText(document);

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

            // Skip the no-op edit when nothing changed, so view switches
            // and identical round-trips don't dirty the document
            if (newContent === document.getText()) {
                if (isSave) {
                    if (document.isDirty) {
                        await document.save();
                    }
                    vscode.window.showInformationMessage('File saved successfully');
                }
                return;
            }

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
                    // Format-on-save may have rewritten the text; parse what was actually saved
                    newContent = document.getText();
                    this.rawContent = newContent;
                }
                
                // Update internal data structures for both save and content changes
                // Parse the new content to update internal data without full reload
                const lines = newContent.split('\n');
                // This parse replaces every row; a background chunk load of
                // the old text must not keep appending to them
                this.loadGeneration++;
                this.loadingChunks = false;
                this.backgroundLoad = null;
                this.totalLines = lines.length;
                this.rows = [];
                this.parsedLines = [];
                this.pathCounts = {};
                this.errorCount = 0;
                this.processChunk(lines, 0);
                this.loadedLines = this.totalLines;
                this.invalidateColumnTypes();
                this.filterRows();

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
            if (rowIndex < 0 || rowIndex >= this.rows.length) {
                return;
            }

            this.isUpdating = true;

            // Update the row data
            this.rows[rowIndex] = newData;
            this.filterRows();
            this.composeDocumentText(document);

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
        } catch (error) {
            console.error('Error handling document change:', error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage('Failed to save changes: ' + errorMessage);
        } finally {
            setTimeout(() => {
                this.isUpdating = false;
            }, 100);
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


            // Update filtered rows if search is active
            this.filterRows();

            // Rebuild the text from the document's own, so lines the edit didn't touch stay as they were
            this.composeDocumentText(document);

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


            // Update filtered rows if search is active
            this.filterRows();

            // Rebuild the text from the document's own, so lines the edit didn't touch stay as they were
            this.composeDocumentText(document);

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

    private async handleReorderRows(fromIndex: number, toIndex: number, webviewPanel: vscode.WebviewPanel, document: vscode.TextDocument) {
        try {
            if (fromIndex < 0 || fromIndex >= this.rows.length || toIndex < 0 || toIndex >= this.rows.length) {
                vscode.window.showErrorMessage('Invalid row indices for reorder');
                return;
            }
            if (fromIndex === toIndex) return;

            this.isUpdating = true;

            const [movedRow] = this.rows.splice(fromIndex, 1);
            const insertIndex = fromIndex < toIndex ? toIndex - 1 : toIndex;
            this.rows.splice(insertIndex, 0, movedRow);


            this.filterRows();
            // Rebuild the text from the document's own, so lines the edit didn't touch stay as they were
            this.composeDocumentText(document);

            const edit = new vscode.WorkspaceEdit();
            edit.replace(
                document.uri,
                new vscode.Range(0, 0, document.lineCount, 0),
                this.rawContent
            );
            await vscode.workspace.applyEdit(edit);

            this.updateWebview(webviewPanel);
        } catch (error) {
            console.error('Error reordering rows:', error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage('Failed to reorder rows: ' + errorMessage);
        } finally {
            setTimeout(() => {
                this.isUpdating = false;
            }, 100);
        }
    }

    // Display-only sort: reorders the table, leaves the file untouched
    private setDisplaySort(columnPath: string | null, direction: SortDirection, webviewPanel: vscode.WebviewPanel) {
        if (!columnPath || (direction !== 'asc' && direction !== 'desc')) {
            this.displaySort = null;
        } else {
            this.displaySort = { columnPath, direction };
        }

        this.filterRows();
        this.updateWebview(webviewPanel);
    }

    // Permanent sort: rewrites the document so the file itself is ordered
    private async handleSortRows(columnPath: string, direction: SortDirection, webviewPanel: vscode.WebviewPanel, document: vscode.TextDocument) {
        try {
            if (!columnPath || (direction !== 'asc' && direction !== 'desc')) {
                return;
            }

            // Refuse and point at the display-only sort, which is always safe:
            // mid-load the rows aren't all there yet, and with unparseable
            // lines there is no sensible place for them among sorted rows.
            if (this.isIndexing || this.loadingChunks) {
                vscode.window.showWarningMessage(
                    'JSONL Gazelle: the file is still loading. Wait for it to finish, or use "Display Sorted" to sort the view only.'
                );
                return;
            }
            if (this.memoryOptimized) {
                vscode.window.showWarningMessage(
                    'JSONL Gazelle: this file is too large to sort in place (only part of it is held in memory). Use "Display Sorted" to sort the view only.'
                );
                return;
            }
            if (this.errorCount > 0) {
                vscode.window.showWarningMessage(
                    `JSONL Gazelle: this file has ${this.errorCount} line(s) that could not be parsed. Fix them first, or use "Display Sorted" to sort the view only.`
                );
                return;
            }
            if (this.rows.length < 2) {
                return;
            }

            this.isUpdating = true;

            this.rows = sortRows(this.rows, columnPath, direction, this.getColumnType(columnPath));


            // The file now carries the order itself; a display sort on top of it
            // would be redundant
            this.displaySort = null;
            this.filterRows();
            // Rebuild the text from the document's own, so lines the edit didn't touch stay as they were
            this.composeDocumentText(document);

            const edit = new vscode.WorkspaceEdit();
            edit.replace(
                document.uri,
                new vscode.Range(0, 0, document.lineCount, 0),
                this.rawContent
            );
            await vscode.workspace.applyEdit(edit);

            this.updateWebview(webviewPanel);
        } catch (error) {
            console.error('Error sorting rows:', error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage('Failed to sort rows: ' + errorMessage);
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


            // Update filtered rows if search is active
            this.filterRows();

            // Rebuild the text from the document's own, so lines the edit didn't touch stay as they were
            this.composeDocumentText(document);

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


            // Update filtered rows if search is active
            this.filterRows();

            // Rebuild the text from the document's own, so lines the edit didn't touch stay as they were
            this.composeDocumentText(document);

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

    /**
     * The document text for this.rows, built from the document's current text
     * rather than from the rows alone: lines that don't parse, blank lines, the
     * exact spelling of every row the edit didn't change, the line endings and
     * the trailing newline all come through as they were (see documentText.ts).
     * Brings rawContent, parsedLines and errorCount in line with the new text.
     */
    private composeDocumentText(document: vscode.TextDocument): string {
        const rebuilt = rebuildJsonlText(document.getText(), this.rows);
        this.parsedLines = rebuilt.lines.map((line, index) => {
            const parsedLine: ParsedLine = {
                data: line.rowIndex === null ? null : this.rows[line.rowIndex],
                lineNumber: index + 1,
                rawLine: line.text
            };
            if (line.error) {
                parsedLine.error = line.error;
            }
            return parsedLine;
        });
        this.errorCount = rebuilt.errorCount;
        this.rawContent = rebuilt.text;
        this.totalLines = rebuilt.lines.length;
        this.loadedLines = this.totalLines;
        return rebuilt.text;
    }

    private createEmptyRow(): JsonRow {
        // Return an empty object - user can fill in values as needed
        return {};
    }

    private updateWebview(webviewPanel: vscode.WebviewPanel, options?: { appendCompatible?: boolean }) {
        try {
            // Ensure data consistency before sending to webview
            if (!this.rows || !this.columns) {
                console.warn('updateWebview: rows or columns not initialized');
                return;
            }

            // Create a mapping of filtered rows to their actual indices
            const rowIndices = this.filteredRowIndices.length === this.filteredRows.length
                ? this.filteredRowIndices
                : this.filteredRows.map((_, index) => index);

            // Generate pretty-printed content with line mapping
            const prettyContent = this.convertJsonlToPretty(this.rows);

            // Load persisted UI preferences (view, wrap text)
            const uiPrefs = this.context.globalState.get<{ lastView?: 'table' | 'json' | 'raw'; wrapText?: boolean }>(this.UI_PREFS_KEY, {});

            const unfiltered = this.filteredRows === this.rows;

            webviewPanel.webview.postMessage({
                type: 'update',
                data: {
                    rows: this.filteredRows || [],
                    rowIndices: rowIndices, // Map filtered rows to actual indices
                    // Full array for index mapping; omitted when identical to
                    // rows (the webview falls back to rows) to halve the payload
                    allRows: unfiltered ? undefined : (this.rows || []),
                    // Rows were only appended since the last update, so the
                    // webview may keep its table DOM and scroll position
                    appendCompatible: options?.appendCompatible === true && unfiltered && this.webviewRowsSynced,
                    columns: this.columns || [],
                    // Active display-only sort, so the header can show its arrow
                    displaySort: this.displaySort,
                    // Detected type per visible column, for the sort menu hint
                    columnTypes: this.getVisibleColumnTypes(),
                    isIndexing: this.isIndexing,
                    searchTerm: this.searchTerm,
                    parsedLines: this.parsedLines || [],
                    rawContent: this.rawContent || '',
                    prettyContent: prettyContent,
                    errorCount: this.errorCount,
                    loadingProgress: {
                        loadedLines: this.loadedLines,
                        totalLines: this.totalLines,
                        loadingChunks: this.loadingChunks,
                        progressPercent: this.totalLines > 0 ? Math.round((this.loadedLines / this.totalLines) * 100) : 100,
                        memoryOptimized: this.memoryOptimized,
                        displayedRows: this.rows.length,
                        fileSizeBytes: this.fileSizeBytes || 0
                    },
                    uiPreferences: {
                        lastView: uiPrefs.lastView || 'table',
                        wrapText: uiPrefs.wrapText === true
                    },
                    reloadedFromDisk: this.reloadedFromDisk
                }
            });
            this.reloadedFromDisk = false;
            this.webviewRowsSynced = unfiltered;
            this.lastSentRowCount = (this.filteredRows || []).length;
            this.lastSentParsedLineCount = (this.parsedLines || []).length;
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

        return getHtmlTemplate(gazelleIconUri.toString(), gazelleAnimationUri.toString(), styles, scripts, webview.cspSource, getNonce());
    }

    private async updateViewPreference(viewType: 'table' | 'json' | 'raw'): Promise<void> {
        if (viewType !== 'table' && viewType !== 'json' && viewType !== 'raw') {
            return;
        }
        try {
            const existing = this.context.globalState.get<{ lastView?: 'table' | 'json' | 'raw'; wrapText?: boolean }>(this.UI_PREFS_KEY, {});
            existing.lastView = viewType;
            await this.context.globalState.update(this.UI_PREFS_KEY, existing);
        } catch (error) {
            console.error('Error saving view preference:', error);
        }
    }

    private async updateWrapTextPreference(enabled: boolean): Promise<void> {
        try {
            const existing = this.context.globalState.get<{ lastView?: 'table' | 'json' | 'raw'; wrapText?: boolean }>(this.UI_PREFS_KEY, {});
            existing.wrapText = enabled;
            await this.context.globalState.update(this.UI_PREFS_KEY, existing);
        } catch (error) {
            console.error('Error saving wrap text preference:', error);
        }
    }

    
    private applyCellEdit(rowIndex: number, columnPath: string, value: string): void {
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

        // Update the row in the main array. A bare value or array row
        // (the "(value)" column) is the cell itself, so the row is replaced
        const row = this.rows[rowIndex];
        const column = this.columns.find(col => col.path === columnPath);
        if (columnPath === '(value)' && (row === null || typeof row !== 'object' || Array.isArray(row))) {
            this.rows[rowIndex] = parsedValue;
        } else if (column && !column.parentPath && row !== null && typeof row === 'object' && !Array.isArray(row)) {
            // A column that didn't come from expanding another is a key of
            // the row itself, even when its name contains a dot ("user.name"):
            // a row that lacks it gets that key, not a nested object
            row[columnPath] = parsedValue;
        } else {
            this.setNestedValue(row, columnPath, parsedValue);
        }
    }

    private async updateCells(
        edits: Array<{ rowIndex: number; columnPath: string; value: string }>,
        webviewPanel: vscode.WebviewPanel,
        document: vscode.TextDocument
    ) {
        const validEdits = edits.filter(edit =>
            edit && Number.isInteger(edit.rowIndex) && edit.rowIndex >= 0 && edit.rowIndex < this.rows.length &&
            typeof edit.columnPath === 'string' && edit.columnPath !== '' && typeof edit.value === 'string');
        if (validEdits.length === 0) {
            console.error('updateCells: no valid edits', edits);
            return;
        }

        try {
            validEdits.forEach(edit => this.applyCellEdit(edit.rowIndex, edit.columnPath, edit.value));

            // Update filtered rows
            this.filterRows();

            // Rebuild the text from the document's own, so lines the edit didn't touch stay as they were
            this.composeDocumentText(document);

            // Debounce the save operation
            if (this.pendingSaveTimeout) {
                clearTimeout(this.pendingSaveTimeout);
            }
            this.pendingSaveDocument = document;
            this.pendingSaveTimeout = setTimeout(() => {
                this.flushPendingCellSave().catch(error => console.error('Error saving cell update:', error));
            }, 300); // Debounce for 300ms

            // Update the webview immediately to show the change
            this.updateWebview(webviewPanel);
        } catch (error) {
            console.error('Error updating cell:', error);
            vscode.window.showErrorMessage('Failed to update cell value');
        }
    }
    
    // Write the debounced cell edits now. Also run before another document's
    // state is swapped in, so a quick tab switch can't drop the last edit.
    private async flushPendingCellSave(): Promise<void> {
        if (!this.pendingSaveTimeout) {
            return;
        }
        clearTimeout(this.pendingSaveTimeout);
        this.pendingSaveTimeout = null;
        const document = this.pendingSaveDocument;
        this.pendingSaveDocument = null;
        if (!document || document.isClosed || this.activeDocumentUri !== document.uri.toString()) {
            return;
        }

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

            // Rebuild the text from the document's own, so lines the edit didn't touch stay as they were
            this.composeDocumentText(document);

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

            // Call the configured AI provider with structured output
            let providerConfig: { provider: AIProvider; apiKey: string; model: string; baseUrl?: string };
            try {
                providerConfig = await this.getProviderConfig();
            } catch (error) {
                webviewPanel.webview.postMessage({
                    type: 'columnSuggestions',
                    suggestions: [],
                    error: error instanceof Error ? error.message : 'AI provider not configured. Please set it in AI Settings.'
                });
                return;
            }

            const content = (await chatCompletion(providerConfig.provider, providerConfig.apiKey, providerConfig.model, {
                system: 'You are a helpful assistant that analyzes data structures and suggests useful derived columns. Always return valid JSON arrays.',
                prompt,
                temperature: 0.7,
                schemaName: 'column_suggestions',
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
            }, providerConfig.baseUrl)).trim();

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

    public openSettings(): void {
        if (this.currentWebviewPanel) {
            try {
                this.currentWebviewPanel.reveal();
                this.currentWebviewPanel.webview.postMessage({ type: 'openSettings' });
                return;
            } catch (error) {
                // Panel was disposed - fall through to the info message
            }
        }
        vscode.window.showInformationMessage('Open a JSONL file with JSONL Gazelle to access its settings.');
    }

    public async exportToCsv(uri?: vscode.Uri): Promise<void> {
        try {
            // Resolve which JSONL/NDJSON file to export
            let targetUri = uri;
            if (!targetUri && vscode.window.activeTextEditor && /\.(jsonl|ndjson)$/i.test(vscode.window.activeTextEditor.document.uri.fsPath)) {
                targetUri = vscode.window.activeTextEditor.document.uri;
            }
            if (!targetUri && this.activeDocumentUri) {
                targetUri = vscode.Uri.parse(this.activeDocumentUri);
            }
            if (!targetUri) {
                vscode.window.showErrorMessage('No JSONL file to export. Open a JSONL file first.');
                return;
            }

            // Parse the full file from the document so the export is complete
            // even while the viewer is still loading chunks or memory-optimized
            const document = await vscode.workspace.openTextDocument(targetUri);
            const rows: JsonRow[] = [];
            let skippedLines = 0;
            for (const line of document.getText().split('\n')) {
                const trimmed = line.trim();
                if (!trimmed) {
                    continue;
                }
                try {
                    rows.push(JSON.parse(trimmed));
                } catch (error) {
                    skippedLines++;
                }
            }

            if (rows.length === 0) {
                vscode.window.showWarningMessage('No valid JSON rows found to export.');
                return;
            }

            // Every key in the file, in order of first appearance
            const detectedColumns: ColumnInfo[] = [];
            const seenPaths = new Set<string>();
            for (const row of rows) {
                const counts: { [key: string]: number } = {};
                this.countPaths(row, '', counts);
                for (const path of Object.keys(counts)) {
                    if (!seenPaths.has(path)) {
                        seenPaths.add(path);
                        detectedColumns.push({ path, displayName: this.getDisplayName(path), visible: true });
                    }
                }
            }

            // Use the viewer's column configuration when this file is open in it
            // (its order, its hidden columns, its expanded children). The viewer
            // only makes columns of keys found in at least a tenth of the rows,
            // so keys it never offered are added after its columns rather than
            // silently left out of the export.
            const viewerColumns = targetUri.toString() === this.activeDocumentUri
                ? this.columns
                : this.documentStates.get(targetUri.toString())?.columns;
            let columns: ColumnInfo[];
            if (viewerColumns && viewerColumns.length > 0) {
                const viewerPaths = new Set(viewerColumns.map(col => col.path));
                columns = viewerColumns
                    .filter(col => col.visible)
                    .concat(detectedColumns.filter(col => !viewerPaths.has(col.path)));
            } else {
                columns = detectedColumns;
            }

            if (columns.length === 0) {
                vscode.window.showWarningMessage('No columns found to export.');
                return;
            }

            const saveUri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(targetUri.fsPath.replace(/\.(jsonl|ndjson)$/i, '') + '.csv'),
                filters: { 'CSV': ['csv'] },
                saveLabel: 'Export'
            });
            if (!saveUri) {
                return; // User cancelled
            }

            const csv = this.buildCsv(rows, columns);
            await vscode.workspace.fs.writeFile(saveUri, Buffer.from(csv, 'utf8'));

            const skippedNote = skippedLines > 0 ? ` (${skippedLines} unparseable line${skippedLines === 1 ? '' : 's'} skipped)` : '';
            const action = await vscode.window.showInformationMessage(
                `Exported ${rows.length} row${rows.length === 1 ? '' : 's'} to ${path.basename(saveUri.fsPath)}${skippedNote}`,
                'Open File'
            );
            if (action === 'Open File') {
                await vscode.window.showTextDocument(saveUri);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to export CSV: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    private buildCsv(rows: JsonRow[], columns: ColumnInfo[]): string {
        const header = columns.map(col => this.escapeCsvValue(col.displayName)).join(',');
        const lines = rows.map(row =>
            columns.map(col => this.escapeCsvValue(this.formatCsvValue(utils.getNestedValue(row, col.path)))).join(',')
        );
        return [header, ...lines].join('\r\n') + '\r\n';
    }

    private formatCsvValue(value: any): string {
        if (value === null || value === undefined) {
            return '';
        }
        if (typeof value === 'object') {
            return JSON.stringify(value);
        }
        return String(value);
    }

    private escapeCsvValue(value: string): string {
        if (/[",\r\n]/.test(value)) {
            return '"' + value.replace(/"/g, '""') + '"';
        }
        return value;
    }

}
