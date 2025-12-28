import type {
    DiffHunk,
    DiffHunkLine,
    ParsedDiffLine,
} from '../types/contextTypes';

/**
 * Utilities for parsing and working with diff content
 */
export class DiffUtils {
    /**
     * Parse diff string into structured format with enhanced metadata
     * @param diff The raw diff content
     * @returns Array of parsed diff hunks with structured line information
     */
    static parseDiff(diff: string): DiffHunk[] {
        const files: DiffHunk[] = [];
        const lines = diff.split('\n');
        let currentFile: DiffHunk | null = null;
        let currentHunk: DiffHunkLine | null = null;

        for (const line of lines) {
            // Check for file header (diff --git a/... b/...)
            const fileMatch = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
            if (fileMatch) {
                const oldPath = fileMatch[1];
                const newPath = fileMatch[2];
                if (!oldPath || !newPath) {
                    continue;
                }

                // Determine file operation type
                const isNewFile = oldPath === 'dev/null';
                const isDeletedFile = newPath === 'dev/null';
                const filePath = isDeletedFile ? oldPath : newPath;

                currentFile = {
                    filePath,
                    hunks: [],
                    isNewFile: isNewFile,
                    isDeletedFile: isDeletedFile,
                    originalHeader: line,
                };
                files.push(currentFile);
                currentHunk = null;
                continue;
            }

            // Skip file metadata lines (---, +++, index, etc.)
            if (
                line.startsWith('---') ||
                line.startsWith('+++') ||
                line.startsWith('index ') ||
                line.startsWith('new file mode') ||
                line.startsWith('deleted file mode') ||
                line.startsWith('similarity index') ||
                line.startsWith('rename from') ||
                line.startsWith('rename to')
            ) {
                continue;
            }

            if (currentFile) {
                // Check for hunk header (@@ -oldStart,oldLines +newStart,newLines @@)
                const hunkHeaderMatch =
                    /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(
                        line
                    );
                if (hunkHeaderMatch) {
                    const oldStartStr = hunkHeaderMatch[1];
                    const newStartStr = hunkHeaderMatch[3];
                    if (!oldStartStr || !newStartStr) {
                        continue;
                    }

                    const oldStart = parseInt(oldStartStr, 10);
                    const oldLines = hunkHeaderMatch[2]
                        ? parseInt(hunkHeaderMatch[2], 10)
                        : 1;
                    const newStart = parseInt(newStartStr, 10);
                    const newLines = hunkHeaderMatch[4]
                        ? parseInt(hunkHeaderMatch[4], 10)
                        : 1;

                    currentHunk = {
                        oldStart: oldStart,
                        oldLines: oldLines,
                        newStart: newStart,
                        newLines: newLines,
                        parsedLines: [],
                        hunkId: DiffUtils.getHunkIdentifier(
                            currentFile.filePath,
                            { newStart: newStart }
                        ),
                        hunkHeader: line,
                    };
                    currentFile.hunks.push(currentHunk);
                } else if (
                    currentHunk &&
                    (line.startsWith('+') ||
                        line.startsWith('-') ||
                        line.startsWith(' '))
                ) {
                    // Parse diff line into structured format
                    const parsedLine = DiffUtils.parseDiffLine(
                        line,
                        currentHunk
                    );
                    currentHunk.parsedLines.push(parsedLine);
                }
            }
        }
        return files;
    }

    /**
     * Parse a single diff line into structured format
     * @param line The raw diff line (with +, -, or space prefix)
     * @param hunk The current hunk being parsed
     * @returns Parsed diff line information
     */
    private static parseDiffLine(
        line: string,
        hunk: DiffHunkLine
    ): ParsedDiffLine {
        const prefix = line.charAt(0);
        const content = line.substring(1);

        let type: 'added' | 'removed' | 'context';
        let lineNumber: number | undefined;

        // Calculate the current line number in the new file by counting lines processed so far
        const addedCount = hunk.parsedLines.filter(
            (l) => l.type === 'added'
        ).length;
        const contextCount = hunk.parsedLines.filter(
            (l) => l.type === 'context'
        ).length;
        const currentNewFileLineNumber =
            hunk.newStart + addedCount + contextCount;

        switch (prefix) {
            case '+':
                type = 'added';
                // This is a new line in the new file
                lineNumber = currentNewFileLineNumber;
                break;
            case '-':
                type = 'removed';
                // Removed lines don't have a line number in the new file
                lineNumber = undefined;
                break;
            case ' ':
                type = 'context';
                // Context lines exist in both files
                lineNumber = currentNewFileLineNumber;
                break;
            default:
                type = 'context';
                lineNumber = undefined;
        }

        return {
            type: type,
            content: content,
            lineNumber: lineNumber,
        };
    }

    /**
     * Generate unique identifier for a hunk
     * @param filePath The file path
     * @param hunkInfo Hunk information containing newStart
     * @returns Unique hunk identifier
     */
    static getHunkIdentifier(
        filePath: string,
        hunkInfo: { newStart: number }
    ): string {
        return `${filePath}:${hunkInfo.newStart}`;
    }

    /**
     * Extract file paths from diff content
     * @param diff The raw diff content
     * @returns Array of file paths mentioned in the diff
     */
    static extractFilePaths(diff: string): string[] {
        const filePaths: string[] = [];
        const lines = diff.split('\n');

        for (const line of lines) {
            const fileMatch = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
            if (fileMatch && fileMatch[2]) {
                filePaths.push(fileMatch[2]); // Use the "b/" path (new file path)
            }
        }

        return filePaths;
    }

    /**
     * Check if a diff contains only additions (new file)
     * @param fileDiff Single file diff hunk
     * @returns True if the diff only contains additions
     */
    static isNewFile(fileDiff: DiffHunk): boolean {
        return fileDiff.hunks.every(
            (hunk) => hunk.oldStart === 0 && hunk.oldLines === 0
        );
    }

    /**
     * Check if a diff contains only deletions (deleted file)
     * @param fileDiff Single file diff hunk
     * @returns True if the diff only contains deletions
     */
    static isDeletedFile(fileDiff: DiffHunk): boolean {
        return fileDiff.hunks.every(
            (hunk) => hunk.newStart === 0 && hunk.newLines === 0
        );
    }

    /**
     * Extract added lines from a diff hunk
     * @param hunk The diff hunk to analyze
     * @returns Array of added lines content
     */
    static getAddedLines(hunk: DiffHunkLine): string[] {
        return hunk.parsedLines
            .filter((line) => line.type === 'added')
            .map((line) => line.content);
    }

    /**
     * Extract removed lines from a diff hunk
     * @param hunk The diff hunk to analyze
     * @returns Array of removed lines content
     */
    static getRemovedLines(hunk: DiffHunkLine): string[] {
        return hunk.parsedLines
            .filter((line) => line.type === 'removed')
            .map((line) => line.content);
    }

    /**
     * Get context lines (unchanged lines) from a diff hunk
     * @param hunk The diff hunk to analyze
     * @returns Array of context lines content
     */
    static getContextLines(hunk: DiffHunkLine): string[] {
        return hunk.parsedLines
            .filter((line) => line.type === 'context')
            .map((line) => line.content);
    }
}
