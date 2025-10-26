/**
 * Webview HTML template
 */

export function getHtmlTemplate(gazelleIconUri: string, styles: string, scripts: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>JSONL Gazelle</title>
    <script src="https://cdn.jsdelivr.net/npm/monaco-editor@0.44.0/min/vs/loader.js"></script>
    <style>
${styles}
    </style>
</head>
<body>
    <div class="main-content">
        <div class="view-controls">
            <img src="${gazelleIconUri}" class="logo" alt="JSONL Gazelle" id="logo" title="JSONL Gazelle" style="cursor: pointer;">
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
            <button class="column-manager-btn" id="findReplaceBtn" title="Find and Replace in cells (Cmd+F)">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.35-4.35"></path><path d="M9 15l6-6"></path></svg>
                Find & Replace
            </button>
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

        <!-- Find & Replace Extension Bar -->
        <div class="find-replace-bar" id="findReplaceBar" style="display: none;">
            <div class="find-replace-row">
                <div class="find-replace-input-group">
                    <input type="text" id="findInput" class="find-replace-input" placeholder="Find" />
                    <span class="find-match-count" id="findMatchCount"></span>
                    <button class="find-nav-btn" id="findPrevBtn" title="Previous match (Shift+Enter)">
                        <svg width="14" height="14" viewBox="0 0 16 16"><path fill="currentColor" d="M8 10L3 5h10z"/></svg>
                    </button>
                    <button class="find-nav-btn" id="findNextBtn" title="Next match (Enter)">
                        <svg width="14" height="14" viewBox="0 0 16 16"><path fill="currentColor" d="M8 6l5 5H3z"/></svg>
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

    <!-- AI Column Modal -->
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

    <!-- AI Settings Modal -->
    <div class="column-manager-modal" id="settingsModal">
        <div class="modal-content settings-modal">
            <div class="modal-header">
                <h3>AI Settings</h3>
                <button class="modal-close" id="settingsCloseBtn">&times;</button>
            </div>
            <div class="modal-body">
                <label for="aiProvider" style="display: block; margin-bottom: 8px; font-weight: 500;">AI Provider:</label>
                <select id="aiProvider" class="settings-select" style="width: 100%; padding: 8px 12px; font-size: 13px; background-color: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; outline: none; margin-bottom: 16px; box-sizing: border-box;">
                    <option value="copilot">GitHub Copilot (VS Code)</option>
                    <option value="openai">OpenAI API</option>
                </select>

                <div id="copilotSettings" style="display: none;">
                    <div class="ai-info-box" style="margin-bottom: 16px; padding: 12px; background: rgba(100, 150, 255, 0.1); border-radius: 6px; font-size: 12px; color: var(--vscode-descriptionForeground);">
                        <strong>GitHub Copilot:</strong> Uses your VS Code GitHub Copilot subscription. Make sure you have GitHub Copilot enabled in VS Code.
                    </div>
                </div>

                <div id="openaiSettings" style="display: none;">
                    <label for="openaiKey" style="display: block; margin-bottom: 8px; font-weight: 500;">OpenAI API Key:</label>
                    <input type="text" id="openaiKey" class="column-name-input" placeholder="sk-..." />

                    <label for="openaiModel" style="display: block; margin-top: 16px; margin-bottom: 8px; font-weight: 500;">Model:</label>
                    <select id="openaiModel" class="settings-select" style="width: 100%; padding: 8px 12px; font-size: 13px; background-color: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; outline: none; margin-bottom: 16px; box-sizing: border-box;">
                        <option value="gpt-4o-mini">gpt-4o-mini</option>
                        <option value="gpt-4o">gpt-4o</option>
                        <option value="gpt-4-turbo">gpt-4-turbo</option>
                        <option value="gpt-4">gpt-4</option>
                        <option value="gpt-3.5-turbo">gpt-3.5-turbo</option>
                    </select>

                    <div class="ai-info-box" style="margin-top: 12px; padding: 12px; background: rgba(255, 255, 255, 0.05); border-radius: 6px; font-size: 12px; color: #888;">
                        <strong>Note:</strong> Your API key is stored securely in VS Code's secret storage. It will never be shared or transmitted outside of API requests to OpenAI.
                    </div>
                </div>

                <div class="modal-actions" style="margin-top: 16px;">
                    <button class="modal-button modal-button-primary" id="settingsSaveBtn">Save Settings</button>
                    <button class="modal-button modal-button-secondary" id="settingsCancelBtn">Cancel</button>
                </div>
            </div>
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
${scripts}
    </script>
</body>
</html>`;
}
