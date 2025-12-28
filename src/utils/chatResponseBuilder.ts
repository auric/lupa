import { SEVERITY, SECTION } from '../config/chatEmoji';
import type { Finding } from '../types/chatTypes';

/**
 * Builder utility for constructing consistent chat responses.
 * Implements the verdict-first response structure from UX specification.
 *
 * @example
 * const response = new ChatResponseBuilder()
 *   .addVerdictLine('issues', 'Analysis Complete')
 *   .addSummaryStats(15, 2, 3)
 *   .addFindingsSection('Critical Issues', SEVERITY.critical, criticalFindings)
 *   .addPositiveNotes(['Clean separation of concerns'])
 *   .addFollowupPrompt('Ready for review.')
 *   .build();
 *
 * @see docs/ux-design-specification.md#design-direction-decision
 */
export class ChatResponseBuilder {
    private sections: string[] = [];

    /**
     * Add the opening verdict line with status emoji.
     * Uses ## heading per UX specification.
     * @param status - 'success' (✅), 'issues' (🔍), or 'cancelled' (💬)
     * @param summary - Text to display after emoji (e.g., "Analysis Complete")
     */
    addVerdictLine(
        status: 'success' | 'issues' | 'cancelled',
        summary: string
    ): this {
        let emoji = '💬';
        if (status === 'success') {
            emoji = SEVERITY.success;
        } else if (status === 'issues') {
            emoji = '🔍';
        }
        this.sections.push(`## ${emoji} ${summary}\n`);
        return this;
    }

    /**
     * Adds a styled error section with optional technical details.
     * Uses warning emoji and supportive tone per UX guidelines.
     * @param title - Error section title (e.g., "Configuration Error")
     * @param message - User-friendly error message
     * @param details - Optional technical details shown in code block
     */
    addErrorSection(title: string, message: string, details?: string): this {
        this.sections.push(`## ${SEVERITY.warning} ${title}\n\n${message}`);
        if (details) {
            this.sections.push(`\n\n\`\`\`\n${details}\n\`\`\``);
        }
        this.sections.push('\n');
        return this;
    }

    /**
     * Add the summary statistics bar.
     * Uses 📊 emoji from SECTION constants.
     * @param filesAnalyzed - Number of files analyzed
     * @param critical - Number of critical issues
     * @param suggestions - Number of suggestions
     */
    addSummaryStats(
        filesAnalyzed: number,
        critical: number,
        suggestions: number
    ): this {
        const fileWord = filesAnalyzed === 1 ? 'file' : 'files';
        this.sections.push(
            `\n${SECTION.summary} **${filesAnalyzed} ${fileWord}** analyzed | **${critical}** critical | **${suggestions}** suggestions\n`
        );
        return this;
    }

    /**
     * Add a findings section with title and finding cards.
     * Does nothing if findings array is empty.
     * @param title - Section title (e.g., "Critical Issues")
     * @param emoji - Emoji to prefix title (use SEVERITY constants)
     * @param findings - Array of Finding objects
     */
    addFindingsSection(
        title: string,
        emoji: string,
        findings: Finding[]
    ): this {
        if (findings.length === 0) {
            return this;
        }

        this.sections.push(`\n---\n\n### ${emoji} ${title}\n\n`);
        const findingCards = findings.map(
            (finding) =>
                `**${finding.title}** in [${finding.location}](${finding.anchor})\n${finding.description}`
        );
        this.sections.push(findingCards.join('\n\n') + '\n\n');
        return this;
    }

    /**
     * Add the "What's Good" positive notes section.
     * Does nothing if notes array is empty.
     * Supports emotional design by highlighting positives.
     * @param notes - Array of positive observations
     */
    addPositiveNotes(notes: string[]): this {
        if (notes.length === 0) {
            return this;
        }

        this.sections.push(`\n---\n\n### ${SEVERITY.success} What's Good\n\n`);
        const bulletList = notes.map((note) => `- ${note}`).join('\n');
        this.sections.push(bulletList + '\n');
        return this;
    }

    /**
     * Add the closing follow-up prompt line.
     * @param summary - Closing message (e.g., "Ready for review.")
     */
    addFollowupPrompt(summary: string): this {
        this.sections.push(`\n---\n\n${SECTION.summary} ${summary}\n`);
        return this;
    }

    /**
     * Build and return the complete markdown response.
     * @returns Concatenated markdown string
     */
    build(): string {
        return this.sections.join('');
    }
}
