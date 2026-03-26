import { describe, it, expect } from 'vitest';
import { getCalibrationProfile } from '../models/modelCalibration';

describe('modelCalibration', () => {
    describe('getCalibrationProfile', () => {
        it('returns GPT-4.1 profile for gpt-4.1 family', () => {
            const profile = getCalibrationProfile(
                'gpt-4.1',
                'gpt-4.1-2025-04-14'
            );
            expect(profile.name).toBe('gpt-4.1');
            expect(profile.findingBias).toBe('dismissive');
            expect(profile.challengeMode).toBe('prosecution');
            expect(profile.includeFalsePositiveGuide).toBe(false);
            expect(profile.includeRevertTest).toBe(false);
            expect(profile.includeAgenticPreamble).toBe(true);
            expect(profile.evidenceThreshold).toBe('low');
        });

        it('returns GPT-4o profile for gpt-4o family', () => {
            const profile = getCalibrationProfile(
                'gpt-4o',
                'gpt-4o-2024-11-20'
            );
            expect(profile.name).toBe('gpt-4o');
            expect(profile.findingBias).toBe('dismissive');
            expect(profile.challengeMode).toBe('prosecution');
            expect(profile.includeFalsePositiveGuide).toBe(false);
            expect(profile.includeRevertTest).toBe(false);
        });

        it('returns GPT-5 mini profile for gpt-5-mini id', () => {
            const profile = getCalibrationProfile('gpt-5', 'gpt-5-mini');
            expect(profile.name).toBe('gpt-5-mini');
            expect(profile.findingBias).toBe('aggressive');
            expect(profile.challengeMode).toBe('devils-advocate');
            expect(profile.includeFalsePositiveGuide).toBe(true);
            expect(profile.includeRevertTest).toBe(true);
            expect(profile.evidenceThreshold).toBe('high');
        });

        it('returns Claude profile for claude family', () => {
            const profile = getCalibrationProfile(
                'claude-3.5-sonnet',
                'claude-3.5-sonnet'
            );
            expect(profile.name).toBe('claude');
            expect(profile.findingBias).toBe('balanced');
            expect(profile.challengeMode).toBe('devils-advocate');
            expect(profile.includeAgenticPreamble).toBe(false);
            expect(profile.evidenceThreshold).toBe('medium');
        });

        it('returns Raptor mini profile for oswe-vscode-prime id', () => {
            const profile = getCalibrationProfile(
                'gpt-5-mini',
                'oswe-vscode-prime'
            );
            expect(profile.name).toBe('raptor-mini');
            expect(profile.findingBias).toBe('balanced');
            expect(profile.challengeMode).toBe('devils-advocate');
            expect(profile.includeAgenticPreamble).toBe(true);
            expect(profile.evidenceThreshold).toBe('medium');
        });

        it('returns Raptor mini profile for oswe-vscode id variant', () => {
            const profile = getCalibrationProfile('gpt-5-mini', 'oswe-vscode');
            expect(profile.name).toBe('raptor-mini');
        });

        it('returns GPT-5 mini profile for gpt-5-mini id (not Raptor)', () => {
            const profile = getCalibrationProfile('gpt-5-mini', 'gpt-5-mini');
            expect(profile.name).toBe('gpt-5-mini');
            expect(profile.findingBias).toBe('aggressive');
        });

        it('returns default balanced profile for unknown models', () => {
            const profile = getCalibrationProfile(
                'unknown-model',
                'some-new-model-v3'
            );
            expect(profile.name).toBe('default');
            expect(profile.findingBias).toBe('balanced');
            expect(profile.challengeMode).toBe('devils-advocate');
            expect(profile.includeFalsePositiveGuide).toBe(true);
            expect(profile.includeRevertTest).toBe(true);

            expect(profile.includeAgenticPreamble).toBe(false);
            expect(profile.evidenceThreshold).toBe('medium');
        });

        it('matching is case-insensitive', () => {
            const profile = getCalibrationProfile(
                'GPT-4.1',
                'GPT-4.1-2025-04-14'
            );
            expect(profile.name).toBe('gpt-4.1');
        });

        it('matches gpt-4.1 by id when family differs', () => {
            const profile = getCalibrationProfile(
                'some-family',
                'gpt-4.1-preview'
            );
            expect(profile.name).toBe('gpt-4.1');
        });
    });

    describe('investigation protocols', () => {
        it('GPT-4.1 has anti-dismissal investigation protocol', () => {
            const profile = getCalibrationProfile('gpt-4.1', 'gpt-4.1');
            expect(
                profile.investigationProtocol.minToolCallsBeforeFirstFinding
            ).toBe(3);
            expect(
                profile.investigationProtocol.requiredToolsBeforeDone
            ).toHaveLength(0);
            expect(
                profile.investigationProtocol.investigationPreamble
            ).toContain('find_usages');
        });

        it('GPT-4o has anti-dismissal investigation protocol', () => {
            const profile = getCalibrationProfile('gpt-4o', 'gpt-4o');
            expect(
                profile.investigationProtocol.minToolCallsBeforeFirstFinding
            ).toBe(2);
            expect(
                profile.investigationProtocol.requiredToolsBeforeDone
            ).toHaveLength(0);
            expect(
                profile.investigationProtocol.investigationPreamble
            ).toContain('find_usages');
        });

        it('Claude has minimal investigation protocol', () => {
            const profile = getCalibrationProfile('claude', 'claude-sonnet');
            expect(
                profile.investigationProtocol.minToolCallsBeforeFirstFinding
            ).toBe(2);
            expect(
                profile.investigationProtocol.requiredToolsBeforeDone
            ).toHaveLength(0);
            expect(profile.investigationProtocol.investigationPreamble).toBe(
                ''
            );
        });

        it('default profile inherits Claude investigation protocol', () => {
            const defaultProfile = getCalibrationProfile('unknown', 'unknown');
            const claudeProfile = getCalibrationProfile(
                'claude',
                'claude-sonnet'
            );
            expect(defaultProfile.investigationProtocol).toEqual(
                claudeProfile.investigationProtocol
            );
        });

        it('GPT-5-mini has empty requiredToolsBeforeDone', () => {
            const profile = getCalibrationProfile('gpt-5-mini', 'gpt-5-mini');
            expect(
                profile.investigationProtocol.requiredToolsBeforeDone
            ).toHaveLength(0);
            expect(
                profile.investigationProtocol.minToolCallsBeforeFirstFinding
            ).toBe(2);
        });
    });

    describe('tool filtering and finding caps', () => {
        it('GPT-4.1 disables cognitive-overload tools', () => {
            const profile = getCalibrationProfile('gpt-4.1', 'gpt-4.1');
            expect(profile.disabledTools).toContain('batch_tools');
            expect(profile.disabledTools).toContain('get_symbols_overview');
            expect(profile.disabledTools).not.toContain('validate_claim');
            expect(profile.disabledTools).not.toContain('retract_finding');
            expect(profile.disabledTools.length).toBe(3);
        });

        it('GPT-4.1 has tight finding cap', () => {
            const profile = getCalibrationProfile('gpt-4.1', 'gpt-4.1');
            expect(profile.maxFindingsPerReview).toBe(5);
        });

        it('Claude has no disabled tools', () => {
            const profile = getCalibrationProfile('claude', 'claude-sonnet');
            expect(profile.disabledTools).toHaveLength(0);
        });

        it('Claude has generous finding cap', () => {
            const profile = getCalibrationProfile('claude', 'claude-sonnet');
            expect(profile.maxFindingsPerReview).toBe(15);
        });

        it('default profile matches Claude tool config', () => {
            const defaultProfile = getCalibrationProfile('unknown', 'unknown');
            expect(defaultProfile.disabledTools).toHaveLength(0);
            expect(defaultProfile.maxFindingsPerReview).toBe(15);
        });
    });
});
