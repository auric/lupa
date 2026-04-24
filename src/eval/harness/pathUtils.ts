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
    return process.platform === 'win32' ? filePath.toLowerCase() : filePath;
}

export function pathsMatchBySuffix(
    leftPath: string,
    rightPath: string
): boolean {
    const normalizedLeftPath = normalizePathComparisonKey(leftPath);
    const normalizedRightPath = normalizePathComparisonKey(rightPath);
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
