const fs = require('fs');
const path = require('path');

const rows = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample-data.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map(line => JSON.parse(line));

function detectColumns(rows) {
  const order = [];
  const seen = new Set();
  rows.forEach(row => {
    Object.keys(row).forEach(k => {
      if (!seen.has(k)) { seen.add(k); order.push(k); }
    });
  });
  return order.map(path => ({ path, displayName: path, visible: true, isExpanded: false }));
}

function makeInitialState() {
  const columns = detectColumns(rows);
  const rawContent = rows.map(r => JSON.stringify(r)).join('\n');

  const prettyContent = rows.map(r => JSON.stringify(r, null, 2)).join('\n');

  return {
    rows,
    allRows: rows,
    rowIndices: rows.map((_, i) => i),
    columns,
    parsedLines: rows.map((r, i) => ({ data: r, lineNumber: i + 1, rawLine: JSON.stringify(r) })),
    rawContent,
    prettyContent,
    errorCount: 0,
    loadingProgress: null,
    appendCompatible: false,
    displaySort: null,
    uiPreferences: { lastView: 'table' },
  };
}

function getByPath(obj, p) {
  const parts = p.split('.');
  let cur = obj;
  for (const part of parts) {
    const m = /^([^\[]+)((?:\[\d+\])*)$/.exec(part);
    if (!m) return undefined;
    const key = m[1];
    if (cur == null) return undefined;
    cur = cur[key];
    const idxMatches = m[2].match(/\[(\d+)\]/g) || [];
    for (const im of idxMatches) {
      if (cur == null) return undefined;
      cur = cur[parseInt(im.slice(1, -1), 10)];
    }
  }
  return cur;
}

function getSampleValue(state, columnPath) {
  for (const row of state.rows) {
    const v = getByPath(row, columnPath);
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

// Mirrors JsonlViewerProvider#expandColumn (src/jsonlViewerProvider.ts) closely
// enough for screenshot purposes: replaces an object/array column with one
// column per child field.
function expandColumn(state, columnPath) {
  const column = state.columns.find(c => c.path === columnPath);
  if (!column) return state;
  const sample = getSampleValue(state, columnPath);
  if (!sample || typeof sample !== 'object') return state;

  column.isExpanded = true;
  column.visible = false;
  const idx = state.columns.indexOf(column);
  const newColumns = [];

  if (Array.isArray(sample)) {
    sample.forEach((_, i) => {
      const newPath = `${columnPath}[${i}]`;
      if (!state.columns.find(c => c.path === newPath)) {
        newColumns.push({ path: newPath, displayName: newPath, visible: true, isExpanded: false, parentPath: columnPath });
      }
    });
  } else {
    Object.keys(sample).forEach(key => {
      const newPath = `${columnPath}.${key}`;
      if (!state.columns.find(c => c.path === newPath)) {
        newColumns.push({ path: newPath, displayName: newPath, visible: true, isExpanded: false, parentPath: columnPath });
      }
    });
  }
  state.columns.splice(idx + 1, 0, ...newColumns);
  return state;
}

function typeOfValue(v) {
  if (v === null || v === undefined) return 'text';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return 'timestamp';
  return 'text';
}

// Mirrors the display-sort behavior in src/jsonl/sorting.ts closely enough for
// screenshot purposes (type autodetection + row/index reordering).
function applyDisplaySort(state, columnPath, direction) {
  const indexed = state.rowIndices.map((actualIdx, pos) => ({ actualIdx, row: state.allRows[pos] }));
  const kind = typeOfValue(getSampleValue(state, columnPath));
  indexed.sort((a, b) => {
    const va = getByPath(a.row, columnPath);
    const vb = getByPath(b.row, columnPath);
    let cmp;
    if (kind === 'number') cmp = (va ?? -Infinity) - (vb ?? -Infinity);
    else if (kind === 'timestamp') cmp = new Date(va) - new Date(vb);
    else cmp = String(va ?? '').localeCompare(String(vb ?? ''));
    return direction === 'desc' ? -cmp : cmp;
  });
  state.rows = indexed.map(e => e.row);
  state.rowIndices = indexed.map(e => e.actualIdx);
  state.displaySort = { columnPath, direction };
  return state;
}

function hideColumn(state, columnPath) {
  const column = state.columns.find(c => c.path === columnPath);
  if (column) column.visible = false;
  return state;
}

module.exports = { makeInitialState, expandColumn, hideColumn, applyDisplaySort, getByPath };
