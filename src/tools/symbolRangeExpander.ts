import * as vscode from 'vscode';
import {
    withCancellableTimeout,
    isTimeoutError,
    isCancellationError,
} from '../utils/asyncUtils';
import { getErrorMessage } from '../utils/errorUtils';
import { Log } from '../services/loggingService';

/** Timeout for document symbol provider call */
const SYMBOL_PROVIDER_TIMEOUT = 5_000; // 5 seconds

/**
 * Utility class for expanding symbol ranges to include full symbol definitions.
 * Handles both VS Code DocumentSymbolProvider and fallback heuristic approaches.
 */
export class SymbolRangeExpander {
    /**
     * Get the full range of a symbol definition (e.g., entire function, class, or variable declaration)
     * @param document The text document containing the symbol
     * @param symbolRange The initial range returned by the definition provider
     * @param token Cancellation token for aborting the operation
     * @returns A range that encompasses the full symbol definition
     */
    async getFullSymbolRange(
        document: vscode.TextDocument,
        symbolRange: vscode.Range,
        token: vscode.CancellationToken
    ): Promise<vscode.Range> {
        try {
            const symbolsPromise = vscode.commands.executeCommand<
                vscode.DocumentSymbol[]
            >('vscode.executeDocumentSymbolProvider', document.uri);

            const symbols = await withCancellableTimeout(
                Promise.resolve(symbolsPromise),
                SYMBOL_PROVIDER_TIMEOUT,
                `Document symbols for ${document.fileName}`,
                token
            );

            if (symbols && symbols.length > 0) {
                const targetPosition = symbolRange.start;
                const containingSymbol = this.findContainingSymbol(
                    symbols,
                    targetPosition
                );

                if (containingSymbol) {
                    return containingSymbol.range;
                }
            }

            // Fallback: try to expand the range intelligently based on code structure
            return this.expandRangeForSymbol(document, symbolRange, token);
        } catch (error) {
            if (isCancellationError(error)) {
                throw error;
            }
            if (isTimeoutError(error)) {
                Log.debug(
                    `Document symbol provider timed out for ${document.fileName} - using heuristic expansion`
                );
            } else {
                const message = getErrorMessage(error);
                Log.debug(
                    `Document symbol provider failed for ${document.fileName}: ${message}`
                );
            }
            // Fallback to expanded range if symbol provider fails or times out
            return this.expandRangeForSymbol(document, symbolRange, token);
        }
    }

    /**
     * Recursively find the symbol that contains the target position
     */
    private findContainingSymbol(
        symbols: vscode.DocumentSymbol[],
        targetPosition: vscode.Position
    ): vscode.DocumentSymbol | undefined {
        for (const symbol of symbols) {
            if (symbol.range.contains(targetPosition)) {
                // Check if any child symbol is more specific
                if (symbol.children && symbol.children.length > 0) {
                    const childSymbol = this.findContainingSymbol(
                        symbol.children,
                        targetPosition
                    );
                    if (childSymbol) {
                        return childSymbol;
                    }
                }
                return symbol;
            }
        }
        return undefined;
    }

    /**
     * Fallback method to expand range based on code structure heuristics
     */
    private expandRangeForSymbol(
        document: vscode.TextDocument,
        symbolRange: vscode.Range,
        token: vscode.CancellationToken
    ): vscode.Range {
        if (token.isCancellationRequested) {
            throw new vscode.CancellationError();
        }

        const startLine = symbolRange.start.line;
        const text = document.getText();
        const lines = text.split('\n');

        // Look for common patterns that indicate symbol boundaries
        let expandedStartLine = startLine;
        let expandedEndLine = symbolRange.end.line;

        // Expand backwards to include comments and decorators
        for (let line = startLine - 1; line >= 0; line--) {
            const currentLine = lines[line];
            if (!currentLine) {
                break;
            }
            const lineText = currentLine.trim();
            if (
                lineText.startsWith('//') ||
                lineText.startsWith('/*') ||
                lineText.startsWith('@') ||
                lineText === ''
            ) {
                expandedStartLine = line;
            } else {
                break;
            }
        }

        // Expand forwards to include the full function/class body
        let braceCount = 0;
        let inFunction = false;

        for (let line = startLine; line < lines.length; line++) {
            if (token.isCancellationRequested) {
                throw new vscode.CancellationError();
            }

            const lineText = lines[line];
            if (!lineText) {
                continue;
            }

            // Count braces to find the end of blocks
            for (const char of lineText) {
                if (char === '{') {
                    braceCount++;
                    inFunction = true;
                } else if (char === '}') {
                    braceCount--;
                    if (inFunction && braceCount === 0) {
                        expandedEndLine = line;
                        const endLineText = lines[expandedEndLine];
                        return new vscode.Range(
                            expandedStartLine,
                            0,
                            expandedEndLine,
                            endLineText?.length ?? 0
                        );
                    }
                }
            }

            // If we haven't found braces, look for other end patterns
            if (!inFunction && line > startLine + 10) {
                // For simple declarations, limit expansion
                break;
            }
        }

        // Default expansion: include a few lines of context
        expandedEndLine = Math.min(
            document.lineCount - 1,
            symbolRange.end.line + 5
        );

        const endLineText = lines[expandedEndLine];
        return new vscode.Range(
            expandedStartLine,
            0,
            expandedEndLine,
            endLineText?.length ?? 0
        );
    }
}
