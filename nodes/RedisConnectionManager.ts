import { createClient } from "redis"
import { isQueueModeEnabled, RedisConfig } from "./FunctionRegistryFactory"
import { functionRegistryLogger as logger } from "./Logger"
import { CircuitBreaker, CircuitState } from "./CircuitBreaker"

export interface ConnectionMetrics {
	totalConnections: number
	activeConnections: number
	failedConnections: number
	reconnections: number
	lastConnectionTime: number
	lastFailureTime: number
}

/**
 * Production-hardened Redis connection management
 * Provides connection pooling, circuit breaker protection, and automatic recovery
 */
export class RedisConnectionManager {
	private static instance: RedisConnectionManager | null = null
	private clients: Map<string, any> = new Map()
	private circuitBreaker: CircuitBreaker
	private connectionMetrics: ConnectionMetrics = {
		totalConnections: 0,
		activeConnections: 0,
		failedConnections: 0,
		reconnections: 0,
		lastConnectionTime: 0,
		lastFailureTime: 0,
	}
	private isShuttingDown: boolean = false

	private constructor(private redisConfig: RedisConfig) {
		this.circuitBreaker = new CircuitBreaker({
			failureThreshold: 3,
			recoveryTimeout: 30000, // 30 seconds
			monitoringPeriod: 300000, // 5 minutes
			halfOpenMaxCalls: 2,
		})
		logger.log("🔗 REDIS: Connection manager initialized")
	}

	/**
	 * Get singleton instance
	 */
	static getInstance(redisConfig: RedisConfig): RedisConnectionManager {
		if (!RedisConnectionManager.instance) {
			RedisConnectionManager.instance = new RedisConnectionManager(redisConfig)
		}
		return RedisConnectionManager.instance
	}

	/**
	 * Get or create a Redis client with circuit breaker protection
	 */
	async getClient(clientId: string = "default"): Promise<any> {
		if (!isQueueModeEnabled()) {
			throw new Error("Queue mode is disabled")
		}

		if (this.isShuttingDown) {
			throw new Error("Connection manager is shutting down")
		}

		// Check if we already have a healthy client
		const existingClient = this.clients.get(clientId)
		if (existingClient && existingClient.isReady) {
			logger.log("🔗 REDIS: Reusing existing client:", clientId)
			return existingClient
		}

		// Create new client with circuit breaker protection
		return await this.circuitBreaker.execute(async () => {
			return await this.createClient(clientId)
		}, `create-client-${clientId}`)
	}

	/**
	 * Create a new Redis client
	 */
	private async createClient(clientId: string): Promise<any> {
		logger.log("🔗 REDIS: Creating new client:", clientId)

		try {
			// Remove any existing client
			await this.removeClient(clientId)

			// Create new client
			const clientConfig = this.buildClientConfig()
			const client = createClient(clientConfig)

			// Set up event handlers
			this.setupClientEventHandlers(client, clientId)

			// Connect
			await client.connect()

			// Store client
			this.clients.set(clientId, client)
			this.connectionMetrics.totalConnections++
			this.connectionMetrics.activeConnections++
			this.connectionMetrics.lastConnectionTime = Date.now()

			logger.log("🔗 REDIS: ✅ Client connected successfully:", clientId)
			return client
		} catch (error) {
			this.connectionMetrics.failedConnections++
			this.connectionMetrics.lastFailureTime = Date.now()
			logger.error("🔗 REDIS: ❌ Failed to create client:", clientId, error)
			throw error
		}
	}

	/**
	 * Set up event handlers for Redis client
	 */
	private setupClientEventHandlers(client: any, clientId: string): void {
		client.on("connect", () => {
			logger.log("🔗 REDIS: Client connecting:", clientId)
		})

		client.on("ready", () => {
			logger.log("🔗 REDIS: ✅ Client ready:", clientId)
		})

		client.on("error", (error: any) => {
			logger.error("🔗 REDIS: ❌ Client error:", clientId, error)
			this.handleClientError(clientId, error)
		})

		client.on("end", () => {
			logger.log("🔗 REDIS: Client disconnected:", clientId)
			this.handleClientDisconnect(clientId)
		})

		client.on("reconnecting", () => {
			logger.log("🔗 REDIS: Client reconnecting:", clientId)
			this.connectionMetrics.reconnections++
		})
	}

	/**
	 * Handle client error
	 */
	private handleClientError(clientId: string, error: any): void {
		logger.error("🔗 REDIS: Handling client error:", clientId, error)

		// Remove the failed client
		this.removeClient(clientId).catch((err) => {
			logger.error("🔗 REDIS: Error removing failed client:", err)
		})
	}

	/**
	 * Handle client disconnect
	 */
	private handleClientDisconnect(clientId: string): void {
		logger.log("🔗 REDIS: Handling client disconnect:", clientId)

		if (this.connectionMetrics.activeConnections > 0) {
			this.connectionMetrics.activeConnections--
		}
	}

	/**
	 * Remove a client
	 */
	private async removeClient(clientId: string): Promise<void> {
		const client = this.clients.get(clientId)
		if (client) {
			try {
				if (client.isReady) {
					await client.disconnect()
				}
			} catch (error) {
				logger.error("🔗 REDIS: Error disconnecting client:", clientId, error)
			} finally {
				this.clients.delete(clientId)
				if (this.connectionMetrics.activeConnections > 0) {
					this.connectionMetrics.activeConnections--
				}
			}
		}
	}

	/**
	 * Execute Redis operation with circuit breaker protection
	 */
	async executeOperation<T>(operation: (client: any) => Promise<T>, operationName: string, clientId: string = "default"): Promise<T> {
		return await this.circuitBreaker.execute(async () => {
			const client = await this.getClient(clientId)
			return await operation(client)
		}, operationName)
	}

	/**
	 * Check if connection manager is healthy
	 */
	isHealthy(): boolean {
		return this.circuitBreaker.isHealthy() && this.connectionMetrics.activeConnections > 0 && !this.isShuttingDown
	}

	/**
	 * Get connection metrics
	 */
	getMetrics(): ConnectionMetrics & { circuitBreakerState: CircuitState } {
		return {
			...this.connectionMetrics,
			circuitBreakerState: this.circuitBreaker.getState(),
		}
	}

	/**
	 * Get circuit breaker metrics
	 */
	getCircuitBreakerMetrics() {
		return this.circuitBreaker.getMetrics()
	}

	/**
	 * Health check - ping all clients
	 */
	async healthCheck(): Promise<{ healthy: boolean; details: any }> {
		const details: any = {
			circuitBreaker: this.circuitBreaker.getMetrics(),
			connections: this.connectionMetrics,
			clients: {},
		}

		let healthyClients = 0
		const totalClients = this.clients.size

		for (const [clientId, client] of this.clients) {
			try {
				if (client.isReady) {
					await client.ping()
					details.clients[clientId] = { status: "healthy", ready: true }
					healthyClients++
				} else {
					details.clients[clientId] = { status: "not_ready", ready: false }
				}
			} catch (error) {
				details.clients[clientId] = {
					status: "error",
					ready: false,
					error: error instanceof Error ? error.message : String(error),
				}
			}
		}

		const healthy = this.circuitBreaker.isHealthy() && (totalClients === 0 || healthyClients > 0) && !this.isShuttingDown

		return { healthy, details }
	}

	/**
	 * Graceful shutdown
	 */
	async shutdown(): Promise<void> {
		logger.log("🔗 REDIS: Starting graceful shutdown...")
		this.isShuttingDown = true

		const shutdownPromises: Promise<void>[] = []

		for (const [clientId] of this.clients) {
			shutdownPromises.push(
				this.removeClient(clientId).catch((error) => {
					logger.error("🔗 REDIS: Error shutting down client:", clientId, error)
				})
			)
		}

		await Promise.all(shutdownPromises)
		this.clients.clear()
		this.connectionMetrics.activeConnections = 0

		logger.log("🔗 REDIS: ✅ Graceful shutdown completed")
	}

	/**
	 * Force reset (for recovery scenarios)
	 */
	async forceReset(): Promise<void> {
		logger.log("🔗 REDIS: Force resetting connection manager...")

		await this.shutdown()
		this.circuitBreaker.reset()
		this.isShuttingDown = false

		// Reset metrics
		this.connectionMetrics = {
			totalConnections: 0,
			activeConnections: 0,
			failedConnections: 0,
			reconnections: 0,
			lastConnectionTime: 0,
			lastFailureTime: 0,
		}

		logger.log("🔗 REDIS: ✅ Force reset completed")
	}

	/**
	 * Build Redis client configuration
	 */
	private buildClientConfig(): any {
		const socketConfig: any = {
			host: this.redisConfig.host,
			port: this.redisConfig.port,
			reconnectStrategy: (retries: number) => {
				const delay = Math.min(retries * 100, 3000) // Max 3 seconds
				logger.log("🔗 REDIS: Reconnect attempt:", retries, "delay:", delay)
				return delay
			},
			connectTimeout: 10000, // 10 seconds
		}

		if (this.redisConfig.ssl === true) {
			socketConfig.tls = true
		}

		return {
			socket: socketConfig,
			database: this.redisConfig.database,
			username: this.redisConfig.user || undefined,
			password: this.redisConfig.password || undefined,
		}
	}
}
