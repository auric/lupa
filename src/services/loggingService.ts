import * as vscode from 'vscode';
import { WorkspaceSettingsService } from './workspaceSettingsService';
import { LogLevel, OutputTarget } from '../models/loggingTypes';

const LOG_LEVEL_VALUES: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3
};

/**
 * High-level logging functions for convenient usage throughout the codebase
 * These provide a clean replacement for console.log calls
 */
export class Log {
    static debug = (message: string, ...args: any[]): void =>
        LoggingService.getInstance().debug(message, ...args);

    static info = (message: string, ...args: any[]): void =>
        LoggingService.getInstance().info(message, ...args);

    static warn = (message: string, ...args: any[]): void =>
        LoggingService.getInstance().warn(message, ...args);

    static error = (messageOrError: string | Error, ...args: any[]): void =>
        LoggingService.getInstance().error(messageOrError, ...args);
}

/**
 * Centralized logging service for the Lupa extension
 */
export class LoggingService implements vscode.Disposable {
    private static _instance: LoggingService | null = null;
    private readonly outputChannel: vscode.LogOutputChannel;
    private logLevel: LogLevel;
    private outputTarget: OutputTarget;
    private settingsService: WorkspaceSettingsService | null = null;

    private constructor() {
        this.outputChannel = vscode.window.createOutputChannel('Lupa', { log: true });

        // Initialize with default values - will be updated when settings service is set
        this.logLevel = 'info';
        this.outputTarget = 'console';
    }

    /**
     * Get the singleton instance of the LoggingService
     */
    public static getInstance(): LoggingService {
        if (!LoggingService._instance) {
            LoggingService._instance = new LoggingService();
        }
        return LoggingService._instance;
    }

    /**
     * Initialize the logging service with the workspace settings service
     * This should be called after the settings service is available
     */
    public initialize(settingsService: WorkspaceSettingsService): void {
        this.settingsService = settingsService;
        this.refreshConfiguration();
    }

    /**
     * Refresh the log level and output target from settings
     */
    public refreshConfiguration(): void {
        if (!this.settingsService) {
            return;
        }

        this.logLevel = this.settingsService.getSetting('logLevel', 'info');
    }

    /**
     * Update the log level setting
     */
    public setLogLevel(level: LogLevel): void {
        this.logLevel = level;
        if (this.settingsService) {
            this.settingsService.setSetting('logLevel', level);
        }
    }

    /**
     * Update the output target setting
     */
    public setOutputTarget(target: OutputTarget): void {
        this.outputTarget = target;
        if (this.settingsService) {
            this.settingsService.setSetting('logOutputTarget', target);
        }
    }

    /**
     * Check if the given log level should be logged based on current configuration
     */
    private shouldLog(level: LogLevel): boolean {
        return LOG_LEVEL_VALUES[level] >= LOG_LEVEL_VALUES[this.logLevel];
    }

    /**
     * Format a log message with timestamp and level
     */
    private formatMessage(level: LogLevel, message: string, ...args: any[]): string {
        const now = new Date();
        const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}.${String(now.getMilliseconds()).padStart(3, '0')}`;

        const levelStr = level;
        let formattedMessage = `${timestamp} [${levelStr}] ${message}`;

        if (args.length > 0) {
            const argsStr = args.map(arg =>
                typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
            ).join(' ');
            formattedMessage += ` ${argsStr}`;
        }

        return formattedMessage;
    }

    /**
     * Internal logging method used by all public logging methods
     */
    private _log(level: LogLevel, message: string | Error, ...args: any[]): void {
        if (!this.shouldLog(level)) {
            return;
        }

        let logMessage: string;
        if (message instanceof Error) {
            logMessage = `${message.message}\nStack trace:\n${message.stack}`;
        } else {
            logMessage = message;
        }

        const formattedMessage = this.formatMessage(level, logMessage, ...args);

        const output = this.outputTarget === 'channel' ? this.outputChannel : console;
        if (this.outputTarget === 'channel') {
            // Use native VS Code log methods for colored output
            switch (level) {
                case 'debug':
                    output.debug(logMessage, ...args);
                    break;
                case 'info':
                    output.info(logMessage, ...args);
                    break;
                case 'warn':
                    output.warn(logMessage, ...args);
                    break;
                case 'error':
                    output.error(logMessage, ...args);
                    break;
            }
        } else {
            // Output to console based on log level
            switch (level) {
                case 'debug':
                case 'info':
                    console.log(formattedMessage);
                    break;
                case 'warn':
                    console.warn(formattedMessage);
                    break;
                case 'error':
                    console.error(formattedMessage);
                    break;
            }
        }
    }

    /**
     * Log a debug message
     */
    public debug(message: string, ...args: any[]): void {
        this._log('debug', message, ...args);
    }

    /**
     * Log an info message
     */
    public info(message: string, ...args: any[]): void {
        this._log('info', message, ...args);
    }

    /**
     * Log a warning message
     */
    public warn(message: string, ...args: any[]): void {
        this._log('warn', message, ...args);
    }

    /**
     * Log an error message
     */
    public error(messageOrError: string | Error, ...args: any[]): void {
        this._log('error', messageOrError, ...args);
    }

    /**
     * Show the output channel in VS Code
     */
    public show(): void {
        this.outputChannel.show();
    }

    /**
     * Dispose of the logging service resources
     */
    public dispose(): void {
        this.outputChannel.dispose();
        LoggingService._instance = null;
    }
}
