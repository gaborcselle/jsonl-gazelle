const assert = require('assert');
const { scripts } = require('../out/webview/scripts');

// The webview JS ships as a template-literal string that tsc never parses,
// so an escaping mistake would only surface as a blank webview at runtime.
// new Function() parses the script body and throws on any syntax error.
assert.doesNotThrow(() => new Function(scripts), 'webview scripts string must be valid JavaScript');

// Sanity: key functions of the table pipeline are present
['updateTable', 'buildTableHeader', 'renderTableChunk', 'createTableRow', 'rebuildTable', 'flushDeferredUpdate', 'appendRows', 'restoreTableScroll', 'updateLoadingBanner'].forEach(name => {
    assert.ok(scripts.includes('function ' + name), 'expected function ' + name + ' in webview scripts');
});

// Sanity: the row details side panel pipeline is present
['createJsonNode', 'renderRowDetails', 'syncRowDetailsVisibility', 'setRowDetailsOpen', 'showRowDetailsFor', 'setAllJsonNodesExpanded'].forEach(name => {
    assert.ok(scripts.includes('function ' + name), 'expected function ' + name + ' in webview scripts');
});

// The panel is a webview-only feature except for its persisted open/closed state
assert.ok(scripts.includes("type: 'setRowDetailsPreference'"), 'row details panel must persist its state via setRowDetailsPreference');

// jsonValueSummary is pure; check its formatting directly
const summarySource = scripts.match(/function jsonValueSummary\(value\) \{[\s\S]*?\n {8}\}/);
assert.ok(summarySource, 'expected jsonValueSummary in webview scripts');
const jsonValueSummary = new Function(summarySource[0] + '\nreturn jsonValueSummary;')();
assert.strictEqual(jsonValueSummary([]), '[0 items]');
assert.strictEqual(jsonValueSummary(['a']), '[1 item]');
assert.strictEqual(jsonValueSummary(['a', 'b']), '[2 items]');
assert.strictEqual(jsonValueSummary({}), '{0 keys}');
assert.strictEqual(jsonValueSummary({ a: 1 }), '{1 key}');
assert.strictEqual(jsonValueSummary({ a: 1, b: 2 }), '{2 keys}');

console.log('webviewScripts tests passed');
