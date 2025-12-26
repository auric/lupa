import React, { useState, useEffect } from 'react';
import { useVSCodeApi } from '../hooks/useVSCodeApi';
import { ValidatePathPayload, PathValidationResultPayload } from '../../types/webviewMessages';

interface FileLinkProps {
    filePath: string;
    line?: number;
    endLine?: number;
    column?: number;
    children: React.ReactNode;
    className?: string;
}

export const FileLink: React.FC<FileLinkProps> = ({
    filePath,
    line,
    endLine,
    column,
    children,
    className = ''
}) => {
    const [isValid, setIsValid] = useState<boolean | null>(null); // null = pending, false = invalid, true = valid
    const [resolvedPath, setResolvedPath] = useState<string | undefined>();
    const vscode = useVSCodeApi();

    // Validate this specific path
    useEffect(() => {
        if (!vscode) return;

        const validatePath = () => {
            const requestId = `filelink-${filePath}-${Date.now()}`;

            const payload: ValidatePathPayload = {
                filePath,
                requestId
            };

            vscode.postMessage({
                command: 'validatePath',
                payload
            });
        };

        // Start validation immediately
        validatePath();

        // Listen for validation result
        const handleMessage = (event: MessageEvent) => {
            const message = event.data;
            if (message.command === 'pathValidationResult') {
                const payload: PathValidationResultPayload = message.payload;

                // Only update if this is our path
                if (payload.filePath === filePath) {
                    setIsValid(payload.isValid);
                    setResolvedPath(payload.resolvedPath);
                }
            }
        };

        window.addEventListener('message', handleMessage);
        return () => window.removeEventListener('message', handleMessage);
    }, [filePath, vscode]);

    const handleClick = () => {
        // Only allow clicking if path is valid
        if (vscode && isValid) {
            vscode.postMessage({
                command: 'openFile',
                payload: {
                    filePath: resolvedPath || filePath,
                    line,
                    endLine,
                    column
                }
            });
        }
    };

    // Show as regular text while validating or if invalid
    if (isValid === null || !isValid) {
        return (
            <span
                className={`${isValid === null ? 'text-gray-500' : 'text-inherit'} ${className}`}
                title={isValid === null ? `Validating: ${filePath}` : `Invalid path: ${filePath}`}
            >
                {children}
            </span>
        );
    }

    // Show as clickable link when valid
    return (
        <button
            type="button"
            onClick={handleClick}
            title={resolvedPath || filePath}
            className={`file-link cursor-pointer text-blue-500 hover:underline hover:text-blue-700 ${className}`}
        >
            {children}
        </button>
    );
};