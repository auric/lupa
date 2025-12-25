import * as vscode from 'vscode';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SymbolRangeExpander } from '../tools/symbolRangeExpander';

// Mock vscode - Vitest 4 requires function syntax for constructor mocks
vi.mock('vscode', async () => {
  const actualVscode = await vi.importActual('vscode');
  return {
    ...actualVscode,
    commands: {
      executeCommand: vi.fn()
    },
    Range: vi.fn().mockImplementation(function (this: any, startLine: number, startChar: number, endLine: number, endChar: number) {
      this.start = { line: startLine, character: startChar };
      this.end = { line: endLine, character: endChar };
    }),
    Position: vi.fn().mockImplementation(function (this: any, line: number, character: number) {
      this.line = line;
      this.character = character;
    })
  };
});

describe('SymbolRangeExpander', () => {
  let expander: SymbolRangeExpander;
  let mockDocument: any;

  beforeEach(() => {
    expander = new SymbolRangeExpander();
    vi.clearAllMocks();

    // Create mock document
    mockDocument = {
      uri: { toString: () => 'file:///test.ts' },
      getText: vi.fn(),
      lineCount: 20
    };
  });

  describe('getFullSymbolRange', () => {
    it('should use DocumentSymbolProvider when available', async () => {
      const mockSymbols = [{
        name: 'TestClass',
        range: new vscode.Range(0, 0, 10, 0),
        children: []
      }];

      // Mock a symbol that contains our input range
      mockSymbols[0].range.contains = vi.fn().mockReturnValue(true);

      vi.mocked(vscode.commands.executeCommand).mockResolvedValue(mockSymbols);

      // Setup fallback text in case expandRangeForSymbol is called
      mockDocument.getText.mockReturnValue('class TestClass {\n  // content\n}');

      const inputRange = new vscode.Range(2, 0, 2, 10);
      const result = await expander.getFullSymbolRange(mockDocument, inputRange);

      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        'vscode.executeDocumentSymbolProvider',
        mockDocument.uri
      );
      expect(result).toEqual(mockSymbols[0].range);
    });

    it('should fall back to heuristic expansion when DocumentSymbolProvider fails', async () => {
      vi.mocked(vscode.commands.executeCommand).mockRejectedValue(new Error('Provider failed'));

      const mockText = [
        'class TestClass {',
        '  constructor() {',
        '    // some code',
        '  }',
        '}'
      ].join('\n');

      mockDocument.getText.mockReturnValue(mockText);

      const inputRange = new vscode.Range(0, 0, 0, 15);
      const result = await expander.getFullSymbolRange(mockDocument, inputRange);

      // Should expand to include the full class
      expect(result.start.line).toBe(0);
      expect(result.end.line).toBe(4);
    });

    it('should handle nested symbols correctly', async () => {
      const mockSymbols = [{
        name: 'TestClass',
        range: new vscode.Range(0, 0, 10, 0),
        children: [{
          name: 'constructor',
          range: new vscode.Range(1, 2, 3, 3),
          children: []
        }]
      }];

      // Mock the contains method for ranges
      mockSymbols[0].range.contains = vi.fn().mockReturnValue(true);
      mockSymbols[0].children[0].range.contains = vi.fn().mockReturnValue(true);

      vi.mocked(vscode.commands.executeCommand).mockResolvedValue(mockSymbols);

      // Setup fallback text in case expandRangeForSymbol is called
      mockDocument.getText.mockReturnValue('class TestClass {\n  constructor() {}\n}');

      const inputRange = new vscode.Range(2, 5, 2, 15); // Inside constructor
      const result = await expander.getFullSymbolRange(mockDocument, inputRange);

      // Should return the constructor range, not the class range
      expect(result).toEqual(mockSymbols[0].children[0].range);
    });

    it('should expand range with comments and decorators', async () => {
      vi.mocked(vscode.commands.executeCommand).mockResolvedValue([]);

      const mockText = [
        '// This is a comment',
        '@decorator',
        'function testFunction() {',
        '  return "test";',
        '}'
      ].join('\n');

      mockDocument.getText.mockReturnValue(mockText);

      const inputRange = new vscode.Range(2, 0, 2, 20);
      const result = await expander.getFullSymbolRange(mockDocument, inputRange);

      // Should include comments and decorators
      expect(result.start.line).toBe(0);
      expect(result.end.line).toBe(4);
    });
  });
});