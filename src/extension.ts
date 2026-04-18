/**
 * Lupa - Pull Request Analysis Extension for VS Code
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (c) 2026 Ihor Lifanov
 */

import * as vscode from 'vscode';
import * as z from 'zod';
import { PRAnalysisCoordinator } from './services/prAnalysisCoordinator';
import { StatusBarService } from './services/statusBarService';
import { getErrorMessage } from './utils/errorUtils';
import {
    runHeadless,
    type HeadlessRunnerOptions,
    type HeadlessAnalysisResult,
} from './eval/headlessRunner';

// Zod 4's English locale is loaded via a side-effect call `config(en())` in the
// entry module. Vite tree-shakes this, causing all validation errors to fall back
// to "Invalid input". Explicitly re-initialize to survive bundling.
z.config(z.locales.en());

/**
 * Public API returned by activate(). Consumed by the headless entry point
 * (src/eval/headlessRunner.ts) and by integration harnesses that need access
 * to the fully-wired service registry without going through UI commands.
 */
export interface LupaExtensionApi {
    runHeadless(opts: HeadlessRunnerOptions): Promise<HeadlessAnalysisResult>;
}

// Main extension activation function
export async function activate(
    context: vscode.ExtensionContext
): Promise<LupaExtensionApi | undefined> {
    console.log('Activating Lupa extension');

    try {
        const prAnalysisCoordinator = new PRAnalysisCoordinator(context);

        context.subscriptions.push(prAnalysisCoordinator);

        console.log('Lupa extension activated successfully');

        return {
            runHeadless: async (opts) => {
                const services =
                    await prAnalysisCoordinator.waitForInitialization();
                return runHeadless(opts, services);
            },
        };
    } catch (error) {
        console.error('Failed to activate extension:', error);
        vscode.window.showErrorMessage(
            `Failed to activate Lupa: ${getErrorMessage(error)}`
        );
        return undefined;
    }
}

// Main extension deactivation function
export function deactivate() {
    console.log('Deactivating Lupa extension');
    StatusBarService.reset();
}
