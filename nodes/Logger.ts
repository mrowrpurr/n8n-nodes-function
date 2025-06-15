/**
 * Simple logger utility for n8n function nodes
 *
 * Log Levels:
 * - INFO: Important events like function registration, calls, etc. (default: enabled)
 * - DEBUG: Detailed tracing and debugging information (default: disabled)
 */

// Configuration - change these to control logging
const LOG_INFO_ENABLED = true // Set to false to disable info logs
const LOG_DEBUG_ENABLED = true // Set to true to enable debug logs

export class Logger {
	private prefix: string

	constructor(prefix: string) {
		this.prefix = prefix
	}

	/**
	 * Log important information (function registration, calls, errors)
	 * Default: ENABLED
	 */
	info(...args: any[]): void {
		if (LOG_INFO_ENABLED) {
			console.log(`${this.prefix}:`, ...args)
		}
	}

	/**
	 * Log detailed debugging information (Redis operations, parameter processing, etc.)
	 * Default: DISABLED
	 */
	debug(...args: any[]): void {
		if (LOG_DEBUG_ENABLED) {
			console.log(`${this.prefix}:`, ...args)
		}
	}

	/**
	 * Log errors (always enabled regardless of log level)
	 */
	error(...args: any[]): void {
		console.error(`${this.prefix}:`, ...args)
	}

	/**
	 * Log warnings (always enabled regardless of log level)
	 */
	warn(...args: any[]): void {
		console.warn(`${this.prefix}:`, ...args)
	}

	/**
	 * General log method (maps to info level)
	 * This provides compatibility with existing logger.log() calls
	 */
	log(...args: any[]): void {
		this.info(...args)
	}
}

// Factory function to create loggers with consistent prefixes
export function createLogger(component: string): Logger {
	return new Logger(component)
}

// Pre-configured loggers for common components
export const functionRegistryLogger = createLogger("🎯 FunctionRegistry")
export const functionRegistryFactoryLogger = createLogger("🏭 FunctionRegistryFactory")
export const functionNodeLogger = createLogger("🌊 Function")
export const callFunctionLogger = createLogger("🔧 CallFunction")
export const returnFromFunctionLogger = createLogger("🌊 ReturnFromFunction")
