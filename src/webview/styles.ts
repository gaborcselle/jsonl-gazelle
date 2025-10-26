/**
 * Webview CSS styles
 */

export const styles = `
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
            font-family: var(--vscode-editor-font-family);
            font-size: 12px;
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

        /* Find/Replace Modal Styles */
        .find-replace-modal {
            width: 550px;
        }

        .find-replace-group {
            margin-bottom: 16px;
        }

        .find-replace-group label {
            display: block;
            margin-bottom: 6px;
            font-weight: 500;
            font-size: 13px;
        }

        .find-replace-input {
            width: 100%;
            padding: 8px 12px;
            font-size: 13px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            outline: none;
            font-family: var(--vscode-font-family);
            box-sizing: border-box;
        }

        .find-replace-input:focus {
            border-color: var(--vscode-focusBorder);
        }

        .find-replace-info {
            margin-top: 6px;
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
        }

        .find-replace-options {
            display: flex;
            flex-wrap: wrap;
            gap: 16px;
            margin-bottom: 16px;
            padding: 12px;
            background-color: var(--vscode-textBlockQuote-background);
            border-radius: 4px;
        }

        .checkbox-label {
            display: flex;
            align-items: center;
            gap: 8px;
            cursor: pointer;
            font-size: 13px;
        }

        .checkbox-label input[type="checkbox"] {
            cursor: pointer;
        }

        /* Find & Replace Extension Bar */
        .find-replace-bar {
            background-color: var(--vscode-editorWidget-background);
            border-bottom: 1px solid var(--vscode-editorWidget-border);
            padding: 4px 8px;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
        }

        .find-replace-row {
            display: flex;
            align-items: center;
            gap: 4px;
            flex-wrap: wrap;
        }

        .find-replace-input-group {
            display: flex;
            align-items: center;
            gap: 4px;
        }

        .find-replace-input {
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            padding: 3px 6px;
            font-size: 13px;
            font-family: var(--vscode-font-family);
            outline: none;
            width: 150px;
            border-radius: 2px;
        }

        .find-replace-input:focus {
            border-color: var(--vscode-focusBorder);
        }

        .find-match-count {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            min-width: 50px;
        }

        .find-nav-btn,
        .find-close-btn {
            background-color: transparent;
            border: 1px solid transparent;
            color: var(--vscode-icon-foreground);
            padding: 3px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 2px;
            width: 22px;
            height: 22px;
        }

        .find-nav-btn:hover,
        .find-close-btn:hover {
            background-color: var(--vscode-toolbar-hoverBackground);
        }

        .find-option-label {
            display: flex;
            align-items: center;
            gap: 4px;
            font-size: 12px;
            color: var(--vscode-foreground);
            cursor: pointer;
            padding: 2px 6px;
            border-radius: 2px;
            white-space: nowrap;
        }

        .find-option-label:hover {
            background-color: var(--vscode-toolbar-hoverBackground);
        }

        .find-option-checkbox {
            cursor: pointer;
            margin: 0;
        }

        .find-action-btn {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: 1px solid var(--vscode-button-secondaryBorder);
            padding: 3px 8px;
            font-size: 12px;
            cursor: pointer;
            border-radius: 2px;
            white-space: nowrap;
        }

        .find-action-btn:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }

        .find-action-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        .find-replace-options-group {
            display: flex;
            gap: 8px;
            margin-left: auto;
            align-items: center;
        }

        .find-close-btn {
            margin-left: 4px;
        }

`;
