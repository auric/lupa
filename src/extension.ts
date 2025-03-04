import * as vscode from 'vscode';
import { ModelCacheService } from './services/modelCacheService';
import { PRAnalyzer } from './services/prAnalyzer';
import { StatusBarService } from './services/statusBarService';

// Main extension activation function
export async function activate(context: vscode.ExtensionContext) {
    console.log('Activating codelens-pr-analyzer extension');

    try {
        // Initialize model cache service
        const modelCacheService = new ModelCacheService(context);

        // Create the PR analyzer instance
        const prAnalyzer = new PRAnalyzer(context, modelCacheService);

        // Register services to be disposed when the extension is deactivated
        context.subscriptions.push(modelCacheService);
        context.subscriptions.push(prAnalyzer);
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
