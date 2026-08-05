/**
 * Webview HTML template
 */

export function getHtmlTemplate(gazelleIconUri: string, gazelleAnimationUri: string, styles: string, scripts: string, cspSource: string, nonce: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; script-src 'nonce-${nonce}' https://cdn.jsdelivr.net; style-src 'unsafe-inline' https://cdn.jsdelivr.net; font-src https://cdn.jsdelivr.net; connect-src https://cdn.jsdelivr.net; worker-src blob: data:;">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>JSONL Gazelle</title>
    <script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/monaco-editor@0.44.0/min/vs/loader.js"></script>
    <style>
${styles}
    </style>
</head>
<body>
    <div class="main-content">
        <div class="view-controls">
            <div class="logo-container" style="position: relative; width: 32px; height: 32px;">
                <img src="${gazelleIconUri}" class="logo" alt="JSONL Gazelle" id="logo" title="JSONL Gazelle" style="cursor: pointer;">
                <img src="${gazelleAnimationUri}" class="logo-animation" id="logoAnimation" alt="Loading..." style="display: none; position: absolute; top: 0; left: 0; width: 32px; height: 32px;">
            </div>
            <div class="loading-state" id="loadingState" style="display: none;">
                <div>Loading large file...</div>
                <div class="loading-progress" id="loadingProgress"></div>
            </div>
            <div class="segmented-control">
                <button class="active" data-view="table"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="9" y1="3" x2="9" y2="21"></line><line x1="15" y1="3" x2="15" y2="21"></line><line x1="3" y1="9" x2="21" y2="9"></line><line x1="3" y1="15" x2="21" y2="15"></line></svg> Table</button>
                <button data-view="json"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="6" x2="20" y2="6"></line><line x1="8" y1="10" x2="20" y2="10"></line><line x1="12" y1="14" x2="20" y2="14"></line><line x1="8" y1="18" x2="20" y2="18"></line></svg> Pretty Print</button>
                <button data-view="raw"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg> Raw</button>
                <div class="error-count" id="errorCount" style="display: none;"></div>
            </div>
            <button class="column-manager-btn" id="refreshBtn" data-tooltip="Reload the file from disk (Ctrl+R / F5)">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>
            </button>
            <button class="column-manager-btn" id="followBtn" data-tooltip="Follow mode: auto-reload and scroll to new rows (like tail -f)">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="7 13 12 18 17 13"></polyline><polyline points="7 6 12 11 17 6"></polyline></svg>
            </button>
            <button class="column-manager-btn" id="findReplaceBtn" data-tooltip="Find and replace in cells (Cmd+F / Ctrl+F)">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.35-4.35"></path></svg>
            </button>
            <button class="column-manager-btn" id="rowDetailsBtn" data-tooltip="Inspect the selected row as JSON, including hidden columns">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="15" y1="3" x2="15" y2="21"></line></svg>
                Row Details
            </button>
            <button class="column-manager-btn" id="columnManagerBtn" data-tooltip="Show, hide, and reorder columns">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3h7a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-7m0-18H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h7m0-18v18"></path></svg>
                Columns
            </button>
            <button class="column-manager-btn tooltip-right" id="settingsBtn" data-tooltip="AI settings: provider, API key, and model">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1 1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
            </button>
            <label class="wrap-text-control tooltip-right" data-tooltip="Wrap long text in table cells">
                <input type="checkbox" id="wrapTextCheckbox">
                <span>Wrap Text</span>
            </label>
        </div>

        <!-- Find & Replace Extension Bar -->
        <div class="find-replace-bar" id="findReplaceBar" style="display: none;">
            <div class="find-replace-row">
                <div class="find-replace-input-group">
                    <input type="text" id="findInput" class="find-replace-input" placeholder="Find" />
                    <span class="find-match-count" id="findMatchCount"></span>
                    <button class="find-nav-btn" id="findNextBtn" title="Next match (Enter)">
                        <svg width="14" height="14" viewBox="0 0 16 16"><path fill="currentColor" d="M8 6l5 5H3z"/></svg>
                    </button>
                    <button class="find-nav-btn" id="findPrevBtn" title="Previous match (Shift+Enter)">
                        <svg width="14" height="14" viewBox="0 0 16 16"><path fill="currentColor" d="M8 10L3 5h10z"/></svg>
                    </button>
                </div>
                <div class="find-replace-input-group">
                    <input type="text" id="replaceInput" class="find-replace-input" placeholder="Replace" />
                    <button class="find-action-btn" id="replaceBtn" title="Replace">Replace</button>
                    <button class="find-action-btn" id="replaceAllBtn" title="Replace All">Replace All</button>
                </div>
                <div class="find-replace-options-group">
                    <label class="find-option-label">
                        <input type="checkbox" id="caseSensitiveCheckbox" class="find-option-checkbox" />
                        <span>Match Case</span>
                    </label>
                    <label class="find-option-label">
                        <input type="checkbox" id="wholeWordCheckbox" class="find-option-checkbox" />
                        <span>Whole Word</span>
                    </label>
                    <label class="find-option-label">
                        <input type="checkbox" id="regexCheckbox" class="find-option-checkbox" />
                        <span>Regex</span>
                    </label>
                </div>
                <button class="find-close-btn" id="findReplaceCloseBtn" title="Close (Escape)">
                    <svg width="16" height="16" viewBox="0 0 16 16"><path fill="currentColor" d="M8 8.7L2.9 13.8 2.2 13.1 7.3 8 2.2 2.9 2.9 2.2 8 7.3 13.1 2.2 13.8 2.9 8.7 8 13.8 13.1 13.1 13.8z"/></svg>
                </button>
            </div>
            <div class="regex-error" id="regexError" style="display: none;"></div>
        </div>

        <div class="content-area">
        <div class="table-container" id="tableContainer">
            <div class="indexing" id="indexingDiv">
                <img src="${gazelleAnimationUri}" style="width: 32px; height: 32px;" alt="Indexing...">
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
                <div id="prettyEditor" style="height: 100%; width: 100%;"></div>
            </div>
            
            <!-- Raw View Container -->
            <div class="view-container" id="rawViewContainer" style="display: none;">
                <div class="raw-view" id="rawView">
                    <div id="rawEditor" style="height: 100%; width: 100%;"></div>
                </div>
            </div>
        </div>

        <!-- Row Details Side Panel -->
        <aside class="row-details-panel" id="rowDetailsPanel" style="display: none;">
            <div class="row-details-resizer" id="rowDetailsResizer" title="Drag to resize"></div>
            <div class="row-details-inner">
                <div class="row-details-header">
                    <span class="row-details-title" id="rowDetailsTitle">Row Details</span>
                    <button class="row-details-icon-btn" id="rowDetailsCopyBtn" title="Copy row JSON to clipboard">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                    </button>
                    <button class="row-details-icon-btn" id="rowDetailsExpandBtn" title="Expand all">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="7 13 12 18 17 13"></polyline><polyline points="7 6 12 11 17 6"></polyline></svg>
                    </button>
                    <button class="row-details-icon-btn" id="rowDetailsCollapseBtn" title="Collapse all">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 11 12 6 7 11"></polyline><polyline points="17 18 12 13 7 18"></polyline></svg>
                    </button>
                    <button class="row-details-icon-btn" id="rowDetailsCloseBtn" title="Close panel">
                        <svg width="16" height="16" viewBox="0 0 16 16"><path fill="currentColor" d="M8 8.7L2.9 13.8 2.2 13.1 7.3 8 2.2 2.9 2.9 2.2 8 7.3 13.1 2.2 13.8 2.9 8.7 8 13.8 13.1 13.1 13.8z"/></svg>
                    </button>
                </div>
                <div class="row-details-body" id="rowDetailsBody"></div>
            </div>
        </aside>
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
        <div class="context-menu-item" data-action="insertAIColumn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
            Insert Column with AI
        </div>
        <div class="context-menu-item" data-action="suggestColumnWithAI">
            <span style="font-size: 14px; line-height: 14px;">🪄</span>
            Suggest Column with AI
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
        <div class="row-context-menu-item" data-action="viewRowDetails">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="15" y1="3" x2="15" y2="21"></line></svg>
            View Row Details
        </div>
        <div class="row-context-menu-separator"></div>
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

    <!-- AI Column Modal -->
    <div class="column-manager-modal" id="aiColumnModal">
        <div class="modal-content ai-column-modal">
            <div class="modal-header">
                <h3>Insert Column with AI</h3>
                <button class="modal-close" id="aiColumnCloseBtn">&times;</button>
            </div>
            <div class="modal-body">
                <div class="field-row" style="display: flex; align-items: center; gap: 8px;">
                    <label for="aiColumnName" style="margin-right: 8px; font-weight: 500; white-space: nowrap;">Column Name:</label>
                    <input type="text" id="aiColumnName" class="column-name-input-inline" placeholder="e.g., summary, category, score" style="flex: 1;" />
                </div>

                <div style="margin-top: 12px;">
                    <div style="display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px;">
                        <label for="aiPrompt" style="font-weight: 500;">AI Prompt:</label>
                        <button class="modal-info-btn" id="aiColumnInfoBtn">?</button>
                    </div>
                    <div class="ai-prompt-row" style="display: flex; gap: 12px; align-items: stretch;">
                        <textarea id="aiPrompt" class="ai-prompt-textarea" rows="10" style="flex: 1;" placeholder="Example: Assign a U.S. school grade (K–12 or college) that best matches the reading level of {{row.model_output}}.

Available variables:
- {{row}} - entire row as JSON
- {{row.fieldname}} - specific field value
- {{row.fieldname[0]}} - array element
- {{row_number}} - current row number
- {{rows_before}} - number of rows before this one
- {{rows_after}} - number of rows after this one"></textarea>

                        <div class="ai-info-panel" id="aiInfoPanel" style="display: none; width: 40%; min-width: 260px; padding: 12px; background: rgba(255, 255, 255, 0.05); border-radius: 6px; font-size: 12px; color: #888;">
                            <strong>Example:</strong> Assign a U.S. school grade (K–12 or college) that best matches the reading level of {{row.model_output}}.<br><br>
                            <strong>Available variables:</strong><br>
                            • <code>{{row}}</code> - entire row as JSON<br>
                            • <code>{{row.fieldname}}</code> - specific field value<br>
                            • <code>{{row.fieldname[0]}}</code> - array element<br>
                            • <code>{{row_number}}</code> - current row number<br>
                            • <code>{{rows_before}}</code> - number of rows before this one<br>
                            • <code>{{rows_after}}</code> - number of rows after this one
                        </div>
                    </div>
                </div>

                <div style="margin-top: 16px; padding: 12px; background: rgba(255, 255, 255, 0.03); border-radius: 6px; border: 1px solid var(--vscode-input-border);">
                    <label style="display: flex; align-items: center; margin-bottom: 8px; cursor: pointer;">
                        <input type="checkbox" id="aiUseEnum" style="margin-right: 8px; cursor: pointer;" />
                        <span style="font-weight: 500;">Restrict output to enum values</span>
                    </label>
                    <div style="position: relative; display: grid; grid-template-rows: auto auto;">
                        <input type="text" id="aiEnumValues" class="column-name-input" placeholder="Enter values separated by comma, e.g., 1, 2, 3" 
                               style="margin-top: 8px; display: none; width: 100%; box-sizing: border-box;" disabled />
                    </div>
                </div>
            </div>
            <div id="enumHistoryDropdown" class="enum-history-dropdown" style="display: none;"></div>
            <div class="modal-actions" style="padding: 16px; border-top: 1px solid var(--vscode-panel-border);">
                <button class="modal-button modal-button-primary" id="aiColumnConfirmBtn">Generate Column</button>
                <button class="modal-button modal-button-secondary" id="aiColumnCancelBtn">Cancel</button>
            </div>
        </div>
    </div>

    <!-- AI Settings Modal -->
    <div class="column-manager-modal" id="settingsModal">
        <div class="modal-content settings-modal">
            <div class="modal-header">
                <h3>AI Settings</h3>
                <button class="modal-close" id="settingsCloseBtn">&times;</button>
            </div>
            <div class="modal-body">
                <div id="apiKeyWarning" style="display: none; margin-bottom: 16px; padding: 12px; background: rgba(255, 200, 0, 0.15); border-left: 3px solid #ffc800; border-radius: 4px; color: var(--vscode-errorForeground);">
                    <strong style="display: block; margin-bottom: 4px;">⚠️ API Key Required</strong>
                    <span style="font-size: 12px;">No API key is set for the selected provider. Please enter your API key below to use AI features.</span>
                </div>

                <label for="aiProviderSelect" style="display: block; margin-bottom: 8px; font-weight: 500;">Provider:</label>
                <select id="aiProviderSelect" class="settings-select" style="width: 100%; padding: 8px 12px; font-size: 13px; background-color: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; outline: none; margin-bottom: 16px; box-sizing: border-box;">
                    <option value="openai">OpenAI</option>
                    <option value="anthropic">Anthropic</option>
                    <option value="gemini">Google Gemini</option>
                    <option value="local">Local (OpenAI-compatible)</option>
                </select>

                <div id="aiBaseUrlRow" style="display: none;">
                    <label for="aiBaseUrl" style="display: block; margin-bottom: 8px; font-weight: 500;">Base URL:</label>
                    <input type="text" id="aiBaseUrl" class="column-name-input" placeholder="http://localhost:11434/v1" />
                    <div style="font-size: 11px; color: #888; margin-top: 4px; margin-bottom: 16px;">OpenAI-compatible endpoint, e.g. Ollama (http://localhost:11434/v1) or LM Studio (http://localhost:1234/v1).</div>
                </div>

                <div id="aiApiKeyRow">
                    <label for="aiApiKey" id="aiApiKeyLabel" style="display: block; margin-bottom: 8px; font-weight: 500;">OpenAI API Key:</label>
                    <input type="text" id="aiApiKey" class="column-name-input" placeholder="sk-..." />
                </div>

                <label for="aiModelSelect" style="display: block; margin-top: 16px; margin-bottom: 8px; font-weight: 500;">Model:</label>
                <div style="display: flex; gap: 8px; align-items: center;">
                    <select id="aiModelSelect" class="settings-select" style="flex: 1; padding: 8px 12px; font-size: 13px; background-color: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; outline: none; box-sizing: border-box;">
                    </select>
                    <button id="refreshModelsBtn" class="modal-button modal-button-secondary" title="Fetch the latest models from the provider" style="padding: 8px 12px; white-space: nowrap;">↻ Refresh</button>
                </div>
                <div id="modelFetchStatus" style="font-size: 11px; color: #888; margin-top: 6px; min-height: 14px;"></div>

                <div class="ai-info-box" style="margin-top: 12px; padding: 12px; background: rgba(255, 255, 255, 0.05); border-radius: 6px; font-size: 12px; color: #888;">
                    Used by <em>Insert Column with AI</em>, <em>Suggest Column with AI</em> (right-click a column header) and <em>Insert Rows with AI</em> (right-click a row).
                </div>

                <div class="ai-info-box" style="margin-top: 12px; padding: 12px; background: rgba(255, 255, 255, 0.05); border-radius: 6px; font-size: 12px; color: #888;">
                    <strong>Note:</strong> Your API keys are stored securely in VS Code's secret storage. They will never be shared or transmitted outside of API requests to the selected provider. Use ↻ Refresh to pull the latest model list from the provider.
                </div>
            </div>

            <div class="modal-actions" style="padding: 16px; border-top: 1px solid var(--vscode-panel-border); margin-top: 0;">
                <button class="modal-button modal-button-primary" id="settingsSaveBtn">Save Settings</button>
                <button class="modal-button modal-button-secondary" id="settingsCancelBtn">Cancel</button>
            </div>
            <!-- Hidden reset button in bottom left corner -->
            <div id="settingsResetBtn" style="position: absolute; bottom: 0; left: 0; width: 40px; height: 40px; background: transparent; z-index: 1000; pointer-events: auto;"></div>
        </div>
    </div>

    <!-- AI Rows Modal -->
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

				<button id="aiRowsAdvancedToggle" class="modal-button modal-button-primary" style="margin-top: 16px;">Advanced</button>
				<div id="aiRowsAdvancedSection" style="display: none;">
					<label for="aiRowsPrompt" style="display: block; margin-top: 16px; margin-bottom: 8px; font-weight: 500;">AI Prompt:</label>
					<textarea id="aiRowsPrompt" class="ai-prompt-textarea" rows="8" placeholder="Generate more rows like these, but make them different from the lines provided.

					Available variables:
					- {{context_rows}} - JSON array of previous rows
					- {{row_count}} - number of rows to generate
					- {{existing_count}} - total existing rows">Generate more rows like these, but make them different from the lines provided.</textarea>
				</div>

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

    <!-- AI Column Suggestions Modal -->
    <div class="column-manager-modal" id="aiSuggestionsModal">
        <div class="modal-content ai-column-modal">
            <div class="modal-header">
                <h3>Suggest Column with AI</h3>
                <button class="modal-close" id="aiSuggestionsCloseBtn">&times;</button>
            </div>
            <div class="modal-body">
                <div id="aiSuggestionsLoading" style="text-align: center; padding: 30px; color: #888; font-size: 14px;">
                    Analyzing data and generating suggestions...
                </div>
                <div id="aiSuggestionsList" style="display: none; max-height: 400px; overflow-y: auto;">
                    <!-- Suggestions will be inserted here -->
                </div>
                <div id="aiSuggestionsError" style="display: none; padding: 12px; background: rgba(255, 0, 0, 0.1); border-left: 3px solid var(--vscode-errorForeground); border-radius: 4px; color: var(--vscode-errorForeground); font-size: 13px;">
                    <strong>Error:</strong> <span id="aiSuggestionsErrorMessage"></span>
                </div>
                <div class="modal-actions" style="margin-top: 16px;">
                    <button class="modal-button modal-button-secondary" id="aiSuggestionsCancelBtn">Cancel</button>
                </div>
            </div>
        </div>
    </div>


    <script nonce="${nonce}">
${scripts}
    </script>
</body>
</html>`;
}
