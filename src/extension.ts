import * as vscode from 'vscode';
import { CodeEmbeddingService } from './services/codeEmbeddingService';

export async function activate(context: vscode.ExtensionContext) {
    console.log('Activating CodeLens PR Analyzer extension');

    // Create services
    const codeEmbeddingService = new CodeEmbeddingService(context);

    // Register commands
    const analyzePRCommand = vscode.commands.registerCommand(
        'codelens-pr-analyzer.analyzePR',
        async () => {
            vscode.window.showInformationMessage('Analyzing PR...');

            try {
                // This will demonstrate the embedding service works
                const testCode = `
          function hello() {
            console.log("Hello, World!");
          }
        `;

                vscode.window.showInformationMessage('Generating embedding for test code...');

                const embedding = await codeEmbeddingService.generateEmbedding(testCode);

                vscode.window.showInformationMessage(
                    `Successfully generated embedding with ${embedding.length} dimensions`
                );
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`Error: ${errorMessage}`);
            }
        }
    );

    const configureModelsCommand = vscode.commands.registerCommand(
        'codelens-pr-analyzer.configureModels',
        () => {
            vscode.window.showInformationMessage('Model configuration panel will be implemented here');
        }
    );

    // Add to subscriptions
    context.subscriptions.push(analyzePRCommand, configureModelsCommand);
    context.subscriptions.push(codeEmbeddingService);

    console.log('CodeLens PR Analyzer extension activated');
}

export function deactivate() {
    console.log('CodeLens PR Analyzer extension deactivated');
}
