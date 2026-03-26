/**
 * Case-insensitive path suffix match with path boundary check.
 * Returns true when `suffix` matches the end of `fullPath` at a `/` boundary
 * (or is an exact match). Used by tool gates that compare model-provided paths
 * against canonical paths from diffs or investigatedFiles.
 */
export function pathSuffixMatch(fullPath: string, suffix: string): boolean {
    const fp = fullPath.toLowerCase();
    const sf = suffix.toLowerCase();
    if (fp === sf) {
        return true;
    }
    if (!fp.endsWith(sf)) {
        return false;
    }
    return fp[fp.length - sf.length - 1] === '/';
}
