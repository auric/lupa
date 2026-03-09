import { describe, it, expect } from 'vitest';
import { AdversarialPromptGenerator } from '../prompts/adversarialPromptGenerator';
import type { RecordedFinding } from '../types/findingTypes';

function makeFinding(
    overrides: Partial<RecordedFinding> = {}
): RecordedFinding {
    return {
        id: overrides.id ?? 'finding-1',
        agentId: overrides.agentId ?? 'root',
        timestamp: overrides.timestamp ?? Date.now(),
        severity: overrides.severity ?? 'CRITICAL',
        category: overrides.category ?? 'security',
        title: overrides.title ?? 'SQL injection in query builder',
        file: overrides.file ?? 'src/db/queryBuilder.ts',
        lineRange: overrides.lineRange ?? [42, 55],
        description:
            overrides.description ??
            'User input is concatenated into SQL query without parameterization',
        supportingToolCalls: overrides.supportingToolCalls ?? [
            'read_file',
            'find_usages',
        ],
        disproof: overrides.disproof ?? {
            attempted: true,
            method: 'Searched for input sanitization',
            result: 'No sanitization found',
        },
        verifiableClaims: overrides.verifiableClaims ?? [],
        lspValidation: overrides.lspValidation,
    };
}

describe('AdversarialPromptGenerator', () => {
    const generator = new AdversarialPromptGenerator();

    it('generates a prompt containing finding details', () => {
        const finding = makeFinding();
        const prompt = generator.generateSystemPrompt(finding);

        expect(prompt).toContain('adversarial verification');
        expect(prompt).toContain('SQL injection in query builder');
        expect(prompt).toContain('CRITICAL');
        expect(prompt).toContain('src/db/queryBuilder.ts');
        expect(prompt).toContain('42-55');
    });

    it('sanitizes finding text to prevent prompt injection', () => {
        const finding = makeFinding({
            title: '<script>alert("xss")</script>',
            description: 'Unsafe <div>content</div>',
        });
        const prompt = generator.generateSystemPrompt(finding);

        expect(prompt).not.toContain('<script>');
        expect(prompt).not.toContain('<div>');
        expect(prompt).toContain('&lt;script&gt;');
    });

    it('includes investigation strategy', () => {
        const finding = makeFinding();
        const prompt = generator.generateSystemPrompt(finding);

        expect(prompt).toContain('read_file');
        expect(prompt).toContain('find_usages');
        expect(prompt).toContain('validate_claim');
        expect(prompt).toContain('REFUTED');
        expect(prompt).toContain('CONFIRMED');
        expect(prompt).toContain('UNCERTAIN');
    });

    it('includes disproof mandate', () => {
        const finding = makeFinding();
        const prompt = generator.generateSystemPrompt(finding);

        expect(prompt).toContain('DISPROVE');
        expect(prompt).toContain('Bias toward REFUTED');
    });
});
