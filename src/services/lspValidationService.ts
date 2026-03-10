import * as vscode from 'vscode';
import * as path from 'path';
import type {
    ClaimValidationRequest,
    ClaimValidationResult,
    ClaimType,
} from '../types/claimTypes';
import {
    withCancellableTimeout,
    isTimeoutError,
    isCancellationError,
    rethrowIfCancellationOrTimeout,
} from '../utils/asyncUtils';
import { AsyncSemaphore } from '../utils/asyncSemaphore';
import { getErrorMessage } from '../utils/errorUtils';
import { extractHoverText } from '../utils/hoverTextExtractor';
import { Log } from './loggingService';
import type { GitOperationsManager } from './gitOperationsManager';

const LSP_VALIDATION_TIMEOUT = 2000;
const LSP_VALIDATION_CONCURRENCY = 4;

export class LspValidationService implements vscode.Disposable {
    constructor(private readonly gitOps: GitOperationsManager) {}

    async validate(
        request: ClaimValidationRequest,
        token: vscode.CancellationToken
    ): Promise<ClaimValidationResult> {
        try {
            const uri = this.resolveFileUri(request.file);
            if (!uri) {
                return this.inconclusive(
                    request.claimType,
                    'Could not resolve file path'
                );
            }

            switch (request.claimType) {
                case 'symbol_unused':
                case 'no_callers':
                    return await this.validateReferenceCount(
                        request,
                        uri,
                        token
                    );
                case 'type_mismatch':
                    return await this.validateTypeMismatch(request, uri, token);
                case 'symbol_missing':
                    return await this.validateSymbolExists(request, uri, token);
                case 'not_exported':
                    return await this.validateNotExported(request, uri, token);
                case 'no_implementation':
                    return await this.validateNoImplementation(
                        request,
                        uri,
                        token
                    );
                default:
                    return this.inconclusive(
                        request.claimType,
                        `Unknown claim type: ${request.claimType}`
                    );
            }
        } catch (error) {
            if (isCancellationError(error)) {
                throw error;
            }
            if (isTimeoutError(error)) {
                return this.inconclusive(
                    request.claimType,
                    'LSP query timed out'
                );
            }
            return this.inconclusive(
                request.claimType,
                `LSP error: ${getErrorMessage(error)}`
            );
        }
    }

    async validateBatch(
        requests: ClaimValidationRequest[],
        token: vscode.CancellationToken
    ): Promise<ClaimValidationResult[]> {
        const semaphore = new AsyncSemaphore(LSP_VALIDATION_CONCURRENCY);
        return Promise.all(
            requests.map((request) =>
                semaphore.run(() => this.validate(request, token), token)
            )
        );
    }

    private resolveFileUri(filePath: string): vscode.Uri | undefined {
        const repo = this.gitOps.getRepository();
        if (!repo) {
            return undefined;
        }
        const rootPath = repo.rootUri.fsPath;
        const absolutePath = path.isAbsolute(filePath)
            ? filePath
            : path.join(rootPath, filePath);
        return vscode.Uri.file(absolutePath);
    }

    private async getPositionForSymbol(
        uri: vscode.Uri,
        line: number,
        symbol: string,
        token: vscode.CancellationToken
    ): Promise<vscode.Position | undefined> {
        try {
            const document = await withCancellableTimeout(
                Promise.resolve(vscode.workspace.openTextDocument(uri)),
                LSP_VALIDATION_TIMEOUT,
                `Open document ${path.basename(uri.fsPath)}`,
                token
            );
            const lineIndex = Math.max(0, line - 1);
            if (lineIndex >= document.lineCount) {
                return undefined;
            }
            const lineText = document.lineAt(lineIndex).text;
            const col = lineText.indexOf(symbol);
            if (col >= 0) {
                return new vscode.Position(lineIndex, col);
            }
            // Fallback: check adjacent lines (LLM line numbers can be off by 1-2)
            for (const offset of [-1, 1, -2, 2]) {
                const adjacentLine = lineIndex + offset;
                if (adjacentLine < 0 || adjacentLine >= document.lineCount) {
                    continue;
                }
                const adjText = document.lineAt(adjacentLine).text;
                const adjCol = adjText.indexOf(symbol);
                if (adjCol >= 0) {
                    return new vscode.Position(adjacentLine, adjCol);
                }
            }
            return undefined;
        } catch (error) {
            rethrowIfCancellationOrTimeout(error);
            return undefined;
        }
    }

    private async validateReferenceCount(
        request: ClaimValidationRequest,
        uri: vscode.Uri,
        token: vscode.CancellationToken
    ): Promise<ClaimValidationResult> {
        const position = await this.getPositionForSymbol(
            uri,
            request.line,
            request.symbol,
            token
        );
        if (!position) {
            return this.inconclusive(
                request.claimType,
                `Could not locate symbol "${request.symbol}" near line ${request.line}`
            );
        }

        const references = await withCancellableTimeout(
            Promise.resolve(
                vscode.commands.executeCommand<vscode.Location[]>(
                    'vscode.executeReferenceProvider',
                    uri,
                    position,
                    { includeDeclaration: false }
                )
            ),
            LSP_VALIDATION_TIMEOUT,
            `Reference count for ${request.symbol}`,
            token
        );

        if (references === undefined) {
            if (token.isCancellationRequested) {
                throw new vscode.CancellationError();
            }
            return this.inconclusive(
                request.claimType,
                'LSP returned no result'
            );
        }

        const refCount = references.length;
        const claimHolds = refCount === 0;

        return {
            claimType: request.claimType,
            verified: claimHolds,
            confidence: 'definitive',
            evidence: claimHolds
                ? `No references found for "${request.symbol}"`
                : `Found ${refCount} references to "${request.symbol}"`,
            groundTruth: `${refCount} references`,
        };
    }

    private async validateTypeMismatch(
        request: ClaimValidationRequest,
        uri: vscode.Uri,
        token: vscode.CancellationToken
    ): Promise<ClaimValidationResult> {
        const position = await this.getPositionForSymbol(
            uri,
            request.line,
            request.symbol,
            token
        );
        if (!position) {
            return this.inconclusive(
                request.claimType,
                `Could not locate symbol "${request.symbol}" near line ${request.line}`
            );
        }

        const hovers = await withCancellableTimeout(
            Promise.resolve(
                vscode.commands.executeCommand<vscode.Hover[]>(
                    'vscode.executeHoverProvider',
                    uri,
                    position
                )
            ),
            LSP_VALIDATION_TIMEOUT,
            `Hover info for ${request.symbol}`,
            token
        );

        if (!hovers || hovers.length === 0) {
            return this.inconclusive(
                request.claimType,
                'No hover information available'
            );
        }

        const hoverText = this.extractHoverText(hovers);

        if (!request.expectedValue) {
            return {
                claimType: request.claimType,
                verified: false,
                confidence: 'inconclusive',
                evidence: `Hover type info: ${hoverText.substring(0, 200)}`,
                groundTruth: hoverText.substring(0, 200),
            };
        }

        const typeMismatchConfirmed = !hoverText.includes(
            request.expectedValue
        );
        return {
            claimType: request.claimType,
            verified: typeMismatchConfirmed,
            confidence: 'probable',
            evidence: typeMismatchConfirmed
                ? `Type does not include "${request.expectedValue}". Hover: ${hoverText.substring(0, 200)}`
                : `Type includes "${request.expectedValue}". Hover: ${hoverText.substring(0, 200)}`,
            groundTruth: hoverText.substring(0, 200),
        };
    }

    private async validateSymbolExists(
        request: ClaimValidationRequest,
        uri: vscode.Uri,
        token: vscode.CancellationToken
    ): Promise<ClaimValidationResult> {
        const position = await this.getPositionForSymbol(
            uri,
            request.line,
            request.symbol,
            token
        );
        if (!position) {
            return this.inconclusive(
                request.claimType,
                `Could not locate symbol "${request.symbol}" near line ${request.line} — cannot confirm or deny existence`
            );
        }

        const definitions = await withCancellableTimeout(
            Promise.resolve(
                vscode.commands.executeCommand<
                    (vscode.Location | vscode.LocationLink)[]
                >('vscode.executeDefinitionProvider', uri, position)
            ),
            LSP_VALIDATION_TIMEOUT,
            `Definition check for ${request.symbol}`,
            token
        );

        if (!definitions || definitions.length === 0) {
            return {
                claimType: request.claimType,
                verified: true,
                confidence: 'definitive',
                evidence: `No definitions found for "${request.symbol}"`,
                groundTruth: '0 definitions',
            };
        }

        return {
            claimType: request.claimType,
            verified: false,
            confidence: 'definitive',
            evidence: `Found ${definitions.length} definition(s) for "${request.symbol}"`,
            groundTruth: `${definitions.length} definitions`,
        };
    }

    private async validateNotExported(
        request: ClaimValidationRequest,
        uri: vscode.Uri,
        token: vscode.CancellationToken
    ): Promise<ClaimValidationResult> {
        const position = await this.getPositionForSymbol(
            uri,
            request.line,
            request.symbol,
            token
        );
        if (!position) {
            return this.inconclusive(
                request.claimType,
                `Could not locate symbol "${request.symbol}" near line ${request.line}`
            );
        }

        const hovers = await withCancellableTimeout(
            Promise.resolve(
                vscode.commands.executeCommand<vscode.Hover[]>(
                    'vscode.executeHoverProvider',
                    uri,
                    position
                )
            ),
            LSP_VALIDATION_TIMEOUT,
            `Export check for ${request.symbol}`,
            token
        );

        if (!hovers || hovers.length === 0) {
            return this.inconclusive(
                request.claimType,
                'No hover information available'
            );
        }

        const hoverText = this.extractHoverText(hovers);
        const isExported = /\bexport\b/.test(hoverText);

        return {
            claimType: request.claimType,
            verified: !isExported,
            confidence: isExported ? 'definitive' : 'probable',
            evidence: isExported
                ? `Symbol "${request.symbol}" IS exported (hover shows 'export' keyword)`
                : `Symbol "${request.symbol}" does not appear to be exported`,
            groundTruth: hoverText.substring(0, 200),
        };
    }

    private async validateNoImplementation(
        request: ClaimValidationRequest,
        uri: vscode.Uri,
        token: vscode.CancellationToken
    ): Promise<ClaimValidationResult> {
        const position = await this.getPositionForSymbol(
            uri,
            request.line,
            request.symbol,
            token
        );
        if (!position) {
            return this.inconclusive(
                request.claimType,
                `Could not locate symbol "${request.symbol}" near line ${request.line}`
            );
        }

        try {
            const implementations = await withCancellableTimeout(
                Promise.resolve(
                    vscode.commands.executeCommand<vscode.Location[]>(
                        'vscode.executeImplementationProvider',
                        uri,
                        position
                    )
                ),
                LSP_VALIDATION_TIMEOUT,
                `Implementation check for ${request.symbol}`,
                token
            );

            if (!implementations || implementations.length === 0) {
                return {
                    claimType: request.claimType,
                    verified: true,
                    confidence: 'definitive',
                    evidence: `No implementations found for "${request.symbol}"`,
                    groundTruth: '0 implementations',
                };
            }

            return {
                claimType: request.claimType,
                verified: false,
                confidence: 'definitive',
                evidence: `Found ${implementations.length} implementation(s) of "${request.symbol}"`,
                groundTruth: `${implementations.length} implementations`,
            };
        } catch (error) {
            if (isCancellationError(error)) {
                throw error;
            }
            return this.inconclusive(
                request.claimType,
                'Implementation provider not available'
            );
        }
    }

    private extractHoverText(hovers: vscode.Hover[]): string {
        return extractHoverText(hovers);
    }

    private inconclusive(
        claimType: ClaimType,
        reason: string
    ): ClaimValidationResult {
        Log.debug(`LSP validation inconclusive for ${claimType}: ${reason}`);
        return {
            claimType,
            verified: false,
            confidence: 'inconclusive',
            evidence: reason,
            groundTruth: '',
        };
    }

    dispose(): void {
        // No resources to clean up
    }
}
