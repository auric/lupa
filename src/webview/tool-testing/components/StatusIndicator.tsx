import React from 'react';

export type ExecutionStatus =
    | 'idle'
    | 'running'
    | 'completed'
    | 'error'
    | 'cancelled';

interface StatusIndicatorProps {
    /** Current execution status */
    status: ExecutionStatus;
    /** Additional CSS classes */
    className?: string;
    /** Show status text along with icon */
    showText?: boolean;
}

interface StatusConfig {
    icon: string;
    text: string;
    className: string;
}

const STATUS_CONFIG: Record<ExecutionStatus, StatusConfig> = {
    idle: {
        icon: '⭕',
        text: 'Ready',
        className: 'text-muted-foreground',
    },
    running: {
        icon: '⏳',
        text: 'Executing...',
        className: 'text-blue-500',
    },
    completed: {
        icon: '✅',
        text: 'Completed',
        className: 'text-green-500',
    },
    error: {
        icon: '❌',
        text: 'Error',
        className: 'text-destructive',
    },
    cancelled: {
        icon: '🚫',
        text: 'Cancelled',
        className: 'text-muted-foreground',
    },
};

/**
 * StatusIndicator component that displays animated status with icon and optional text
 */
export const StatusIndicator: React.FC<StatusIndicatorProps> = ({
    status,
    className = '',
    showText = true,
}) => {
    const config = STATUS_CONFIG[status];

    if (!config) {
        console.warn(`Unknown status: ${status}`);
        return null;
    }

    return (
        <div
            className={`flex items-center gap-2 text-sm font-medium ${config.className} ${className}`.trim()}
            role="status"
            aria-label={`Status: ${config.text}`}
        >
            <span
                className={`text-base flex items-center justify-center ${status === 'running' ? 'animate-pulse' : ''}`.trim()}
                aria-hidden="true"
            >
                {config.icon}
            </span>
            {showText && <span>{config.text}</span>}
        </div>
    );
};

export default StatusIndicator;
