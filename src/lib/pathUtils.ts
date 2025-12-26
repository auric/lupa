export interface ParsedPath {
    fullMatch: string;
    filePath: string;
    line?: number;
    column?: number;
    startIndex: number;
    endIndex: number;
}

/**
 * Regex to match file paths in text
 * Requirements:
 * - Must contain at least one path separator (/ or \)
 * - Must have a reasonable file extension
 * - Handles quoted paths and line numbers
 * - Matches relative paths like src/file.ts and absolute paths
 */
export const FILE_PATH_REGEX = /(?:^|[\s\(\[\{,;])((?:[`"']?)(?:[a-zA-Z]:[/\\]|\.{0,2}[/\\]|[a-zA-Z0-9._-]+[/\\])[a-zA-Z0-9._/\\\-]*\.[a-zA-Z0-9]+(?:[`"'])?)(?:\s*(?:[:(\[\s]?\s*(?:line\s+)?(\d+)(?:\s*[:\],]?\s*(?:col(?:umn)?\s*)?(\d+))?\s*[\)\]]?)|(?:\s+at\s+line\s+(\d+)))?/gi;

/**
 * Parse text content to find all potential file paths
 * @param text The text content to parse
 * @returns Array of parsed path objects
 */
export function parseFilePaths(text: string): ParsedPath[] {
    const paths: ParsedPath[] = [];

    // Create a new regex instance to avoid global state issues
    const regex = new RegExp(FILE_PATH_REGEX.source, FILE_PATH_REGEX.flags);
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
        let filePath = match[1];
        const lineStr = match[2] || match[4]; // Handle both formats: :123 and "at line 123"
        const columnStr = match[3];

        // Clean up quotes and backticks from file path
        filePath = filePath.replace(/^[`"']|[`"']$/g, '');

        // Skip if the path doesn't look like a real file path
        if (!isValidFilePath(filePath)) {
            continue;
        }

        const line = lineStr ? parseInt(lineStr, 10) : undefined;
        const column = columnStr ? parseInt(columnStr, 10) : undefined;

        // Calculate correct start and end indices
        const filePathStart = match.index + match[0].indexOf(match[1]);
        const filePathEnd = filePathStart + match[1].length;

        paths.push({
            fullMatch: match[0],
            filePath,
            line,
            column,
            startIndex: filePathStart,
            endIndex: filePathEnd
        });
    }

    return paths;
}

/**
 * Validate if a string looks like a legitimate file path
 * @param path The path string to validate
 * @returns True if it looks like a valid file path
 */
function isValidFilePath(path: string): boolean {
    // Must have a file extension
    if (!/\.[a-zA-Z0-9]+$/.test(path)) {
        return false;
    }

    // Must not be too short or too long
    if (path.length < 3 || path.length > 1000) {
        return false;
    }

    // Must not contain invalid characters for file paths
    if (/[<>"|*?]/.test(path)) {
        return false;
    }

    // Must not be just dots
    if (/^\.+$/.test(path.replace(/[/\\]/g, ''))) {
        return false;
    }

    return true;
}

/**
 * Parse a markdown link URL to extract file path and location information.
 * Supports formats like:
 * - src/file.ts:42
 * - src/file.ts:42:10
 * - src/file.ts
 * 
 * @param url The URL from a markdown link
 * @returns Parsed path information or null if not a file path
 */
export function parseFilePathFromUrl(url: string): { filePath: string; line?: number; column?: number } | null {
    if (/^[a-z]+:/i.test(url)) {
        return null;
    }

    const match = url.match(/^([^:]+\.[a-zA-Z0-9]+)(?::(\d+))?(?::(\d+))?$/);
    
    if (!match) {
        return null;
    }

    const filePath = match[1];
    const line = match[2] ? parseInt(match[2], 10) : undefined;
    const column = match[3] ? parseInt(match[3], 10) : undefined;

    if (!isValidFilePath(filePath)) {
        return null;
    }

    return { filePath, line, column };
}
