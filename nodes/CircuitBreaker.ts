import { functionRegistryLogger as logger } from "./Logger"

export enum CircuitState {
	CLOSED = "CLOSED",
	OPEN = "OPEN",
	HALF_OPEN = "HALF_OPEN",
}

export interface CircuitBreakerConfig {
	failureThreshold: number
	recoveryTimeout: number
	monitoringPeriod: number
	halfOpenMaxCalls: number
}

export interface CircuitBreakerMetrics {
	totalCalls: number
	successfulCalls: number
	failedCalls: number
	consecutiveFailures: number
	lastFailureTime: number
	state: CircuitState
}

/**
 * Production-grade circuit breaker for Redis operations
 * Prevents cascading failures and provides automatic recovery
 */
export class CircuitBreaker {
	private state: CircuitState = CircuitState.CLOSED
	private failureCount: number = 0
	private consecutiveFailures: number = 0
	private lastFailureTime: number = 0
	private successCount: number = 0
	private totalCalls: number = 0
	private halfOpenCalls: number = 0
	private nextAttemptTime: number = 0

	private readonly config: CircuitBreakerConfig = {
		failureThreshold: 5,
		recoveryTimeout: 60000, // 1 minute
		monitoringPeriod: 300000, // 5 minutes
		halfOpenMaxCalls: 3,
	}

	constructor(config?: Partial<CircuitBreakerConfig>) {
		if (config) {
			this.config = { ...this.config, ...config }
		}
		logger.log("🔌 CIRCUIT: Circuit breaker initialized with config:", this.config)
	}

	/**
	 * Execute a function with circuit breaker protection
	 */
	async execute<T>(operation: () => Promise<T>, operationName: string = "operation"): Promise<T> {
		this.totalCalls++

		// Check if circuit is open
		if (this.state === CircuitState.OPEN) {
			if (Date.now() < this.nextAttemptTime) {
				const error = new Error(`Circuit breaker is OPEN for ${operationName}. Next attempt in ${Math.ceil((this.nextAttemptTime - Date.now()) / 1000)}s`)
				logger.log("🔌 CIRCUIT: ❌ Operation blocked:", operationName, error.message)
				throw error
			} else {
				// Transition to half-open
				this.transitionToHalfOpen()
			}
		}

		// Check if we're in half-open and have exceeded max calls
		if (this.state === CircuitState.HALF_OPEN && this.halfOpenCalls >= this.config.halfOpenMaxCalls) {
			const error = new Error(`Circuit breaker is HALF_OPEN and max calls exceeded for ${operationName}`)
			logger.log("🔌 CIRCUIT: ❌ Half-open max calls exceeded:", operationName)
			throw error
		}

		try {
			logger.log("🔌 CIRCUIT: Executing operation:", operationName, "State:", this.state)

			if (this.state === CircuitState.HALF_OPEN) {
				this.halfOpenCalls++
			}

			const result = await operation()

			// Operation succeeded
			this.onSuccess(operationName)
			return result
		} catch (error) {
			// Operation failed
			this.onFailure(operationName, error)
			throw error
		}
	}

	/**
	 * Handle successful operation
	 */
	private onSuccess(operationName: string): void {
		this.successCount++
		this.consecutiveFailures = 0

		if (this.state === CircuitState.HALF_OPEN) {
			// If we've had enough successful calls in half-open, close the circuit
			if (this.halfOpenCalls >= this.config.halfOpenMaxCalls) {
				this.transitionToClosed()
				logger.log("🔌 CIRCUIT: ✅ Operation succeeded, circuit CLOSED:", operationName)
			}
		}

		logger.log("🔌 CIRCUIT: ✅ Operation succeeded:", operationName, "State:", this.state)
	}

	/**
	 * Handle failed operation
	 */
	private onFailure(operationName: string, error: any): void {
		this.failureCount++
		this.consecutiveFailures++
		this.lastFailureTime = Date.now()

		logger.log("🔌 CIRCUIT: ❌ Operation failed:", operationName, "Error:", error.message, "Consecutive failures:", this.consecutiveFailures)

		// Check if we should open the circuit
		if (this.state === CircuitState.CLOSED && this.consecutiveFailures >= this.config.failureThreshold) {
			this.transitionToOpen()
			logger.log("🔌 CIRCUIT: ⚠️ Circuit OPENED due to failure threshold:", operationName)
		} else if (this.state === CircuitState.HALF_OPEN) {
			// Any failure in half-open state should open the circuit
			this.transitionToOpen()
			logger.log("🔌 CIRCUIT: ⚠️ Circuit OPENED due to half-open failure:", operationName)
		}
	}

	/**
	 * Transition to CLOSED state
	 */
	private transitionToClosed(): void {
		this.state = CircuitState.CLOSED
		this.consecutiveFailures = 0
		this.halfOpenCalls = 0
		logger.log("🔌 CIRCUIT: State transition -> CLOSED")
	}

	/**
	 * Transition to OPEN state
	 */
	private transitionToOpen(): void {
		this.state = CircuitState.OPEN
		this.nextAttemptTime = Date.now() + this.config.recoveryTimeout
		this.halfOpenCalls = 0
		logger.log("🔌 CIRCUIT: State transition -> OPEN, next attempt at:", new Date(this.nextAttemptTime).toISOString())
	}

	/**
	 * Transition to HALF_OPEN state
	 */
	private transitionToHalfOpen(): void {
		this.state = CircuitState.HALF_OPEN
		this.halfOpenCalls = 0
		logger.log("🔌 CIRCUIT: State transition -> HALF_OPEN")
	}

	/**
	 * Get current circuit breaker metrics
	 */
	getMetrics(): CircuitBreakerMetrics {
		return {
			totalCalls: this.totalCalls,
			successfulCalls: this.successCount,
			failedCalls: this.failureCount,
			consecutiveFailures: this.consecutiveFailures,
			lastFailureTime: this.lastFailureTime,
			state: this.state,
		}
	}

	/**
	 * Get current state
	 */
	getState(): CircuitState {
		return this.state
	}

	/**
	 * Check if circuit is healthy
	 */
	isHealthy(): boolean {
		return this.state === CircuitState.CLOSED || (this.state === CircuitState.HALF_OPEN && this.halfOpenCalls < this.config.halfOpenMaxCalls)
	}

	/**
	 * Force circuit to closed state (for testing/recovery)
	 */
	forceClose(): void {
		logger.log("🔌 CIRCUIT: Force closing circuit")
		this.transitionToClosed()
	}

	/**
	 * Force circuit to open state (for maintenance)
	 */
	forceOpen(): void {
		logger.log("🔌 CIRCUIT: Force opening circuit")
		this.transitionToOpen()
	}

	/**
	 * Reset all metrics
	 */
	reset(): void {
		logger.log("🔌 CIRCUIT: Resetting circuit breaker")
		this.state = CircuitState.CLOSED
		this.failureCount = 0
		this.consecutiveFailures = 0
		this.lastFailureTime = 0
		this.successCount = 0
		this.totalCalls = 0
		this.halfOpenCalls = 0
		this.nextAttemptTime = 0
	}
}
