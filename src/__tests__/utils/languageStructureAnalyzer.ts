import * as vscode from 'vscode';
import { CodeStructureTestUtils } from './codeStructureTestUtils';
import { TreeStructureAnalyzer } from '../../services/treeStructureAnalyzer';
import { SUPPORTED_LANGUAGES } from '../../types/types';

/**
 * Command handler for testing the TreeStructureAnalyzer
 * This can be registered as a command to be invoked from the VS Code command palette
 */
export async function testTreeStructureAnalyzer(context: vscode.ExtensionContext): Promise<void> {
    const editor = vscode.window.activeTextEditor;

    if (!editor) {
        vscode.window.showErrorMessage('No active editor found');
        return;
    }

    const document = editor.document;
    const fileContent = document.getText();
    const filePath = document.uri.fsPath;

    // Get language from document
    let language = document.languageId;
    let variant: string | undefined;

    // Map VS Code language identifiers to our internal ones if needed
    const languageMapping: Record<string, { language: string, variant?: string }> = {};

    // Build language mapping from SUPPORTED_LANGUAGES
    Object.values(SUPPORTED_LANGUAGES).forEach(langData => {
        // Handle VS Code specific language IDs
        if (langData.language === 'javascript') {
            languageMapping['javascriptreact'] = { language: 'javascript' };
        } else if (langData.language === 'typescript') {
            if (langData.variant === 'tsx') {
                languageMapping['typescriptreact'] = { language: 'typescript', variant: 'tsx' };
            }
        }

        // Add the standard language mapping
        languageMapping[langData.language] = {
            language: langData.language,
            variant: langData.variant
        };
    });

    if (languageMapping[language]) {
        language = languageMapping[language].language;
        variant = languageMapping[language].variant;
    } else {
        vscode.window.showWarningMessage(`Language "${language}" may not be fully supported for structure analysis`);
    }

    // Create test utils
    const testUtils = new CodeStructureTestUtils(context.extensionPath);

    // Output channel for results
    const outputChannel = vscode.window.createOutputChannel('Code Structure Analyzer');
    outputChannel.clear();
    outputChannel.show();

    outputChannel.appendLine(`Analyzing file: ${filePath}`);
    outputChannel.appendLine(`Language: ${language}${variant ? ` (${variant})` : ''}`);
    outputChannel.appendLine('-----------------------------------');

    try {
        // Detect functions
        outputChannel.appendLine('FUNCTION DETECTION:');
        const functions = await testUtils.testFunctionDetection(fileContent, language, variant);

        for (const func of functions) {
            outputChannel.appendLine(`- ${func.type}: ${func.name || 'anonymous'}`);
            outputChannel.appendLine(`  Range: (${func.range.startPosition.row},${func.range.startPosition.column}) - (${func.range.endPosition.row},${func.range.endPosition.column})`);
        }

        // Show structure at cursor position if there's a selection
        if (editor.selection) {
            const position = editor.selection.active;

            outputChannel.appendLine('\nSTRUCTURE AT CURSOR:');
            const cursorFunction = await testUtils.testPositionInsideFunction(
                fileContent,
                language,
                position.line,
                position.character,
                variant
            );

            if (cursorFunction) {
                outputChannel.appendLine(`Cursor is inside function: ${cursorFunction.name || 'anonymous'}`);
                outputChannel.appendLine(`Function text:\n---\n${cursorFunction.text}\n---`);
            } else {
                outputChannel.appendLine('Cursor is not inside any function');
            }

            // Show structure hierarchy
            outputChannel.appendLine('\nSTRUCTURE HIERARCHY:');
            const hierarchy = await testUtils.testStructureHierarchy(
                fileContent,
                language,
                position.line,
                position.character,
                variant
            );

            for (let i = 0; i < hierarchy.length; i++) {
                const node = hierarchy[i];
                const indent = '  '.repeat(i);
                outputChannel.appendLine(`${indent}${node.type}${node.name ? ` (${node.name})` : ''}`);
            }
        }

        // Find break points
        outputChannel.appendLine('\nBREAK POINTS:');
        const breakPoints = await testUtils.testStructureBreakPoints(fileContent, language, variant);

        // Display the first 10 break points
        const displayCount = Math.min(10, breakPoints.length);
        outputChannel.appendLine(`Showing ${displayCount} of ${breakPoints.length} break points:`);

        // Get line information for visualizing break points
        const lines = fileContent.split('\n');
        const lineStartPositions: number[] = [];
        let currentPos = 0;

        for (const line of lines) {
            lineStartPositions.push(currentPos);
            currentPos += line.length + 1; // +1 for the newline
        }

        for (let i = 0; i < displayCount; i++) {
            const bp = breakPoints[i];

            // Find the line number for this position
            const lineIndex = lineStartPositions.findIndex(
                (startPos, index) => startPos <= bp.position &&
                    (index === lines.length - 1 || lineStartPositions[index + 1] > bp.position)
            );

            if (lineIndex >= 0) {
                const line = lines[lineIndex];
                const offset = bp.position - lineStartPositions[lineIndex];
                outputChannel.appendLine(`- Line ${lineIndex + 1}, col ${offset}: quality=${bp.quality}`);

                // Show context around the break point
                const contextStart = Math.max(0, offset - 10);
                const contextEnd = Math.min(line.length, offset + 10);
                const beforeContext = line.substring(contextStart, offset);
                const afterContext = line.substring(offset, contextEnd);

                outputChannel.appendLine(`  Context: "${beforeContext}|${afterContext}"`);
            }
        }

        outputChannel.appendLine('\nAnalysis completed successfully');
    } catch (error) {
        outputChannel.appendLine(`\nERROR: ${error instanceof Error ? error.message : String(error)}`);
        if (error instanceof Error && error.stack) {
            outputChannel.appendLine(error.stack);
        }
        vscode.window.showErrorMessage('Error analyzing code structure. See output for details.');
    }
}

/**
 * Register all commands related to language structure analysis
 */
export function registerLanguageStructureCommands(context: vscode.ExtensionContext): void {
    const testCommand = vscode.commands.registerCommand(
        'codelens-pr-analyzer.testStructureAnalyzer',
        () => testTreeStructureAnalyzer(context)
    );

    context.subscriptions.push(testCommand);
}