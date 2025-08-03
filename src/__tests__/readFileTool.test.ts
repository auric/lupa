import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';
import * as vscode from 'vscode';
import * as path from 'path';
import { ReadFileTool } from '../tools/readFileTool';
import { TokenConstants } from '../models/tokenConstants';
import { GitOperationsManager } from '../services/gitOperationsManager';
import { PathSanitizer } from '../utils/pathSanitizer';

// Mock VS Code
vi.mock('vscode', () => ({
  Uri: {
    file: vi.fn((path: string) => ({ fsPath: path }))
  },
  workspace: {
    fs: {
      stat: vi.fn(),
      readFile: vi.fn()
    }
  }
}));

// Mock PathSanitizer
vi.mock('../utils/pathSanitizer', () => ({
  PathSanitizer: {
    sanitizePath: vi.fn((path: string) => path)
  }
}));

describe('ReadFileTool', () => {
  let readFileTool: ReadFileTool;
  let mockGitOperationsManager: {
    getRepository: Mock;
  };
  let mockWorkspaceFs: {
    stat: Mock;
    readFile: Mock;
  };

  beforeEach(() => {
    mockGitOperationsManager = {
      getRepository: vi.fn()
    };

    mockWorkspaceFs = {
      stat: vi.fn(),
      readFile: vi.fn()
    };

    // Setup VS Code mocks
    vi.mocked(vscode.workspace.fs.stat).mockImplementation(mockWorkspaceFs.stat);
    vi.mocked(vscode.workspace.fs.readFile).mockImplementation(mockWorkspaceFs.readFile);
    vi.mocked(PathSanitizer.sanitizePath).mockImplementation((path) => path);

    readFileTool = new ReadFileTool(mockGitOperationsManager as any);
  });

  describe('schema validation', () => {
    it('should have correct schema properties', () => {
      expect(readFileTool.name).toBe('read_file');
      expect(readFileTool.description).toContain('Read the content of a file');
      expect(readFileTool.schema).toBeDefined();
    });

    it('should validate file path is required', () => {
      const result = readFileTool.schema.safeParse({});
      expect(result.success).toBe(false);
    });

    it('should validate line count is within limits', () => {
      const result = readFileTool.schema.safeParse({
        filePath: 'test.ts',
        startLine: 1,
        lineCount: TokenConstants.MAX_FILE_READ_LINES + 1
      });
      expect(result.success).toBe(false);
    });

    it('should accept valid parameters', () => {
      const result = readFileTool.schema.safeParse({
        filePath: 'src/test.ts',
        startLine: 10,
        lineCount: 50
      });
      expect(result.success).toBe(true);
    });
  });

  describe('execute', () => {
    beforeEach(() => {
      mockGitOperationsManager.getRepository.mockReturnValue({
        rootUri: { fsPath: '/project/root' }
      });
      mockWorkspaceFs.stat.mockResolvedValue({});
    });

    it('should return error when git repository not found', async () => {
      mockGitOperationsManager.getRepository.mockReturnValue(null);

      const result = await readFileTool.execute({ filePath: 'test.ts' });

      expect(result).toEqual(['<file_content>\n  <error>Git repository not found</error>\n</file_content>']);
    });

    it('should return error when file not found', async () => {
      mockWorkspaceFs.stat.mockRejectedValue(new Error('File not found'));

      const result = await readFileTool.execute({ filePath: 'nonexistent.ts' });

      expect(result[0]).toContain('<error>File not found: nonexistent.ts</error>');
    });

    it('should read full file successfully', async () => {
      const fileContent = 'line 1\nline 2\nline 3';
      mockWorkspaceFs.readFile.mockResolvedValue(Buffer.from(fileContent));

      const result = await readFileTool.execute({ filePath: 'test.ts' });

      expect(result).toHaveLength(1);
      expect(result[0]).toContain('<file_content>');
      expect(result[0]).toContain('<file>test.ts</file>');
      expect(result[0]).toContain('<content>');
      expect(result[0]).toContain('1: line 1');
      expect(result[0]).toContain('2: line 2');
      expect(result[0]).toContain('3: line 3');
    });

    it('should read partial file with startLine and lineCount', async () => {
      const fileContent = 'line 1\nline 2\nline 3\nline 4\nline 5';
      mockWorkspaceFs.readFile.mockResolvedValue(Buffer.from(fileContent));

      const result = await readFileTool.execute({
        filePath: 'test.ts',
        startLine: 2,
        lineCount: 2
      });

      expect(result[0]).toContain('2: line 2');
      expect(result[0]).toContain('3: line 3');
      expect(result[0]).not.toContain('1: line 1');
      expect(result[0]).not.toContain('4: line 4');
    });

    it('should handle startLine beyond file length', async () => {
      const fileContent = 'line 1\nline 2';
      mockWorkspaceFs.readFile.mockResolvedValue(Buffer.from(fileContent));

      const result = await readFileTool.execute({
        filePath: 'test.ts',
        startLine: 10
      });

      expect(result[0]).toContain('<error>Start line 10 exceeds file length (2 lines)</error>');
    });

    it('should limit line count to maximum allowed', async () => {
      const fileContent = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\n');
      mockWorkspaceFs.readFile.mockResolvedValue(Buffer.from(fileContent));

      const result = await readFileTool.execute({
        filePath: 'test.ts',
        startLine: 1,
        lineCount: 250
      });

      // Should be limited to MAX_FILE_READ_LINES
      const lines = result[0].split('\n').filter(line => line.match(/^\d+: /));
      expect(lines.length).toBeLessThanOrEqual(TokenConstants.MAX_FILE_READ_LINES);
    });

    it('should return error for files exceeding size limit', async () => {
      const largeContent = 'A'.repeat(TokenConstants.MAX_TOOL_RESPONSE_CHARS + 1000);
      mockWorkspaceFs.readFile.mockResolvedValue(Buffer.from(largeContent));

      const result = await readFileTool.execute({ filePath: 'large.ts' });

      expect(result[0]).toContain('<error>File too large');
      expect(result[0]).toContain('Please use startLine and lineCount parameters');
    });

    it('should handle read errors gracefully', async () => {
      mockWorkspaceFs.readFile.mockRejectedValue(new Error('Permission denied'));

      const result = await readFileTool.execute({ filePath: 'test.ts' });

      expect(result[0]).toContain('<error>Failed to read file test.ts: Permission denied</error>');
    });

    it('should sanitize file paths', async () => {
      const fileContent = 'test content';
      mockWorkspaceFs.readFile.mockResolvedValue(Buffer.from(fileContent));
      vi.mocked(PathSanitizer.sanitizePath).mockReturnValue('sanitized/path.ts');

      // Clear previous calls to get accurate assertion
      vi.mocked(vscode.Uri.file).mockClear();

      await readFileTool.execute({ filePath: '../../../etc/passwd' });

      expect(PathSanitizer.sanitizePath).toHaveBeenCalledWith('../../../etc/passwd');
      expect(vscode.Uri.file).toHaveBeenCalledWith(
        expect.stringContaining('sanitized')
      );
    });

    it('should handle partial file reading with size check', async () => {
      // Create content that would be too large when formatted but acceptable when limited
      const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1} with some content`);
      const fileContent = lines.join('\n');
      mockWorkspaceFs.readFile.mockResolvedValue(Buffer.from(fileContent));

      const result = await readFileTool.execute({
        filePath: 'test.ts',
        startLine: 1,
        lineCount: 10
      });

      expect(result[0]).toContain('<file_content>');
      expect(result[0]).toContain('1: line 1 with some content');
      expect(result[0]).toContain('10: line 10 with some content');
      expect(result[0]).not.toContain('11: line 11');
    });

    it('should use default startLine when not provided', async () => {
      const fileContent = 'line 1\nline 2\nline 3';
      mockWorkspaceFs.readFile.mockResolvedValue(Buffer.from(fileContent));

      const result = await readFileTool.execute({
        filePath: 'test.ts',
        lineCount: 2
      });

      expect(result[0]).toContain('1: line 1');
      expect(result[0]).toContain('2: line 2');
      expect(result[0]).not.toContain('3: line 3');
    });

    it('should handle empty files', async () => {
      mockWorkspaceFs.readFile.mockResolvedValue(Buffer.from(''));

      const result = await readFileTool.execute({ filePath: 'empty.ts' });

      expect(result[0]).toContain('<file_content>');
      expect(result[0]).toContain('<file>empty.ts</file>');
      expect(result[0]).toContain('<content>');
      expect(result[0]).toContain('</content>');
    });

    it('should properly escape XML in file content', async () => {
      const fileContent = 'const html = "<div>test & data</div>";';
      mockWorkspaceFs.readFile.mockResolvedValue(Buffer.from(fileContent));

      const result = await readFileTool.execute({ filePath: 'test.ts' });

      // Content should be XML-escaped
      expect(result[0]).toContain('&lt;div&gt;test &amp; data&lt;/div&gt;');
    });

    it('should handle files with only newlines', async () => {
      const fileContent = '\n\n\n';
      mockWorkspaceFs.readFile.mockResolvedValue(Buffer.from(fileContent));

      const result = await readFileTool.execute({ filePath: 'newlines.ts' });

      expect(result[0]).toContain('1: ');
      expect(result[0]).toContain('2: ');
      expect(result[0]).toContain('3: ');
      expect(result[0]).toContain('4: '); // Empty line after last newline
    });
  });

  describe('XML formatting', () => {
    beforeEach(() => {
      mockGitOperationsManager.getRepository.mockReturnValue({
        rootUri: { fsPath: '/project/root' }
      });
      mockWorkspaceFs.stat.mockResolvedValue({});
    });

    it('should format output with proper XML structure', async () => {
      const fileContent = 'function test() {\n  return "hello";\n}';
      mockWorkspaceFs.readFile.mockResolvedValue(Buffer.from(fileContent));

      const result = await readFileTool.execute({ filePath: 'test.ts' });

      expect(result[0]).toContain('<file_content>');
      expect(result[0]).toContain('  <file>test.ts</file>');
      expect(result[0]).toContain('  <content>');
      expect(result[0]).toContain('1: function test() {');
      expect(result[0]).toContain('2:   return &quot;hello&quot;;');
      expect(result[0]).toContain('3: }');
      expect(result[0]).toContain('  </content>');
      expect(result[0]).toContain('</file_content>');
    });

    it('should format error output with proper XML structure', async () => {
      mockGitOperationsManager.getRepository.mockReturnValue(null);

      const result = await readFileTool.execute({ filePath: 'test.ts' });

      expect(result[0]).toContain('<file_content>');
      expect(result[0]).toContain('  <error>Git repository not found</error>');
      expect(result[0]).toContain('</file_content>');
    });
  });
});