import { createClient, RedisClientType } from "redis"
import { isQueueModeEnabled, RedisConfig } from "./FunctionRegistryFactory"
import { functionRegistryLogger as logger } from "./Logger"
import { ConsumerStateManager, ConsumerState } from "./ConsumerStateManager"

export interface ConsumerConfig {
	functionName: string
	scope: string
	streamKey: string
	groupName: string
	processId: string
	workerId: string
}

export interface ProcessingResult {
	success: boolean
	messageId?: string
	error?: string
	processingTime: number
}

/**
 * Production-hardened consumer lifecycle management
 * Eliminates race conditions through Redis-based state coordination
 */
export class ConsumerLifecycleManager {
	private client: RedisClientType | null = null
	private stateManager: ConsumerStateManager
	private consumerId: string | null = null
	private isRunning: boolean = false
	private processingLoop: Promise<void> | null = null
	private readonly BLOCK_TIME = 5000 // 5 seconds
	private readonly RETRY_DELAY = 1000 // 1 second
	private readonly PROCESSING_TIMEOUT = 30000 // 30 seconds

	constructor(
		private config: ConsumerConfig,
		private redisConfig: RedisConfig,
		private messageHandler: (message: any) => Promise<any>
	) {
		this.stateManager = new ConsumerStateManager(redisConfig)
		this.consumerId = `${config.functionName}-${config.scope}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
	}

	/**
	 * Start the consumer with robust lifecycle management
	 */
	async start(): Promise<void> {
		if (this.isRunning) {
			logger.log("🔄 LIFECYCLE: Consumer already running:", this.consumerId)
			return
		}

		if (!isQueueModeEnabled()) {
			logger.log("🔄 LIFECYCLE: Queue mode disabled, skipping consumer start")
			return
		}

		try {
			logger.log("🔄 LIFECYCLE: Starting consumer:", this.consumerId)

			// Initialize Redis client
			await this.initializeClient()

			// Initialize state manager
			await this.stateManager.initialize()

			// Register consumer in state management
			await this.registerConsumer()

			// Start processing loop
			this.isRunning = true
			this.processingLoop = this.runProcessingLoop()

			// Start heartbeat
			this.stateManager.startHeartbeat(this.consumerId!)

			logger.log("🔄 LIFECYCLE: ✅ Consumer started successfully:", this.consumerId)
		} catch (error) {
			logger.error("🔄 LIFECYCLE: ❌ Failed to start consumer:", error)
			await this.cleanupResources()
			throw error
		}
	}

	/**
	 * Stop the consumer gracefully
	 */
	async stop(): Promise<void> {
		if (!this.isRunning) {
			logger.log("🔄 LIFECYCLE: Consumer not running:", this.consumerId)
			return
		}

		logger.log("🔄 LIFECYCLE: Stopping consumer:", this.consumerId)

		try {
			// Update state to stopping
			if (this.consumerId) {
				await this.stateManager.updateConsumerStatus(this.consumerId, "stopping")
			}

			// Stop processing loop
			this.isRunning = false

			// Wait for processing loop to finish
			if (this.processingLoop) {
				await this.processingLoop
			}

			// Cleanup
			await this.cleanupResources()

			logger.log("🔄 LIFECYCLE: ✅ Consumer stopped successfully:", this.consumerId)
		} catch (error) {
			logger.error("🔄 LIFECYCLE: ❌ Error stopping consumer:", error)
		}
	}

	/**
	 * Check if consumer is running
	 */
	isActive(): boolean {
		return this.isRunning
	}

	/**
	 * Get consumer ID
	 */
	getConsumerId(): string | null {
		return this.consumerId
	}

	/**
	 * Initialize Redis client
	 */
	private async initializeClient(): Promise<void> {
		const clientConfig = this.buildRedisClientConfig()
		this.client = createClient(clientConfig)
		await this.client.connect()
		logger.log("🔄 LIFECYCLE: ✅ Redis client connected")
	}

	/**
	 * Register consumer in state management
	 */
	private async registerConsumer(): Promise<void> {
		if (!this.consumerId) {
			throw new Error("Consumer ID not set")
		}

		const state: Omit<ConsumerState, "startTime" | "lastHeartbeat" | "errorCount"> = {
			id: this.consumerId,
			functionName: this.config.functionName,
			scope: this.config.scope,
			streamKey: this.config.streamKey,
			groupName: this.config.groupName,
			status: "starting",
			processId: this.config.processId,
			workerId: this.config.workerId,
		}

		await this.stateManager.registerConsumer(state)
		logger.log("🔄 LIFECYCLE: ✅ Consumer registered in state management")
	}

	/**
	 * Main processing loop with robust error handling
	 */
	private async runProcessingLoop(): Promise<void> {
		logger.log("🔄 LIFECYCLE: Starting processing loop:", this.consumerId)

		// Update status to active
		if (this.consumerId) {
			await this.stateManager.updateConsumerStatus(this.consumerId, "active")
		}

		while (this.isRunning) {
			try {
				await this.processStreamMessages()
			} catch (error) {
				logger.error("🔄 LIFECYCLE: ❌ Error in processing loop:", error)

				// Update error status
				if (this.consumerId) {
					await this.stateManager.updateConsumerStatus(this.consumerId, "error", String(error))
				}

				// Wait before retrying
				await this.sleepMs(this.RETRY_DELAY)

				// Check if we should continue
				if (this.consumerId) {
					const state = await this.stateManager.getConsumerState(this.consumerId)
					if (state && !this.stateManager.isConsumerHealthy(state)) {
						logger.log("🔄 LIFECYCLE: Consumer unhealthy, stopping:", this.consumerId)
						break
					}
				}
			}
		}

		logger.log("🔄 LIFECYCLE: Processing loop ended:", this.consumerId)
	}

	/**
	 * Process messages from Redis stream
	 */
	private async processStreamMessages(): Promise<void> {
		if (!this.client || !this.isRunning) {
			return
		}

		try {
			// Read messages from stream
			const result = await this.client.xReadGroup(
				this.config.groupName,
				this.consumerId!,
				[
					{
						key: this.config.streamKey,
						id: ">",
					},
				],
				{
					COUNT: 1,
					BLOCK: this.BLOCK_TIME,
				}
			)

			if (!result || result.length === 0) {
				// No messages, continue loop
				return
			}

			// Process each message
			for (const stream of result) {
				for (const message of stream.messages) {
					if (!this.isRunning) {
						logger.log("🔄 LIFECYCLE: Consumer stopping, skipping message processing")
						return
					}

					await this.processMessage(message.id, message.message)
				}
			}
		} catch (error) {
			// Only log error if we're still running (not a shutdown error)
			if (this.isRunning) {
				logger.error("🔄 LIFECYCLE: ❌ Error reading from stream:", error)
			}
			throw error
		}
	}

	/**
	 * Process a single message with timeout and error handling
	 */
	private async processMessage(messageId: string, messageData: any): Promise<void> {
		const startTime = Date.now()
		logger.log("🔄 LIFECYCLE: Processing message:", messageId)

		try {
			// Process message with timeout
			await Promise.race([this.messageHandler(messageData), this.createTimeoutPromise(this.PROCESSING_TIMEOUT)])

			// Acknowledge message
			if (this.client) {
				await this.client.xAck(this.config.streamKey, this.config.groupName, messageId)
			}

			const processingTime = Date.now() - startTime
			logger.log("🔄 LIFECYCLE: ✅ Message processed successfully:", messageId, "in", processingTime, "ms")
		} catch (error) {
			const processingTime = Date.now() - startTime
			logger.error("🔄 LIFECYCLE: ❌ Error processing message:", messageId, error, "in", processingTime, "ms")

			// Update error status
			if (this.consumerId) {
				await this.stateManager.updateConsumerStatus(this.consumerId, "error", String(error))
			}

			// For now, acknowledge failed messages to prevent infinite retries
			// In production, you might want to implement a dead letter queue
			if (this.client) {
				await this.client.xAck(this.config.streamKey, this.config.groupName, messageId)
			}

			throw error
		}
	}

	/**
	 * Create a timeout promise
	 */
	private createTimeoutPromise(timeout: number): Promise<never> {
		return new Promise((_, reject) => {
			setTimeout(() => {
				reject(new Error(`Processing timeout after ${timeout}ms`))
			}, timeout)
		})
	}

	/**
	 * Sleep for specified milliseconds
	 */
	private sleepMs(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms))
	}

	/**
	 * Cleanup resources
	 */
	private async cleanupResources(): Promise<void> {
		logger.log("🔄 LIFECYCLE: Cleaning up consumer:", this.consumerId)

		try {
			// Stop heartbeat
			this.stateManager.stopHeartbeat()

			// Unregister consumer
			if (this.consumerId) {
				await this.stateManager.unregisterConsumer(this.consumerId)
			}

			// Disconnect state manager
			await this.stateManager.disconnect()

			// Disconnect Redis client
			if (this.client) {
				await this.client.disconnect()
				this.client = null
			}

			logger.log("🔄 LIFECYCLE: ✅ Cleanup completed")
		} catch (error) {
			logger.error("🔄 LIFECYCLE: ❌ Error during cleanup:", error)
		}
	}

	/**
	 * Build Redis client configuration
	 */
	private buildRedisClientConfig(): any {
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
}
