import * as vscode from 'vscode';
import { z } from 'zod';
import { Log } from './loggingService';
import { GetSymbolsOverviewTool } from '../tools/getSymbolsOverviewTool';
import type { ToolResult } from '../types/toolResultTypes';

/** Full input type derived from tool's Zod schema - no artificial limitations. */
type GetSymbolsOverviewInput = z.infer<GetSymbolsOverviewTool['schema']>;

/**
 * Registers Lupa's unique tools for VS Code Language Model API (Agent Mode).
 * Currently exposes only GetSymbolsOverviewTool as it provides unique value
 * not available in built-in Copilot tools.
 *
 * @see Decision 5 in docs/architecture.md
 */
export class LanguageModelToolProvider implements vscode.Disposable {
    private registration: vscode.Disposable | undefined;

    constructor(private readonly symbolsOverviewTool: GetSymbolsOverviewTool) {}

    /**
     * Register the tool with VS Code's Language Model API.
     */
    public register(): void {
        try {
            // Check if the API is available
            if (!vscode.lm || typeof vscode.lm.registerTool !== 'function') {
                Log.warn(
                    '[LanguageModelToolProvider]: Language Model API may not be available - tool registration skipped'
                );
                return;
            }

            this.registration = vscode.lm.registerTool<GetSymbolsOverviewInput>(
                'lupa_getSymbolsOverview',
                {
                    invoke: async (options, token) => {
                        return this.handleInvoke(options.input, token);
                    },
                }
            );
            Log.info(
                '[LanguageModelToolProvider]: lupa_getSymbolsOverview registered for Agent Mode'
            );
        } catch (error) {
            Log.warn(
                '[LanguageModelToolProvider]: Tool registration failed - Language Model API may not be available',
                error
            );
        }
    }

    /**
     * Handle tool invocation from Copilot Agent Mode.
     */
    private async handleInvoke(
        input: GetSymbolsOverviewInput,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const result: ToolResult =
                await this.symbolsOverviewTool.execute(input);

            if (result.success && result.data) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(String(result.data)),
                ]);
            } else {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        `Error: ${result.error || 'Unknown error occurred'}`
                    ),
                ]);
            }
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            Log.error(
                '[LanguageModelToolProvider]: Tool invocation failed',
                error
            );
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Error: ${message}`),
            ]);
        }
    }

    /**
     * Dispose of the registration.
     */
    public dispose(): void {
        if (this.registration) {
            this.registration.dispose();
            this.registration = undefined;
        }
    }
}
