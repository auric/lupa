import { clamp } from './helpers';

export interface Page<T> {
    items: T[];
    pageIndex: number;
    pageCount: number;
}

export function paginate<T>(
    items: T[],
    pageSize: number,
    pageIndex: number
): Page<T> {
    if (pageSize <= 0) {
        throw new Error('pageSize must be positive');
    }
    const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
    const safeIndex = clamp(pageIndex, 0, pageCount - 1);
    const start = safeIndex * pageSize;
    const end = Math.min(start + pageSize, items.length);

    const out: T[] = [];
    for (let i = start; i < end; i++) {
        out.push(items[i]);
    }
    return { items: out, pageIndex: safeIndex, pageCount };
}
