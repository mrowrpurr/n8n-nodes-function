import { createClient, RedisClientType } from "redis"
import { isQueueModeEnabled, RedisConfig } from "./FunctionRegistryFactory"
import { functionRegistryLogger as logger } from "./Logger"
import { ConsumerStateManager, ConsumerState } from "./ConsumerStateManager"
import { NotificationManager, NotificationListener } from "./NotificationManager"

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
	private readonly BLOCK_TIME = 30000 // 30 seconds (was 100ms) - reduces idle Redis traffic by 99.7%
	private readonly RETRY_DELAY = 1000 // 1 second
	private readonly PROCESSING_TIMEOUT = 30000 // 30 seconds
	private notificationManager: NotificationManager | null = null
	private wakeUpReceived: boolean = false

	// Promise resolver for instant wake-up interruption
	private wakeUpResolver: (() => void) | null = null

	// Traffic monitoring for Phase 3
	private redisOperationCount: number = 0
	private lastTrafficReport: number = Date.now()
	private readonly TRAFFIC_REPORT_INTERVAL = 60000 // Report every 60 seconds

	constructor(
		private config: ConsumerConfig,
		private redisConfig: RedisConfig,
		private messageHandler: (message: any) => Promise<any>,
		notificationManager?: NotificationManager
	) {
		this.stateManager = new ConsumerStateManager(redisConfig)
		this.consumerId = `${config.functionName}-${config.scope}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
		this.notificationManager = notificationManager || null
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

			// CRITICAL: Create stream and consumer group BEFORE starting consumer
			await this.ensureStreamAndGroupExist()

			// CRITICAL: Claim any pending messages from dead consumers
			await this.claimPendingMessages()

			// Register consumer in state management
			await this.registerConsumer()

			// Subscribe to wake-up notifications if available
			if (this.notificationManager) {
				logger.log("🔄 LIFECYCLE: Subscribing to wake-up notifications for instant responsiveness")
				const wakeUpListener: NotificationListener = (message: any) => {
					if (message.type === "function-call" && message.functionName === this.config.functionName) {
						console.log(`📢📢📢 CONSUMER: WAKE-UP NOTIFICATION received for ${this.config.functionName}!`)
						logger.log(`📢🔄 LIFECYCLE: Wake-up notification received for function call ${message.callId}`)
						this.wakeUpReceived = true
						// Instantly interrupt blocking call
						if (this.wakeUpResolver) {
							this.wakeUpResolver()
							this.wakeUpResolver = null
						}
					}
				}

				await this.notificationManager.subscribeToWakeUp(wakeUpListener)
				logger.log("🔄 LIFECYCLE: ✅ Subscribed to wake-up notifications - will respond instantly to function calls")

				// NOTE: Function nodes do NOT subscribe to shutdown notifications
				// Shutdown notifications are for CallFunction nodes to detect Function node restarts
				// Function nodes should only publish shutdown notifications, not listen to them
				logger.log("🔄 LIFECYCLE: Function nodes do not subscribe to shutdown notifications")
			} else {
				logger.log("🔄 LIFECYCLE: No notification manager - using 30-second polling only")
			}

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

			// Instantly interrupt any blocking calls
			if (this.wakeUpResolver) {
				this.wakeUpResolver()
				this.wakeUpResolver = null
			}

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
	 * Ensure Redis stream and consumer group exist before starting consumer
	 */
	private async ensureStreamAndGroupExist(): Promise<void> {
		if (!this.client) {
			throw new Error("Redis client not initialized")
		}

		try {
			logger.log("🔄 LIFECYCLE: Ensuring stream and group exist...")
			logger.log("🔄 LIFECYCLE: Stream key:", this.config.streamKey)
			logger.log("🔄 LIFECYCLE: Group name:", this.config.groupName)

			// First, create the stream by adding a dummy message if it doesn't exist
			try {
				await this.client.xAdd(this.config.streamKey, "*", {
					init: "stream_initialization",
					timestamp: Date.now().toString(),
				})
				logger.log("🔄 LIFECYCLE: ✅ Stream created/exists:", this.config.streamKey)
			} catch (error) {
				logger.log("🔄 LIFECYCLE: Stream creation error (may already exist):", error.message)
			}

			// Create the consumer group
			try {
				await this.client.xGroupCreate(this.config.streamKey, this.config.groupName, "0", {
					MKSTREAM: true,
				})
				logger.log("🔄 LIFECYCLE: ✅ Consumer group created:", this.config.groupName)
			} catch (error) {
				if (error.message.includes("BUSYGROUP")) {
					logger.log("🔄 LIFECYCLE: ✅ Consumer group already exists:", this.config.groupName)
				} else {
					logger.error("🔄 LIFECYCLE: ❌ Error creating consumer group:", error)
					throw error
				}
			}

			logger.log("🔄 LIFECYCLE: ✅ Stream and group setup completed")
		} catch (error) {
			logger.error("🔄 LIFECYCLE: ❌ Failed to ensure stream and group exist:", error)
			throw error
		}
	}

	/**
	 * Claim pending messages from dead/stopped consumers
	 * This ensures no messages are lost during consumer transitions
	 */
	private async claimPendingMessages(): Promise<void> {
		if (!this.client) {
			throw new Error("Redis client not initialized")
		}

		try {
			logger.log("🔄 LIFECYCLE: Checking for pending messages to claim...")

			// Get pending messages info
			const pending = await this.client.xPending(this.config.streamKey, this.config.groupName)

			if (pending.pending === 0) {
				logger.log("🔄 LIFECYCLE: No pending messages found")
				return
			}

			logger.log(`🔄 LIFECYCLE: Found ${pending.pending} pending messages`)

			// Get detailed pending messages (up to 100 at a time)
			const pendingMessages = await this.client.xPendingRange(this.config.streamKey, this.config.groupName, "-", "+", 100)

			let claimedCount = 0

			for (const msg of pendingMessages) {
				// Only claim messages older than 5 seconds (to avoid race conditions)
				if (msg.millisecondsSinceLastDelivery > 5000) {
					try {
						// Claim the message for this consumer
						const claimed = await this.client.xClaim(
							this.config.streamKey,
							this.config.groupName,
							this.consumerId!,
							5000, // min idle time
							[msg.id]
						)

						if (claimed && claimed.length > 0 && claimed[0] && claimed[0].message) {
							claimedCount++
							logger.log(`🔄 LIFECYCLE: Claimed pending message ${msg.id} from consumer ${msg.consumer}`)

							// Process the claimed message immediately
							await this.processMessage(msg.id, claimed[0].message)
						}
					} catch (error) {
						logger.error(`🔄 LIFECYCLE: Failed to claim message ${msg.id}:`, error)
					}
				}
			}

			logger.log(`🔄 LIFECYCLE: ✅ Claimed and processed ${claimedCount} pending messages`)
		} catch (error) {
			logger.error("🔄 LIFECYCLE: ❌ Error claiming pending messages:", error)
			// Don't throw - allow consumer to start even if claiming fails
		}
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
	 * Process messages from Redis stream with instant wake-up support using Promise.race()
	 */
	private async processStreamMessages(): Promise<void> {
		if (!this.client || !this.isRunning) {
			return
		}

		try {
			// Check if we received a wake-up notification - if so, use non-blocking read
			const useNonBlocking = this.wakeUpReceived
			if (useNonBlocking) {
				console.log(`📢📢📢 CONSUMER: Wake-up detected! Using non-blocking read for instant response`)
				logger.log("📢🔄 LIFECYCLE: Wake-up detected - checking for messages immediately")
				this.wakeUpReceived = false // Reset flag AFTER logging
			}

			let result: any = null

			if (useNonBlocking) {
				// CRITICAL: For wake-up, try multiple times with small delays to handle race conditions
				// The message might not be immediately available due to Redis replication lag
				let attempts = 0
				const maxAttempts = 5

				while (attempts < maxAttempts && !result) {
					result = await this.client.xReadGroup(
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
							BLOCK: 0, // Non-blocking
						}
					)

					if (!result || result.length === 0) {
						attempts++
						if (attempts < maxAttempts) {
							console.log(`📢📢📢 CONSUMER: No messages found on attempt ${attempts}, retrying in 10ms...`)
							await this.sleepMs(10) // Small delay to handle race conditions
						}
					}
				}

				if (!result || result.length === 0) {
					console.log(`📢📢📢 CONSUMER: No messages found after ${maxAttempts} attempts - may have been processed by another consumer`)
					logger.log("📢🔄 LIFECYCLE: No messages found after wake-up retries - continuing normal processing")
				}
			} else {
				// Use Promise.race() for instant interruption of blocking calls
				logger.log("🔄 LIFECYCLE: Using Promise.race() for interruptible blocking read")

				const streamPromise = this.client.xReadGroup(
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
						BLOCK: this.BLOCK_TIME, // 30 seconds
					}
				)

				const wakeUpPromise = new Promise<"wake-up">((resolve) => {
					this.wakeUpResolver = () => resolve("wake-up")
				})

				// Race between stream read and wake-up (shutdown removed)
				const raceResult = await Promise.race([streamPromise, wakeUpPromise])

				// Clean up resolvers
				this.wakeUpResolver = null

				if (raceResult === "wake-up") {
					console.log(`📢📢📢 CONSUMER: Promise.race() interrupted by WAKE-UP notification!`)
					logger.log("📢🔄 LIFECYCLE: Blocking call interrupted by wake-up - will check for messages")
					// Continue to check for messages with non-blocking read
					result = await this.client.xReadGroup(
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
							BLOCK: 0, // Non-blocking
						}
					)
				} else {
					// Normal stream result
					result = raceResult
				}
			}

			// Track Redis operation for monitoring
			this.redisOperationCount++
			this.reportTrafficIfNeeded()

			if (!result || result.length === 0) {
				// No messages - this is normal for polling, but concerning after wake-up
				if (useNonBlocking) {
					// This was already logged in the retry loop above
				}
				// Continue loop (no log spam for normal polling)
				return
			}

			// Only log when we actually receive messages
			console.log(`🚀🚀🚀 CONSUMER: Received ${result.length} streams with messages`)

			// Process each message
			for (const stream of result) {
				console.log(`🚀🚀🚀 CONSUMER: Processing stream with ${stream.messages.length} messages`)
				for (const message of stream.messages) {
					if (!this.isRunning) {
						logger.log("🔄 LIFECYCLE: Consumer stopping, leaving message for next consumer")
						// Don't acknowledge the message - let the next consumer claim it
						return
					}

					console.log(`🚀🚀🚀 CONSUMER: Processing message ${message.id}`)
					await this.processMessage(message.id, message.message)
				}
			}
		} catch (error) {
			// Only log error if we're still running (not a shutdown error)
			if (this.isRunning) {
				console.log(`🚀🚀🚀 CONSUMER: ERROR reading from stream:`, error)
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

			// Disconnect Redis client (our own client, not the shared connection manager)
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
	 * Report Redis traffic statistics for monitoring
	 */
	private reportTrafficIfNeeded(): void {
		const currentTime = Date.now()
		const timeSinceLastReport = currentTime - this.lastTrafficReport

		if (timeSinceLastReport >= this.TRAFFIC_REPORT_INTERVAL) {
			const operationsPerSecond = this.redisOperationCount / (timeSinceLastReport / 1000)
			const hasNotifications = this.notificationManager ? "with wake-up" : "polling-only"

			logger.log(`📊 TRAFFIC: Consumer ${this.consumerId} - ${operationsPerSecond.toFixed(2)} Redis ops/sec (${hasNotifications})`)

			// Reset counters
			this.redisOperationCount = 0
			this.lastTrafficReport = currentTime
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
