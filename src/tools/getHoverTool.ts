import { z } from 'zod';
import * as path from 'path';
import * as vscode from 'vscode';
import { BaseTool } from './baseTool';
import { GitOperationsManager } from '../services/gitOperationsManager';
import { PathSanitizer } from '../utils/pathSanitizer';

/**
 * Tool that provides hover information for a symbol at a specific position.
 * Uses vscode.executeHoverProvider to get type and documentation information.
 */
export class GetHoverTool extends BaseTool {
  name = 'get_hover';
  description = "Get hover information (type, documentation) for a symbol at a specific position using VS Code's hover provider";

  schema = z.object({
    filePath: z.string().min(1, 'File path cannot be empty').describe('The file path (relative to project root)'),
    line: z.number().int().min(0, 'Line must be a non-negative integer').describe('The line number (0-based)'),
    character: z.number().int().min(0, 'Character must be a non-negative integer').describe('The character position (0-based)'),
  });

  constructor(private readonly gitOperationsManager: GitOperationsManager) {
    super();
  }

  async execute(args: z.infer<typeof this.schema>): Promise<string[]> {
    try {
      const { filePath, line, character } = args;

      // Get git repository root
      const gitRootDirectory = this.gitOperationsManager.getRepository()?.rootUri.fsPath;
      if (!gitRootDirectory) {
        return ['Error: Git repository not found'];
      }

      // Sanitize the relative path to prevent directory traversal attacks
      let sanitizedPath: string;
      try {
        sanitizedPath = PathSanitizer.sanitizePath(filePath);
      } catch (error) {
        return [`Error: Invalid file path: ${error instanceof Error ? error.message : String(error)}`];
      }

      // Resolve the file path relative to git root
      const absoluteFilePath = path.join(gitRootDirectory, sanitizedPath);
      const fileUri = vscode.Uri.file(absoluteFilePath);
      
      // Check if file exists
      try {
        await vscode.workspace.fs.stat(fileUri);
      } catch (error) {
        return [`Error: File not found: ${sanitizedPath}`];
      }

      // Open the document
      let document: vscode.TextDocument;
      try {
        document = await vscode.workspace.openTextDocument(fileUri);
      } catch (error) {
        return [`Error: Could not open file: ${error instanceof Error ? error.message : String(error)}`];
      }

      // Validate position bounds
      if (line >= document.lineCount) {
        return [`Error: Line ${line} is out of bounds (file has ${document.lineCount} lines)`];
      }

      const lineText = document.lineAt(line);
      if (character >= lineText.text.length) {
        return [`Error: Character position ${character} is out of bounds (line has ${lineText.text.length} characters)`];
      }

      const position = new vscode.Position(line, character);

      // Execute hover provider
      let hoverInfo: vscode.Hover[] | undefined;
      try {
        hoverInfo = await vscode.commands.executeCommand<vscode.Hover[]>(
          'vscode.executeHoverProvider',
          fileUri,
          position
        );
      } catch (error) {
        return [`Error executing hover provider: ${error instanceof Error ? error.message : String(error)}`];
      }

      if (!hoverInfo || hoverInfo.length === 0) {
        return [`No hover information available for position ${line}:${character} in ${sanitizedPath}`];
      }

      // Format hover information as simple list of strings
      const results: string[] = [];
      
      for (const hover of hoverInfo) {
        if (hover.contents && hover.contents.length > 0) {
          for (const content of hover.contents) {
            if (typeof content === 'string') {
              results.push(content);
            } else if (content instanceof vscode.MarkdownString) {
              results.push(content.value);
            } else if ('language' in content && 'value' in content) {
              // Handle marked strings (code blocks)
              const language = content.language || '';
              const value = content.value || '';
              if (language) {
                results.push(`\`\`\`${language}\n${value}\n\`\`\``);
              } else {
                results.push(value);
              }
            } else if ('value' in content) {
              // Handle objects with value property (fallback for MarkdownString-like objects)
              results.push((content as any).value);
            }
          }
        }
      }

      if (results.length === 0) {
        return [`No hover content available for position ${line}:${character} in ${sanitizedPath}`];
      }

      return results;

    } catch (error) {
      return [`Error getting hover information: ${error instanceof Error ? error.message : String(error)}`];
    }
  }
}