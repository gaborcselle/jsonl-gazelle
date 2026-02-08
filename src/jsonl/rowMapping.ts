import { JsonRow } from './types';

export function filterRowsWithIndices(rows: JsonRow[], searchTerm: string): {
    filteredRows: JsonRow[];
    filteredRowIndices: number[];
} {
    if (!searchTerm) {
        return {
            filteredRows: rows,
            filteredRowIndices: rows.map((_, index) => index)
        };
    }

    const filteredRows: JsonRow[] = [];
    const filteredRowIndices: number[] = [];
    const term = searchTerm.toLowerCase();

    rows.forEach((row, index) => {
        const searchText = JSON.stringify(row).toLowerCase();
        if (searchText.includes(term)) {
            filteredRows.push(row);
            filteredRowIndices.push(index);
        }
    });

    return { filteredRows, filteredRowIndices };
}
