/**
 * Represents a parsed line from a diff hunk with structured information
 */
export interface ParsedDiffLine {
    type: 'added' | 'removed' | 'context';
    content: string; // Clean content without +/- prefix
    lineNumber?: number; // Line number in target file
}

export interface DiffHunkLine {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    parsedLines: ParsedDiffLine[]; // Structured diff line information
    hunkId: string; // Unique identifier for this hunk within its file (required)
    hunkHeader: string; // Original @@ header text (e.g., "@@ -1,3 +1,5 @@ context")
}

export interface DiffHunk {
    filePath: string;
    hunks: DiffHunkLine[];
    isNewFile: boolean; // True if this file is being created (/dev/null -> file)
    isDeletedFile: boolean; // True if this file is being deleted (file -> /dev/null)
    originalHeader: string; // File diff header (e.g., "diff --git a/file.ts b/file.ts")
}
