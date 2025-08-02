import { describe, it, expect } from 'vitest';
import { DiffUtils } from '../utils/diffUtils';
import type { DiffHunk, DiffHunkLine, ParsedDiffLine } from '../types/contextTypes';

describe('DiffUtils', () => {
    describe('parseDiff', () => {
        it('should parse a simple diff with added lines', () => {
            const diff = `diff --git a/src/test.js b/src/test.js
index 1234567..abcdefg 100644
--- a/src/test.js
+++ b/src/test.js
@@ -1,3 +1,5 @@
 function hello() {
+    console.log('Hello');
+    console.log('World');
     return 'hello';
 }`;

            const result = DiffUtils.parseDiff(diff);

            expect(result).toHaveLength(1);
            expect(result[0].filePath).toBe('src/test.js');
            expect(result[0].isNewFile).toBe(false);
            expect(result[0].isDeletedFile).toBe(false);
            expect(result[0].originalHeader).toBe('diff --git a/src/test.js b/src/test.js');

            const hunk = result[0].hunks[0];
            expect(hunk.oldStart).toBe(1);
            expect(hunk.oldLines).toBe(3);
            expect(hunk.newStart).toBe(1);
            expect(hunk.newLines).toBe(5);
            expect(hunk.hunkHeader).toBe('@@ -1,3 +1,5 @@');
            expect(hunk.hunkId).toBe('src/test.js:1');

            expect(hunk.parsedLines).toHaveLength(5);
            expect(hunk.parsedLines[0]).toEqual({
                type: 'context',
                content: 'function hello() {',
                lineNumber: 1
            });
            expect(hunk.parsedLines[1]).toEqual({
                type: 'added',
                content: "    console.log('Hello');",
                lineNumber: 2
            });
            expect(hunk.parsedLines[2]).toEqual({
                type: 'added',
                content: "    console.log('World');",
                lineNumber: 3
            });
            expect(hunk.parsedLines[3]).toEqual({
                type: 'context',
                content: "    return 'hello';",
                lineNumber: 4
            });
            expect(hunk.parsedLines[4]).toEqual({
                type: 'context',
                content: '}',
                lineNumber: 5
            });
        });

        it('should parse a diff with removed lines', () => {
            const diff = `diff --git a/src/test.js b/src/test.js
index 1234567..abcdefg 100644
--- a/src/test.js
+++ b/src/test.js
@@ -1,4 +1,2 @@
 function hello() {
-    console.log('Debug');
-    console.log('More debug');
     return 'hello';
 }`;

            const result = DiffUtils.parseDiff(diff);

            expect(result).toHaveLength(1);
            const hunk = result[0].hunks[0];
            expect(hunk.parsedLines).toHaveLength(5);

            expect(hunk.parsedLines[0]).toEqual({
                type: 'context',
                content: 'function hello() {',
                lineNumber: 1
            });
            expect(hunk.parsedLines[1]).toEqual({
                type: 'removed',
                content: "    console.log('Debug');",
                lineNumber: undefined
            });
            expect(hunk.parsedLines[2]).toEqual({
                type: 'removed',
                content: "    console.log('More debug');",
                lineNumber: undefined
            });
            expect(hunk.parsedLines[3]).toEqual({
                type: 'context',
                content: "    return 'hello';",
                lineNumber: 2
            });
            expect(hunk.parsedLines[4]).toEqual({
                type: 'context',
                content: '}',
                lineNumber: 3
            });
        });

        it('should detect new file correctly', () => {
            const diff = `diff --git a/dev/null b/src/newfile.js
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/src/newfile.js
@@ -0,0 +1,3 @@
+function newFunction() {
+    return 'new';
+}`;

            const result = DiffUtils.parseDiff(diff);

            expect(result).toHaveLength(1);
            expect(result[0].filePath).toBe('src/newfile.js');
            expect(result[0].isNewFile).toBe(true);
            expect(result[0].isDeletedFile).toBe(false);

            const hunk = result[0].hunks[0];
            expect(hunk.oldStart).toBe(0);
            expect(hunk.oldLines).toBe(0);
            expect(hunk.newStart).toBe(1);
            expect(hunk.newLines).toBe(3);

            expect(hunk.parsedLines.every(line => line.type === 'added')).toBe(true);
        });

        it('should detect deleted file correctly', () => {
            const diff = `diff --git a/src/oldfile.js b/dev/null
deleted file mode 100644
index 1234567..0000000
--- a/src/oldfile.js
+++ /dev/null
@@ -1,3 +0,0 @@
-function oldFunction() {
-    return 'old';
-}`;

            const result = DiffUtils.parseDiff(diff);

            expect(result).toHaveLength(1);
            expect(result[0].filePath).toBe('src/oldfile.js');
            expect(result[0].isNewFile).toBe(false);
            expect(result[0].isDeletedFile).toBe(true);

            const hunk = result[0].hunks[0];
            expect(hunk.oldStart).toBe(1);
            expect(hunk.oldLines).toBe(3);
            expect(hunk.newStart).toBe(0);
            expect(hunk.newLines).toBe(0);

            expect(hunk.parsedLines.every(line => line.type === 'removed')).toBe(true);
        });

        it('should handle multiple files in one diff', () => {
            const diff = `diff --git a/src/file1.js b/src/file1.js
index 1234567..abcdefg 100644
--- a/src/file1.js
+++ b/src/file1.js
@@ -1,1 +1,2 @@
 line1
+line2
diff --git a/src/file2.js b/src/file2.js
index 7654321..gfedcba 100644
--- a/src/file2.js
+++ b/src/file2.js
@@ -1,2 +1,1 @@
 line1
-line2`;

            const result = DiffUtils.parseDiff(diff);

            expect(result).toHaveLength(2);
            expect(result[0].filePath).toBe('src/file1.js');
            expect(result[1].filePath).toBe('src/file2.js');

            // File1 has an addition
            expect(result[0].hunks[0].parsedLines).toHaveLength(2);
            expect(result[0].hunks[0].parsedLines[1].type).toBe('added');

            // File2 has a removal
            expect(result[1].hunks[0].parsedLines).toHaveLength(2);
            expect(result[1].hunks[0].parsedLines[1].type).toBe('removed');
        });

        it('should handle hunk headers with context information', () => {
            const diff = `diff --git a/src/test.js b/src/test.js
index 1234567..abcdefg 100644
--- a/src/test.js
+++ b/src/test.js
@@ -10,4 +10,5 @@ function testContext() {
 function existing() {
     let x = 1;
+    let y = 2;
     return x;
 }`;

            const result = DiffUtils.parseDiff(diff);

            const hunk = result[0].hunks[0];
            expect(hunk.hunkHeader).toBe('@@ -10,4 +10,5 @@ function testContext() {');
            expect(hunk.oldStart).toBe(10);
            expect(hunk.newStart).toBe(10);
        });

        it('should handle empty diff', () => {
            const result = DiffUtils.parseDiff('');
            expect(result).toHaveLength(0);
        });

        it('should skip git metadata lines', () => {
            const diff = `diff --git a/src/test.js b/src/test.js
index 1234567..abcdefg 100644
--- a/src/test.js
+++ b/src/test.js
@@ -1,1 +1,2 @@
 line1
+line2`;

            const result = DiffUtils.parseDiff(diff);

            expect(result).toHaveLength(1);
            expect(result[0].hunks[0].parsedLines).toHaveLength(2);
        });
    });

    describe('helper methods', () => {
        const sampleHunk: DiffHunkLine = {
            oldStart: 1,
            oldLines: 3,
            newStart: 1,
            newLines: 4,
            parsedLines: [
                { type: 'context', content: 'unchanged line', lineNumber: 1 },
                { type: 'added', content: 'new line 1', lineNumber: 2 },
                { type: 'added', content: 'new line 2', lineNumber: 3 },
                { type: 'removed', content: 'old line', lineNumber: undefined },
                { type: 'context', content: 'another unchanged', lineNumber: 4 }
            ],
            hunkId: 'test:1',
            hunkHeader: '@@ -1,3 +1,4 @@'
        };

        describe('getAddedLines', () => {
            it('should return only added line content', () => {
                const result = DiffUtils.getAddedLines(sampleHunk);
                expect(result).toEqual(['new line 1', 'new line 2']);
            });
        });

        describe('getRemovedLines', () => {
            it('should return only removed line content', () => {
                const result = DiffUtils.getRemovedLines(sampleHunk);
                expect(result).toEqual(['old line']);
            });
        });

        describe('getContextLines', () => {
            it('should return only context line content', () => {
                const result = DiffUtils.getContextLines(sampleHunk);
                expect(result).toEqual(['unchanged line', 'another unchanged']);
            });
        });

        describe('isNewFile', () => {
            it('should return true for new files', () => {
                const newFileDiff: DiffHunk = {
                    filePath: 'new.js',
                    hunks: [{ ...sampleHunk, oldStart: 0, oldLines: 0 }],
                    isNewFile: true,
                    isDeletedFile: false,
                    originalHeader: 'diff --git a/dev/null b/new.js'
                };
                expect(DiffUtils.isNewFile(newFileDiff)).toBe(true);
            });

            it('should return false for existing files', () => {
                const existingFileDiff: DiffHunk = {
                    filePath: 'existing.js',
                    hunks: [sampleHunk],
                    isNewFile: false,
                    isDeletedFile: false,
                    originalHeader: 'diff --git a/existing.js b/existing.js'
                };
                expect(DiffUtils.isNewFile(existingFileDiff)).toBe(false);
            });
        });

        describe('isDeletedFile', () => {
            it('should return true for deleted files', () => {
                const deletedFileDiff: DiffHunk = {
                    filePath: 'deleted.js',
                    hunks: [{ ...sampleHunk, newStart: 0, newLines: 0 }],
                    isNewFile: false,
                    isDeletedFile: true,
                    originalHeader: 'diff --git a/deleted.js b/dev/null'
                };
                expect(DiffUtils.isDeletedFile(deletedFileDiff)).toBe(true);
            });

            it('should return false for existing files', () => {
                const existingFileDiff: DiffHunk = {
                    filePath: 'existing.js',
                    hunks: [sampleHunk],
                    isNewFile: false,
                    isDeletedFile: false,
                    originalHeader: 'diff --git a/existing.js b/existing.js'
                };
                expect(DiffUtils.isDeletedFile(existingFileDiff)).toBe(false);
            });
        });

        describe('getHunkIdentifier', () => {
            it('should generate consistent identifiers', () => {
                const id1 = DiffUtils.getHunkIdentifier('test.js', { newStart: 10 });
                const id2 = DiffUtils.getHunkIdentifier('test.js', { newStart: 10 });
                expect(id1).toBe(id2);
                expect(id1).toBe('test.js:10');
            });
        });

        describe('extractFilePaths', () => {
            it('should extract file paths from diff content', () => {
                const diff = `diff --git a/src/file1.js b/src/file1.js
diff --git a/src/file2.ts b/src/file2.ts`;

                const paths = DiffUtils.extractFilePaths(diff);
                expect(paths).toEqual(['src/file1.js', 'src/file2.ts']);
            });
        });
    });
});