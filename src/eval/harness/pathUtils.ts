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
    const normalized =
        process.platform === 'win32' ? filePath.replace(/\\/g, '/') : filePath;
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
    if (normalizedRightPath.length === 0) {
        return false;
    }
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
