import * as vscode from 'vscode';
import { AnalysisOrchestrator } from './analysisOrchestrator';
import { CopilotModelCoordinator } from './copilotModelCoordinator';
import { IServiceRegistry } from '../services/serviceManager';
import { ANALYSIS_LIMITS } from '../models/workspaceSettingsSchema';

/**
 * CommandRegistry handles all VS Code command registration.
 * Centralizes command management and reduces coordinator complexity.
 */
export class CommandRegistry implements vscode.Disposable {
    private readonly disposables: vscode.Disposable[] = [];

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly services: IServiceRegistry,
        private readonly analysisOrchestrator: AnalysisOrchestrator,
        private readonly copilotModelCoordinator: CopilotModelCoordinator
    ) { }

    /**
     * Register all extension commands
     */
    public registerAllCommands(): void {
        // Core analysis commands
        this.registerCommand('lupa.analyzePR', () =>
            this.analysisOrchestrator.analyzePR()
        );

        // Copilot language model commands
        this.registerCommand('lupa.showLanguageModelsInfo', () =>
            this.copilotModelCoordinator.showCopilotModelsInfo()
        );

        this.registerCommand('lupa.selectLanguageModel', () =>
            this.copilotModelCoordinator.showCopilotModelSelectionOptions()
        );

        // Repository selection command
        this.registerCommand('lupa.selectRepository', () =>
            this.selectRepository()
        );

        // Settings commands
        this.registerCommand('lupa.resetAnalysisLimits', () =>
            this.resetAnalysisLimitsToDefaults()
        );

        // Development-only commands - only register in development mode
        if (this.context.extensionMode === vscode.ExtensionMode.Development) {
            // Tool testing interface command
            this.registerCommand('lupa.openToolTesting', () =>
                this.services.toolTestingWebview.openToolTestingInterface()
            );

            // Test webview command for development
            this.registerCommand('lupa.testWebview', () =>
                this.showTestWebview()
            );
        }
    }

    /**
     * Reset analysis limits to their default values
     */
    private resetAnalysisLimitsToDefaults(): void {
        this.services.workspaceSettings.resetAnalysisLimitsToDefaults();
        vscode.window.showInformationMessage(
            'Analysis limits reset to defaults: ' +
            `Max Iterations: ${ANALYSIS_LIMITS.maxIterations.default}, ` +
            `Request Timeout: ${ANALYSIS_LIMITS.requestTimeoutSeconds.default}s`
        );
    }

    /**
     * Allow user to manually select a different Git repository
     */
    private async selectRepository(): Promise<void> {
        await this.services.gitOperations.selectRepositoryManually();
    }

    /**
     * Show test webview with sample data for development
     */
    private showTestWebview(): void {
        const title = "Test PR Analysis - Sample Data";

        const diffText = `diff --git a/src/services/analysisProvider.ts b/src/services/analysisProvider.ts
index 1234567..abcdefg 100644
--- a/src/services/analysisProvider.ts
+++ b/src/services/analysisProvider.ts
@@ -45,6 +45,10 @@ export class AnalysisProvider {
         const result = await this.toolCallingAnalysisProvider.analyze(
             diffText,
+            undefined, // options
+            mode,
+            undefined, // systemPrompt
+            progressCallback,
             token
         );`;

        const analysis = `# PR Analysis Results

## Overview
This is a sample analysis for development testing.

## Summary
The changes look good.`;

        // Display the test webview
        this.services.uiManager.displayAnalysisResults(title, diffText, analysis);
    }

    /**
     * Helper method to register a command and track disposables
     */
    private registerCommand(command: string, callback: (...args: any[]) => any): void {
        const disposable = vscode.commands.registerCommand(command, callback);
        this.disposables.push(disposable);
        this.context.subscriptions.push(disposable);
    }

    /**
     * Dispose of all registered commands
     */
    public dispose(): void {
        this.disposables.forEach(disposable => disposable.dispose());
        this.disposables.length = 0;
    }
}
