import * as vscode from 'vscode';
import { TreeStructureAnalyzer, CodePosition, CodeStructure } from '../../services/treeStructureAnalyzer';

/**
 * Utility class to test code structure detection
 */
export class CodeStructureTestUtils {
    private analyzer: TreeStructureAnalyzer;

    constructor(extensionPath: string) {
        this.analyzer = TreeStructureAnalyzer.getInstance(extensionPath);
    }

    /**
     * Test if the structure analyzer correctly identifies functions
     * @param content The code content to analyze
     * @param language The language identifier (e.g., 'typescript', 'python')
     * @param variant Optional language variant (e.g., 'tsx')
     * @returns The detected functions
     */
    async testFunctionDetection(content: string, language: string, variant?: string): Promise<CodeStructure[]> {
        const functions = await this.analyzer.findFunctions(content, language, variant);
        console.log(`Detected ${functions.length} functions in ${language}${variant ? ` (${variant})` : ''} code`);

        return functions;
    }

    /**
     * Test if a specific position is inside a function
     * @param content The code content
     * @param language The language identifier
     * @param line The line number (0-based)
     * @param column The column number (0-based)
     * @param variant Optional language variant (e.g., 'tsx')
     * @returns The function if position is inside a function, null otherwise
     */
    async testPositionInsideFunction(
        content: string,
        language: string,
        line: number,
        column: number,
        variant?: string
    ): Promise<CodeStructure | null> {
        const position: CodePosition = { row: line, column: column };
        const result = await this.analyzer.isPositionInsideFunction(content, language, position, variant);

        if (result) {
            console.log(`Position (${line},${column}) is inside function: ${result.name}`);
        } else {
            console.log(`Position (${line},${column}) is NOT inside any function`);
        }

        return result;
    }

    /**
     * Find the best break points for chunking code
     * @param content The code content
     * @param language The language identifier
     * @param variant Optional language variant (e.g., 'tsx')
     * @returns Array of recommended break positions
     */
    async testStructureBreakPoints(
        content: string,
        language: string,
        variant?: string
    ): Promise<Array<{ position: number, quality: number }>> {
        const breakPoints = await this.analyzer.findStructureBreakPoints(content, language, variant);

        console.log(`Found ${breakPoints.length} structure break points`);

        // Visualize the break points in the code
        const lines = content.split('\n');
        const lineStartPositions: number[] = [];
        let currentPos = 0;

        for (const line of lines) {
            lineStartPositions.push(currentPos);
            currentPos += line.length + 1; // +1 for the newline
        }

        console.log('Break point locations:');
        for (const bp of breakPoints) {
            // Find the line number for this position
            const lineIndex = lineStartPositions.findIndex(
                (startPos, index) => startPos <= bp.position &&
                    (index === lines.length - 1 || lineStartPositions[index + 1] > bp.position)
            );

            if (lineIndex >= 0) {
                const offset = bp.position - lineStartPositions[lineIndex];
                console.log(`Line ${lineIndex + 1}, col ${offset}: quality=${bp.quality}`);
            }
        }

        return breakPoints;
    }

    /**
     * Get the hierarchy of code structures at a position
     * @param content The code content
     * @param language The language identifier
     * @param line The line number (0-based)
     * @param column The column number (0-based)
     * @param variant Optional language variant (e.g., 'tsx')
     */
    async testStructureHierarchy(
        content: string,
        language: string,
        line: number,
        column: number,
        variant?: string
    ): Promise<CodeStructure[]> {
        const position: CodePosition = { row: line, column: column };
        const hierarchy = await this.analyzer.getStructureHierarchyAtPosition(
            content,
            language,
            position,
            variant
        );

        console.log(`Structure hierarchy at position (${line},${column}):`);
        for (let i = 0; i < hierarchy.length; i++) {
            const indent = '  '.repeat(i);
            console.log(`${indent}${hierarchy[i].type}${hierarchy[i].name ? ` (${hierarchy[i].name})` : ''}`);
        }

        return hierarchy;
    }
}