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
 * Row `-1` is the column-header row and column `-1` is the row-number column,
 * reachable only when `bounds` opens them up, and only by the arrow keys.
 * They never intersect: the cell where they would cross is the row-number
 * header, which carries the hidden-columns badge rather than anything the
 * cursor can act on.
 *
 * Keep in sync with the copy in `src/webview/scripts.ts` (see the
 * `shared:grid-navigation` block, which the webview tests extract).
 */

export interface GridPosition {
    row: number;
    column: number;
}

/** How far above and to the left of the data grid the cursor may go: 0 (the
 *  default) keeps it in the data cells, -1 opens the header row / row-number
 *  column. */
export interface GridBounds {
    minRow?: number;
    minColumn?: number;
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
    pageSize?: number,
    bounds?: GridBounds | null
): GridPosition | null {
    if (!(rowCount > 0) || !(columnCount > 0)) {
        return null;
    }

    const firstRow = bounds && bounds.minRow === -1 ? -1 : 0;
    const firstColumn = bounds && bounds.minColumn === -1 ? -1 : 0;
    const lastRow = rowCount - 1;
    const lastColumn = columnCount - 1;
    const page = pageSize && pageSize > 0 ? Math.floor(pageSize) : 1;

    if (!cursor) {
        return { row: 0, column: 0 };
    }

    // Rows can be filtered away and columns hidden between two keystrokes, so a
    // stored cursor is clamped back into the grid before it is moved
    let row = clampIndex(cursor.row, firstRow, lastRow);
    let column = clampIndex(cursor.column, firstColumn, lastColumn);

    // Only the arrow keys step onto a header. Tab is a data-entry motion and
    // Home/End/paging are grid motions, so those keep the cursor in the band it
    // is already in - they walk along a header but never wander onto one.
    const bandRow = Math.min(0, row);
    const bandColumn = Math.min(0, column);

    switch (move) {
        case 'up':
            row = Math.max(firstRow, row - 1);
            break;
        case 'down':
            row = Math.min(lastRow, row + 1);
            break;
        case 'left':
            column = Math.max(firstColumn, column - 1);
            break;
        case 'right':
            column = Math.min(lastColumn, column + 1);
            break;
        case 'rowStart':
            column = bandColumn;
            break;
        case 'rowEnd':
            column = lastColumn;
            break;
        case 'pageUp':
            row = Math.max(bandRow, row - page);
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
            if (column > bandColumn) {
                column = column - 1;
            } else if (row > bandRow) {
                row = row - 1;
                column = lastColumn;
            }
            break;
        default:
            break;
    }

    // The header row and the row-number column do not cross. Whichever axis
    // moved into the corner steps back, so the move reads as "stopped at the
    // edge" rather than sliding the cursor sideways into the other header.
    if (row < 0 && column < 0) {
        if (move === 'up' || move === 'down' || move === 'pageUp' || move === 'pageDown') {
            row = 0;
        } else {
            column = 0;
        }
    }

    return { row: row, column: column };
}

function clampIndex(value: number, min: number, max: number): number {
    if (typeof value !== 'number' || !isFinite(value)) {
        return min;
    }
    return Math.min(Math.max(min, Math.floor(value)), max);
}
