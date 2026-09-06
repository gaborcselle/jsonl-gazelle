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

// The cursor also reaches the column headers and the row-number cells, which
// carry actions of their own and a hint that spells them out
['cursorZone', 'cycleCursorColumnSort', 'moveCursorRowInFile', 'deleteCursorRow',
 'showCursorHint', 'hideCursorHint', 'getHeaderRow'].forEach(name => {
    assert.ok(scripts.includes('function ' + name), 'expected function ' + name + ' in webview scripts');
});
assert.ok(styles.includes('th.cell-cursor'), 'the cursor on a column header needs a style');

// The sort arrow aligns against the column-name span, and that span clips its
// overflow - which makes its baseline its bottom edge. Both have to be centred
// or the arrow hangs below the name it belongs to.
assert.ok(/headerContent\.style\.verticalAlign = 'middle'/.test(scripts),
    'the column-name span must be centred so the sort arrow lines up with it');
assert.ok(/\.sort-indicator\s*\{[^}]*vertical-align:\s*middle/.test(styles),
    'and the sort arrow must be centred too');
assert.ok(styles.includes('.cursor-hint'), 'the header hint needs a style');

// The row-number column's sentinel path is a NUL so no real JSON key can
// collide with it. This file is a template literal, so the escape has to
// survive into the emitted script: a raw NUL inlined into the page's HTML
// is rewritten to U+FFFD by the parser before any JS ever sees it.
assert.ok(!scripts.includes(String.fromCharCode(0)),
    'the webview script must not carry a raw NUL into the page HTML');
assert.ok(scripts.includes("'\\u0000row-header'"),
    'the row-header sentinel must reach the webview as an escape');
assert.ok(getHtmlTemplate({}).includes('id="cursorHint"'), 'the header hint needs an element to render into');
assert.ok(/letter === 's'/.test(scripts), 'S must cycle the sort from a column header');
assert.ok(/letter === 'u' \|\| letter === 'd'/.test(scripts), 'U and D must move the cursor row in the file');
assert.ok(/e\.key === 'Delete' \|\| e\.key === 'Backspace'/.test(scripts), 'Delete must remove the cursor row');

console.log('webviewScripts tests passed');
