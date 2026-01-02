import { describe, it, expect } from 'vitest';
import {
    splitDiffByFile,
    isBinaryFileDiff,
    extractFilePath,
    filterBinaryDiffs,
} from '../services/gitService';

/**
 * Test data based on actual git diff output formats.
 * Research from git/git repository and documentation.
 */

// Text file diff examples
const TEXT_FILE_DIFF = `diff --git a/readme.txt b/readme.txt
index a1b2c3d..e4f5g6h 100644
--- a/readme.txt
+++ b/readme.txt
@@ -1 +1 @@
-old content
+new content`;

const NEW_TEXT_FILE_DIFF = `diff --git a/newfile.ts b/newfile.ts
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/newfile.ts
@@ -0,0 +1,3 @@
+export function hello() {
+  return 'world';
+}`;

// Binary file diff examples
const MODIFIED_BINARY_DIFF = `diff --git a/image.png b/image.png
index a1b2c3d..e4f5g6h 100644
Binary files a/image.png and b/image.png differ`;

const NEW_BINARY_DIFF = `diff --git a/image.png b/image.png
new file mode 100644
index 0000000..a1b2c3d
Binary files /dev/null and b/image.png differ`;

const DELETED_BINARY_DIFF = `diff --git a/image.png b/image.png
deleted file mode 100644
index a1b2c3d..0000000
Binary files a/image.png and /dev/null differ`;

const RENAMED_BINARY_WITH_CHANGES = `diff --git a/old-name.png b/new-name.png
similarity index 85%
rename from old-name.png
rename to new-name.png
index a1b2c3d..e4f5g6h 100644
Binary files a/old-name.png and b/new-name.png differ`;

const GIT_BINARY_PATCH = `diff --git a/image.png b/image.png
new file mode 100644
index 0000000..a1b2c3d
GIT binary patch
literal 1026
zcmV+d1pWo}iwFP!000001MIqR

literal 0
HcmV?d00001`;

// Mode change only (NOT binary - should NOT be filtered)
const MODE_CHANGE_ONLY = `diff --git a/script.sh b/script.sh
old mode 100644
new mode 100755`;

// Renamed binary file with 100% similarity (no content change)
const RENAMED_BINARY_NO_CHANGES = `diff --git a/old.png b/new.png
similarity index 100%
rename from old.png
rename to new.png`;

// Mixed diff with both text and binary files
const MIXED_DIFF = `diff --git a/readme.txt b/readme.txt
index a1b2c3d..e4f5g6h 100644
--- a/readme.txt
+++ b/readme.txt
@@ -1 +1 @@
-old
+new
diff --git a/image.png b/image.png
index a1b2c3d..e4f5g6h 100644
Binary files a/image.png and b/image.png differ
diff --git a/data.bin b/data.bin
new file mode 100644
index 0000000..1234567
Binary files /dev/null and b/data.bin differ`;

// Path with spaces
const BINARY_WITH_SPACES_IN_PATH = `diff --git a/my folder/my image.png b/my folder/my image.png
index a1b2c3d..e4f5g6h 100644
Binary files a/my folder/my image.png and b/my folder/my image.png differ`;

describe('splitDiffByFile', () => {
    it('should return empty array for empty input', () => {
        expect(splitDiffByFile('')).toEqual([]);
        expect(splitDiffByFile('   ')).toEqual([]);
        expect(splitDiffByFile('\n\n')).toEqual([]);
    });

    it('should split single file diff', () => {
        const result = splitDiffByFile(TEXT_FILE_DIFF);
        expect(result).toHaveLength(1);
        expect(result[0]).toContain('diff --git a/readme.txt');
    });

    it('should split multiple file diffs', () => {
        const result = splitDiffByFile(MIXED_DIFF);
        expect(result).toHaveLength(3);
        expect(result[0]).toContain('readme.txt');
        expect(result[1]).toContain('image.png');
        expect(result[2]).toContain('data.bin');
    });

    it('should preserve diff headers', () => {
        const result = splitDiffByFile(NEW_BINARY_DIFF);
        expect(result).toHaveLength(1);
        expect(result[0]).toContain('diff --git');
        expect(result[0]).toContain('new file mode');
        expect(result[0]).toContain('Binary files');
    });

    it('should handle text without diff --git prefix', () => {
        const notADiff = 'This is just some text\nwithout any diff content';
        expect(splitDiffByFile(notADiff)).toEqual([]);
    });
});

describe('isBinaryFileDiff', () => {
    it('should detect modified binary file', () => {
        expect(isBinaryFileDiff(MODIFIED_BINARY_DIFF)).toBe(true);
    });

    it('should detect new binary file', () => {
        expect(isBinaryFileDiff(NEW_BINARY_DIFF)).toBe(true);
    });

    it('should detect deleted binary file', () => {
        expect(isBinaryFileDiff(DELETED_BINARY_DIFF)).toBe(true);
    });

    it('should detect renamed binary with changes', () => {
        expect(isBinaryFileDiff(RENAMED_BINARY_WITH_CHANGES)).toBe(true);
    });

    it('should detect GIT binary patch format', () => {
        expect(isBinaryFileDiff(GIT_BINARY_PATCH)).toBe(true);
    });

    it('should NOT detect text file as binary', () => {
        expect(isBinaryFileDiff(TEXT_FILE_DIFF)).toBe(false);
    });

    it('should NOT detect new text file as binary', () => {
        expect(isBinaryFileDiff(NEW_TEXT_FILE_DIFF)).toBe(false);
    });

    it('should NOT detect mode change only as binary', () => {
        expect(isBinaryFileDiff(MODE_CHANGE_ONLY)).toBe(false);
    });

    it('should NOT detect renamed binary with no changes as binary', () => {
        // This is a rename-only diff with no content, no "Binary files differ" line
        expect(isBinaryFileDiff(RENAMED_BINARY_NO_CHANGES)).toBe(false);
    });
});

describe('extractFilePath', () => {
    it('should extract path from text file diff', () => {
        expect(extractFilePath(TEXT_FILE_DIFF)).toBe('readme.txt');
    });

    it('should extract path from binary file diff', () => {
        expect(extractFilePath(MODIFIED_BINARY_DIFF)).toBe('image.png');
    });

    it('should extract path from new file diff', () => {
        expect(extractFilePath(NEW_BINARY_DIFF)).toBe('image.png');
    });

    it('should extract path with spaces', () => {
        expect(extractFilePath(BINARY_WITH_SPACES_IN_PATH)).toBe(
            'my folder/my image.png'
        );
    });

    it('should extract renamed path (new name)', () => {
        expect(extractFilePath(RENAMED_BINARY_WITH_CHANGES)).toBe(
            'new-name.png'
        );
    });

    it('should return null for malformed diff header', () => {
        expect(extractFilePath('not a diff')).toBe(null);
        expect(extractFilePath('diff --git invalid')).toBe(null);
    });
});

describe('filterBinaryDiffs', () => {
    it('should return empty result for empty input', () => {
        const result = filterBinaryDiffs('');
        expect(result.filteredDiff).toBe('');
        expect(result.binaryFiles).toEqual([]);
    });

    it('should keep text file unchanged', () => {
        const result = filterBinaryDiffs(TEXT_FILE_DIFF);
        expect(result.filteredDiff).toBe(TEXT_FILE_DIFF);
        expect(result.binaryFiles).toEqual([]);
    });

    it('should filter single binary file', () => {
        const result = filterBinaryDiffs(MODIFIED_BINARY_DIFF);
        expect(result.filteredDiff).toBe('');
        expect(result.binaryFiles).toEqual(['image.png']);
    });

    it('should filter new binary file', () => {
        const result = filterBinaryDiffs(NEW_BINARY_DIFF);
        expect(result.filteredDiff).toBe('');
        expect(result.binaryFiles).toEqual(['image.png']);
    });

    it('should filter deleted binary file', () => {
        const result = filterBinaryDiffs(DELETED_BINARY_DIFF);
        expect(result.filteredDiff).toBe('');
        expect(result.binaryFiles).toEqual(['image.png']);
    });

    it('should filter GIT binary patch format', () => {
        const result = filterBinaryDiffs(GIT_BINARY_PATCH);
        expect(result.filteredDiff).toBe('');
        expect(result.binaryFiles).toEqual(['image.png']);
    });

    it('should filter multiple binary files', () => {
        const iconBinaryDiff = `diff --git a/icon.png b/icon.png
new file mode 100644
index 0000000..a1b2c3d
Binary files /dev/null and b/icon.png differ`;

        const multipleBinaries = `${MODIFIED_BINARY_DIFF}
${iconBinaryDiff}`;

        const result = filterBinaryDiffs(multipleBinaries);
        expect(result.filteredDiff).toBe('');
        expect(result.binaryFiles).toHaveLength(2);
        expect(result.binaryFiles).toContain('image.png');
        expect(result.binaryFiles).toContain('icon.png');
    });

    it('should separate binary and text files in mixed diff', () => {
        const result = filterBinaryDiffs(MIXED_DIFF);

        // Should keep text file
        expect(result.filteredDiff).toContain('readme.txt');
        expect(result.filteredDiff).toContain('-old');
        expect(result.filteredDiff).toContain('+new');

        // Should remove binary files
        expect(result.filteredDiff).not.toContain('Binary files');
        expect(result.filteredDiff).not.toContain('image.png');
        expect(result.filteredDiff).not.toContain('data.bin');

        // Should list binary files
        expect(result.binaryFiles).toEqual(['image.png', 'data.bin']);
    });

    it('should NOT filter mode change only', () => {
        const result = filterBinaryDiffs(MODE_CHANGE_ONLY);
        expect(result.filteredDiff).toBe(MODE_CHANGE_ONLY);
        expect(result.binaryFiles).toEqual([]);
    });

    it('should NOT filter renamed binary with no content changes', () => {
        const result = filterBinaryDiffs(RENAMED_BINARY_NO_CHANGES);
        expect(result.filteredDiff).toBe(RENAMED_BINARY_NO_CHANGES);
        expect(result.binaryFiles).toEqual([]);
    });

    it('should filter renamed binary with content changes', () => {
        const result = filterBinaryDiffs(RENAMED_BINARY_WITH_CHANGES);
        expect(result.filteredDiff).toBe('');
        expect(result.binaryFiles).toEqual(['new-name.png']);
    });

    it('should handle binary file with spaces in path', () => {
        const result = filterBinaryDiffs(BINARY_WITH_SPACES_IN_PATH);
        expect(result.filteredDiff).toBe('');
        expect(result.binaryFiles).toEqual(['my folder/my image.png']);
    });

    it('should handle complex mixed diff preserving order', () => {
        const logoBinaryDiff = `diff --git a/logo.png b/logo.png
new file mode 100644
index 0000000..a1b2c3d
Binary files /dev/null and b/logo.png differ`;

        // Create a complex diff with text, binary, text, binary
        const complexDiff = `${TEXT_FILE_DIFF}
${MODIFIED_BINARY_DIFF}
${NEW_TEXT_FILE_DIFF}
${logoBinaryDiff}`;

        const result = filterBinaryDiffs(complexDiff);

        // Should have both text files in order
        const textParts = splitDiffByFile(result.filteredDiff);
        expect(textParts).toHaveLength(2);
        expect(textParts[0]).toContain('readme.txt');
        expect(textParts[1]).toContain('newfile.ts');

        // Should have both binary files
        expect(result.binaryFiles).toEqual(['image.png', 'logo.png']);
    });
});
