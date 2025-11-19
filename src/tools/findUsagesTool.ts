import { z } from 'zod';
import * as vscode from 'vscode';
import { BaseTool } from './baseTool';
import { UsageFormatter } from './usageFormatter';

/**
 * Tool that finds all usages of a code symbol using VS Code's reference provider.
 * Uses vscode.executeReferenceProvider to locate all references to a symbol.
 */
export class FindUsagesTool extends BaseTool {
  name = 'find_usages';
  description = "Find all usages/references of a code symbol using VS Code's reference provider";

  private readonly formatter = new UsageFormatter();

  schema = z.object({
    symbol_name: z.string().min(1, 'Symbol name cannot be empty')
      .describe('The name of the symbol to find usages for'),
    file_path: z.string().min(1, 'File path cannot be empty')
      .describe('The file path where the symbol is defined (used as starting point for reference search)'),
    should_include_declaration: z.boolean().default(false).optional()
      .describe('Whether to include the symbol declaration in results (default: false)'),
    context_line_count: z.number().min(0).max(10).default(2).optional()
      .describe('Number of context lines to include around each usage (0-10, default: 2)'),
  });

  async execute(args: z.infer<typeof this.schema>): Promise<string[]> {
    try {
      const { symbol_name, file_path, should_include_declaration, context_line_count } = args;

      // Sanitize input to prevent potential injection attacks
      const sanitizedSymbolName = symbol_name.trim();
      const sanitizedFilePath = file_path.trim();

      if (!sanitizedSymbolName) {
        return ['Error: Symbol name cannot be empty'];
      }

      if (!sanitizedFilePath) {
        return ['Error: File path cannot be empty'];
      }

      // Get the document containing the symbol definition
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        return ['Error: No workspace folder is open'];
      }

      // Convert relative path to absolute path
      const absolutePath = vscode.Uri.joinPath(workspaceFolder.uri, sanitizedFilePath);
      
      let document: vscode.TextDocument;
      try {
        document = await vscode.workspace.openTextDocument(absolutePath);
      } catch (error) {
        return [`Error: Could not open file '${sanitizedFilePath}': ${error instanceof Error ? error.message : String(error)}`];
      }

      // Find the symbol position in the document to use as starting point
      const symbolPosition = await this.findSymbolPosition(document, sanitizedSymbolName);
      if (!symbolPosition) {
        return [this.formatter.formatNoUsagesMessage(sanitizedSymbolName, sanitizedFilePath)];
      }

      try {
        // Use VS Code's reference provider to find all references
        const references = await vscode.commands.executeCommand<vscode.Location[]>(
          'vscode.executeReferenceProvider',
          document.uri,
          symbolPosition,
          { includeDeclaration: should_include_declaration || false }
        );

        if (!references || references.length === 0) {
          return [this.formatter.formatNoUsagesMessage(sanitizedSymbolName, sanitizedFilePath)];
        }

        // Remove duplicates based on URI and range
        const uniqueReferences = this.deduplicateReferences(references);

        // Format each reference with context
        const formattedUsages: string[] = [];

        for (const reference of uniqueReferences) {
          try {
            const refDocument = await vscode.workspace.openTextDocument(reference.uri);
            const relativeFilePath = vscode.workspace.asRelativePath(reference.uri);
            
            // Extract context lines around the reference
            const contextText = this.formatter.extractContextLines(
              refDocument,
              reference.range,
              context_line_count || 2
            );

            const formattedUsage = this.formatter.formatUsage(
              relativeFilePath,
              sanitizedSymbolName,
              reference.range,
              contextText
            );

            formattedUsages.push(formattedUsage);
          } catch (error) {
            const relativeFilePath = vscode.workspace.asRelativePath(reference.uri);
            const errorUsage = this.formatter.formatErrorUsage(
              relativeFilePath,
              sanitizedSymbolName,
              reference.range,
              error
            );

            formattedUsages.push(errorUsage);
          }
        }

        return formattedUsages;

      } catch (error) {
        return [`Error executing reference provider: ${error instanceof Error ? error.message : String(error)}`];
      }

    } catch (error) {
      return [`Error finding symbol usages: ${error instanceof Error ? error.message : String(error)}`];
    }
  }

  /**
   * Find the position of a symbol within a document
   * @param document The VS Code text document
   * @param symbolName The name of the symbol to find
   * @returns The position of the symbol, or null if not found
   */
  private async findSymbolPosition(document: vscode.TextDocument, symbolName: string): Promise<vscode.Position | null> {
    const text = document.getText();
    const lines = text.split('\n');

    // Look for the symbol in the document
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      const symbolIndex = line.indexOf(symbolName);

      if (symbolIndex !== -1) {
        const position = new vscode.Position(lineIndex, symbolIndex);
        
        // Verify this is actually a symbol definition by checking if definition provider returns this location
        try {
          const definitions = await vscode.commands.executeCommand<vscode.Location[]>(
            'vscode.executeDefinitionProvider',
            document.uri,
            position
          );

          // If we get back the same location, this is likely the definition
          if (definitions && definitions.some(def => 
            def.uri.toString() === document.uri.toString() &&
            def.range.contains(position)
          )) {
            return position;
          }
        } catch {
          // Continue searching if definition check fails
        }
      }
    }

    // If no definition found, return the first occurrence as fallback
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      const symbolIndex = line.indexOf(symbolName);

      if (symbolIndex !== -1) {
        return new vscode.Position(lineIndex, symbolIndex);
      }
    }

    return null;
  }

  /**
   * Remove duplicate references based on URI and range
   * @param references Array of VS Code Location objects
   * @returns Deduplicated array of references
   */
  private deduplicateReferences(references: vscode.Location[]): vscode.Location[] {
    return references.filter((ref, index, arr) => {
      return arr.findIndex(r =>
        r.uri.toString() === ref.uri.toString() &&
        r.range.start.line === ref.range.start.line &&
        r.range.start.character === ref.range.start.character &&
        r.range.end.line === ref.range.end.line &&
        r.range.end.character === ref.range.end.character
      ) === index;
    });
  }
}