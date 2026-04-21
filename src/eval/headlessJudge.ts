import * as fs from 'node:fs';
import * as vscode from 'vscode';
import type { IServiceRegistry } from '../services/serviceManager';
import type {
    ResolutionJudgePayload,
    ResolutionJudgeResult,
} from './harness/types';

export interface HeadlessResolutionJudgeOptions {
    workspaceRoot: string;
    modelIdentifier: string;
    timeoutMs: number;
    payloadPath: string;
    cancellationToken: vscode.CancellationToken;
}

const SYSTEM_PROMPT =
    'You are classifying whether a code-review finding was actually resolved by a later patch. ' +
    'Return exactly one JSON object: {"verdict":"resolved|disputed|noise","reason":"short explanation"}. ' +
    'Use resolved only when the diff likely fixes the finding. Use disputed when the diff touches related code but the fix is unclear. Use noise when the finding appears unsupported or irrelevant to the diff. Never output markdown.';

function normalizeModelIdentifier(identifier: string): string {
    const trimmed = identifier.trim().toLowerCase();
    if (trimmed.includes('/')) {
        return trimmed;
    }
    return `copilot/${trimmed}`;
}

export async function runHeadlessResolutionJudge(
    opts: HeadlessResolutionJudgeOptions,
    services: IServiceRegistry
): Promise<ResolutionJudgeResult> {
    const payload = readPayload(opts.payloadPath);
    const normalizedRequestedIdentifier = normalizeModelIdentifier(
        opts.modelIdentifier
    );

    const model = await services.copilotModelManager.selectModel({
        identifier: opts.modelIdentifier,
        persist: false,
    });
    const actualIdentifier = normalizeModelIdentifier(
        `${model.vendor}/${model.id}`
    );
    if (actualIdentifier !== normalizedRequestedIdentifier) {
        throw new Error(
            `Requested model '${normalizedRequestedIdentifier}' is not available; ` +
                `CopilotModelManager fell back to '${actualIdentifier}'. ` +
                `Refusing to run on an unintended model (risks premium quota).`
        );
    }

    const response = await services.copilotModelManager.sendRequest(
        {
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: buildUserPrompt(payload) },
            ],
            tools: [],
        },
        opts.cancellationToken
    );

    return parseJudgeResponse(response.content, model.id);
}

function readPayload(payloadPath: string): ResolutionJudgePayload {
    let raw: string;
    try {
        raw = fs.readFileSync(payloadPath, 'utf8');
    } catch (error) {
        throw new Error(
            `Failed to read resolution-judge payload at ${payloadPath}: ${error instanceof Error ? error.message : String(error)}`
        );
    }

    try {
        return JSON.parse(raw) as ResolutionJudgePayload;
    } catch (error) {
        throw new Error(
            `Resolution-judge payload is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

function buildUserPrompt(payload: ResolutionJudgePayload): string {
    const finding = payload.finding;
    const sourceText = (finding.sources ?? [])
        .map((source) => `${source.path}:${source.lineStart}-${source.lineEnd}`)
        .join(', ');
    return [
        'Classify whether this finding was resolved by the follow-up diff.',
        '',
        `Title: ${finding.title}`,
        `Severity: ${finding.severity}`,
        `Category: ${finding.category}`,
        `Location: ${finding.file}:${finding.lineRange[0]}-${finding.lineRange[1]}`,
        `Sources: ${sourceText || '(none supplied; file/lineRange fallback may have been used)'}`,
        `Description: ${finding.description}`,
        '',
        'Follow-up diff:',
        payload.diffText || '(no diff for this path)',
    ].join('\n');
}

function parseJudgeResponse(
    content: string | null,
    modelId: string
): ResolutionJudgeResult {
    const trimmed = content?.trim() ?? '';
    const normalized = unwrapCodeFence(trimmed);
    if (normalized.startsWith('{') && normalized.endsWith('}')) {
        try {
            const parsed = JSON.parse(normalized) as {
                verdict?: string;
                reason?: string;
            };
            if (isVerdict(parsed.verdict)) {
                return {
                    verdict: parsed.verdict,
                    reason:
                        typeof parsed.reason === 'string' &&
                        parsed.reason.length > 0
                            ? parsed.reason
                            : 'No reason supplied by auxiliary judge.',
                    modelId,
                };
            }
        } catch {
            // fall through to heuristic parsing
        }
    }

    if (isVerdict(normalized.toLowerCase())) {
        return {
            verdict:
                normalized.toLowerCase() as ResolutionJudgeResult['verdict'],
            reason:
                normalized || 'Auxiliary judge returned only a bare verdict.',
            modelId,
        };
    }

    throw new Error(
        `Auxiliary judge returned an unparseable verdict: ${trimmed || '(empty response)'}`
    );
}

function unwrapCodeFence(content: string): string {
    const match = content.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    return match?.[1]?.trim() ?? content;
}

function isVerdict(
    value: string | undefined
): value is ResolutionJudgeResult['verdict'] {
    return value === 'resolved' || value === 'disputed' || value === 'noise';
}
