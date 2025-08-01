import { AnalysisMode } from '../types/modelTypes';
import { DiffHunk } from '../types/contextTypes';

/**
 * Few-shot examples demonstrating high-quality code reviews with XML tagged output
 */
const FEW_SHOT_EXAMPLES = [
    {
        scenario: "Security vulnerability in authentication",
        code: `// Added user authentication check
if (user.password === inputPassword) {
    return { success: true, token: generateToken(user.id) };
}`,
        review: `<suggestion_security>
This authentication implementation is vulnerable to timing attacks. Use a secure comparison method instead of direct string comparison.
</suggestion_security>

<example_fix>
\`\`\`javascript
// For Node.js environments
const bcrypt = require('bcrypt');

if (await bcrypt.compare(inputPassword, user.hashedPassword)) {
    return { success: true, token: generateToken(user.id) };
}

// For other environments with crypto support
const crypto = require('crypto');

function secureCompare(a, b) {
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
\`\`\`
</example_fix>

<explanation>
Direct string comparison for passwords creates timing vulnerabilities where attackers can measure response times to guess passwords. Using bcrypt.compare() provides constant-time comparison and proper password hashing.
</explanation>`
    },
    {
        scenario: "Performance issue in data processing",
        code: `// Process user data
const results = [];
for (let i = 0; i < users.length; i++) {
    const profile = await fetchUserProfile(users[i].id);
    results.push(processProfile(profile));
}`,
        review: `<suggestion_performance>
This sequential processing creates unnecessary latency. Consider using concurrent operations when order doesn't matter.
</suggestion_performance>

<example_fix>
\`\`\`javascript
// Process user data concurrently
const profilePromises = users.map(user => fetchUserProfile(user.id));
const profiles = await Promise.all(profilePromises);
const results = profiles.map(profile => processProfile(profile));
\`\`\`
</example_fix>

<explanation>
Sequential await in loops creates O(n) latency where n is the number of async operations. Concurrent processing reduces total time to the longest single operation plus overhead.
</explanation>`
    },
    {
        scenario: "Code maintainability improvement",
        code: `// Updated validation logic
if (data.email && data.email.includes('@') && data.email.length > 5 && data.password && data.password.length >= 8 && /[A-Z]/.test(data.password) && /[0-9]/.test(data.password)) {
    return true;
}`,
        review: `<suggestion_maintainability>
This complex conditional is difficult to read and maintain. Extract validation logic into separate, well-named functions.
</suggestion_maintainability>

<example_fix>
\`\`\`javascript
const isValidEmail = (email) => {
    return email && email.includes('@') && email.length > 5;
};

const isValidPassword = (password) => {
    return password &&
           password.length >= 8 &&
           /[A-Z]/.test(password) &&
           /[0-9]/.test(password);
};

if (isValidEmail(data.email) && isValidPassword(data.password)) {
    return true;
}
\`\`\`
</example_fix>

<explanation>
Breaking complex conditions into named functions improves readability, testability, and reusability. Each function has a single responsibility and clear intent.
</explanation>`
    },
    {
        scenario: "Error handling improvement",
        code: `// API call with basic error handling
try {
    const response = await api.getData();
    return response.data;
} catch (error) {
    console.log('Error occurred');
    return null;
}`,
        review: `<suggestion_reliability>
Error handling is too generic and loses important debugging information. Implement specific error types and proper logging.
</suggestion_reliability>

<example_fix>
\`\`\`javascript
try {
    const response = await api.getData();
    return response.data;
} catch (error) {
    if (error.name === 'NetworkError' || error.code === 'NETWORK_ERROR') {
        logger.warn('Network failure in getData', { error: error.message, retryable: true });
        throw new Error('Data fetch failed due to network issues');
    } else if (error.status === 401 || error.name === 'AuthenticationError') {
        logger.error('Authentication failed in getData', { error: error.message });
        throw new Error('Invalid credentials for data access');
    } else {
        logger.error('Unexpected error in getData', { error: error.message, stack: error.stack });
        throw new Error('Unexpected error during data retrieval');
    }
}
\`\`\`
</example_fix>

<explanation>
Specific error handling provides better debugging information, enables appropriate recovery strategies, and maintains system observability through proper logging.
</explanation>`
    },
    {
        scenario: "Type safety enhancement",
        code: `// Function to process user data
function processUserData(userData) {
    return {
        id: userData.id,
        name: userData.fullName || userData.name,
        email: userData.email.toLowerCase()
    };
}`,
        review: `<suggestion_type_safety>
Missing type definitions create runtime risks and reduce IDE support. Add comprehensive type annotations or interfaces.
</suggestion_type_safety>

<example_fix>
\`\`\`javascript
// For TypeScript/JavaScript with JSDoc
/**
 * @typedef {Object} RawUserData
 * @property {string} id
 * @property {string} [fullName]
 * @property {string} [name]
 * @property {string} email
 */

/**
 * @typedef {Object} ProcessedUserData
 * @property {string} id
 * @property {string} name
 * @property {string} email
 */

/**
 * @param {RawUserData} userData
 * @returns {ProcessedUserData}
 */
function processUserData(userData) {
    if (!userData.email) {
        throw new ValidationError('Email is required');
    }

    return {
        id: userData.id,
        name: userData.fullName || userData.name || 'Unknown',
        email: userData.email.toLowerCase()
    };
}
\`\`\`
</example_fix>

<explanation>
Explicit type definitions prevent runtime errors, improve IDE autocomplete, and make code self-documenting. Proper validation and null checks ensure robustness across different languages.
</explanation>`
    }
];

/**
 * Centralized prompt generation service following Anthropic best practices
 * - Focused system prompt for role definition only
 * - Task instructions in user messages
 * - Proper XML structure with underscores
 * - Optimized for long context (query at end)
 */
export class PromptGenerator {

    /**
     * Generate focused system prompt (role definition only)
     * Following Anthropic guideline: "Place the role definition in the system parameter"
     */
    public getSystemPrompt(): string {
        return `You are an Expert Senior Software Engineer specializing in comprehensive code review and security analysis. You have extensive experience in:

- Security vulnerability identification and mitigation strategies
- Performance optimization and architectural assessment
- Code quality evaluation and maintainability improvement
- Cross-language best practices and modern design patterns
- Technical mentorship and actionable feedback delivery

Your expertise spans all major programming languages and frameworks. You provide thorough, structured, actionable feedback that helps development teams build robust, secure, maintainable software.`;
    }

    /**
     * Generate tool information section for system prompt
     * Used when tool-calling approach is enabled
     */
    public getToolInformation(): string {
        return `

You have access to tools that can help you gather information about the codebase:

Available tools:
- find_symbol: Find the definition of a code symbol by name, including its full source code and location information

Use these tools proactively to understand the context of any functions, classes, variables, or other symbols mentioned in the diff. This will help you provide more accurate and detailed analysis.`;
    }

    /**
     * Generate response prefill to guide output format
     * Following Anthropic guideline for structured data extraction
     */
    public getResponsePrefill(): string {
        return `I'll analyze this pull request comprehensively, examining security, performance, maintainability, and architectural considerations.

## Comprehensive Code Review Analysis

`;
    }

    /**
     * Generate complete user prompt with proper structure
     * Following Anthropic guidelines:
     * - Task instructions in user message
     * - Long context optimization (query at end)
     * - Proper XML structure
     */
    public generateUserPrompt(
        diffText: string,
        parsedDiff: DiffHunk[],
        contextString: string,
        hasContext: boolean
    ): string {
        // 1. Long documents at top (Anthropic guideline)
        const contextSection = hasContext
            ? `<context>\n${contextString}\n</context>\n\n`
            : '';

        // 2. Few-shot examples for guidance
        const examplesSection = this.generateExamplesSection();

        // 3. File content structured with metadata
        const fileContentSection = this.generateFileContentSection(diffText, parsedDiff);

        // 4. Task instructions at end (Anthropic guideline for 30% improvement)
        const instructionsSection = this.generateInstructionsSection();

        return `${contextSection}${examplesSection}${fileContentSection}${instructionsSection}`;
    }

    /**
     * Generate few-shot examples section with proper XML structure
     */
    private generateExamplesSection(): string {
        let examplesXml = '<examples>\n';
        FEW_SHOT_EXAMPLES.forEach((example, index) => {
            examplesXml += `<example id="${index + 1}">\n`;
            examplesXml += `<scenario>${example.scenario}</scenario>\n`;
            examplesXml += `<code>\n${example.code}\n</code>\n`;
            examplesXml += `<review>\n${example.review}\n</review>\n`;
            examplesXml += '</example>\n\n';
        });
        examplesXml += '</examples>\n\n';
        return examplesXml;
    }

    /**
     * Generate file content section with proper structure
     */
    private generateFileContentSection(diffText: string, parsedDiff: DiffHunk[]): string {
        let fileContentXml = "<files_to_review>\n";

        for (const fileDiff of parsedDiff) {
            fileContentXml += `<file>\n<path>${fileDiff.filePath}</path>\n<changes>\n`;

            for (const hunk of fileDiff.hunks) {
                // Extract hunk header from original diff
                const hunkHeaderMatch = diffText.match(
                    new RegExp(`^@@ .*${hunk.oldStart},${hunk.oldLines} \\\\+${hunk.newStart},${hunk.newLines} @@.*`, "m")
                );

                if (hunkHeaderMatch) {
                    fileContentXml += `${hunkHeaderMatch[0]}\n`;
                } else {
                    fileContentXml += `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n`;
                }

                fileContentXml += hunk.lines.join('\n') + '\n\n';
            }

            fileContentXml += '</changes>\n</file>\n\n';
        }

        fileContentXml += "</files_to_review>\n\n";
        return fileContentXml;
    }

    /**
     * Generate comprehensive analysis instructions
     * Positioned at end for optimal long context performance
     */
    private generateInstructionsSection(): string {
        return `<instructions>
Analyze the pull request changes using this comprehensive framework:

## Analysis Dimensions

### 1. Security Analysis
- **Vulnerability Assessment**: Input validation, injection risks, data exposure
- **Authentication & Authorization**: Access controls, privilege escalation
- **Cryptographic Review**: Algorithm choices, key management, secure implementations
- **Attack Surface**: New vectors, trust boundaries, security boundaries

### 2. Performance Analysis
- **Algorithmic Complexity**: Big O analysis, optimization opportunities
- **Resource Management**: Memory usage, connection handling, cleanup
- **Concurrency**: Race conditions, thread safety, deadlock potential
- **Database Performance**: Query optimization, N+1 problems, indexing

### 3. Code Quality & Maintainability
- **Design Patterns**: SOLID principles, pattern opportunities, anti-patterns
- **Code Structure**: Duplication, naming, documentation, complexity
- **Technical Debt**: Maintainability impact, refactoring opportunities

### 4. Reliability & Error Handling
- **Exception Handling**: Comprehensive coverage, recovery strategies
- **Edge Cases**: Boundary conditions, null handling, error propagation
- **Observability**: Logging, monitoring, debugging support

### 5. Type Safety & Runtime Correctness
- **Type System**: Strong typing, interface definitions, generics
- **Runtime Safety**: Null safety, bounds checking, validation
- **API Contracts**: Input/output validation, integration points

### 6. Testing & Quality Assurance
- **Coverage Gaps**: Missing scenarios, edge cases, integration points
- **Test Quality**: Maintainability, brittleness, clarity
- **Testing Strategy**: Unit vs integration recommendations

## Response Structure

Provide comprehensive analysis using these XML tags (all support full markdown):

- <suggestion_security> - Security recommendations and vulnerability identification
- <suggestion_performance> - Performance optimizations and efficiency improvements
- <suggestion_maintainability> - Code organization, readability, long-term maintenance
- <suggestion_reliability> - Error handling, edge cases, system robustness
- <suggestion_type_safety> - Type system improvements and runtime safety
- <example_fix> - Concrete code examples with recommended changes
- <explanation> - Detailed reasoning and implementation guidance

## Analysis Requirements

For each identified issue:
1. **Detailed Problem Description** with severity assessment (Critical/High/Medium/Low)
2. **Root Cause Analysis** explaining why the issue exists
3. **Comprehensive Solution** with step-by-step implementation approach
4. **Prevention Strategy** to avoid similar issues

**Critical**: Always include specific file paths (relative paths from diff) in suggestions to make them actionable. Reference exact lines, functions, and architectural decisions.

**Content Depth**: Provide multiple suggestions per category when applicable, with detailed explanations, implementation examples, and reasoning behind each recommendation.
</instructions>`;
    }

    /**
     * Calculate tokens for the complete structured prompt
     * This method helps with token estimation for the generated prompt structure
     */
    public calculatePromptStructureTokens(
        diffText: string,
        parsedDiff: DiffHunk[],
        contextPlaceholder: string = "[CONTEXT_PLACEHOLDER]"
    ): {
        examplesTokens: number;
        fileContentTokens: number;
        instructionsTokens: number;
        contextPlaceholderTokens: number;
        estimatedPromptLength: number;
    } {
        const examplesSection = this.generateExamplesSection();
        const fileContentSection = this.generateFileContentSection(diffText, parsedDiff);
        const instructionsSection = this.generateInstructionsSection();
        const contextSection = `<context>\n${contextPlaceholder}\n</context>\n\n`;

        // Rough token estimation (4 chars per token average)
        const examplesTokens = Math.ceil(examplesSection.length / 4);
        const fileContentTokens = Math.ceil(fileContentSection.length / 4);
        const instructionsTokens = Math.ceil(instructionsSection.length / 4);
        const contextPlaceholderTokens = Math.ceil(contextSection.length / 4);

        const totalPrompt = contextSection + examplesSection + fileContentSection + instructionsSection;

        return {
            examplesTokens,
            fileContentTokens,
            instructionsTokens,
            contextPlaceholderTokens,
            estimatedPromptLength: totalPrompt.length
        };
    }

    public dispose(): void {
        // No resources to dispose in this service
    }
}
