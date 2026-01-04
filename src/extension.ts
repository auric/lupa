/**
 * Lupa - Pull Request Analysis Extension for VS Code
 * @license AGPL-3.0-or-later
 * @copyright 2025-2026 Ihor Lifanov
 */

import * as vscode from 'vscode';
import { PRAnalysisCoordinator } from './services/prAnalysisCoordinator';
import { StatusBarService } from './services/statusBarService';

// Main extension activation function
export async function activate(context: vscode.ExtensionContext) {
    console.log('Activating Lupa extension');

    try {
        const prAnalysisCoordinator = new PRAnalysisCoordinator(context);

        context.subscriptions.push(prAnalysisCoordinator);

        console.log('Lupa extension activated successfully');
    } catch (error) {
        console.error('Failed to activate extension:', error);
        vscode.window.showErrorMessage(
            `Failed to activate Lupa: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

// Main extension deactivation function
export function deactivate() {
    console.log('Deactivating Lupa extension');
    StatusBarService.reset();
}
