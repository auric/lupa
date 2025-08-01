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
                end: { line: 10, character: 1 }
            } as vscode.Range;

            const result = formatter.formatDefinition(
                'src/test.ts',
                'TestClass',
                range,
                'class TestClass {\n  constructor() {}\n}',
                true
            );

            expect(result).toContain('<symbol_definition>');
            expect(result).toContain('<file>src/test.ts</file>');
            expect(result).toContain('<symbol_name>TestClass</symbol_name>');
            expect(result).toContain('<start_line>6</start_line>'); // 1-based
            expect(result).toContain('<start_character>0</start_character>');
            expect(result).toContain('<end_line>11</end_line>'); // 1-based
            expect(result).toContain('<end_character>1</end_character>');
            expect(result).toContain('<full_body>\nclass TestClass {\n  constructor() {}\n}\n  </full_body>');
            expect(result).toContain('</symbol_definition>');
        });

        it('should format definition without full body', () => {
            const range = {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 15 }
            } as vscode.Range;

            const result = formatter.formatDefinition(
                'src/utils.ts',
                'myFunction',
                range,
                undefined,
                false
            );

            expect(result).toContain('<symbol_name>myFunction</symbol_name>');
            expect(result).toContain('<full_body>false</full_body>');
            expect(result).not.toContain('function myFunction');
        });

        it('should escape XML special characters', () => {
            const range = {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 10 }
            } as vscode.Range;

            const result = formatter.formatDefinition(
                'src/file<with>special&chars"test\'.ts',
                'symbol<with>&special"chars\'',
                range,
                'const test = "value & other";',
                true
            );

            expect(result).toContain('<file>src/file&lt;with&gt;special&amp;chars&quot;test&#x27;.ts</file>');
            expect(result).toContain('<symbol_name>symbol&lt;with&gt;&amp;special&quot;chars&#x27;</symbol_name>');
            expect(result).toContain('const test = "value & other";');
        });
    });

    describe('formatErrorDefinition', () => {
        it('should format error definition with Error object', () => {
            const range = {
                start: { line: 3, character: 5 },
                end: { line: 3, character: 15 }
            } as vscode.Range;

            const error = new Error('File not found');
            const result = formatter.formatErrorDefinition(
                'src/missing.ts',
                'MissingClass',
                range,
                error
            );

            expect(result).toContain('<file>src/missing.ts</file>');
            expect(result).toContain('<symbol_name>MissingClass</symbol_name>');
            expect(result).toContain('<start_line>4</start_line>'); // 1-based
            expect(result).toContain('<error>Could not read file content: File not found</error>');
        });

        it('should format error definition with string error', () => {
            const range = {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 10 }
            } as vscode.Range;

            const result = formatter.formatErrorDefinition(
                'src/test.ts',
                'TestSymbol',
                range,
                'Custom error message'
            );

            expect(result).toContain('<error>Could not read file content: Custom error message</error>');
        });

        it('should escape XML characters in error messages', () => {
            const range = {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 5 }
            } as vscode.Range;

            const result = formatter.formatErrorDefinition(
                'src/test.ts',
                'TestSymbol',
                range,
                'Error with <XML> & "quotes"'
            );

            expect(result).toContain('<error>Could not read file content: Error with &lt;XML&gt; &amp; &quot;quotes&quot;</error>');
        });
    });

    describe('formatNotFoundMessage', () => {
        it('should format not found message', () => {
            const result = formatter.formatNotFoundMessage('MissingSymbol');
            expect(result).toBe("Symbol 'MissingSymbol' not found");
        });

        it('should escape XML characters in symbol name', () => {
            const result = formatter.formatNotFoundMessage('Symbol<with>&special"chars\'');
            expect(result).toBe("Symbol 'Symbol&lt;with&gt;&amp;special&quot;chars&#x27;' not found");
        });
    });
});