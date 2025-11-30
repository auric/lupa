import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';
import * as vscode from 'vscode';
import * as path from 'path';
import { ReadFileTool } from '../tools/readFileTool';
import { TokenConstants } from '../models/tokenConstants';
import { GitOperationsManager } from '../services/gitOperationsManager';
import { PathSanitizer } from '../utils/pathSanitizer';
import { ToolResult } from '../types/toolResultTypes';

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
        file_path: 'test.ts',
        start_line: 1,
        line_count: TokenConstants.MAX_FILE_READ_LINES + 1
      });
      expect(result.success).toBe(false);
    });

    it('should accept valid parameters', () => {
      const result = readFileTool.schema.safeParse({
        file_path: 'src/test.ts',
        start_line: 10,
        line_count: 50
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

      const result = await readFileTool.execute({ file_path: 'test.ts' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Git repository not found');
    });

    it('should return error when file not found', async () => {
      mockWorkspaceFs.stat.mockRejectedValue(new Error('File not found'));

      const result = await readFileTool.execute({ file_path: 'nonexistent.ts' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('File not found: nonexistent.ts');
    });

    it('should read full file successfully', async () => {
      const fileContent = 'line 1\nline 2\nline 3';
      mockWorkspaceFs.readFile.mockResolvedValue(Buffer.from(fileContent));

      const result = await readFileTool.execute({ file_path: 'test.ts' });

      expect(result.success).toBe(true);
      expect(result.data).toContain('=== test.ts ===');
      expect(result.data).toContain('1: line 1');
      expect(result.data).toContain('2: line 2');
      expect(result.data).toContain('3: line 3');
    });

    it('should read partial file with startLine and lineCount', async () => {
      const fileContent = 'line 1\nline 2\nline 3\nline 4\nline 5';
      mockWorkspaceFs.readFile.mockResolvedValue(Buffer.from(fileContent));

      const result = await readFileTool.execute({
        file_path: 'test.ts',
        start_line: 2,
        line_count: 2
      });

      expect(result.success).toBe(true);
      expect(result.data).toContain('2: line 2');
      expect(result.data).toContain('3: line 3');
      expect(result.data).not.toContain('1: line 1');
      expect(result.data).not.toContain('4: line 4');
    });

    it('should handle startLine beyond file length', async () => {
      const fileContent = 'line 1\nline 2';
      mockWorkspaceFs.readFile.mockResolvedValue(Buffer.from(fileContent));

      const result = await readFileTool.execute({
        file_path: 'test.ts',
        start_line: 10
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Start line 10 exceeds file length (2 lines)');
    });

    it('should limit line count to maximum allowed', async () => {
      const fileContent = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\n');
      mockWorkspaceFs.readFile.mockResolvedValue(Buffer.from(fileContent));

      const result = await readFileTool.execute({
        file_path: 'test.ts',
        start_line: 1,
        line_count: 250
      });

      expect(result.success).toBe(true);
      const lines = result.data!.split('\n').filter((line: string) => line.match(/^\d+: /));
      expect(lines.length).toBeLessThanOrEqual(TokenConstants.MAX_FILE_READ_LINES);
    });

    it('should return error for files exceeding size limit', async () => {
      const largeContent = 'A'.repeat(TokenConstants.MAX_TOOL_RESPONSE_CHARS + 1000);
      mockWorkspaceFs.readFile.mockResolvedValue(Buffer.from(largeContent));

      const result = await readFileTool.execute({ file_path: 'large.ts' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('File too large');
      expect(result.error).toContain('Please use start_line and line_count parameters');
    });

    it('should handle read errors gracefully', async () => {
      mockWorkspaceFs.readFile.mockRejectedValue(new Error('Permission denied'));

      const result = await readFileTool.execute({ file_path: 'test.ts' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to read file test.ts: Permission denied');
    });

    it('should sanitize file paths', async () => {
      const fileContent = 'test content';
      mockWorkspaceFs.readFile.mockResolvedValue(Buffer.from(fileContent));
      vi.mocked(PathSanitizer.sanitizePath).mockReturnValue('sanitized/path.ts');

      // Clear previous calls to get accurate assertion
      vi.mocked(vscode.Uri.file).mockClear();

      await readFileTool.execute({ file_path: '../../../etc/passwd' });

      expect(PathSanitizer.sanitizePath).toHaveBeenCalledWith('../../../etc/passwd');
      expect(vscode.Uri.file).toHaveBeenCalledWith(
        expect.stringContaining('sanitized')
      );
    });

    it('should handle partial file reading with size check', async () => {
      const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1} with some content`);
      const fileContent = lines.join('\n');
      mockWorkspaceFs.readFile.mockResolvedValue(Buffer.from(fileContent));

      const result = await readFileTool.execute({
        file_path: 'test.ts',
        start_line: 1,
        line_count: 10
      });

      expect(result.success).toBe(true);
      expect(result.data).toContain('=== test.ts ===');
      expect(result.data).toContain('1: line 1 with some content');
      expect(result.data).toContain('10: line 10 with some content');
      expect(result.data).not.toContain('11: line 11');
    });

    it('should use default startLine when not provided', async () => {
      const fileContent = 'line 1\nline 2\nline 3';
      mockWorkspaceFs.readFile.mockResolvedValue(Buffer.from(fileContent));

      const result = await readFileTool.execute({
        file_path: 'test.ts',
        line_count: 2
      });

      expect(result.success).toBe(true);
      expect(result.data).toContain('1: line 1');
      expect(result.data).toContain('2: line 2');
      expect(result.data).not.toContain('3: line 3');
    });

    it('should handle empty files', async () => {
      mockWorkspaceFs.readFile.mockResolvedValue(Buffer.from(''));

      const result = await readFileTool.execute({ file_path: 'empty.ts' });

      expect(result.success).toBe(true);
      expect(result.data).toContain('=== empty.ts ===');
    });

    it('should properly handle special characters in file content', async () => {
      const fileContent = 'const html = "<div>test & data</div>";';
      mockWorkspaceFs.readFile.mockResolvedValue(Buffer.from(fileContent));

      const result = await readFileTool.execute({ file_path: 'test.ts' });

      expect(result.success).toBe(true);
      expect(result.data).toContain('<div>test & data</div>');
    });

    it('should handle files with only newlines', async () => {
      const fileContent = '\n\n\n';
      mockWorkspaceFs.readFile.mockResolvedValue(Buffer.from(fileContent));

      const result = await readFileTool.execute({ file_path: 'newlines.ts' });

      expect(result.success).toBe(true);
      expect(result.data).toContain('1: ');
      expect(result.data).toContain('2: ');
      expect(result.data).toContain('3: ');
      expect(result.data).toContain('4: ');
    });
  });

  describe('output formatting', () => {
    beforeEach(() => {
      mockGitOperationsManager.getRepository.mockReturnValue({
        rootUri: { fsPath: '/project/root' }
      });
      mockWorkspaceFs.stat.mockResolvedValue({});
    });

    it('should format output with file header and line numbers', async () => {
      const fileContent = 'function test() {\n  return "hello";\n}';
      mockWorkspaceFs.readFile.mockResolvedValue(Buffer.from(fileContent));

      const result = await readFileTool.execute({ file_path: 'test.ts' });

      expect(result.success).toBe(true);
      expect(result.data).toContain('=== test.ts ===');
      expect(result.data).toContain('1: function test() {');
      expect(result.data).toContain('2:   return "hello";');
      expect(result.data).toContain('3: }');
    });

    it('should return error with proper structure', async () => {
      mockGitOperationsManager.getRepository.mockReturnValue(null);

      const result = await readFileTool.execute({ file_path: 'test.ts' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Git repository not found');
      expect(result.data).toBeUndefined();
    });
  });
});