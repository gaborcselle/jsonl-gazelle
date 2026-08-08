const assert = require('assert');
const { scripts } = require('../out/webview/scripts');
const { styles } = require('../out/webview/styles');
const { getHtmlTemplate } = require('../out/webview/template');

// The webview JS ships as a template-literal string that tsc never parses,
// so an escaping mistake would only surface as a blank webview at runtime.
// new Function() parses the script body and throws on any syntax error.
assert.doesNotThrow(() => new Function(scripts), 'webview scripts string must be valid JavaScript');

// Sanity: key functions of the table pipeline are present
['updateTable', 'buildTableHeader', 'renderTableChunk', 'createTableRow', 'rebuildTable', 'flushDeferredUpdate', 'appendRows', 'restoreTableScroll', 'updateLoadingBanner', 'renderFileInfo', 'toggleFileInfo', 'setDisplaySort', 'watchSortJump', 'checkSortJump', 'hideSortJumpNotice', 'jumpToDisplayRow', 'moveGridCursor', 'moveCellCursor', 'setCellCursor', 'clearCellCursor', 'getCursorPosition', 'getCursorCell', 'editCursorCell', 'isGridNavigationActive'].forEach(name => {
    assert.ok(scripts.includes('function ' + name), 'expected function ' + name + ' in webview scripts');
});

// Both sort flavours must reach the extension: the display-only sort and the
// one that rewrites the file
assert.ok(scripts.includes("type: 'setDisplaySort'"), 'expected a setDisplaySort message');
assert.ok(scripts.includes("type: 'sortRows'"), 'expected a sortRows message');
['displaySortAsc', 'displaySortDesc', 'clearDisplaySort', 'sortAsc', 'sortDesc'].forEach(action => {
    assert.ok(scripts.includes("case '" + action + "'"), 'expected context menu action ' + action);
});

// Every column context-menu entry must be handled by the script's action
// switch, or the menu item would silently do nothing when clicked.
const html = getHtmlTemplate('icon', 'anim', '', '', 'csp', 'nonce');
const contextMenu = html.slice(html.indexOf('id="contextMenu"'), html.indexOf('id="rowContextMenu"'));
const menuActions = [...contextMenu.matchAll(/data-action="([^"]+)"/g)].map(match => match[1]);
assert.ok(menuActions.length > 0, 'expected data-action entries in the column context menu');
menuActions.forEach(action => {
    assert.ok(scripts.includes("case '" + action + "'"), 'context menu action ' + action + ' has no handler');
});
// The sort entries live in a "Sort" submenu rather than crowding the top level
const sortSubmenu = contextMenu.slice(contextMenu.indexOf('id="sortSubmenu"'));
['displaySortAsc', 'displaySortDesc', 'clearDisplaySort', 'sortAsc', 'sortDesc'].forEach(action => {
    assert.ok(menuActions.includes(action), 'expected context menu entry for ' + action);
    assert.ok(sortSubmenu.includes('data-action="' + action + '"'),
        'sort entry ' + action + ' must live inside the Sort submenu');
});
// The submenu's parent must be column-only: the menu also opens from the
// row-number header with no column selected, where sorting has nothing to act on
const sortParentEnd = contextMenu.indexOf('id="sortMenuItem"');
const sortParent = contextMenu.slice(Math.max(0, sortParentEnd - 160), sortParentEnd);
assert.ok(sortParent.includes('column-only'), 'the Sort menu entry must be column-only');
assert.ok(sortParent.includes('has-submenu'), 'the Sort menu entry must be a submenu parent');
// The type hint belongs with the sort entries it describes
assert.ok(sortSubmenu.includes('id="sortTypeHint"'), 'the sort type hint must live in the Sort submenu');

// The "row moved" notice needs its markup and both of its buttons wired up
['sortJumpNotice', 'sortJumpNoticeText', 'sortJumpGoBtn', 'sortJumpCloseBtn'].forEach(id => {
    assert.ok(html.includes('id="' + id + '"'), 'expected element ' + id + ' in the template');
    assert.ok(scripts.includes("'" + id + "'"), 'expected ' + id + ' to be referenced by the scripts');
});
// Editing the sorted column must arm the watch that produces that notice
assert.ok(/watchSortJump\(rowIndex, columnPath\)/.test(scripts), 'cell edits must arm the sort-jump watch');

// Spreadsheet keyboard navigation: every key the grid claims must be mapped,
// and the cursor needs a style or it would move invisibly
['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].forEach(key => {
    assert.ok(new RegExp(key + ':').test(scripts), 'expected a grid navigation mapping for ' + key);
});
assert.ok(scripts.includes("e.key === 'Tab'"), 'Tab must be handled by the grid');
assert.ok(/e\.key === 'Enter' \|\| e\.key === 'F2'/.test(scripts), 'Enter (and F2) must start an edit');
assert.ok(styles.includes('td.cell-cursor'), 'the cell cursor needs a style');

console.log('webviewScripts tests passed');
