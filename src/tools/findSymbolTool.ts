import { z } from 'zod';
import * as vscode from 'vscode';
import { BaseTool } from './baseTool';
import { SymbolRangeExpander } from './symbolRangeExpander';
import { DefinitionFormatter } from './definitionFormatter';

/**
 * Tool that finds the definition of a code symbol using VS Code's definition provider.
 * Uses vscode.executeDefinitionProvider to locate symbol definitions.
 */
export class FindSymbolTool extends BaseTool {
  name = 'find_symbol';
  description = "Find the definition of a code symbol by name using VS Code's definition provider";

  private readonly rangeExpander = new SymbolRangeExpander();
  private readonly formatter = new DefinitionFormatter();

  schema = z.object({
    symbolName: z.string().min(1, 'Symbol name cannot be empty').describe('The name of the symbol to find the definition for'),
    relativePath: z.string().optional().describe("Optional relative path to search within (e.g., 'src/components/Button.tsx')"),
    includeFullBody: z.boolean().default(true).optional().describe('Whether to include the full symbol body (default: true). Set to false for just location info.'),
  });

  async execute(args: z.infer<typeof this.schema>): Promise<string[]> {
    try {
      const { symbolName, relativePath, includeFullBody } = args;

      // Sanitize input to prevent potential injection attacks
      const sanitizedSymbolName = symbolName.trim();
      if (!sanitizedSymbolName) {
        return ['Error: Symbol name cannot be empty'];
      }

      // Get text documents to search for the symbol
      let textDocuments = vscode.workspace.textDocuments;

      // Filter by relative path if provided
      if (relativePath) {
        const targetPath = relativePath.trim();
        textDocuments = textDocuments.filter(doc => {
          const docRelativePath = vscode.workspace.asRelativePath(doc.uri);
          return docRelativePath.includes(targetPath) || docRelativePath.endsWith(targetPath);
        });
      }

      const definitions: vscode.Location[] = [];

      // Search through all open documents for the symbol
      for (const document of textDocuments) {
        const text = document.getText();
        const lines = text.split('\n');

        for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
          const line = lines[lineIndex];
          const symbolIndex = line.indexOf(sanitizedSymbolName);

          if (symbolIndex !== -1) {
            const position = new vscode.Position(lineIndex, symbolIndex);

            try {
              // Use VS Code's definition provider to find the symbol definition
              const foundDefinitions = await vscode.commands.executeCommand<vscode.Location[]>(
                'vscode.executeDefinitionProvider',
                document.uri,
                position
              );

              if (foundDefinitions && foundDefinitions.length > 0) {
                definitions.push(...foundDefinitions);
              }
            } catch (error) {
              // Continue searching even if one position fails
              continue;
            }
          }
        }
      }

      // Remove duplicates based on URI and range
      const uniqueDefinitions = definitions.filter((def, index, arr) => {
        return arr.findIndex(d =>
          d.uri.toString() === def.uri.toString() &&
          d.range.start.line === def.range.start.line &&
          d.range.start.character === def.range.start.character
        ) === index;
      });

      if (uniqueDefinitions.length === 0) {
        return [this.formatter.formatNotFoundMessage(sanitizedSymbolName)];
      }

      // Extract and format the definition text from each location
      const formattedDefinitions: string[] = [];

      for (const definition of uniqueDefinitions) {
        try {
          const document = await vscode.workspace.openTextDocument(definition.uri);
          const range = definition.range;
          const filePath = vscode.workspace.asRelativePath(definition.uri);

          let symbolBody: string | undefined;
          if (includeFullBody) {
            // Get the full symbol body by finding the complete structure (function, class, etc.)
            const fullSymbolRange = await this.rangeExpander.getFullSymbolRange(document, range);
            symbolBody = document.getText(fullSymbolRange);
          }

          const formattedDefinition = this.formatter.formatDefinition(
            filePath,
            sanitizedSymbolName,
            range,
            symbolBody,
            includeFullBody
          );

          formattedDefinitions.push(formattedDefinition);
        } catch (error) {
          const filePath = vscode.workspace.asRelativePath(definition.uri);
          const errorDefinition = this.formatter.formatErrorDefinition(
            filePath,
            sanitizedSymbolName,
            definition.range,
            error
          );

          formattedDefinitions.push(errorDefinition);
        }
      }

      return formattedDefinitions;

    } catch (error) {
      return [`Error finding symbol definition: ${error instanceof Error ? error.message : String(error)}`];
    }
  }

}
