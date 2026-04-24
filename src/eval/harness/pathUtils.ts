export function pathsEqualForComparison(
    leftPath: string,
    rightPath: string
): boolean {
    return (
        normalizePathComparisonKey(leftPath) ===
        normalizePathComparisonKey(rightPath)
    );
}

export function normalizePathComparisonKey(filePath: string): string {
    const normalized = filePath.replace(/\\/g, '/');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function pathsMatchBySuffix(
    leftPath: string,
    rightPath: string
): boolean {
    const normalizedLeftPath = normalizePathComparisonKey(leftPath);
    const normalizedRightPath = normalizePathComparisonKey(rightPath).replace(
        /^\//,
        ''
    );
    return (
        normalizedLeftPath === normalizedRightPath ||
        normalizedLeftPath.endsWith(`/${normalizedRightPath}`)
    );
}

export function pathMatchesCitedSuffix(
    candidatePath: string,
    citedPath: string
): boolean {
    return pathsMatchBySuffix(candidatePath, citedPath);
}
