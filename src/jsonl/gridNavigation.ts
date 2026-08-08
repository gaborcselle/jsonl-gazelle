/**
 * Cell-cursor movement for the table view's spreadsheet-style keyboard navigation.
 *
 * Positions are *display* coordinates: `row` indexes the rows currently on screen
 * (after search filtering and any display sort) and `column` indexes the visible
 * columns only. The webview stores the cursor as a file row index plus a column
 * path — see `setCellCursor` in `src/webview/scripts.ts` — and converts to and
 * from these coordinates around each move, so hiding a column or filtering rows
 * never leaves the cursor pointing at a cell that is no longer there.
 *
 * Keep in sync with the copy in `src/webview/scripts.ts` (see the
 * `shared:grid-navigation` block, which the webview tests extract).
 */

export interface GridPosition {
    row: number;
    column: number;
}

export type GridMove =
    | 'up'
    | 'down'
    | 'left'
    | 'right'
    | 'next'       // Tab
    | 'previous'   // Shift+Tab
    | 'rowStart'   // Home
    | 'rowEnd'     // End
    | 'pageUp'
    | 'pageDown';

/**
 * The cursor position after `move`, or null when the grid has no cells.
 *
 * Arrow keys stop at the edges; Tab/Shift+Tab wrap around the end of a row into
 * the next/previous one and stop at the grid's first and last cell. A missing or
 * out-of-range cursor is treated as entering the grid at the first cell.
 */
export function moveGridCursor(
    cursor: GridPosition | null | undefined,
    move: GridMove,
    rowCount: number,
    columnCount: number,
    pageSize?: number
): GridPosition | null {
    if (!(rowCount > 0) || !(columnCount > 0)) {
        return null;
    }

    const lastRow = rowCount - 1;
    const lastColumn = columnCount - 1;
    const page = pageSize && pageSize > 0 ? Math.floor(pageSize) : 1;

    if (!cursor) {
        return { row: 0, column: 0 };
    }

    // Rows can be filtered away and columns hidden between two keystrokes, so a
    // stored cursor is clamped back into the grid before it is moved
    let row = clampIndex(cursor.row, lastRow);
    let column = clampIndex(cursor.column, lastColumn);

    switch (move) {
        case 'up':
            row = Math.max(0, row - 1);
            break;
        case 'down':
            row = Math.min(lastRow, row + 1);
            break;
        case 'left':
            column = Math.max(0, column - 1);
            break;
        case 'right':
            column = Math.min(lastColumn, column + 1);
            break;
        case 'rowStart':
            column = 0;
            break;
        case 'rowEnd':
            column = lastColumn;
            break;
        case 'pageUp':
            row = Math.max(0, row - page);
            break;
        case 'pageDown':
            row = Math.min(lastRow, row + page);
            break;
        case 'next':
            if (column < lastColumn) {
                column = column + 1;
            } else if (row < lastRow) {
                row = row + 1;
                column = 0;
            }
            break;
        case 'previous':
            if (column > 0) {
                column = column - 1;
            } else if (row > 0) {
                row = row - 1;
                column = lastColumn;
            }
            break;
        default:
            break;
    }

    return { row: row, column: column };
}

function clampIndex(value: number, max: number): number {
    if (typeof value !== 'number' || !isFinite(value)) {
        return 0;
    }
    return Math.min(Math.max(0, Math.floor(value)), max);
}
