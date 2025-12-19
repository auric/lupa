import { describe, it, expect, vi } from 'vitest';
import * as vscode from 'vscode';
import { createFollowupProvider } from '../services/chatFollowupProvider';
import type { ChatAnalysisMetadata } from '../types/chatTypes';

describe('ChatFollowupProvider', () => {
    const provider = createFollowupProvider();

    it('should return default follow-ups when metadata is missing', () => {
        const result: vscode.ChatResult = {};
        const followups = provider.provideFollowups(result, {} as any, {} as any) as vscode.ChatFollowup[];

        expect(followups).toHaveLength(2);
        expect(followups[0].label).toBe('❓ Ask Question');
        expect(followups[1].label).toBe('🎯 Next Steps');
    });

    it('should return default follow-ups when analysis was cancelled', () => {
        const result: vscode.ChatResult = {
            metadata: { cancelled: true } as ChatAnalysisMetadata
        };
        const followups = provider.provideFollowups(result, {} as any, {} as any) as vscode.ChatFollowup[];

        expect(followups[0].label).toBe('❓ Ask Question');
    });

    it('should prioritize critical issues', () => {
        const result: vscode.ChatResult = {
            metadata: {
                hasCriticalIssues: true,
                issuesFound: true
            } as ChatAnalysisMetadata
        };
        const followups = provider.provideFollowups(result, {} as any, {} as any) as vscode.ChatFollowup[];

        expect(followups[0].label).toBe('🔴 Critical Focus');
        expect(followups[0].prompt).toBe('Focus on critical issues only');
    });

    it('should include security details when security issues found', () => {
        const result: vscode.ChatResult = {
            metadata: {
                hasSecurityIssues: true
            } as ChatAnalysisMetadata
        };
        const followups = provider.provideFollowups(result, {} as any, {} as any) as vscode.ChatFollowup[];

        expect(followups.some(f => f.label === '🔒 Security Details')).toBe(true);
    });

    it('should include testing suggestions when requested', () => {
        const result: vscode.ChatResult = {
            metadata: {
                hasTestingSuggestions: true
            } as ChatAnalysisMetadata
        };
        const followups = provider.provideFollowups(result, {} as any, {} as any) as vscode.ChatFollowup[];

        expect(followups.some(f => f.label === '🧪 Test Suggestions')).toBe(true);
    });

    it('should include fix guidance when issues are found', () => {
        const result: vscode.ChatResult = {
            metadata: {
                issuesFound: true
            } as ChatAnalysisMetadata
        };
        const followups = provider.provideFollowups(result, {} as any, {} as any) as vscode.ChatFollowup[];

        expect(followups.some(f => f.label === '🔧 Fix Guidance')).toBe(true);
    });

    it('should limit follow-ups to 4', () => {
        const result: vscode.ChatResult = {
            metadata: {
                hasCriticalIssues: true,
                hasSecurityIssues: true,
                hasTestingSuggestions: true,
                issuesFound: true
            } as ChatAnalysisMetadata
        };
        const followups = provider.provideFollowups(result, {} as any, {} as any) as vscode.ChatFollowup[];

        expect(followups.length).toBeLessThanOrEqual(4);
    });

    it('should include general follow-ups to fill slots', () => {
        const result: vscode.ChatResult = {
            metadata: {
                issuesFound: false
            } as ChatAnalysisMetadata
        };
        const followups = provider.provideFollowups(result, {} as any, {} as any) as vscode.ChatFollowup[];

        expect(followups.some(f => f.label === '✅ What\'s Good')).toBe(true);
        expect(followups.some(f => f.label === '💬 Explain Changes')).toBe(true);
    });
});
