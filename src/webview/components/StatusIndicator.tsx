import React from 'react';

export type ExecutionStatus = 'idle' | 'running' | 'completed' | 'error' | 'cancelled';

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
    className: 'status-idle'
  },
  running: {
    icon: '⏳',
    text: 'Executing...',
    className: 'status-running'
  },
  completed: {
    icon: '✅',
    text: 'Completed',
    className: 'status-completed'
  },
  error: {
    icon: '❌',
    text: 'Error',
    className: 'status-error'
  },
  cancelled: {
    icon: '🚫',
    text: 'Cancelled',
    className: 'status-cancelled'
  }
};

/**
 * StatusIndicator component that displays animated status with icon and optional text
 */
export const StatusIndicator: React.FC<StatusIndicatorProps> = ({
  status,
  className = '',
  showText = true
}) => {
  const config = STATUS_CONFIG[status];

  if (!config) {
    console.warn(`Unknown status: ${status}`);
    return null;
  }

  return (
    <div 
      className={`status-indicator ${config.className} ${className}`.trim()}
      role="status"
      aria-label={`Status: ${config.text}`}
    >
      <span 
        className={`status-icon ${status === 'running' ? 'pulse' : ''}`.trim()}
        aria-hidden="true"
      >
        {config.icon}
      </span>
      {showText && (
        <span className="status-text">
          {config.text}
        </span>
      )}
    </div>
  );
};

export default React.memo(StatusIndicator);