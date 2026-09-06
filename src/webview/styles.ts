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
        
        .logo-container {
            margin-right: 6px;
        }

        .logo {
            width: 32px;
            height: 32px;
        }

        .logo.loading {
            animation: spin 2s linear infinite;
        }

        .loading-state {
            display: flex;
            align-items: center;
            gap: 10px;
            font-size: 13px;
            white-space: nowrap;
            color: var(--vscode-descriptionForeground);
        }
        
        .loading-progress {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
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
        
        table {
            width: fit-content;
            min-width: 100%;
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
            box-shadow: inset 0 -1px 0 var(--vscode-panel-border);
            position: sticky;
            top: 0;
            z-index: 10;
            cursor: grab;
            user-select: none;
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

        th.row-header {
            top: 0;
            left: 0;
            z-index: 15;
        }

        td {
            padding: 6px 8px;
            border-bottom: 1px solid var(--vscode-panel-border);
            max-width: 500px;
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

        tr.selected td {
            background-color: var(--vscode-list-activeSelectionBackground);
            color: var(--vscode-list-activeSelectionForeground);
        }

        tr.selected td.row-header {
            background-color: var(--vscode-list-activeSelectionBackground);
            color: var(--vscode-list-activeSelectionForeground);
        }

        /* The keyboard cell cursor. An inset outline rather than a background so
           it stays visible on top of the selected row's highlight. Also lands on
           the column headers and the row-number cells, which the cursor can
           reach for the actions that live there. */
        td.cell-cursor,
        th.cell-cursor {
            outline: 2px solid var(--vscode-focusBorder, var(--vscode-textLink-foreground));
            outline-offset: -2px;
        }

        /* What the header cell under the cursor can do. Bottom left, opposite
           the sort-jump notice so the two never sit on top of each other. */
        .cursor-hint {
            position: fixed;
            left: 16px;
            bottom: 16px;
            z-index: 1200;
            display: flex;
            align-items: center;
            gap: 6px;
            max-width: min(520px, calc(100vw - 32px));
            padding: 6px 10px;
            font-size: 12px;
            border: 1px solid var(--vscode-notifications-border, var(--vscode-panel-border));
            border-radius: 4px;
            background-color: var(--vscode-notifications-background, var(--vscode-editorWidget-background));
            color: var(--vscode-notifications-foreground, var(--vscode-foreground));
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
            pointer-events: none;
        }

        .cursor-hint kbd {
            flex-shrink: 0;
            padding: 1px 5px;
            border: 1px solid var(--vscode-panel-border);
            border-bottom-width: 2px;
            border-radius: 3px;
            background-color: var(--vscode-keybindingLabel-background, var(--vscode-badge-background));
            color: var(--vscode-keybindingLabel-foreground, var(--vscode-badge-foreground));
            font-family: var(--vscode-editor-font-family);
            font-size: 11px;
            line-height: 15px;
        }

        .cursor-hint kbd + span {
            margin-right: 6px;
        }

        .indexing {
            display: flex;
            align-items: center;
            justify-content: center;
            height: 200px;
            flex-direction: column;
            gap: 10px;
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

        /* Non-interactive line naming the column's detected sort type */
        .context-menu-hint {
            padding: 3px 15px 5px;
            font-size: 0.85em;
            opacity: 0.7;
            color: var(--vscode-menu-foreground);
            cursor: default;
            white-space: nowrap;
        }

        /* Count of hidden columns, shown on the row-number header */
        .hidden-columns-badge {
            display: inline-flex;
            align-items: center;
            gap: 2px;
            margin-left: 4px;
            padding: 1px 4px;
            border: none;
            border-radius: 8px;
            cursor: pointer;
            font-size: 10px;
            font-family: inherit;
            line-height: 1.4;
            vertical-align: middle;
            background-color: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
        }

        .hidden-columns-badge:hover {
            filter: brightness(1.25);
        }

        /* Non-modal notice: the edited row moved because the view is sorted */
        .sort-jump-notice {
            position: fixed;
            right: 16px;
            bottom: 16px;
            z-index: 1200;
            display: flex;
            align-items: center;
            gap: 8px;
            max-width: min(420px, calc(100vw - 32px));
            padding: 8px 10px;
            font-size: 12px;
            border: 1px solid var(--vscode-notifications-border, var(--vscode-panel-border));
            border-radius: 4px;
            background-color: var(--vscode-notifications-background, var(--vscode-editorWidget-background));
            color: var(--vscode-notifications-foreground, var(--vscode-foreground));
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
        }

        .sort-jump-notice > svg {
            flex-shrink: 0;
            opacity: 0.8;
        }

        .sort-jump-notice > span {
            flex: 1;
            min-width: 0;
        }

        .sort-jump-btn {
            flex-shrink: 0;
            padding: 3px 10px;
            border: none;
            border-radius: 2px;
            cursor: pointer;
            font-size: 12px;
            font-family: inherit;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }

        .sort-jump-btn:hover {
            background-color: var(--vscode-button-hoverBackground);
        }

        .sort-jump-close {
            flex-shrink: 0;
            padding: 2px 4px;
            border: none;
            background: none;
            cursor: pointer;
            font-size: 12px;
            line-height: 1;
            opacity: 0.7;
            color: inherit;
        }

        .sort-jump-close:hover {
            opacity: 1;
        }

        /* Brief highlight on the row jumped to, so it's findable after scrolling */
        tr.row-flash td {
            animation: rowFlash 1.6s ease-out;
        }

        @keyframes rowFlash {
            from { background-color: var(--vscode-editor-findMatchHighlightBackground, rgba(255, 200, 0, 0.5)); }
            to { background-color: transparent; }
        }

        /* Arrow marking the column the table is currently display-sorted by */
        .sort-indicator {
            display: inline-block;
            margin-left: 4px;
            font-size: 0.85em;
            opacity: 0.9;
            /* Centred against the column name, which is centred too - see the
               vertical-align headerContent gets in buildTableHeader. Its own
               line box is pinned to the glyph so it cannot drift either. */
            vertical-align: middle;
            line-height: 1;
        }

        .context-menu-item.has-submenu {
            position: relative;
            padding-right: 28px;
        }

        .submenu-arrow {
            position: absolute;
            right: 10px;
            opacity: 0.7;
        }

        .context-submenu {
            display: none;
            position: absolute;
            top: -6px;
            left: 100%;
            min-width: 160px;
            max-width: 320px;
            max-height: 320px;
            overflow-y: auto;
            background-color: var(--vscode-menu-background);
            border: 1px solid var(--vscode-menu-border);
            border-radius: 3px;
            padding: 5px 0;
            z-index: 1001;
        }

        .context-menu-item.has-submenu:hover > .context-submenu,
        .context-menu-item.has-submenu.submenu-open > .context-submenu {
            display: block;
        }

        .context-submenu.flip-left {
            left: auto;
            right: 100%;
        }

        .context-submenu.flip-up {
            top: auto;
            bottom: -6px;
        }

        .context-submenu .context-menu-item {
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
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
        
        .view-controls {
            display: flex;
            align-items: center;
            gap: 10px;
            flex-wrap: wrap;
            row-gap: 8px;
            padding: 10px;
            background-color: var(--vscode-editor-background);
            border-bottom: 1px solid var(--vscode-panel-border);
            flex-shrink: 0;
        }

        /* File stats button + popover */
        .file-info-control {
            display: flex;
            flex-shrink: 0;
        }

        /* The wrapper restarts :first-of-type, so cancel the toolbar's
           margin-left: auto that would otherwise apply to the button inside */
        .file-info-control .column-manager-btn {
            margin-left: 0;
        }

        /* Positioned by positionFileInfo() - the toolbar wraps at narrow
           widths, so the button's place on screen is not fixed */
        .file-info-popover {
            position: fixed;
            top: 0;
            left: 0;
            z-index: 1000;
            min-width: 190px;
            padding: 8px 10px;
            background-color: var(--vscode-editorHoverWidget-background, var(--vscode-editor-background));
            color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground));
            border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-panel-border));
            border-radius: 3px;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
            font-size: 12px;
            cursor: default;
        }

        .file-info-row {
            display: flex;
            justify-content: space-between;
            gap: 16px;
            padding: 2px 0;
            white-space: nowrap;
        }

        .file-info-label {
            color: var(--vscode-descriptionForeground);
        }

        .segmented-control {
            display: flex;
            flex-shrink: 0;
            background-color: var(--vscode-button-secondaryBackground);
            border-radius: 5px;
            overflow: hidden;
        }

        .segmented-control button {
            background: none;
            border: none;
            padding: 0 14px;
            height: 28px;
            font-size: 13px;
            font-family: var(--vscode-font-family);
            color: var(--vscode-button-secondaryForeground);
            cursor: pointer;
            transition: background-color 0.2s;
            display: flex;
            align-items: center;
            gap: 6px;
            white-space: nowrap;
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
        }

        .raw-view {
            height: 100%;
            background-color: var(--vscode-editor-background);
        }

        .expandable-cell {
            cursor: pointer;
            position: relative;
        }
        
        .expandable-cell:hover {
            background-color: var(--vscode-list-hoverBackground);
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
        
        /* Toolbar buttons (Refresh, Follow, Find, Columns, Settings) */
        .column-manager-btn {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            padding: 0 12px;
            height: 28px;
            border-radius: 5px;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 13px;
            font-family: var(--vscode-font-family);
        }

        .column-manager-btn:first-of-type {
            margin-left: auto;
        }

        .column-manager-btn:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }

        .column-manager-btn.toggled {
            background-color: var(--vscode-inputOption-activeBackground);
            color: var(--vscode-inputOption-activeForeground);
            outline: 1px solid var(--vscode-inputOption-activeBorder);
            outline-offset: -1px;
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
            padding: 0 12px;
            height: 28px;
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

        /* Toolbar tooltips */
        [data-tooltip] {
            position: relative;
        }

        [data-tooltip]::after {
            content: attr(data-tooltip);
            position: absolute;
            top: calc(100% + 6px);
            left: 50%;
            transform: translateX(-50%);
            background-color: var(--vscode-editorHoverWidget-background, var(--vscode-editor-background));
            color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground));
            border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-panel-border));
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
            padding: 4px 8px;
            border-radius: 3px;
            font-size: 12px;
            font-weight: normal;
            line-height: 1.4;
            white-space: nowrap;
            pointer-events: none;
            opacity: 0;
            visibility: hidden;
            transition: opacity 0.1s ease 0.35s, visibility 0.1s ease 0.35s;
            z-index: 1000;
        }

        [data-tooltip]:hover::after {
            opacity: 1;
            visibility: visible;
        }

        /* Right-align tooltips on controls near the right edge of the window */
        [data-tooltip].tooltip-right::after {
            left: auto;
            right: 0;
            transform: none;
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
            position: relative;
        }
        
        .add-column-modal {
            width: 450px;
        }

        .ai-column-modal {
            width: 580px;
            max-width: 90vw;
            max-height: 90vh;
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
            align-items: baseline;
            gap: 8px;
            margin-top: 16px;
            margin-bottom: 8px;
        }

        /* AI Prompt two-column layout helper */
        .ai-prompt-row {
            display: flex;
            gap: 12px;
            align-items: stretch;
        }

        @media (max-width: 1100px) {
            .ai-prompt-row {
                flex-direction: column;
            }
            #aiInfoPanel {
                width: 100% !important;
                min-width: 0 !important;
            }
        }
        
        .field-row {
            display: flex;
            align-items: center;
            gap: 4px;
        }
        
        .column-name-input-inline {
            flex: 1;
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
        
        .column-name-input-inline:focus {
            border-color: var(--vscode-focusBorder);
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

        th:active {
            cursor: grabbing;
        }

        /* Drag and Drop for Table Rows */
        tr.dragging-row {
            opacity: 0.5;
        }
        
        tr.drag-over-row {
            border-top: 2px solid var(--vscode-focusBorder);
        }
        
        #tableBody tr {
            cursor: grab;
        }
        
        #tableBody tr:active {
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
        
        .enum-history-dropdown {
            position: fixed;
            background-color: var(--vscode-dropdown-background);
            border: 1px solid var(--vscode-dropdown-border);
            border-radius: 4px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
            z-index: 10001;
            max-height: 200px;
            overflow-y: auto;
            margin-top: 2px;
            min-width: 200px;
        }
        
        .enum-history-item {
            padding: 8px 12px;
            cursor: pointer;
            border-bottom: 1px solid var(--vscode-dropdown-border);
            font-size: 13px;
            color: var(--vscode-foreground);
            transition: background-color 0.2s;
        }
        
        .enum-history-item:hover {
            background-color: var(--vscode-list-hoverBackground);
        }
        
        .enum-history-item:last-child {
            border-bottom: none;
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
        
        .modal-button-primary:disabled,
        .modal-button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
            pointer-events: none;
        }
        
        .modal-button-secondary {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        
        .modal-button-secondary:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
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

        /* Find & Replace highlighting */
        .find-highlight {
            background-color: var(--vscode-editor-findMatchHighlightBackground);
            border: 1px solid var(--vscode-editor-findMatchBorder);
            border-radius: 2px;
        }

        .find-highlight-current {
            background-color: var(--vscode-editor-findMatchBackground);
            border: 1px solid var(--vscode-editor-findMatchBorder);
            border-radius: 2px;
        }

        td.find-highlight,
        td.find-highlight-current {
            position: relative;
        }

`;
