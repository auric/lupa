import * as vscode from 'vscode';
import { PRAnalysisCoordinator } from './services/prAnalysisCoordinator';
import { StatusBarService } from './services/statusBarService';

// Main extension activation function
export async function activate(context: vscode.ExtensionContext) {
    console.log('Activating codelens-pr-analyzer extension');

    try {
        // Create the PR analysis coordinator instance
        const prAnalysisCoordinator = new PRAnalysisCoordinator(context);

        context.subscriptions.push(prAnalysisCoordinator);

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
