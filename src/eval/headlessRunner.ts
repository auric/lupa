import * as vscode from 'vscode';
import type { IServiceRegistry } from '../services/serviceManager';
import { DiffUtils } from '../utils/diffUtils';
import type { ToolCallRecord } from '../types/toolCallTypes';
import type { RecordedFinding } from '../types/findingTypes';
import { resolveDiff } from './diffResolver';
import { Log } from '../services/loggingService';

export interface HeadlessRunnerOptions {
    workspaceRoot: string;
    baseRef: string;
    headRef: string;
    modelIdentifier: string;
    seed: number;
    timeoutMs: number;
    cancellationToken: vscode.CancellationToken;
}

export interface HeadlessTelemetry {
    iterations: number;
    toolCalls: number;
    promptTokens: number;
    completionTokens: number;
    durationMs: number;
    compactionsUsed: number;
}

export interface HeadlessAnalysisResult {
    findings: RecordedFinding[];
    narrative: string;
    telemetry: HeadlessTelemetry;
    rawToolCallLog: ToolCallRecord[];
    modelId: string;
    seed: number;
    completed: boolean;
    wasCancelled: boolean;
}

/**
 * Run a full Lupa analysis from a (workspaceRoot, baseRef, headRef, model)
 * tuple without invoking any UI. Intended for CI jobs, eval harnesses, and
 * scripted evaluation — shares the same AnalysisEngine code path as the
 * webview (AnalysisOrchestrator) and chat (ChatParticipantService) entries.
 */
export async function runHeadless(
    opts: HeadlessRunnerOptions,
    services: IServiceRegistry
): Promise<HeadlessAnalysisResult> {
    const startedAt = Date.now();

    const diffText = await resolveDiff(opts, services);
    if (!diffText.trim()) {
        throw new Error(
            `No diff produced for ${opts.baseRef}..${opts.headRef}`
        );
    }
    const parsedDiff = DiffUtils.parseDiff(diffText);

    // persist: false — don't persist the model choice into the target
    // workspace's .vscode/lupa.json (treat the analyzed repo as read-only).
    const model = await services.copilotModelManager.selectModel({
        identifier: opts.modelIdentifier,
        persist: false,
    });
    const actualIdentifier = `${model.vendor}/${model.id}`;
    if (actualIdentifier !== opts.modelIdentifier) {
        Log.warn(
            `Requested model ${opts.modelIdentifier} unavailable; fell back to ${actualIdentifier}`
        );
    }

    const result = await services.analysisEngine.analyze(
        {
            parsedDiff,
            llmClient: services.copilotModelManager,
            model: {
                family: model.family,
                id: model.id,
                name: model.name,
                maxInputTokens: model.maxInputTokens,
            },
            token: opts.cancellationToken,
            userPromptSuffix: undefined,
            chatHandler: undefined,
        },
        {
            onProgress: () => {},
        }
    );

    if (result.error) {
        throw new Error(result.error);
    }
    if (result.wasCancelled) {
        throw new Error(
            `Analysis cancelled for ${opts.baseRef}..${opts.headRef}`
        );
    }

    return {
        findings: result.findings,
        narrative: result.analysisText,
        telemetry: {
            iterations: result.iterationsUsed ?? 0,
            toolCalls: result.toolCallRecords.length,
            // Prompt/completion token accounting and compaction tracking are
            // not yet plumbed through AnalysisEngineResult; reported as 0
            // until upstream counters land.
            promptTokens: 0,
            completionTokens: 0,
            durationMs: Date.now() - startedAt,
            compactionsUsed: 0,
        },
        rawToolCallLog: result.toolCallRecords,
        modelId: model.id,
        seed: opts.seed,
        completed: result.completed,
        wasCancelled: result.wasCancelled,
    };
}
