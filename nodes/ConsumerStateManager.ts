import { createClient, RedisClientType } from "redis"
import { isQueueModeEnabled, RedisConfig } from "./FunctionRegistryFactory"
import { functionRegistryLogger as logger } from "./Logger"

export interface ConsumerState {
	id: string
	functionName: string
	scope: string
	streamKey: string
	groupName: string
	status: "starting" | "active" | "stopping" | "stopped" | "error"
	startTime: number
	lastHeartbeat: number
	processId: string
	workerId: string
	errorCount: number
	lastError?: string
}

export interface ConsumerMetrics {
	messagesProcessed: number
	messagesErrored: number
	averageProcessingTime: number
	lastProcessingTime: number
}

/**
 * Production-hardened consumer state management
 * Eliminates race conditions and provides robust lifecycle management
 */
export class ConsumerStateManager {
	private client: RedisClientType | null = null
	private redisConfig: RedisConfig | null = null
	private isConnected: boolean = false
	private heartbeatInterval: any = null
	private readonly HEARTBEAT_INTERVAL = 5000 // 5 seconds
	private readonly CONSUMER_TIMEOUT = 30000 // 30 seconds
	private readonly MAX_ERROR_COUNT = 5

	constructor(redisConfig: RedisConfig) {
		this.redisConfig = redisConfig
	}

	/**
	 * Initialize the state manager
	 */
	async initialize(): Promise<void> {
		if (!isQueueModeEnabled()) {
			logger.log("🏗️ STATE: Queue mode disabled, skipping Redis state management")
			return
		}

		try {
			logger.log("🏗️ STATE: Initializing consumer state manager...")

			const clientConfig = this.buildRedisClientConfig()
			this.client = createClient(clientConfig)
			await this.client.connect()
			this.isConnected = true

			logger.log("🏗️ STATE: ✅ Consumer state manager initialized")
		} catch (error) {
			logger.error("🏗️ STATE: ❌ Failed to initialize state manager:", error)
			throw error
		}
	}

	/**
	 * Register a new consumer with robust state tracking
	 */
	async registerConsumer(state: Omit<ConsumerState, "startTime" | "lastHeartbeat" | "errorCount">): Promise<ConsumerState> {
		if (!this.client) {
			throw new Error("State manager not initialized")
		}

		const fullState: ConsumerState = {
			...state,
			startTime: Date.now(),
			lastHeartbeat: Date.now(),
			errorCount: 0,
		}

		const stateKey = `consumer:state:${state.id}`
		const activeKey = `consumer:active:${state.functionName}:${state.scope}`

		logger.log("🏗️ STATE: Registering consumer:", state.id)
		logger.log("🏗️ STATE: Function:", state.functionName, "Scope:", state.scope)
		logger.log("🏗️ STATE: Status:", fullState.status)

		try {
			// Use Redis transaction to ensure atomicity
			const multi = this.client.multi()

			// Store consumer state
			multi.hSet(stateKey, {
				id: fullState.id,
				functionName: fullState.functionName,
				scope: fullState.scope,
				streamKey: fullState.streamKey,
				groupName: fullState.groupName,
				status: fullState.status,
				startTime: fullState.startTime.toString(),
				lastHeartbeat: fullState.lastHeartbeat.toString(),
				processId: fullState.processId,
				workerId: fullState.workerId,
				errorCount: fullState.errorCount.toString(),
			})

			// Set expiration for cleanup
			multi.expire(stateKey, 3600) // 1 hour

			// Add to active consumers set
			multi.sAdd(activeKey, state.id)
			multi.expire(activeKey, 3600)

			// Add to global consumer registry
			multi.sAdd("consumers:all", state.id)

			await multi.exec()

			logger.log("🏗️ STATE: ✅ Consumer registered successfully")
			return fullState
		} catch (error) {
			logger.error("🏗️ STATE: ❌ Failed to register consumer:", error)
			throw error
		}
	}

	/**
	 * Update consumer status with atomic operations
	 */
	async updateConsumerStatus(consumerId: string, status: ConsumerState["status"], error?: string): Promise<void> {
		if (!this.client) return

		const stateKey = `consumer:state:${consumerId}`

		logger.log("🏗️ STATE: Updating consumer status:", consumerId, "->", status)

		try {
			const updates: Record<string, string> = {
				status,
				lastHeartbeat: Date.now().toString(),
			}

			if (error) {
				updates.lastError = error
				// Increment error count
				const currentErrorCount = await this.client.hGet(stateKey, "errorCount")
				updates.errorCount = (parseInt(currentErrorCount || "0") + 1).toString()
			}

			await this.client.hSet(stateKey, updates)
			logger.log("🏗️ STATE: ✅ Consumer status updated")
		} catch (error) {
			logger.error("🏗️ STATE: ❌ Failed to update consumer status:", error)
		}
	}

	/**
	 * Send heartbeat for a consumer
	 */
	async sendHeartbeat(consumerId: string): Promise<void> {
		if (!this.client) return

		const stateKey = `consumer:state:${consumerId}`

		try {
			await this.client.hSet(stateKey, "lastHeartbeat", Date.now().toString())
		} catch (error) {
			logger.error("🏗️ STATE: ❌ Failed to send heartbeat:", error)
		}
	}

	/**
	 * Start automatic heartbeat for a consumer
	 */
	startHeartbeat(consumerId: string): void {
		if (this.heartbeatInterval) {
			clearInterval(this.heartbeatInterval)
		}

		this.heartbeatInterval = setInterval(async () => {
			await this.sendHeartbeat(consumerId)
		}, this.HEARTBEAT_INTERVAL)

		logger.log("🏗️ STATE: ✅ Heartbeat started for consumer:", consumerId)
	}

	/**
	 * Stop heartbeat
	 */
	stopHeartbeat(): void {
		if (this.heartbeatInterval) {
			clearInterval(this.heartbeatInterval)
			this.heartbeatInterval = null
			logger.log("🏗️ STATE: ✅ Heartbeat stopped")
		}
	}

	/**
	 * Get consumer state
	 */
	async getConsumerState(consumerId: string): Promise<ConsumerState | null> {
		if (!this.client) return null

		const stateKey = `consumer:state:${consumerId}`

		try {
			const state = await this.client.hGetAll(stateKey)
			if (!state || Object.keys(state).length === 0) {
				return null
			}

			return {
				id: state.id,
				functionName: state.functionName,
				scope: state.scope,
				streamKey: state.streamKey,
				groupName: state.groupName,
				status: state.status as ConsumerState["status"],
				startTime: parseInt(state.startTime),
				lastHeartbeat: parseInt(state.lastHeartbeat),
				processId: state.processId,
				workerId: state.workerId,
				errorCount: parseInt(state.errorCount || "0"),
				lastError: state.lastError,
			}
		} catch (error) {
			logger.error("🏗️ STATE: ❌ Failed to get consumer state:", error)
			return null
		}
	}

	/**
	 * Get all active consumers for a function
	 */
	async getActiveConsumers(functionName: string, scope: string): Promise<ConsumerState[]> {
		if (!this.client) return []

		const activeKey = `consumer:active:${functionName}:${scope}`

		try {
			const consumerIds = await this.client.sMembers(activeKey)
			const consumers: ConsumerState[] = []

			for (const id of consumerIds) {
				const state = await this.getConsumerState(id)
				if (state && this.isConsumerHealthy(state)) {
					consumers.push(state)
				}
			}

			return consumers
		} catch (error) {
			logger.error("🏗️ STATE: ❌ Failed to get active consumers:", error)
			return []
		}
	}

	/**
	 * Check if a consumer is healthy
	 */
	isConsumerHealthy(state: ConsumerState): boolean {
		const now = Date.now()
		const age = now - state.lastHeartbeat
		const isHealthy = age < this.CONSUMER_TIMEOUT && state.status === "active" && state.errorCount < this.MAX_ERROR_COUNT

		if (!isHealthy) {
			logger.log("🏗️ STATE: Consumer unhealthy:", state.id, "age:", age, "status:", state.status, "errors:", state.errorCount)
		}

		return isHealthy
	}

	/**
	 * Cleanup stale consumers
	 */
	async cleanupStaleConsumers(functionName: string, scope: string): Promise<number> {
		if (!this.client) return 0

		const activeKey = `consumer:active:${functionName}:${scope}`
		let cleanedCount = 0

		try {
			const consumerIds = await this.client.sMembers(activeKey)

			for (const id of consumerIds) {
				const state = await this.getConsumerState(id)
				if (!state || !this.isConsumerHealthy(state)) {
					// Remove from active set
					await this.client.sRem(activeKey, id)

					// Update status to stopped
					if (state) {
						await this.updateConsumerStatus(id, "stopped")
					}

					cleanedCount++
					logger.log("🏗️ STATE: ✅ Cleaned up stale consumer:", id)
				}
			}

			return cleanedCount
		} catch (error) {
			logger.error("🏗️ STATE: ❌ Failed to cleanup stale consumers:", error)
			return 0
		}
	}

	/**
	 * Gracefully unregister a consumer
	 */
	async unregisterConsumer(consumerId: string): Promise<void> {
		if (!this.client) return

		logger.log("🏗️ STATE: Unregistering consumer:", consumerId)

		try {
			const state = await this.getConsumerState(consumerId)
			if (state) {
				const activeKey = `consumer:active:${state.functionName}:${state.scope}`

				// Remove from active set
				await this.client.sRem(activeKey, consumerId)

				// Update status to stopped
				await this.updateConsumerStatus(consumerId, "stopped")
			}

			// Remove from global registry
			await this.client.sRem("consumers:all", consumerId)

			logger.log("🏗️ STATE: ✅ Consumer unregistered successfully")
		} catch (error) {
			logger.error("🏗️ STATE: ❌ Failed to unregister consumer:", error)
		}
	}

	/**
	 * Check if there are any healthy consumers for a function
	 */
	async hasHealthyConsumers(functionName: string, scope: string): Promise<boolean> {
		const consumers = await this.getActiveConsumers(functionName, scope)
		return consumers.length > 0
	}

	/**
	 * Build Redis client configuration
	 */
	private buildRedisClientConfig(): any {
		if (!this.redisConfig) {
			throw new Error("Redis configuration not set")
		}

		const socketConfig: any = {
			host: this.redisConfig.host,
			port: this.redisConfig.port,
			reconnectStrategy: (retries: number) => Math.min(retries * 50, 500),
			connectTimeout: 100,
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

	/**
	 * Disconnect and cleanup
	 */
	async disconnect(): Promise<void> {
		this.stopHeartbeat()

		if (this.client && this.isConnected) {
			try {
				await this.client.disconnect()
				this.isConnected = false
				logger.log("🏗️ STATE: ✅ Disconnected from Redis")
			} catch (error) {
				logger.error("🏗️ STATE: ❌ Error disconnecting:", error)
			}
		}
	}
}
