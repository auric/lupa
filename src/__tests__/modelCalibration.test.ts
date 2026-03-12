import { describe, it, expect } from 'vitest';
import {
    getCalibrationProfile,
    isDismissiveModel,
    isAggressiveModel,
} from '../models/modelCalibration';

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
            expect(profile.includeFalsePositiveGuide).toBe(true);
            expect(profile.includeRevertTest).toBe(true);
            expect(profile.minValidateClaimBeforeSubmit).toBe(1);
            expect(profile.includeAgenticPreamble).toBe(true);
            expect(profile.evidenceThreshold).toBe('high');
        });

        it('returns GPT-4o profile for gpt-4o family', () => {
            const profile = getCalibrationProfile(
                'gpt-4o',
                'gpt-4o-2024-11-20'
            );
            expect(profile.name).toBe('gpt-4o');
            expect(profile.findingBias).toBe('dismissive');
            expect(profile.challengeMode).toBe('prosecution');
            expect(profile.includeFalsePositiveGuide).toBe(true);
            expect(profile.includeRevertTest).toBe(false);
            expect(profile.minValidateClaimBeforeSubmit).toBe(1);
        });

        it('returns GPT-5 mini profile for gpt-5-mini id', () => {
            const profile = getCalibrationProfile('gpt-5', 'gpt-5-mini');
            expect(profile.name).toBe('gpt-5-mini');
            expect(profile.findingBias).toBe('aggressive');
            expect(profile.challengeMode).toBe('devils-advocate');
            expect(profile.includeFalsePositiveGuide).toBe(true);
            expect(profile.includeRevertTest).toBe(true);
            expect(profile.minValidateClaimBeforeSubmit).toBe(0);
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
            expect(profile.minValidateClaimBeforeSubmit).toBe(0);
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

    describe('isDismissiveModel', () => {
        it('returns true for GPT-4.1', () => {
            expect(
                isDismissiveModel(getCalibrationProfile('gpt-4.1', 'gpt-4.1'))
            ).toBe(true);
        });

        it('returns true for GPT-4o', () => {
            expect(
                isDismissiveModel(getCalibrationProfile('gpt-4o', 'gpt-4o'))
            ).toBe(true);
        });

        it('returns false for Claude', () => {
            expect(
                isDismissiveModel(getCalibrationProfile('claude', 'claude'))
            ).toBe(false);
        });

        it('returns false for GPT-5 mini', () => {
            expect(
                isDismissiveModel(getCalibrationProfile('gpt-5', 'gpt-5-mini'))
            ).toBe(false);
        });
    });

    describe('isAggressiveModel', () => {
        it('returns true for GPT-5 mini', () => {
            expect(
                isAggressiveModel(getCalibrationProfile('gpt-5', 'gpt-5-mini'))
            ).toBe(true);
        });

        it('returns false for GPT-4.1', () => {
            expect(
                isAggressiveModel(getCalibrationProfile('gpt-4.1', 'gpt-4.1'))
            ).toBe(false);
        });

        it('returns false for Claude', () => {
            expect(
                isAggressiveModel(getCalibrationProfile('claude', 'claude'))
            ).toBe(false);
        });
    });

    describe('investigation protocols', () => {
        it('GPT-4.1 has the most structured investigation protocol', () => {
            const profile = getCalibrationProfile('gpt-4.1', 'gpt-4.1');
            expect(
                profile.investigationProtocol.minToolCallsBeforeFirstFinding
            ).toBe(5);
            expect(
                profile.investigationProtocol.requiredToolsBeforeDone
            ).toContain('get_file_diff');
            expect(
                profile.investigationProtocol.requiredToolsBeforeDone
            ).toContain('find_symbol');
            expect(
                profile.investigationProtocol.requiredToolsBeforeDone
            ).toContain('validate_claim');
            expect(
                profile.investigationProtocol.investigationPreamble
            ).toContain('keep investigating');
        });

        it('GPT-4o has moderate investigation requirements', () => {
            const profile = getCalibrationProfile('gpt-4o', 'gpt-4o');
            expect(
                profile.investigationProtocol.minToolCallsBeforeFirstFinding
            ).toBe(3);
            expect(
                profile.investigationProtocol.requiredToolsBeforeDone
            ).toContain('validate_claim');
            expect(
                profile.investigationProtocol.requiredToolsBeforeDone
            ).not.toContain('find_symbol');
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

        it('GPT-5-mini requires validate_claim', () => {
            const profile = getCalibrationProfile('gpt-5-mini', 'gpt-5-mini');
            expect(
                profile.investigationProtocol.requiredToolsBeforeDone
            ).toContain('validate_claim');
            expect(
                profile.investigationProtocol.minToolCallsBeforeFirstFinding
            ).toBe(2);
        });
    });
});
