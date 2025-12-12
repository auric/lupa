import { useState, useEffect, useRef, useCallback } from 'react';

interface UseLiveTimerOptions {
  /** Whether the timer should be running */
  isRunning: boolean;
  /** Update interval in milliseconds (default: 100ms for smooth updates) */
  updateInterval?: number;
}

interface LiveTimerResult {
  /** Elapsed time in milliseconds */
  elapsedTime: number;
  /** Formatted time string as mm:ss::ms */
  formattedTime: string;
  /** Reset the timer to 0 */
  reset: () => void;
}

/**
 * Custom hook for managing a live timer that updates continuously while running
 */
export const useLiveTimer = ({ 
  isRunning, 
  updateInterval = 100 
}: UseLiveTimerOptions): LiveTimerResult => {
  const [elapsedTime, setElapsedTime] = useState(0);
  const startTimeRef = useRef<number | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const formatTime = useCallback((totalMs: number): string => {
    const minutes = Math.floor(totalMs / 60000);
    const seconds = Math.floor((totalMs % 60000) / 1000);
    const milliseconds = Math.floor(totalMs % 1000);
    
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}:${milliseconds.toString().padStart(3, '0')}`;
  }, []);

  const updateTimer = useCallback(() => {
    if (startTimeRef.current !== null && isRunning) {
      const now = performance.now();
      const elapsed = Math.round(now - startTimeRef.current);
      setElapsedTime(elapsed);
    }
  }, [isRunning]);

  const reset = useCallback(() => {
    setElapsedTime(0);
    startTimeRef.current = null;
    
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (isRunning) {
      // Start the timer
      if (startTimeRef.current === null) {
        startTimeRef.current = performance.now();
      }
      
      // Use setInterval for consistent updates
      intervalRef.current = setInterval(updateTimer, updateInterval);
    } else {
      // Stop the timer but keep the elapsed time
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [isRunning, updateTimer, updateInterval]);

  return {
    elapsedTime,
    formattedTime: formatTime(elapsedTime),
    reset
  };
};