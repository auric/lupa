import * as vscode from 'vscode';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UsageFormatter } from '../tools/usageFormatter';

vi.mock('vscode');

describe('UsageFormatter', () => {
    let formatter: UsageFormatter;

    beforeEach(() => {
        formatter = new UsageFormatter();
    });

    describe('formatUsage', () => {
        it('should format usage with proper JSON structure', () => {
            const range = new vscode.Range(
                new vscode.Position(5, 10),
                new vscode.Position(5, 17)
            );

            const result = formatter.formatUsage(
                'src/components/Button.tsx',
                'MyClass',
                range,
                [
                    '  5: const instance = new MyClass();',
                    '  6: return instance;',
                ]
            );

            expect(result).toContain('=== src/components/Button.tsx ===');
            expect(result).toContain('5: const instance = new MyClass()');
            expect(result).toContain('const instance = new MyClass()');
            expect(result).not.toContain('"location"');
        });

        it('should handle special characters in file path', () => {
            const range = new vscode.Range(
                new vscode.Position(0, 0),
                new vscode.Position(0, 5)
            );

            const result = formatter.formatUsage(
                'src/test<file>.ts',
                'Class&Name',
                range,
                ['context line']
            );

            expect(result).toContain('=== src/test<file>.ts ==='); // Header format preserves original characters
            expect(result).toContain('context line'); // Should include context lines
        });
    });

    describe('formatErrorUsage', () => {
        it('should format error usage with proper JSON structure', () => {
            const range = new vscode.Range(
                new vscode.Position(2, 5),
                new vscode.Position(2, 12)
            );
            const error = new Error('File read failed');

            const result = formatter.formatErrorUsage(
                'src/error.ts',
                'ErrorClass',
                range,
                error
            );

            expect(result).toContain('=== src/error.ts ===');
            expect(result).toContain(
                'Error: Could not read file content: File read failed'
            );
            expect(result).not.toContain('"location"');
        });

        it('should handle non-Error objects', () => {
            const range = new vscode.Range(
                new vscode.Position(0, 0),
                new vscode.Position(0, 1)
            );

            const result = formatter.formatErrorUsage(
                'src/test.ts',
                'TestClass',
                range,
                'String error message'
            );

            expect(result).toContain(
                'Error: Could not read file content: String error message'
            );
        });

        it('should handle special characters in error messages', () => {
            const range = new vscode.Range(
                new vscode.Position(0, 0),
                new vscode.Position(0, 1)
            );

            const result = formatter.formatErrorUsage(
                'src/test.ts',
                'TestClass',
                range,
                'Error with <brackets> & ampersands'
            );

            expect(result).toContain(
                'Error: Could not read file content: Error with <brackets> & ampersands'
            );
        });
    });

    describe('formatNoUsagesMessage', () => {
        it('should format message without file path', () => {
            const result = formatter.formatNoUsagesMessage('UnusedClass');
            expect(result).toBe("No usages found for symbol 'UnusedClass'");
        });

        it('should format message with file path', () => {
            const result = formatter.formatNoUsagesMessage(
                'UnusedClass',
                'src/unused.ts'
            );
            expect(result).toBe(
                "No usages found for symbol 'UnusedClass' in src/unused.ts"
            );
        });

        it('should handle special characters in symbol name and file path', () => {
            const result = formatter.formatNoUsagesMessage(
                'Class<T>',
                'src/test&file.ts'
            );
            expect(result).toContain("'Class<T>'"); // No XML escaping needed for plain strings
            expect(result).toContain('src/test&file.ts');
        });
    });

    describe('extractContextLines', () => {
        let mockDocument: any;

        beforeEach(() => {
            mockDocument = {
                getText: () =>
                    'line0\nline1\nline2\nline3\nline4\nline5\nline6',
            };
        });

        it('should extract context lines with default context size', () => {
            const range = new vscode.Range(
                new vscode.Position(3, 0),
                new vscode.Position(3, 5)
            );

            const result = formatter.extractContextLines(mockDocument, range);

            expect(Array.isArray(result)).toBe(true); // Now returns an array
            expect(result).toHaveLength(5); // 2 before + 1 target + 2 after
            expect(result[0]).toBe('2: line1'); // Line before (1-based indexing, no spaces)
            expect(result[1]).toBe('3: line2');
            expect(result[2]).toBe('4: line3'); // Target line (no > prefix in array format)
            expect(result[3]).toBe('5: line4');
            expect(result[4]).toBe('6: line5'); // Line after
        });

        it('should extract context lines with custom context size', () => {
            const range = new vscode.Range(
                new vscode.Position(3, 0),
                new vscode.Position(3, 5)
            );

            const result = formatter.extractContextLines(
                mockDocument,
                range,
                1
            );

            expect(Array.isArray(result)).toBe(true); // Now returns an array
            expect(result).toHaveLength(3); // 1 before + 1 target + 1 after
            expect(result[0]).toBe('3: line2');
            expect(result[1]).toBe('4: line3'); // Target line
            expect(result[2]).toBe('5: line4');
        });

        it('should handle context at beginning of file', () => {
            const range = new vscode.Range(
                new vscode.Position(0, 0),
                new vscode.Position(0, 5)
            );

            const result = formatter.extractContextLines(
                mockDocument,
                range,
                2
            );

            expect(Array.isArray(result)).toBe(true); // Now returns an array
            expect(result[0]).toBe('1: line0'); // First line, no lines before
            expect(result[1]).toBe('2: line1');
            expect(result[2]).toBe('3: line2');
        });

        it('should handle context at end of file', () => {
            const range = new vscode.Range(
                new vscode.Position(6, 0), // Last line (0-based)
                new vscode.Position(6, 5)
            );

            const result = formatter.extractContextLines(
                mockDocument,
                range,
                2
            );

            expect(Array.isArray(result)).toBe(true); // Now returns an array
            expect(result[result.length - 1]).toBe('7: line6'); // Last line
            // Should include previous lines but not exceed file bounds
        });

        it('should handle zero context size', () => {
            const range = new vscode.Range(
                new vscode.Position(3, 0),
                new vscode.Position(3, 5)
            );

            const result = formatter.extractContextLines(
                mockDocument,
                range,
                0
            );

            expect(Array.isArray(result)).toBe(true); // Now returns an array
            expect(result).toHaveLength(1);
            expect(result[0]).toBe('4: line3'); // Only the target line
        });

        it('should handle single line document', () => {
            const singleLineDoc = {
                getText: () => 'single line',
            } as unknown as vscode.TextDocument;

            const range = new vscode.Range(
                new vscode.Position(0, 0),
                new vscode.Position(0, 6)
            );

            const result = formatter.extractContextLines(
                singleLineDoc,
                range,
                2
            );

            expect(Array.isArray(result)).toBe(true); // Now returns an array
            expect(result).toHaveLength(1);
            expect(result[0]).toBe('1: single line');
        });
    });
});
