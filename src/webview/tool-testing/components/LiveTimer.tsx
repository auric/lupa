import React from 'react';
import { useLiveTimer } from '../../hooks/useLiveTimer';

interface LiveTimerProps {
  /** Whether the timer is currently running */
  isRunning: boolean;
  /** Additional CSS classes */
  className?: string;
  /** Show timer even when not running (shows 00:00:00) */
  showWhenIdle?: boolean;
  /** Update interval in milliseconds */
  updateInterval?: number;
}

/**
 * LiveTimer component that displays a continuously updating timer
 * Format: mm:ss:cs (minutes:seconds:centiseconds)
 */
export const LiveTimer: React.FC<LiveTimerProps> = ({
  isRunning,
  className = '',
  showWhenIdle = true,
  updateInterval = 100
}) => {
  const { formattedTime } = useLiveTimer({
    isRunning,
    updateInterval
  });

  // Don't render if not running and showWhenIdle is false
  if (!isRunning && !showWhenIdle) {
    return null;
  }

  return (
    <span
      className={`font-mono text-sm ${isRunning ? 'text-foreground' : 'text-muted-foreground'} ${className}`.trim()}
      role="timer"
      aria-live="polite"
      aria-label={`Execution time: ${formattedTime}`}
    >
      {formattedTime}
    </span>
  );
};

export default LiveTimer;