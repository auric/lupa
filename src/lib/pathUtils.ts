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
export const FILE_PATH_REGEX =
    /(?:^|[\s([{,;])((?:[`"']?)(?:[a-zA-Z]:[/\\]|\.{0,2}[/\\]|[a-zA-Z0-9._-]+[/\\])[a-zA-Z0-9._/\\-]*\.[a-zA-Z0-9]+(?:[`"'])?)(?:\s*(?:[:([\s]?\s*(?:line\s+)?(\d+)(?:\s*[:\],]?\s*(?:col(?:umn)?\s*)?(\d+))?\s*[)\]]?)|(?:\s+at\s+line\s+(\d+)))?/gi;

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
        if (!filePath) {
            continue;
        }

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
        const matchedFilePath = match[1]!;
        const filePathStart = match.index + match[0].indexOf(matchedFilePath);
        const filePathEnd = filePathStart + matchedFilePath.length;

        paths.push({
            fullMatch: match[0],
            filePath,
            line,
            column,
            startIndex: filePathStart,
            endIndex: filePathEnd,
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
    // Get the filename (last segment of path)
    const filename = path.split(/[/\\]/).pop() || path;

    // Must have a file extension OR be a dot-prefixed file (like .gitignore, .env)
    const hasDotPrefix = filename.startsWith('.') && filename.length > 1;
    const hasExtension = /\.[a-zA-Z0-9]+$/.test(path);
    if (!hasDotPrefix && !hasExtension) {
        return false;
    }

    // Must not be too short or too long
    if (path.length < 2 || path.length > 1000) {
        return false;
    }

    // Must not contain invalid characters for file paths
    if (/[<>"|*?]/.test(path)) {
        return false;
    }

    // Must not be just dots (like . or ..)
    if (/^\.\.?$/.test(filename)) {
        return false;
    }

    return true;
}

/**
 * Parse a markdown link URL to extract file path and location information.
 * Supports formats like:
 * - src/file.ts:42
 * - src/file.ts:42:10 (line:column)
 * - src/file.ts:104-115 (line range)
 * - src/file.ts#L42 (GitHub-style single line)
 * - src/file.ts#L42-L50 (GitHub-style line range)
 * - src/file.ts#L42-50 (GitHub-style mixed format)
 * - src/file.ts
 * - README.md (root-level files without directory prefix)
 * - .gitignore, .env (dot files)
 * - C:\src\file.ts:42 (Windows absolute paths)
 * - D:\project\main.ts:10:5
 *
 * @param url The URL from a markdown link
 * @returns Parsed path information or null if not a file path
 */
export function parseFilePathFromUrl(url: string): {
    filePath: string;
    line?: number;
    endLine?: number;
    column?: number;
} | null {
    // Skip external URLs (http:, https:, mailto:, etc.) but NOT Windows drive letters
    // Windows drive letters are single letters followed by colon, e.g., C: or D:
    if (/^[a-z]{2,}:/i.test(url)) {
        return null;
    }

    // Try GitHub-style line format first: file.ts#L42 or file.ts#L42-L50 or file.ts#L42-50
    const githubMatch = url.match(
        /^((?:[a-zA-Z]:[/\\])?[^#]+)#L(\d+)(?:-L?(\d+))?$/
    );
    if (githubMatch && githubMatch[1]) {
        const filePath = githubMatch[1];
        const line = parseInt(githubMatch[2]!, 10);
        const endLine = githubMatch[3]
            ? parseInt(githubMatch[3], 10)
            : undefined;

        if (isValidFilePath(filePath)) {
            return { filePath, line, endLine, column: undefined };
        }
    }

    // Match file paths with optional line info (colon-based format):
    // - :line (single line)
    // - :line-endLine (line range)
    // - :line:column (line and column)
    // Supports:
    // - Paths with extensions: src/file.ts, C:\file.ts
    // - Root-level files: README.md, package.json
    // - Dot files: .gitignore, src/.env
    // - Both forward and backslash separators (Windows and Unix)
    const match = url.match(
        /^((?:[a-zA-Z]:[/\\])?(?:[^:]*[/\\])?(?:\.[^:/\\]+|[^:/\\]+\.[a-zA-Z0-9]+))(?::(\d+)(?:-(\d+)|:(\d+))?)?$/
    );
    if (!match || !match[1]) {
        return null;
    }

    const filePath = match[1];
    const line = match[2] ? parseInt(match[2], 10) : undefined;
    const endLine = match[3] ? parseInt(match[3], 10) : undefined;
    const column = match[4] ? parseInt(match[4], 10) : undefined;

    if (!isValidFilePath(filePath)) {
        return null;
    }

    return { filePath, line, endLine, column };
}

/**
 * Represents a segment of markdown content that can be either text or a file link.
 */
export interface MarkdownSegment {
    type: 'text' | 'fileLink';
    content: string;
    /** For file links: the parsed file path */
    filePath?: string;
    /** For file links: the start line number (1-based) */
    line?: number;
    /** For file links: the end line for ranges (1-based), e.g., :104-115 */
    endLine?: number;
    /** For file links: the column number (1-based) */
    column?: number;
    /** For file links: the display title from markdown link text */
    title?: string;
}

/**
 * Parse markdown content to extract file links and split into segments.
 * This allows streaming markdown with proper file link handling in VS Code Chat.
 *
 * Matches markdown links like:
 * - [file.ts:42](file.ts:42)
 * - [src/main.ts](src/main.ts:10:5)
 * - [handler.ts:45](src/auth/handler.ts:45)
 *
 * @param markdown The markdown content to parse
 * @returns Array of segments alternating between text and file links
 */
export function parseMarkdownFileLinks(markdown: string): MarkdownSegment[] {
    const segments: MarkdownSegment[] = [];

    // Match markdown links: [title](url)
    const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = linkRegex.exec(markdown)) !== null) {
        const [fullMatch, title, url] = match;
        if (!url) {
            continue;
        }
        const parsedPath = parseFilePathFromUrl(url);

        // Add text before this match
        if (match.index > lastIndex) {
            segments.push({
                type: 'text',
                content: markdown.slice(lastIndex, match.index),
            });
        }

        if (parsedPath) {
            // This is a file link
            segments.push({
                type: 'fileLink',
                content: fullMatch,
                filePath: parsedPath.filePath,
                line: parsedPath.line,
                endLine: parsedPath.endLine,
                column: parsedPath.column,
                title,
            });
        } else {
            // Not a file link, keep as text (regular markdown link)
            segments.push({
                type: 'text',
                content: fullMatch,
            });
        }

        lastIndex = match.index + fullMatch.length;
    }

    // Add remaining text after last match
    if (lastIndex < markdown.length) {
        segments.push({
            type: 'text',
            content: markdown.slice(lastIndex),
        });
    }

    return segments;
}
