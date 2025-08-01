import * as vscode from 'vscode';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UsageFormatter } from '../tools/usageFormatter';

// Mock vscode
vi.mock('vscode', async () => {
    const actualVscode = await vi.importActual('vscode');
    return {
        ...actualVscode,
        Range: vi.fn().mockImplementation((start, end) => ({ start, end })),
        Position: vi.fn().mockImplementation((line, character) => ({ line, character }))
    };
});

describe('UsageFormatter', () => {
    let formatter: UsageFormatter;

    beforeEach(() => {
        formatter = new UsageFormatter();
    });

    describe('formatUsage', () => {
        it('should format usage with proper XML structure', () => {
            const range = new vscode.Range(
                new vscode.Position(5, 10),
                new vscode.Position(5, 17)
            );

            const result = formatter.formatUsage(
                'src/components/Button.tsx',
                'MyClass',
                range,
                '  5: const instance = new MyClass();\n  6: return instance;'
            );

            expect(result).toContain('<symbol_usage>');
            expect(result).toContain('<file>src/components/Button.tsx</file>');
            expect(result).toContain('<symbol_name>MyClass</symbol_name>');
            expect(result).toContain('<location>');
            expect(result).toContain('<start_line>6</start_line>'); // 1-based line numbers
            expect(result).toContain('<start_character>10</start_character>');
            expect(result).toContain('<end_line>6</end_line>');
            expect(result).toContain('<end_character>17</end_character>');
            expect(result).toContain('<context>');
            expect(result).toContain('const instance = new MyClass()');
            expect(result).toContain('</symbol_usage>');
        });

        it('should escape XML characters in file path and symbol name', () => {
            const range = new vscode.Range(
                new vscode.Position(0, 0),
                new vscode.Position(0, 5)
            );

            const result = formatter.formatUsage(
                'src/test<file>.ts',
                'Class&Name',
                range,
                'context'
            );

            expect(result).toContain('<file>src/test&lt;file&gt;.ts</file>');
            expect(result).toContain('<symbol_name>Class&amp;Name</symbol_name>');
        });
    });

    describe('formatErrorUsage', () => {
        it('should format error usage with proper XML structure', () => {
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

            expect(result).toContain('<symbol_usage>');
            expect(result).toContain('<file>src/error.ts</file>');
            expect(result).toContain('<symbol_name>ErrorClass</symbol_name>');
            expect(result).toContain('<location>');
            expect(result).toContain('<start_line>3</start_line>'); // 1-based
            expect(result).toContain('<error>Could not read file content: File read failed</error>');
            expect(result).toContain('</symbol_usage>');
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

            expect(result).toContain('<error>Could not read file content: String error message</error>');
        });

        it('should escape XML characters in error messages', () => {
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

            expect(result).toContain('Error with &lt;brackets&gt; &amp; ampersands');
        });
    });

    describe('formatNoUsagesMessage', () => {
        it('should format message without file path', () => {
            const result = formatter.formatNoUsagesMessage('UnusedClass');
            expect(result).toBe("No usages found for symbol 'UnusedClass'");
        });

        it('should format message with file path', () => {
            const result = formatter.formatNoUsagesMessage('UnusedClass', 'src/unused.ts');
            expect(result).toBe("No usages found for symbol 'UnusedClass' in src/unused.ts");
        });

        it('should escape XML characters in symbol name and file path', () => {
            const result = formatter.formatNoUsagesMessage('Class<T>', 'src/test&file.ts');
            expect(result).toContain("'Class&lt;T&gt;'");
            expect(result).toContain('src/test&amp;file.ts');
        });
    });

    describe('extractContextLines', () => {
        let mockDocument: any;

        beforeEach(() => {
            mockDocument = {
                getText: () => 'line0\nline1\nline2\nline3\nline4\nline5\nline6'
            };
        });

        it('should extract context lines with default context size', () => {
            const range = new vscode.Range(
                new vscode.Position(3, 0),
                new vscode.Position(3, 5)
            );

            const result = formatter.extractContextLines(mockDocument, range);

            const lines = result.split('\n');
            expect(lines).toHaveLength(5); // 2 before + 1 target + 2 after
            expect(lines[0]).toBe('  2: line1'); // Line before (2-based indexing)
            expect(lines[1]).toBe('  3: line2');
            expect(lines[2]).toBe('> 4: line3'); // Target line with > prefix
            expect(lines[3]).toBe('  5: line4');
            expect(lines[4]).toBe('  6: line5'); // Line after
        });

        it('should extract context lines with custom context size', () => {
            const range = new vscode.Range(
                new vscode.Position(3, 0),
                new vscode.Position(3, 5)
            );

            const result = formatter.extractContextLines(mockDocument, range, 1);

            const lines = result.split('\n');
            expect(lines).toHaveLength(3); // 1 before + 1 target + 1 after
            expect(lines[0]).toBe('  3: line2');
            expect(lines[1]).toBe('> 4: line3'); // Target line
            expect(lines[2]).toBe('  5: line4');
        });

        it('should handle context at beginning of file', () => {
            const range = new vscode.Range(
                new vscode.Position(0, 0),
                new vscode.Position(0, 5)
            );

            const result = formatter.extractContextLines(mockDocument, range, 2);

            const lines = result.split('\n');
            expect(lines[0]).toBe('> 1: line0'); // First line, no lines before
            expect(lines[1]).toBe('  2: line1');
            expect(lines[2]).toBe('  3: line2');
        });

        it('should handle context at end of file', () => {
            const range = new vscode.Range(
                new vscode.Position(6, 0), // Last line (0-based)
                new vscode.Position(6, 5)
            );

            const result = formatter.extractContextLines(mockDocument, range, 2);

            const lines = result.split('\n');
            expect(lines[lines.length - 1]).toBe('> 7: line6'); // Last line
            // Should include previous lines but not exceed file bounds
        });

        it('should handle zero context size', () => {
            const range = new vscode.Range(
                new vscode.Position(3, 0),
                new vscode.Position(3, 5)
            );

            const result = formatter.extractContextLines(mockDocument, range, 0);

            const lines = result.split('\n');
            expect(lines).toHaveLength(1);
            expect(lines[0]).toBe('> 4: line3'); // Only the target line
        });

        it('should handle single line document', () => {
            const singleLineDoc = {
                getText: () => 'single line'
            };

            const range = new vscode.Range(
                new vscode.Position(0, 0),
                new vscode.Position(0, 6)
            );

            const result = formatter.extractContextLines(singleLineDoc, range, 2);

            const lines = result.split('\n');
            expect(lines).toHaveLength(1);
            expect(lines[0]).toBe('> 1: single line');
        });
    });
});