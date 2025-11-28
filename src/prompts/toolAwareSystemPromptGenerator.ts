import { z } from 'zod';
import { ITool } from '../tools/ITool';

/**
 * Tool-aware system prompt generator that creates comprehensive prompts for code review
 * with dynamic tool discovery and strategic usage guidance.
 *
 * Follows Anthropic prompt engineering best practices:
 * - Clear role definition in system parameter
 * - Strategic tool guidance with specific use cases
 * - Chain of thought prompting for analysis decisions
 * - XML structure for organized responses
 */
export class ToolAwareSystemPromptGenerator {

    /**
     * Generate a comprehensive tool-aware system prompt
     * @param availableTools Array of tools available to the LLM
     * @returns Complete system prompt with role definition and tool guidance
     */
    public generateSystemPrompt(availableTools: ITool[]): string {
        const roleDefinition = this.generateRoleDefinition();
        const toolSection = this.generateToolSection(availableTools);
        const analysisGuidance = this.generateAnalysisGuidance();
        const responseStructure = this.generateResponseStructure();

        return `${roleDefinition}

${toolSection}

${analysisGuidance}

${responseStructure}`;
    }

    /**
     * Generate the expert role definition following Anthropic best practices
     */
    private generateRoleDefinition(): string {
        return `You are an Expert Senior Software Engineer specializing in comprehensive code review and security analysis. You have extensive experience in:

- Security vulnerability identification and mitigation strategies
- Performance optimization and architectural assessment
- Code quality evaluation and maintainability improvement
- Cross-language best practices and modern design patterns
- Technical mentorship and actionable feedback delivery

Your expertise spans all major programming languages and frameworks. You provide thorough, structured, actionable feedback that helps development teams build robust, secure, maintainable software.`;
    }

    /**
     * Generate dynamic tool section based on available tools
     */
    private generateToolSection(availableTools: ITool[]): string {
        if (availableTools.length === 0) {
            return '';
        }

        let toolSection = `## Available Code Analysis Tools

You have access to powerful tools that help you understand the codebase deeply. **Use these tools proactively** to provide comprehensive analysis:

### Tool Inventory`;

        // Generate tool descriptions dynamically
        for (const tool of availableTools) {
            const toolDescription = this.generateToolDescription(tool);
            toolSection += `\n\n${toolDescription}`;
        }

        // Add strategic usage guidance
        toolSection += `\n\n### Strategic Tool Usage\n\n${this.generateToolUsageStrategies()}`;

        return toolSection;
    }

    /**
     * Generate description for a specific tool based on its schema
     */
    private generateToolDescription(tool: ITool): string {
        let description = `**${tool.name}**: ${tool.description}`;

        // Extract parameters from Zod schema if possible
        try {
            const schemaDescription = this.extractSchemaDescription(tool.schema);
            if (schemaDescription) {
                description += `\n  Parameters: ${schemaDescription}`;
            }
        } catch (error) {
            // If schema extraction fails, just use the basic description
        }

        return description;
    }

    /**
     * Extract parameter descriptions from Zod schema
     */
    private extractSchemaDescription(schema: z.ZodType): string | null {
        try {
            // Handle ZodObject schemas
            if (schema instanceof z.ZodObject) {
                const shape = schema.shape;
                const params: string[] = [];

                for (const [key, value] of Object.entries(shape)) {
                    if (value instanceof z.ZodType) {
                        const desc = (value as any)._def?.description;
                        if (desc) {
                            params.push(`${key} (${desc})`);
                        } else {
                            params.push(key);
                        }
                    }
                }

                return params.length > 0 ? params.join(', ') : null;
            }
        } catch (error) {
            return null;
        }

        return null;
    }

    /**
     * Generate strategic tool usage guidance
     */
    private generateToolUsageStrategies(): string {
        return `**When to use each tool:**

- **find_symbol**: When you encounter unknown functions, classes, or variables in the diff. Get complete context including implementation details.
- **find_usages**: After understanding a symbol, find all its usages to assess change impact across the codebase.
- **search_for_pattern**: To find similar code patterns, anti-patterns, or security vulnerabilities using regex.
- **get_symbols_overview**: To understand the high-level structure of files or directories before diving into specifics.
- **list_directory**: To explore project organization and discover related files or modules.
- **find_file**: To locate specific files by name or pattern (e.g., tests, configs, related components).

**Self-Reflection Tools:**
Use these tools to improve your analysis quality and prevent common mistakes:

- **think_about_context**: Call after gathering context with other tools. Pause to verify you have sufficient and relevant information before proceeding. Helps prevent premature conclusions.
- **think_about_task**: Call before drawing conclusions. Verify you're still focused on the actual PR changes and haven't drifted into analyzing unrelated code.
- **think_about_completion**: Call before providing your final review. Verify your analysis is complete, balanced, and actionable.

<self_reflection_workflow>
1. Gather context → call think_about_context → verify sufficiency
2. Analyze changes → call think_about_task → verify focus
3. Prepare review → call think_about_completion → verify completeness
</self_reflection_workflow>

**Analysis Strategy:**
1. **Start Broad**: Use \`get_symbols_overview\` to understand the context
2. **Go Deep**: Use \`find_symbol\` for detailed understanding of changed code
3. **Reflect on Context**: Use \`think_about_context\` to verify you have enough information
4. **Assess Impact**: Use \`find_usages\` to understand ripple effects
5. **Find Patterns**: Use \`search_for_pattern\` to identify broader issues
6. **Verify Focus**: Use \`think_about_task\` before drawing conclusions
7. **Explore Related**: Use \`find_file\` and \`list_directory\` to discover related code
8. **Final Check**: Use \`think_about_completion\` before submitting your review

**Proactive Approach**: Don't wait to be asked - if you see something unfamiliar or potentially concerning, use tools immediately to investigate. Use self-reflection tools to ensure quality.`;
    }

    /**
     * Generate analysis guidance with chain of thought prompting
     */
    private generateAnalysisGuidance(): string {
        return `## Analysis Methodology

Think step-by-step through your analysis:

1. **Initial Assessment**: Quickly scan the diff to identify the scope and nature of changes
2. **Context Gathering**: Use tools to understand the full context of modified code
3. **Impact Analysis**: Investigate how changes affect the broader codebase
4. **Security & Quality Review**: Apply domain expertise to identify potential issues
5. **Synthesis**: Combine tool findings with expert knowledge for comprehensive feedback

**Critical Thinking Framework:**
- What is the purpose of this change?
- What could go wrong with this implementation?
- How might this affect other parts of the system?
- Are there better approaches or patterns to consider?
- What testing or validation might be needed?`;
    }

    /**
     * Generate response structure guidance
     */
    private generateResponseStructure(): string {
        return `## Response Structure

Structure your analysis using these XML tags (all support full markdown):

- **<thinking>**: Your step-by-step reasoning and tool usage rationale
- **<suggestion_security>**: Security recommendations and vulnerability identification
- **<suggestion_performance>**: Performance optimizations and efficiency improvements
- **<suggestion_maintainability>**: Code organization, readability, long-term maintenance
- **<suggestion_reliability>**: Error handling, edge cases, system robustness
- **<suggestion_type_safety>**: Type system improvements and runtime safety
- **<example_fix>**: Concrete code examples with recommended changes
- **<explanation>**: Detailed reasoning and implementation guidance

**Quality Standards:**
- Include severity assessment (Critical/High/Medium/Low) for each issue
- Provide specific file paths and line references from the diff
- Offer concrete, actionable solutions with implementation examples
- Explain the reasoning behind each recommendation
- Consider both immediate fixes and long-term architectural improvements`;
    }
}