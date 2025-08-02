import type { DiffHunk, DiffHunkLine } from '../types/contextTypes';

/**
 * Utilities for parsing and working with diff content
 */
export class DiffUtils {
    /**
     * Parse diff string into structured format
     * @param diff The raw diff content
     * @returns Array of parsed diff hunks
     */
    static parseDiff(diff: string): DiffHunk[] {
        const files: DiffHunk[] = [];
        const lines = diff.split('\n');
        let currentFile: DiffHunk | null = null;
        let currentHunk: DiffHunkLine | null = null;

        for (const line of lines) {
            const fileMatch = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
            if (fileMatch) {
                currentFile = { filePath: fileMatch[2], hunks: [] };
                files.push(currentFile);
                currentHunk = null;
                continue;
            }

            if (currentFile) {
                const hunkHeaderMatch = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
                if (hunkHeaderMatch) {
                    const oldStart = parseInt(hunkHeaderMatch[1], 10);
                    const oldLines = hunkHeaderMatch[2] ? parseInt(hunkHeaderMatch[2], 10) : 1;
                    const newStart = parseInt(hunkHeaderMatch[3], 10);
                    const newLines = hunkHeaderMatch[4] ? parseInt(hunkHeaderMatch[4], 10) : 1;

                    currentHunk = {
                        oldStart: oldStart,
                        oldLines: oldLines,
                        newStart: newStart,
                        newLines: newLines,
                        lines: [],
                        hunkId: DiffUtils.getHunkIdentifier(currentFile.filePath, { newStart: newStart })
                    };
                    currentFile.hunks.push(currentHunk);
                } else if (currentHunk && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' '))) {
                    currentHunk.lines.push(line);
                }
            }
        }
        return files;
    }

    /**
     * Generate unique identifier for a hunk
     * @param filePath The file path
     * @param hunkInfo Hunk information containing newStart
     * @returns Unique hunk identifier
     */
    static getHunkIdentifier(filePath: string, hunkInfo: { newStart: number }): string {
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
            if (fileMatch) {
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
        return fileDiff.hunks.every(hunk => 
            hunk.oldStart === 0 && hunk.oldLines === 0
        );
    }

    /**
     * Check if a diff contains only deletions (deleted file)
     * @param fileDiff Single file diff hunk
     * @returns True if the diff only contains deletions
     */
    static isDeletedFile(fileDiff: DiffHunk): boolean {
        return fileDiff.hunks.every(hunk => 
            hunk.newStart === 0 && hunk.newLines === 0
        );
    }

    /**
     * Extract added lines from a diff hunk
     * @param hunk The diff hunk to analyze
     * @returns Array of added lines (without the '+' prefix)
     */
    static getAddedLines(hunk: DiffHunkLine): string[] {
        return hunk.lines
            .filter(line => line.startsWith('+') && !line.startsWith('+++'))
            .map(line => line.substring(1)); // Remove the '+' prefix
    }

    /**
     * Extract removed lines from a diff hunk
     * @param hunk The diff hunk to analyze
     * @returns Array of removed lines (without the '-' prefix)
     */
    static getRemovedLines(hunk: DiffHunkLine): string[] {
        return hunk.lines
            .filter(line => line.startsWith('-') && !line.startsWith('---'))
            .map(line => line.substring(1)); // Remove the '-' prefix
    }

    /**
     * Get context lines (unchanged lines) from a diff hunk
     * @param hunk The diff hunk to analyze
     * @returns Array of context lines (without the ' ' prefix)
     */
    static getContextLines(hunk: DiffHunkLine): string[] {
        return hunk.lines
            .filter(line => line.startsWith(' '))
            .map(line => line.substring(1)); // Remove the ' ' prefix
    }
}