import React from 'react';
import { useVSCodeApi } from '../hooks/useVSCodeApi';

interface FileLinkProps {
    filePath: string;
    line?: number;
    column?: number;
    children: React.ReactNode;
    className?: string;
}

export const FileLink: React.FC<FileLinkProps> = ({ 
    filePath, 
    line, 
    column, 
    children, 
    className = '' 
}) => {
    const vscode = useVSCodeApi();

    const handleClick = () => {
        if (vscode) {
            vscode.postMessage({
                command: 'openFile',
                payload: {
                    filePath,
                    line,
                    column
                }
            });
        }
    };

    return (
        <button
            type="button"
            onClick={handleClick}
            title={filePath}
            className={`file-link ${className}`}
        >
            {children}
        </button>
    );
};