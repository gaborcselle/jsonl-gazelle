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

    <!-- Find/Replace Modal -->
    <div class="column-manager-modal" id="findReplaceModal" style="display: none;">
        <div class="modal-content find-replace-modal">
            <div class="modal-header">
                <h3>Find and Replace</h3>
                <button class="modal-close" id="findReplaceCloseBtn">&times;</button>
            </div>
            <div class="modal-body">
                <div class="find-replace-group">
                    <label for="findInput">Find:</label>
                    <input type="text" id="findInput" class="find-replace-input" placeholder="Enter text or regex pattern..." />
                    <div class="find-replace-info" id="findMatchCount">0 matches</div>
                </div>

                <div class="find-replace-group">
                    <label for="replaceInput">Replace with:</label>
                    <input type="text" id="replaceInput" class="find-replace-input" placeholder="Enter replacement text..." />
                </div>

                <div class="find-replace-options">
                    <label class="checkbox-label">
                        <input type="checkbox" id="regexCheckbox" />
                        <span>Use Regular Expression</span>
                    </label>
                    <label class="checkbox-label">
                        <input type="checkbox" id="caseSensitiveCheckbox" />
                        <span>Case Sensitive</span>
                    </label>
                    <label class="checkbox-label">
                        <input type="checkbox" id="wholeWordCheckbox" />
                        <span>Whole Word</span>
                    </label>
                </div>

                <div class="regex-error" id="regexError" style="display: none;"></div>

                <div class="modal-actions find-replace-actions">
                    <button class="modal-button modal-button-secondary" id="findPrevBtn">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="15 18 9 12 15 6"></polyline>
                        </svg>
                        Previous
                    </button>
                    <button class="modal-button modal-button-secondary" id="findNextBtn">
                        Next
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="9 18 15 12 9 6"></polyline>
                        </svg>
                    </button>
                    <button class="modal-button modal-button-secondary" id="replaceBtn">Replace</button>
                    <button class="modal-button modal-button-primary" id="replaceAllBtn">Replace All</button>
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

        // Find/Replace State
        let findReplaceState = {
            matches: [],
            currentMatchIndex: -1,
            findPattern: '',
            useRegex: false,
            caseSensitive: false,
            wholeWord: false
        };

        // Find/Replace Modal Functions
        function openFindReplaceModal() {
            const modal = document.getElementById('findReplaceModal');
            modal.style.display = 'flex';
            document.getElementById('findInput').focus();
            performFind(); // Initial find with current input
        }

        function closeFindReplaceModal() {
            const modal = document.getElementById('findReplaceModal');
            modal.style.display = 'none';
            clearHighlights();
        }

        function performFind() {
            const findText = document.getElementById('findInput').value;
            const useRegex = document.getElementById('regexCheckbox').checked;
            const caseSensitive = document.getElementById('caseSensitiveCheckbox').checked;
            const wholeWord = document.getElementById('wholeWordCheckbox').checked;

            // Clear previous highlights
            clearHighlights();

            if (!findText) {
                document.getElementById('findMatchCount').textContent = '0 matches';
                document.getElementById('regexError').style.display = 'none';
                findReplaceState.matches = [];
                return;
            }

            try {
                // Build search pattern
                let pattern;
                if (useRegex) {
                    pattern = new RegExp(findText, caseSensitive ? 'g' : 'gi');
                } else {
                    let escapedText = escapeRegex(findText);
                    if (wholeWord) {
                        escapedText = '\\\\b' + escapedText + '\\\\b';
                    }
                    pattern = new RegExp(escapedText, caseSensitive ? 'g' : 'gi');
                }

                // Hide regex error if pattern is valid
                document.getElementById('regexError').style.display = 'none';

                // Store state
                findReplaceState.findPattern = findText;
                findReplaceState.useRegex = useRegex;
                findReplaceState.caseSensitive = caseSensitive;
                findReplaceState.wholeWord = wholeWord;

                // Find matches based on current view
                findMatchesInCurrentView(pattern);

                // Update match count
                const matchCount = findReplaceState.matches.length;
                document.getElementById('findMatchCount').textContent =
                    matchCount === 0 ? 'No matches' :
                    matchCount === 1 ? '1 match' :
                    matchCount + ' matches';

                // Highlight first match
                if (matchCount > 0) {
                    findReplaceState.currentMatchIndex = 0;
                    highlightCurrentMatch();
                }

            } catch (error) {
                // Show regex error
                document.getElementById('regexError').textContent = 'Invalid regex pattern: ' + error.message;
                document.getElementById('regexError').style.display = 'block';
                findReplaceState.matches = [];
                document.getElementById('findMatchCount').textContent = '0 matches';
            }
        }

        function findMatchesInCurrentView(pattern) {
            findReplaceState.matches = [];

            if (currentView === 'table') {
                // Search in table cells (use raw value if available, otherwise text content)
                const cells = document.querySelectorAll('#dataTable td');
                cells.forEach((cell, index) => {
                    // Use raw value for accurate matching (without JSON quotes)
                    const text = cell.dataset.rawValue !== undefined ? cell.dataset.rawValue : cell.textContent;
                    const matches = [...text.matchAll(pattern)];

                    matches.forEach(match => {
                        findReplaceState.matches.push({
                            element: cell,
                            text: text,
                            match: match[0],
                            index: match.index,
                            cellIndex: index
                        });
                    });
                });
            } else if (currentView === 'json') {
                // Search in JSON view
                const jsonLines = document.querySelectorAll('.json-content-editable');
                jsonLines.forEach((textarea, lineIndex) => {
                    const text = textarea.value;
                    const matches = [...text.matchAll(pattern)];

                    matches.forEach(match => {
                        findReplaceState.matches.push({
                            element: textarea,
                            text: text,
                            match: match[0],
                            index: match.index,
                            lineIndex: lineIndex
                        });
                    });
                });
            } else if (currentView === 'raw') {
                // Search in raw view
                const rawLines = document.querySelectorAll('.raw-line-content');
                rawLines.forEach((lineContent, lineIndex) => {
                    const text = lineContent.textContent;
                    const matches = [...text.matchAll(pattern)];

                    matches.forEach(match => {
                        findReplaceState.matches.push({
                            element: lineContent,
                            text: text,
                            match: match[0],
                            index: match.index,
                            lineIndex: lineIndex
                        });
                    });
                });
            }
        }

        function highlightCurrentMatch() {
            // Clear previous current highlight
            document.querySelectorAll('.find-highlight-current').forEach(el => {
                el.classList.remove('find-highlight-current');
                el.classList.add('find-highlight');
            });

            if (findReplaceState.currentMatchIndex < 0 ||
                findReplaceState.currentMatchIndex >= findReplaceState.matches.length) {
                return;
            }

            const match = findReplaceState.matches[findReplaceState.currentMatchIndex];

            // Scroll to and highlight the match
            if (match.element) {
                match.element.scrollIntoView({ behavior: 'smooth', block: 'center' });

                // For table cells and raw content, add highlight class
                if (currentView === 'table' || currentView === 'raw') {
                    match.element.classList.add('find-highlight-current');
                } else if (currentView === 'json') {
                    // For JSON textareas, set selection
                    match.element.focus();
                    match.element.setSelectionRange(match.index, match.index + match.match.length);
                }
            }

            // Update count display
            document.getElementById('findMatchCount').textContent =
                (findReplaceState.currentMatchIndex + 1) + ' of ' + findReplaceState.matches.length;
        }

        function clearHighlights() {
            document.querySelectorAll('.find-highlight, .find-highlight-current').forEach(el => {
                el.classList.remove('find-highlight', 'find-highlight-current');
            });
        }

        function findNext() {
            if (findReplaceState.matches.length === 0) {
                performFind();
                return;
            }

            findReplaceState.currentMatchIndex =
                (findReplaceState.currentMatchIndex + 1) % findReplaceState.matches.length;
            highlightCurrentMatch();
        }

        function findPrevious() {
            if (findReplaceState.matches.length === 0) {
                performFind();
                return;
            }

            findReplaceState.currentMatchIndex =
                (findReplaceState.currentMatchIndex - 1 + findReplaceState.matches.length) % findReplaceState.matches.length;
            highlightCurrentMatch();
        }

        function replaceCurrent() {
            if (findReplaceState.currentMatchIndex < 0 ||
                findReplaceState.matches.length === 0) {
                return;
            }

            const match = findReplaceState.matches[findReplaceState.currentMatchIndex];
            const replaceText = document.getElementById('replaceInput').value;

            if (currentView === 'table') {
                // Replace in table cell
                const cell = match.element;
                const row = cell.closest('tr');
                const rowIndex = parseInt(row.dataset.index);
                const columnPath = cell.dataset.columnPath;

                // Get actual row data with safety checks
                const actualRowIndex = currentData.rowIndices && currentData.rowIndices[rowIndex] !== undefined
                    ? currentData.rowIndices[rowIndex]
                    : rowIndex;

                const allRows = currentData.allRows || currentData.rows || [];
                const rowData = allRows[actualRowIndex];

                if (!rowData) {
                    console.error('Could not find row data for index:', actualRowIndex);
                    console.error('Available data:', {
                        rowIndex,
                        actualRowIndex,
                        allRowsLength: allRows.length,
                        hasRowIndices: !!currentData.rowIndices
                    });
                    return;
                }

                // Get current value from the stored raw value (which matches what we searched)
                let currentValueStr = match.text; // Use the text we found the match in

                // Perform replacement on the actual value
                const newValueStr = currentValueStr.substring(0, match.index) +
                                    replaceText +
                                    currentValueStr.substring(match.index + match.match.length);

                // Update display (JSON stringify for consistent display)
                match.element.textContent = JSON.stringify(newValueStr);
                // Update the raw value data attribute
                match.element.dataset.rawValue = newValueStr;

                // Send update to backend
                vscode.postMessage({
                    type: 'updateCell',
                    rowIndex: actualRowIndex,
                    columnPath: columnPath,
                    value: newValueStr
                });

            } else if (currentView === 'json') {
                // Replace in JSON textarea
                const textarea = match.element;
                const oldValue = textarea.value;
                const newValue = oldValue.substring(0, match.index) +
                                 replaceText +
                                 oldValue.substring(match.index + match.match.length);

                textarea.value = newValue;

                // Trigger update
                const rowIndex = parseInt(textarea.closest('.json-line').dataset.index);
                const actualRowIndex = currentData.rowIndices ? currentData.rowIndices[rowIndex] : rowIndex;

                try {
                    const parsedData = JSON.parse(newValue);
                    vscode.postMessage({
                        type: 'documentChanged',
                        rowIndex: actualRowIndex,
                        newData: parsedData
                    });
                } catch (e) {
                    // Invalid JSON after replace
                }

            } else if (currentView === 'raw') {
                // Raw view is read-only for cell-level edits, so skip
                vscode.window.showWarningMessage('Replace is not supported in Raw view. Switch to Table or JSON view.');
                return;
            }

            // Re-run find to update matches
            performFind();
        }

        function replaceAll() {
            if (findReplaceState.matches.length === 0) {
                return;
            }

            const replaceText = document.getElementById('replaceInput').value;
            const matchCount = findReplaceState.matches.length;

            // Note: confirm() doesn't work in sandboxed webviews, so we skip confirmation
            // User can always undo with Ctrl+Z

            // Group matches by element to reduce updates
            const elementMatches = new Map();
            findReplaceState.matches.forEach(match => {
                if (!elementMatches.has(match.element)) {
                    elementMatches.set(match.element, []);
                }
                elementMatches.get(match.element).push(match);
            });

            // Replace in each element (process in reverse order to maintain indices)
            elementMatches.forEach((matches, element) => {
                matches.sort((a, b) => b.index - a.index); // Reverse order

                if (currentView === 'table') {
                    const row = element.closest('tr');
                    const rowIndex = parseInt(row.dataset.index);
                    const columnPath = element.dataset.columnPath;

                    // Get actual row data with safety checks
                    const actualRowIndex = currentData.rowIndices && currentData.rowIndices[rowIndex] !== undefined
                        ? currentData.rowIndices[rowIndex]
                        : rowIndex;

                    const allRows = currentData.allRows || currentData.rows || [];
                    const rowData = allRows[actualRowIndex];

                    if (!rowData) {
                        console.error('Could not find row data for index:', actualRowIndex);
                        return;
                    }

                    // Get current value from the first match's text (all matches in same element have same text)
                    let newText = matches[0].text;

                    // Apply all replacements in reverse order (already sorted)
                    matches.forEach(match => {
                        newText = newText.substring(0, match.index) +
                                  replaceText +
                                  newText.substring(match.index + match.match.length);
                    });

                    // Update display (JSON stringify for consistent display)
                    element.textContent = JSON.stringify(newText);
                    // Update the raw value data attribute
                    element.dataset.rawValue = newText;

                    // Send update
                    vscode.postMessage({
                        type: 'updateCell',
                        rowIndex: actualRowIndex,
                        columnPath: columnPath,
                        value: newText
                    });

                } else if (currentView === 'json') {
                    let newValue = element.value;
                    matches.forEach(match => {
                        newValue = newValue.substring(0, match.index) +
                                   replaceText +
                                   newValue.substring(match.index + match.match.length);
                    });

                    element.value = newValue;

                    const rowIndex = parseInt(element.closest('.json-line').dataset.index);
                    const actualRowIndex = currentData.rowIndices ? currentData.rowIndices[rowIndex] : rowIndex;

                    try {
                        const parsedData = JSON.parse(newValue);
                        vscode.postMessage({
                            type: 'documentChanged',
                            rowIndex: actualRowIndex,
                            newData: parsedData
                        });
                    } catch (e) {
                        // Invalid JSON
                    }
                }
            });

            vscode.window.showInformationMessage('Replaced ' + matchCount + ' occurrences');

            // Re-run find
            performFind();
        }

        // Find/Replace Event Listeners
        document.getElementById('findReplaceCloseBtn').addEventListener('click', closeFindReplaceModal);
        document.getElementById('findReplaceModal').addEventListener('click', (e) => {
            if (e.target.id === 'findReplaceModal') {
                closeFindReplaceModal();
            }
        });

        document.getElementById('findInput').addEventListener('input', performFind);
        document.getElementById('regexCheckbox').addEventListener('change', performFind);
        document.getElementById('caseSensitiveCheckbox').addEventListener('change', performFind);
        document.getElementById('wholeWordCheckbox').addEventListener('change', performFind);

        document.getElementById('findNextBtn').addEventListener('click', findNext);
        document.getElementById('findPrevBtn').addEventListener('click', findPrevious);
        document.getElementById('replaceBtn').addEventListener('click', replaceCurrent);
        document.getElementById('replaceAllBtn').addEventListener('click', replaceAll);

        // Keyboard shortcuts for Find/Replace
        document.addEventListener('keydown', (e) => {
            // Cmd/Ctrl + F: Open Find
            if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
                e.preventDefault();
                openFindReplaceModal();
            }

            // Cmd/Ctrl + H: Open Find/Replace
            if ((e.metaKey || e.ctrlKey) && e.key === 'h') {
                e.preventDefault();
                openFindReplaceModal();
                document.getElementById('replaceInput').focus();
            }

            // Escape: Close modal
            if (e.key === 'Escape' && document.getElementById('findReplaceModal').style.display === 'flex') {
                closeFindReplaceModal();
            }

            // Enter in find input: Find next
            if (e.key === 'Enter' && document.activeElement.id === 'findInput') {
                e.preventDefault();
                findNext();
            }

            // Enter in replace input: Replace current
            if (e.key === 'Enter' && document.activeElement.id === 'replaceInput') {
                e.preventDefault();
                if (e.shiftKey) {
                    replaceAll();
                } else {
                    replaceCurrent();
                }
            }

            // F3 or Cmd/Ctrl+G: Find next
            if (e.key === 'F3' || ((e.metaKey || e.ctrlKey) && e.key === 'g')) {
                e.preventDefault();
                if (e.shiftKey) {
                    findPrevious();
                } else {
                    findNext();
                }
            }
        });

        // Event listeners
        document.getElementById('logo').addEventListener('click', () => {
            vscode.postMessage({
                type: 'openUrl',
                url: 'https://github.com/gaborcselle/jsonl-gazelle'
            });
        });

        // Find/Replace Button
        document.getElementById('findReplaceBtn').addEventListener('click', openFindReplaceModal);

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
            
            if (data.isIndexing) {
                // Initial loading - show spinning logo and hide controls
                logo.classList.add('loading');
                loadingState.style.display = 'flex';
                
                // Don't show the indexing div since we have header loading state
                document.getElementById('indexingDiv').style.display = 'none';
                document.getElementById('dataTable').style.display = 'none';
                return;
            }
            
            // Show loading progress if chunks are still loading
            if (data.loadingProgress && data.loadingProgress.loadingChunks) {
                logo.classList.add('loading');
                loadingState.style.display = 'flex';
                
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
                
                document.getElementById('indexingDiv').style.display = 'none';
                document.getElementById('dataTable').style.display = 'table';
            }
            
            // Update search inputs
            
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

            // Store the filtered row index on the row element for Find/Replace
            tr.dataset.index = rowIndex.toString();

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

                // Store column path and raw value on the cell element for Find/Replace
                td.dataset.columnPath = column.path;
                // Store the actual value (not JSON stringified) for accurate find/replace
                td.dataset.rawValue = value !== undefined && value !== null ? String(value) : '';

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
            
            // Hide any open context menus when switching views
            hideContextMenu();
            
            // Update data model when switching away from raw view (without saving)
            if (currentView === 'raw' && viewType !== 'raw') {
                // Get current content from Monaco editor and update data model without saving
                const rawEditor = document.getElementById('rawEditor');
                if (rawEditor && rawEditor.editor) {
                    const currentContent = rawEditor.editor.getValue();
                    vscode.postMessage({
                        type: 'rawContentChanged',
                        newContent: currentContent
                    });
                }
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
            logo.classList.add('loading');
            loadingState.style.display = 'flex';
            loadingState.innerHTML = '<div>Switching view...</div>';
            
            // Hide search container during view switch
            
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
                    // Re-render table to apply any active search filters
                    renderTableChunk(true);
                    // Re-apply search highlighting if there's an active search
                    if (searchTerm) {
                        highlightTableResults(searchTerm);
                    }
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

                        // Re-apply search highlighting if there's an active search
                        if (searchTerm) {
                            highlightRawResults(searchTerm);
                        }

                        // Automatically open file in VS Code editor
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
            
            // Initialize Monaco Editor
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
                    fontSize: 12,
                    fontFamily: 'var(--vscode-editor-font-family)'
                });
                
                // Disable JSON validation for JSONL files
                monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
                    validate: false,
                    allowComments: true,
                    schemas: []
                });
                
                // Additionally disable validation for current model
                const model = rawEditor.getModel();
                if (model) {
                    monaco.editor.setModelMarkers(model, 'json', []);
                }
                
                // Handle content changes
                rawEditor.onDidChangeModelContent(() => {
                    clearTimeout(window.rawEditTimeout);
                    window.rawEditTimeout = setTimeout(() => {
                        vscode.postMessage({
                            type: 'rawContentChanged',
                            newContent: rawEditor.getValue()
                        });
                    }, 500);
                });
                
                // Handle Ctrl+S
                rawEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
                    vscode.postMessage({
                        type: 'rawContentSave',
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
            button.addEventListener('click', (e) => switchView(e.currentTarget.dataset.view));
        });
        
        // Add event listeners for context menus
        document.getElementById('contextMenu').addEventListener('click', handleContextMenu);
        document.getElementById('rowContextMenu').addEventListener('click', handleRowContextMenu);
        
        // Hide context menus when clicking outside
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.context-menu') && !e.target.closest('.row-context-menu')) {
                hideContextMenu();
            }
        });
        
    </script>
</body>

    <script>
${scripts}
    </script>
</body>
</html>`;
}
