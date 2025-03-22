import * as vscode from 'vscode';
import { PRAnalyzer } from './services/prAnalyzer';
import { StatusBarService } from './services/statusBarService';
import { registerLanguageStructureCommands } from './__tests__/utils/languageStructureAnalyzer';

// Main extension activation function
export async function activate(context: vscode.ExtensionContext) {
    console.log('Activating codelens-pr-analyzer extension');

    try {
        // Create the PR analyzer instance
        const prAnalyzer = new PRAnalyzer(context);

        context.subscriptions.push(prAnalyzer);

        // Register the test command for the structure analyzer
        registerLanguageStructureCommands(context);

        // Register a simple hello world command as a placeholder
        const disposable = vscode.commands.registerCommand('codelens-pr-analyzer.helloWorld', () => {
            vscode.window.showInformationMessage('Hello from CodeLens PR Analyzer!');
        });

        context.subscriptions.push(disposable);
    } catch (error) {
        console.error('Failed to activate extension:', error);
        vscode.window.showErrorMessage(`Failed to activate PR Analyzer: ${error instanceof Error ? error.message : String(error)}`);
    }
}

// Main extension deactivation function
export function deactivate() {
    console.log('Deactivating codelens-pr-analyzer extension');
    StatusBarService.reset();
}
