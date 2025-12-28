import * as vscode from 'vscode';
import { describe, it, expect, beforeEach } from 'vitest';
import { DefinitionFormatter } from '../tools/definitionFormatter';

describe('DefinitionFormatter', () => {
    let formatter: DefinitionFormatter;

    beforeEach(() => {
        formatter = new DefinitionFormatter();
    });

    describe('formatDefinition', () => {
        it('should format definition with full body', () => {
            const range = {
                start: { line: 5, character: 0 },
                end: { line: 10, character: 1 },
            } as vscode.Range;

            const result = formatter.formatDefinition(
                'src/test.ts',
                range,
                'class TestClass {\n  constructor() {}\n}',
                true
            );

            expect(result).toContain('"file": "src/test.ts"');
            expect(result).toContain('"location"');
            expect(result).toContain('"line": 6');
            expect(result).toContain('"character": 0');
            expect(result).toContain('"body"');
            expect(result).toContain('class TestClass');
            expect(result).toContain('constructor() {}');
            // JSON format includes all the content in body lines
            // JSON format validation complete
        });

        it('should format definition without full body', () => {
            const range = {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 15 },
            } as vscode.Range;

            const result = formatter.formatDefinition(
                'src/utils.ts',
                range,
                undefined,
                false
            );

            expect(result).toContain('"file": "src/utils.ts"');
            expect(result).not.toContain('"body"'); // No body when includeFullBody is false
            expect(result).toContain('"location"'); // Should still have location info
        });

        it('should escape XML special characters', () => {
            const range = {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 10 },
            } as vscode.Range;

            const result = formatter.formatDefinition(
                'src/file<with>special&chars"test\'.ts',
                range,
                'const test = "value & other";',
                true
            );

            expect(result).toContain(
                '"file": "src/file<with>special&chars\\"test\'.ts"'
            ); // JSON preserves original characters
            expect(result).toContain('"body"'); // Should include body content
            expect(result).toContain('const test = \\"value & other\\";'); // JSON escapes quotes
        });
    });

    describe('formatErrorDefinition', () => {
        it('should format error definition with Error object', () => {
            const range = {
                start: { line: 3, character: 5 },
                end: { line: 3, character: 15 },
            } as vscode.Range;

            const error = new Error('File not found');
            const result = formatter.formatErrorDefinition(
                'src/missing.ts',
                'MissingClass',
                range,
                error
            );

            expect(result).toContain('"file": "src/missing.ts"');
            expect(result).toContain('"location"');
            expect(result).toContain('"line": 4'); // 1-based line number
            expect(result).toContain(
                '"error": "Could not read file content: File not found"'
            );
        });

        it('should format error definition with string error', () => {
            const range = {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 10 },
            } as vscode.Range;

            const result = formatter.formatErrorDefinition(
                'src/test.ts',
                'TestSymbol',
                range,
                'Custom error message'
            );

            expect(result).toContain(
                '"error": "Could not read file content: Custom error message"'
            );
        });

        it('should escape XML characters in error messages', () => {
            const range = {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 5 },
            } as vscode.Range;

            const result = formatter.formatErrorDefinition(
                'src/test.ts',
                'TestSymbol',
                range,
                'Error with <XML> & "quotes"'
            );

            expect(result).toContain(
                '"error": "Could not read file content: Error with <XML> & \\"quotes\\""'
            ); // JSON preserves chars, escapes quotes
        });
    });

    describe('formatNotFoundMessage', () => {
        it('should format not found message', () => {
            const result = formatter.formatNotFoundMessage('MissingSymbol');
            expect(result).toBe("Symbol 'MissingSymbol' not found");
        });

        it('should escape XML characters in symbol name', () => {
            const result = formatter.formatNotFoundMessage(
                'Symbol<with>&special"chars\''
            );
            expect(result).toBe(
                "Symbol 'Symbol<with>&special\"chars'' not found"
            ); // No XML escaping needed for plain strings
        });
    });
});
