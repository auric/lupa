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
            expect(profile.includeFalsePositiveGuide).toBe(false);
            expect(profile.includeRevertTest).toBe(false);
            expect(profile.minValidateClaimBeforeSubmit).toBe(1);
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

        it('returns Claude profile for raptor family (Copilot alias)', () => {
            const profile = getCalibrationProfile('raptor', 'raptor-mini');
            expect(profile.name).toBe('claude');
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
});
