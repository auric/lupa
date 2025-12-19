import * as vscode from "vscode";
import type { ChatAnalysisMetadata } from "../types/chatTypes";
import { Log } from "./loggingService";

const MAX_FOLLOWUPS = 4;

/**
 * Generates contextual follow-up suggestions based on analysis results.
 * Follows Anthropic prompt engineering best practices:
 * - Clear, direct language
 * - Action-oriented prompts
 * - Context-aware suggestions
 */
export function createFollowupProvider(): vscode.ChatFollowupProvider {
    return {
        provideFollowups(
            result: vscode.ChatResult,
            _context: vscode.ChatContext,
            _token: vscode.CancellationToken
        ): vscode.ChatFollowup[] {
            const metadata = result.metadata as ChatAnalysisMetadata | undefined;

            // Handle missing metadata, cancelled or error states
            if (!metadata || metadata.cancelled || result.errorDetails) {
                return getDefaultFollowups();
            }

            const followups = buildContextualFollowups(metadata);
            Log.info(`[ChatFollowupProvider]: Generated ${followups.length} follow-ups`);
            return followups;
        },
    };
}

/**
 * Builds a list of contextual follow-up suggestions based on analysis metadata.
 * @param metadata Analysis metadata from the previous turn
 * @returns Array of follow-up suggestions
 */
function buildContextualFollowups(
    metadata: ChatAnalysisMetadata | undefined
): vscode.ChatFollowup[] {
    const followups: vscode.ChatFollowup[] = [];

    // Priority 1: Critical issues (highest priority)
    if (metadata?.hasCriticalIssues) {
        followups.push({
            prompt: "Focus on critical issues only",
            label: "🔴 Critical Focus",
        });
    }

    // Priority 2: Security issues
    if (metadata?.hasSecurityIssues) {
        followups.push({
            prompt: "Explain the security risks in detail",
            label: "🔒 Security Details",
        });
    }

    // Priority 3: Testing suggestions
    if (metadata?.hasTestingSuggestions) {
        followups.push({
            prompt: "What tests should I add for these changes?",
            label: "🧪 Test Suggestions",
        });
    }

    // Priority 4: Fix guidance (if issues exist)
    if (metadata?.issuesFound && followups.length < MAX_FOLLOWUPS) {
        followups.push({
            prompt: "Show me how to fix the most important issue",
            label: "🔧 Fix Guidance",
        });
    }

    // Fill remaining slots with general follow-ups
    const generalFollowups: vscode.ChatFollowup[] = [
        { prompt: "What did you like about this code?", label: "✅ What's Good" },
        {
            prompt: "Explain these changes to a teammate",
            label: "💬 Explain Changes",
        },
    ];

    for (const followup of generalFollowups) {
        if (followups.length >= MAX_FOLLOWUPS) break;
        followups.push(followup);
    }

    return followups.slice(0, MAX_FOLLOWUPS);
}

/**
 * Returns default follow-up suggestions for fallback cases.
 * @returns Array of default follow-up suggestions
 */
function getDefaultFollowups(): vscode.ChatFollowup[] {
    return [
        {
            prompt: "Ask a follow-up question about these changes",
            label: "❓ Ask Question",
        },
        { prompt: "What should I focus on next?", label: "🎯 Next Steps" },
    ];
}
