/**
 * Log-level coloring for the Table view.
 *
 * Structured logs (pino, bunyan, winston, structlog, Python logging, OpenTelemetry...)
 * are one of the most common kinds of JSONL file. When a column is recognisably a
 * log level, its cells are tinted by severity so errors and warnings stand out.
 *
 * Only columns whose name (the last segment of the path) is a known level field get
 * colored, so a `"status": "error"` or a free-text field that happens to say "info"
 * is left alone.
 *
 * Keep in sync with the copy in `src/webview/scripts.ts` (see the
 * `shared:log-levels` block, which the tests extract).
 */

export type LogLevelCategory = 'error' | 'warn' | 'info' | 'debug';

const LEVEL_COLUMN_NAMES = new Set([
    'level',
    'loglevel',
    'log_level',
    'levelname',
    'level_name',
    'lvl',
    'severity',
    'severitytext',
    'severity_text'
]);

const LEVEL_WORDS: { [word: string]: LogLevelCategory } = {
    emerg: 'error',
    emergency: 'error',
    alert: 'error',
    panic: 'error',
    fatal: 'error',
    critical: 'error',
    crit: 'error',
    severe: 'error',
    error: 'error',
    err: 'error',
    warning: 'warn',
    warn: 'warn',
    notice: 'info',
    info: 'info',
    information: 'info',
    informational: 'info',
    debug: 'debug',
    trace: 'debug',
    verbose: 'debug',
    fine: 'debug',
    finer: 'debug',
    finest: 'debug'
};

/** True when a column path names a log-level field, e.g. `level` or `log.level`. */
export function isLogLevelColumn(columnPath: string): boolean {
    if (typeof columnPath !== 'string' || columnPath === '') {
        return false;
    }
    const lower = columnPath.toLowerCase();
    if (LEVEL_COLUMN_NAMES.has(lower)) {
        return true;
    }
    const lastDot = lower.lastIndexOf('.');
    return lastDot !== -1 && LEVEL_COLUMN_NAMES.has(lower.slice(lastDot + 1));
}

/**
 * The severity bucket for a cell, or null when it should not be colored.
 * Accepts level names (case-insensitive) and the numeric levels pino and bunyan
 * write (10 trace, 20 debug, 30 info, 40 warn, 50 error, 60 fatal).
 */
export function getLogLevelCategory(columnPath: string, value: unknown): LogLevelCategory | null {
    if (!isLogLevelColumn(columnPath)) {
        return null;
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value) || value < 10 || value > 60) {
            return null;
        }
        if (value >= 50) { return 'error'; }
        if (value >= 40) { return 'warn'; }
        if (value >= 30) { return 'info'; }
        return 'debug';
    }
    if (typeof value !== 'string') {
        return null;
    }
    const word = value.trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(LEVEL_WORDS, word) ? LEVEL_WORDS[word] : null;
}
