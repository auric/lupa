import { describe, it, expect } from 'vitest';
import {
    SEVERITY,
    ACTIVITY,
    SECTION,
    SeverityType,
    ActivityType,
    SectionType,
} from '../config/chatEmoji';

describe('chatEmoji', () => {
    describe('SEVERITY', () => {
        it('should define critical as red circle', () => {
            expect(SEVERITY.critical).toBe('🔴');
        });

        it('should define high as orange circle', () => {
            expect(SEVERITY.high).toBe('🟠');
        });

        it('should define medium as yellow circle', () => {
            expect(SEVERITY.medium).toBe('🟡');
        });

        it('should define low as green circle', () => {
            expect(SEVERITY.low).toBe('🟢');
        });

        it('should define suggestion as yellow circle', () => {
            expect(SEVERITY.suggestion).toBe('🟡');
        });

        it('should define success as checkmark', () => {
            expect(SEVERITY.success).toBe('✅');
        });

        it('should define warning as warning triangle', () => {
            expect(SEVERITY.warning).toBe('⚠️');
        });

        it('should have exactly 7 severity entries', () => {
            expect(Object.keys(SEVERITY)).toHaveLength(7);
        });
    });

    describe('ACTIVITY', () => {
        it('should define thinking as thought bubble', () => {
            expect(ACTIVITY.thinking).toBe('💭');
        });

        it('should define searching as magnifying glass', () => {
            expect(ACTIVITY.searching).toBe('🔍');
        });

        it('should define reading as folder', () => {
            expect(ACTIVITY.reading).toBe('📂');
        });

        it('should define analyzing as magnifying glass with detail', () => {
            expect(ACTIVITY.analyzing).toBe('🔎');
        });

        it('should have exactly 4 activity entries', () => {
            expect(Object.keys(ACTIVITY)).toHaveLength(4);
        });
    });

    describe('SECTION', () => {
        it('should define security as lock', () => {
            expect(SECTION.security).toBe('🔒');
        });

        it('should define testing as test tube', () => {
            expect(SECTION.testing).toBe('🧪');
        });

        it('should define summary as chart', () => {
            expect(SECTION.summary).toBe('📊');
        });

        it('should define files as folder', () => {
            expect(SECTION.files).toBe('📁');
        });

        it('should have exactly 4 section entries', () => {
            expect(Object.keys(SECTION)).toHaveLength(4);
        });
    });

    describe('Types', () => {
        it('should export SeverityType that accepts valid keys', () => {
            const severity: SeverityType = 'critical';
            expect(severity).toBe('critical');

            const allSeverities: SeverityType[] = [
                'critical',
                'suggestion',
                'success',
                'warning',
            ];
            expect(allSeverities).toHaveLength(4);
        });

        it('should export ActivityType that accepts valid keys', () => {
            const activity: ActivityType = 'thinking';
            expect(activity).toBe('thinking');

            const allActivities: ActivityType[] = [
                'thinking',
                'searching',
                'reading',
                'analyzing',
            ];
            expect(allActivities).toHaveLength(4);
        });

        it('should export SectionType that accepts valid keys', () => {
            const section: SectionType = 'security';
            expect(section).toBe('security');

            const allSections: SectionType[] = [
                'security',
                'testing',
                'summary',
                'files',
            ];
            expect(allSections).toHaveLength(4);
        });

        it('should allow using types to index into emoji objects', () => {
            const severityKey: SeverityType = 'critical';
            expect(SEVERITY[severityKey]).toBe('🔴');

            const activityKey: ActivityType = 'thinking';
            expect(ACTIVITY[activityKey]).toBe('💭');

            const sectionKey: SectionType = 'security';
            expect(SECTION[sectionKey]).toBe('🔒');
        });
    });
});
