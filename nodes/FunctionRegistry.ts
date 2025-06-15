import { createClient, RedisClientType } from "redis"
import { INodeExecutionData } from "n8n-workflow"
import { isQueueModeEnabled } from "./FunctionRegistryFactory"

export interface ParameterDefinition {
	name: string
	type: string
	required: boolean
	defaultValue: string
	description: string
}

interface FunctionListener {
	functionName: string
	executionId: string
	nodeId: string
	parameters: ParameterDefinition[]
	callback: (parameters: Record<string, any>, inputItem: INodeExecutionData) => Promise<INodeExecutionData[]>
}

interface FunctionMetadata {
	functionName: string
	executionId: string
	nodeId: string
	parameters: ParameterDefinition[]
	workerId: string
}

// Generate unique worker ID for this process
const WORKER_ID = `worker-${Date.now()}-${Math.random().toString(36).slice(2)}`

class FunctionRegistry {
	private static instance: FunctionRegistry
	private client: RedisClientType | null = null
	private subscriber: RedisClientType | null = null
	private publisher: RedisClientType | null = null
	private listeners: Map<string, FunctionListener> = new Map()
	private currentFunctionExecutionStack: string[] = []
	private nextCallId: number = 1
	private callContextStack: string[] = []
	private returnPromises: Map<string, { resolve: (value: any) => void; reject: (error: any) => void }> = new Map()
	private redisHost: string = "redis"
	private redisPort: number = 6379
	private isConnected: boolean = false
	private isSubscriberSetup: boolean = false

	// Stream-related properties
	private streamConsumers: Map<string, boolean> = new Map() // Track active stream consumers
	private heartbeatIntervals: Map<string, any> = new Map() // Track heartbeat timers

	static getInstance(): FunctionRegistry {
		if (!FunctionRegistry.instance) {
			FunctionRegistry.instance = new FunctionRegistry()
		}
		return FunctionRegistry.instance
	}

	/**
	 * Set Redis configuration (public method for ConfigureFunctions node)
	 */
	setRedisConfig(host: string, port: number = 6379): void {
		console.log(`🔴 FunctionRegistry[${WORKER_ID}]: Setting Redis config - host: ${host}, port: ${port}`)
		this.redisHost = host
		this.redisPort = port
		// Reset connection state to force reconnection with new config
		this.isConnected = false
		this.isSubscriberSetup = false
	}

	/**
	 * Test Redis connection (public method for ConfigureFunctions node)
	 */
	async testRedisConnection(): Promise<void> {
		await this.ensureRedisConnection()
	}

	private async ensureRedisConnection(): Promise<void> {
		// Skip Redis connection entirely if queue mode is not enabled
		if (!isQueueModeEnabled()) {
			console.log(`🔴 FunctionRegistry[${WORKER_ID}]: Queue mode disabled, skipping Redis connection`)
			return
		}

		if (this.client && this.isConnected) {
			return
		}

		try {
			console.log(`🔴 FunctionRegistry[${WORKER_ID}]: Connecting to Redis at redis://${this.redisHost}:${this.redisPort}`)

			// Main client for metadata storage
			this.client = createClient({
				url: `redis://${this.redisHost}:${this.redisPort}`,
				socket: {
					reconnectStrategy: (retries: number) => Math.min(retries * 50, 500),
					connectTimeout: 100, // 100ms connect timeout
					commandTimeout: 100, // 100ms command timeout
				},
			})

			// Dedicated publisher for sending messages
			this.publisher = createClient({
				url: `redis://${this.redisHost}:${this.redisPort}`,
				socket: {
					reconnectStrategy: (retries: number) => Math.min(retries * 50, 500),
					connectTimeout: 100,
					commandTimeout: 100,
				},
			})

			// Dedicated subscriber for receiving function calls
			this.subscriber = createClient({
				url: `redis://${this.redisHost}:${this.redisPort}`,
				socket: {
					reconnectStrategy: (retries: number) => Math.min(retries * 50, 500),
					connectTimeout: 100,
					commandTimeout: 100,
				},
			})

			await this.client.connect()
			await this.publisher.connect()
			await this.subscriber.connect()

			this.isConnected = true
			console.log(`🔴 FunctionRegistry[${WORKER_ID}]: Successfully connected to Redis`)

			// Set up function call listener
			await this.setupFunctionCallListener()
		} catch (error) {
			console.error(`🔴 FunctionRegistry[${WORKER_ID}]: Failed to connect to Redis:`, error)
			this.isConnected = false
			throw error
		}
	}

	private async setupFunctionCallListener(): Promise<void> {
		if (this.isSubscriberSetup || !this.subscriber) {
			return
		}

		try {
			// Subscribe to function calls targeted at this worker
			const callPattern = `function:call:${WORKER_ID}:*`
			console.log(`🔔 FunctionRegistry[${WORKER_ID}]: Setting up listener for ${callPattern}`)

			await this.subscriber.pSubscribe(callPattern, async (message, channel) => {
				console.log(`🔔 FunctionRegistry[${WORKER_ID}]: Received function call on ${channel}:`, message)

				try {
					const parsedMessage = JSON.parse(message)
					const { callId, functionName, parameters, inputItem, responseChannel } = parsedMessage

					// Find the function in our local listeners
					const functionKey = Object.keys(this.listeners).find((key) => this.listeners.get(key)?.functionName === functionName)

					if (!functionKey) {
						console.warn(`🔔 FunctionRegistry[${WORKER_ID}]: No local function found for ${functionName}`)
						return
					}

					const listener = this.listeners.get(functionKey)!
					console.log(`🔔 FunctionRegistry[${WORKER_ID}]: Executing function ${functionName}`)

					// Execute the function
					const result = await listener.callback(parameters, inputItem)

					// Send result back
					const response = { callId, result, success: true }
					await this.publisher!.publish(responseChannel, JSON.stringify(response))
					console.log(`🔔 FunctionRegistry[${WORKER_ID}]: Published result to ${responseChannel}`)
				} catch (error) {
					console.error(`🔔 FunctionRegistry[${WORKER_ID}]: Error handling function call:`, error)

					// Send error response if we can parse the message
					try {
						const { callId, responseChannel } = JSON.parse(message)
						const errorResponse = { callId, error: error.message, success: false }
						await this.publisher!.publish(responseChannel, JSON.stringify(errorResponse))
					} catch (parseError) {
						console.error(`🔔 FunctionRegistry[${WORKER_ID}]: Could not send error response:`, parseError)
					}
				}
			})

			this.isSubscriberSetup = true
			console.log(`🔔 FunctionRegistry[${WORKER_ID}]: Function call listener setup complete`)
		} catch (error) {
			console.error(`🔔 FunctionRegistry[${WORKER_ID}]: Failed to setup function call listener:`, error)
		}
	}
	// ===== REDIS STREAMS METHODS =====

	/**
	 * Create a function stream and consumer group
	 */
	async createStream(functionName: string, scope: string): Promise<string> {
		await this.ensureRedisConnection()
		if (!this.client) throw new Error("Redis client not available")

		const streamKey = `function:stream:${scope}:${functionName}`
		const groupName = `group:${functionName}`

		try {
			// Create consumer group (MKSTREAM creates the stream if it doesn't exist)
			await this.client.xGroupCreate(streamKey, groupName, "$", { MKSTREAM: true })
			console.log(`🌊 FunctionRegistry[${WORKER_ID}]: Created stream and group: ${streamKey} -> ${groupName}`)
		} catch (error: any) {
			// Ignore "BUSYGROUP" error if group already exists
			if (!error.message?.includes("BUSYGROUP")) {
				throw error
			}
			console.log(`🌊 FunctionRegistry[${WORKER_ID}]: Stream group already exists: ${streamKey} -> ${groupName}`)
		}

		return streamKey
	}

	/**
	 * Add a function call to the stream
	 */
	async addCall(streamKey: string, callId: string, functionName: string, parameters: any, inputItem: INodeExecutionData, responseChannel: string, timeout: number): Promise<void> {
		await this.ensureRedisConnection()
		if (!this.client) throw new Error("Redis client not available")

		const messageId = await this.client.xAdd(streamKey, "*", {
			callId,
			functionName,
			params: JSON.stringify(parameters),
			inputItem: JSON.stringify(inputItem),
			responseChannel,
			timeout: timeout.toString(),
			timestamp: Date.now().toString(),
		})

		console.log(`🌊 FunctionRegistry[${WORKER_ID}]: Added call to stream ${streamKey}: ${messageId}`)
	}

	/**
	 * Read function calls from stream (blocking)
	 */
	async readCalls(streamKey: string, groupName: string, consumerName: string, count: number = 1, blockMs: number = 0): Promise<any[]> {
		await this.ensureRedisConnection()
		if (!this.client) throw new Error("Redis client not available")

		try {
			const messages = await this.client.xReadGroup(groupName, consumerName, [{ key: streamKey, id: ">" }], { COUNT: count, BLOCK: blockMs })

			if (!messages || messages.length === 0) {
				return []
			}

			const streamMessages = messages[0]
			if (!streamMessages || !streamMessages.messages) {
				return []
			}

			console.log(`🌊 FunctionRegistry[${WORKER_ID}]: Read ${streamMessages.messages.length} messages from ${streamKey}`)
			return streamMessages.messages
		} catch (error) {
			console.error(`🌊 FunctionRegistry[${WORKER_ID}]: Error reading from stream ${streamKey}:`, error)
			return []
		}
	}

	/**
	 * Acknowledge a processed message
	 */
	async acknowledgeCall(streamKey: string, groupName: string, messageId: string): Promise<void> {
		await this.ensureRedisConnection()
		if (!this.client) throw new Error("Redis client not available")

		try {
			await this.client.xAck(streamKey, groupName, messageId)
			console.log(`🌊 FunctionRegistry[${WORKER_ID}]: Acknowledged message ${messageId} in ${streamKey}`)
		} catch (error) {
			console.error(`🌊 FunctionRegistry[${WORKER_ID}]: Error acknowledging message ${messageId}:`, error)
		}
	}

	/**
	 * Publish response to caller's response channel (using Lists for simplicity)
	 */
	async publishResponse(responseChannel: string, response: any): Promise<void> {
		await this.ensureRedisConnection()
		if (!this.client) throw new Error("Redis client not available")

		try {
			await this.client.lPush(responseChannel, JSON.stringify(response))
			await this.client.expire(responseChannel, 60) // 1 minute expiry
			console.log(`🌊 FunctionRegistry[${WORKER_ID}]: Published response to ${responseChannel}`)
		} catch (error) {
			console.error(`🌊 FunctionRegistry[${WORKER_ID}]: Error publishing response:`, error)
		}
	}

	/**
	 * Wait for response from function call (using BLPOP)
	 */
	async waitForResponse(responseChannel: string, timeoutSeconds: number): Promise<any> {
		await this.ensureRedisConnection()
		if (!this.client) throw new Error("Redis client not available")

		try {
			const result = await this.client.blPop(responseChannel, timeoutSeconds)

			if (!result) {
				throw new Error("Response timeout")
			}

			const response = JSON.parse(result.element)
			console.log(`🌊 FunctionRegistry[${WORKER_ID}]: Received response from ${responseChannel}:`, response)
			return response
		} catch (error) {
			console.error(`🌊 FunctionRegistry[${WORKER_ID}]: Error waiting for response:`, error)
			throw error
		}
	}

	/**
	 * Start heartbeat for a function
	 */
	startHeartbeat(functionName: string, scope: string): void {
		const heartbeatKey = `${functionName}-${scope}`

		// Clear existing heartbeat if any
		this.stopHeartbeat(functionName, scope)

		const interval = setInterval(async () => {
			try {
				await this.ensureRedisConnection()
				if (this.client) {
					const metadataKey = `function:meta:${WORKER_ID}:${functionName}`
					await this.client.hSet(metadataKey, "lastHeartbeat", Date.now().toString())
				}
			} catch (error) {
				console.error(`🌊 FunctionRegistry[${WORKER_ID}]: Heartbeat error for ${functionName}:`, error)
			}
		}, 10000) // Every 10 seconds

		this.heartbeatIntervals.set(heartbeatKey, interval)
		console.log(`🌊 FunctionRegistry[${WORKER_ID}]: Started heartbeat for ${functionName}`)
	}

	/**
	 * Stop heartbeat for a function
	 */
	stopHeartbeat(functionName: string, scope: string): void {
		const heartbeatKey = `${functionName}-${scope}`
		const interval = this.heartbeatIntervals.get(heartbeatKey)

		if (interval) {
			clearInterval(interval)
			this.heartbeatIntervals.delete(heartbeatKey)
			console.log(`🌊 FunctionRegistry[${WORKER_ID}]: Stopped heartbeat for ${functionName}`)
		}
	}

	/**
	 * Check if a worker is healthy based on heartbeat
	 */
	async isWorkerHealthy(workerId: string, functionName: string, maxAgeMs: number = 30000): Promise<boolean> {
		try {
			await this.ensureRedisConnection()
			if (!this.client) return false

			const metadataKey = `function:meta:${workerId}:${functionName}`
			const lastHeartbeat = await this.client.hGet(metadataKey, "lastHeartbeat")

			if (!lastHeartbeat) return false

			const age = Date.now() - parseInt(lastHeartbeat)
			return age <= maxAgeMs
		} catch (error) {
			console.error(`🌊 FunctionRegistry[${WORKER_ID}]: Error checking worker health:`, error)
			return false
		}
	}

	/**
	 * Clean up stream and consumer group
	 */
	async cleanupStream(streamKey: string, groupName: string): Promise<void> {
		try {
			await this.ensureRedisConnection()
			if (!this.client) return

			// Destroy consumer group
			await this.client.xGroupDestroy(streamKey, groupName)
			console.log(`🌊 FunctionRegistry[${WORKER_ID}]: Destroyed consumer group ${groupName} for ${streamKey}`)

			// Optionally delete the stream if no other groups exist
			// Note: We might want to keep the stream for other consumer groups
		} catch (error) {
			console.error(`🌊 FunctionRegistry[${WORKER_ID}]: Error cleaning up stream:`, error)
		}
	}

	/**
	 * Trim stream to prevent unbounded growth
	 */
	async trimStream(streamKey: string, maxLength: number = 10000): Promise<void> {
		try {
			await this.ensureRedisConnection()
			if (!this.client) return

			await this.client.xTrim(streamKey, "MAXLEN", maxLength)
			console.log(`🌊 FunctionRegistry[${WORKER_ID}]: Trimmed stream ${streamKey} to ~${maxLength} messages`)
		} catch (error) {
			console.error(`🌊 FunctionRegistry[${WORKER_ID}]: Error trimming stream:`, error)
		}
	}

	/**
	 * Reclaim pending messages from crashed consumers
	 */
	async reclaimPendingMessages(streamKey: string, groupName: string, idleTimeMs: number = 30000): Promise<void> {
		try {
			await this.ensureRedisConnection()
			if (!this.client) return

			const claimed = await this.client.xAutoClaim(streamKey, groupName, "reclaimer", idleTimeMs, "0-0", { COUNT: 100 })

			if (claimed.messages && claimed.messages.length > 0) {
				console.log(`🌊 FunctionRegistry[${WORKER_ID}]: Reclaimed ${claimed.messages.length} pending messages from ${streamKey}`)

				// Re-add claimed messages to the stream for reprocessing
				for (const message of claimed.messages) {
					await this.client.xAdd(streamKey, "*", message.message)
				}
			}
		} catch (error) {
			console.error(`🌊 FunctionRegistry[${WORKER_ID}]: Error reclaiming pending messages:`, error)
		}
	}

	/**
	 * Get available workers for a function
	 */
	async getAvailableWorkers(functionName: string): Promise<string[]> {
		try {
			await this.ensureRedisConnection()
			if (!this.client) return []

			return await this.client.sMembers(`function:${functionName}`)
		} catch (error) {
			console.error(`🌊 FunctionRegistry[${WORKER_ID}]: Error getting available workers:`, error)
			return []
		}
	}

	/**
	 * Check if a stream exists and has active consumers
	 */
	async isStreamReady(streamKey: string, groupName: string): Promise<boolean> {
		try {
			await this.ensureRedisConnection()
			if (!this.client) return false

			// Check if stream exists
			const streamExists = await this.client.exists(streamKey)
			if (!streamExists) {
				console.log(`🌊 FunctionRegistry[${WORKER_ID}]: Stream does not exist: ${streamKey}`)
				return false
			}

			// Check if consumer group exists and has consumers
			try {
				const groups = await this.client.xInfoGroups(streamKey)
				const targetGroup = groups.find((group: any) => group.name === groupName)

				if (!targetGroup) {
					console.log(`🌊 FunctionRegistry[${WORKER_ID}]: Consumer group does not exist: ${groupName}`)
					return false
				}

				// Simplified check - just verify the group exists (don't check for active consumers)
				const isReady = true
				console.log(`🌊 FunctionRegistry[${WORKER_ID}]: Stream ${streamKey} ready: ${isReady} (group exists)`)
				return isReady
			} catch (groupError) {
				console.log(`🌊 FunctionRegistry[${WORKER_ID}]: Error checking consumer group info: ${groupError.message}`)
				return false
			}
		} catch (error) {
			console.error(`🌊 FunctionRegistry[${WORKER_ID}]: Error checking stream readiness:`, error)
			return false
		}
	}

	/**
	 * Wait for stream to become ready with timeout
	 */
	async waitForStreamReady(streamKey: string, groupName: string, timeoutMs: number = 2000): Promise<boolean> {
		const startTime = Date.now()
		const checkInterval = 20 // Check every 20ms

		while (Date.now() - startTime < timeoutMs) {
			if (await this.isStreamReady(streamKey, groupName)) {
				return true
			}

			// Wait before next check
			await new Promise((resolve) => setTimeout(resolve, checkInterval))
		}

		console.log(`🌊 FunctionRegistry[${WORKER_ID}]: Timeout waiting for stream to be ready: ${streamKey}`)
		return false
	}

	// ===== END REDIS STREAMS METHODS =====

	async registerFunction(
		functionName: string,
		executionId: string,
		nodeId: string,
		parameters: ParameterDefinition[],
		callback: (parameters: Record<string, any>, inputItem: INodeExecutionData) => Promise<INodeExecutionData[]>
	): Promise<void> {
		const key = `${functionName}-${executionId}`
		console.log(`🎯 FunctionRegistry[${WORKER_ID}]: Registering function: ${key}`)
		console.log(`🎯 FunctionRegistry[${WORKER_ID}]: Parameters:`, parameters)

		// Store callback in memory (callbacks can't be serialized to Redis)
		this.listeners.set(key, {
			functionName,
			executionId,
			nodeId,
			parameters,
			callback,
		})

		// Store metadata in Redis for cross-process access
		try {
			await this.ensureRedisConnection()
			if (!this.client) throw new Error("Redis client not available")

			const metadata: FunctionMetadata = {
				functionName,
				executionId,
				nodeId,
				parameters,
				workerId: WORKER_ID,
			}

			// Store function metadata as hash and add to function set in parallel
			const metadataKey = `function:meta:${WORKER_ID}:${functionName}`
			const functionSetKey = `function:${functionName}`

			console.log(`🎯 FunctionRegistry[${WORKER_ID}]: Starting pipelined Redis operations at ${Date.now()}`)
			const startTime = Date.now()

			// Use Redis pipelining to batch all commands into a single round-trip
			const pipeline = this.client.multi()
			pipeline.hSet(metadataKey, {
				functionName: metadata.functionName,
				executionId: metadata.executionId,
				nodeId: metadata.nodeId,
				parameters: JSON.stringify(metadata.parameters),
				workerId: metadata.workerId,
				lastHeartbeat: Date.now().toString(),
			})
			pipeline.expire(metadataKey, 3600)
			pipeline.sAdd(functionSetKey, WORKER_ID)

			await pipeline.exec()

			const endTime = Date.now()
			console.log(`🎯 FunctionRegistry[${WORKER_ID}]: Pipelined Redis operations completed in ${endTime - startTime}ms`)
			console.log(`🎯 FunctionRegistry[${WORKER_ID}]: Function metadata stored: ${metadataKey}`)
			console.log(`🎯 FunctionRegistry[${WORKER_ID}]: Added to function set: ${functionSetKey}`)
		} catch (error) {
			console.error(`🎯 FunctionRegistry[${WORKER_ID}]: Failed to register function in Redis:`, error)
			// Continue with in-memory only if Redis fails
		}
	}

	async unregisterFunction(functionName: string, executionId: string): Promise<void> {
		const key = `${functionName}-${executionId}`
		console.log(`🎯 FunctionRegistry[${WORKER_ID}]: Unregistering function: ${key}`)

		// Remove from memory
		this.listeners.delete(key)

		// Remove from Redis
		try {
			await this.ensureRedisConnection()
			if (!this.client) throw new Error("Redis client not available")

			// Remove metadata hash and function set in parallel
			const metadataKey = `function:meta:${WORKER_ID}:${functionName}`
			const functionSetKey = `function:${functionName}`

			console.log(`🎯 FunctionRegistry[${WORKER_ID}]: Starting pipelined Redis cleanup operations at ${Date.now()}`)
			const startTime = Date.now()

			// Use Redis pipelining to batch cleanup commands
			const pipeline = this.client.multi()
			pipeline.del(metadataKey)
			pipeline.sRem(functionSetKey, WORKER_ID)

			await pipeline.exec()

			const endTime = Date.now()
			console.log(`🎯 FunctionRegistry[${WORKER_ID}]: Pipelined Redis cleanup completed in ${endTime - startTime}ms`)
			console.log(`🎯 FunctionRegistry[${WORKER_ID}]: Function metadata removed: ${metadataKey}`)
			console.log(`🎯 FunctionRegistry[${WORKER_ID}]: Removed from function set: ${functionSetKey}`)
		} catch (error) {
			console.error(`🎯 FunctionRegistry[${WORKER_ID}]: Failed to unregister function from Redis:`, error)
		}
	}

	async callFunction(
		functionName: string,
		executionId: string,
		parameters: Record<string, any>,
		inputItem: INodeExecutionData
	): Promise<{ result: INodeExecutionData[] | null; actualExecutionId: string }> {
		console.log(`🔧 FunctionRegistry[${WORKER_ID}]: Calling function: ${functionName}`)

		// Generate unique call ID
		const callId = `${WORKER_ID}_${Date.now()}_${this.nextCallId++}`

		// First try local execution
		const localKey = `${functionName}-${executionId}`
		const localListener = this.listeners.get(localKey)

		if (localListener) {
			console.log(`🔧 FunctionRegistry[${WORKER_ID}]: Found function locally, executing directly`)
			try {
				this.callContextStack.push(callId)
				const result = await localListener.callback(parameters, inputItem)
				this.callContextStack.pop()
				return { result, actualExecutionId: callId }
			} catch (error) {
				this.callContextStack.pop()
				throw error
			}
		}

		// Try cross-worker call via Redis
		console.log(`🔧 FunctionRegistry[${WORKER_ID}]: Function not found locally, trying Redis pub/sub`)

		try {
			await this.ensureRedisConnection()
			if (!this.client || !this.publisher || !this.subscriber) {
				throw new Error("Redis clients not available")
			}

			// Get available workers for this function
			const functionSetKey = `function:${functionName}`
			const availableWorkers = await this.client.sMembers(functionSetKey)

			if (availableWorkers.length === 0) {
				console.log(`🔧 FunctionRegistry[${WORKER_ID}]: No workers available for function: ${functionName}`)
				return { result: null, actualExecutionId: callId }
			}

			// Pick a worker (simple round-robin by using first available)
			const targetWorker = availableWorkers[0]
			console.log(`🔧 FunctionRegistry[${WORKER_ID}]: Targeting worker: ${targetWorker}`)

			// Set up response channel and timeout
			const responseChannel = `function:response:${callId}`
			const timeoutMs = 10000 // 10 second timeout

			return new Promise(async (resolve, reject) => {
				let resolved = false

				// Set up timeout
				const timeout = setTimeout(() => {
					if (!resolved) {
						resolved = true
						console.error(`🔧 FunctionRegistry[${WORKER_ID}]: Function call timed out: ${functionName}`)
						resolve({ result: null, actualExecutionId: callId })
					}
				}, timeoutMs)

				// Subscribe to response
				const responseSubscriber = createClient({ url: `redis://${this.redisHost}:${this.redisPort}` })
				await responseSubscriber.connect()

				await responseSubscriber.subscribe(responseChannel, async (message) => {
					if (resolved) return
					resolved = true
					clearTimeout(timeout)

					try {
						const response = JSON.parse(message)
						console.log(`🔧 FunctionRegistry[${WORKER_ID}]: Received response:`, response)
						await responseSubscriber.disconnect()

						if (response.success) {
							resolve({ result: response.result, actualExecutionId: callId })
						} else {
							reject(new Error(response.error || "Function call failed"))
						}
					} catch (error) {
						console.error(`🔧 FunctionRegistry[${WORKER_ID}]: Error parsing response:`, error)
						await responseSubscriber.disconnect()
						resolve({ result: null, actualExecutionId: callId })
					}
				})

				// Send function call request
				const request = {
					callId,
					functionName,
					parameters,
					inputItem,
					responseChannel,
				}
				const callChannel = `function:call:${targetWorker}:${functionName}`
				console.log(`🔧 FunctionRegistry[${WORKER_ID}]: Publishing to ${callChannel}`)
				await this.publisher!.publish(callChannel, JSON.stringify(request))
			})
		} catch (error) {
			console.error(`🔧 FunctionRegistry[${WORKER_ID}]: Error with Redis function call:`, error)
			return { result: null, actualExecutionId: callId }
		}
	}

	async getAvailableFunctions(scope?: string): Promise<Array<{ name: string; value: string }>> {
		console.log(`🎯 FunctionRegistry[${WORKER_ID}]: Getting available functions for scope: ${scope || "all"}`)
		const functionNames = new Set<string>()

		// Get functions from memory (local process)
		for (const listener of this.listeners.values()) {
			// If scope is specified, filter by execution ID (scope)
			if (scope && listener.executionId !== scope) {
				continue
			}
			functionNames.add(listener.functionName)
		}

		// Get functions from Redis (other processes)
		try {
			await this.ensureRedisConnection()
			if (this.client) {
				const functionKeys = await this.client.keys("function:meta:*")
				console.log(`🎯 FunctionRegistry[${WORKER_ID}]: Found ${functionKeys.length} function metadata keys`)

				for (const key of functionKeys) {
					if (key.startsWith("function:meta:")) {
						// Extract function name from metadata key: function:meta:workerId:functionName
						const parts = key.split(":")
						if (parts.length >= 4) {
							const functionName = parts.slice(3).join(":")

							// If scope is specified, check if this function belongs to that scope
							if (scope) {
								// Get the metadata to check the execution ID (scope)
								try {
									const metadata = await this.client.hGetAll(key)
									console.log(`🎯 FunctionRegistry[${WORKER_ID}]: Checking function ${functionName}, metadata executionId: ${metadata.executionId}, looking for scope: ${scope}`)
									if (metadata && metadata.executionId === scope) {
										console.log(`🎯 FunctionRegistry[${WORKER_ID}]: ✅ Function ${functionName} matches scope ${scope}`)
										functionNames.add(functionName)
									} else {
										console.log(`🎯 FunctionRegistry[${WORKER_ID}]: ❌ Function ${functionName} does not match scope ${scope}`)
									}
								} catch (metaError) {
									console.error(`🎯 FunctionRegistry[${WORKER_ID}]: Error reading metadata for ${key}:`, metaError)
								}
							} else {
								functionNames.add(functionName)
							}
						}
					}
				}
			}
		} catch (error) {
			console.error(`🎯 FunctionRegistry[${WORKER_ID}]: Error getting functions from Redis:`, error)
		}

		console.log(`🎯 FunctionRegistry[${WORKER_ID}]: Found functions for scope '${scope || "all"}':`, Array.from(functionNames))
		return Array.from(functionNames).map((name) => ({
			name,
			value: name,
		}))
	}

	async getFunctionParameters(functionName: string, executionId?: string): Promise<ParameterDefinition[]> {
		// Try local first
		for (const listener of this.listeners.values()) {
			if (listener.functionName === functionName) {
				return listener.parameters
			}
		}

		// Try Redis
		try {
			await this.ensureRedisConnection()
			if (this.client) {
				const metadataKeys = await this.client.keys(`function:meta:*:${functionName}`)
				if (metadataKeys.length > 0) {
					const metadataHash = await this.client.hGetAll(metadataKeys[0])
					if (metadataHash && metadataHash.parameters) {
						return JSON.parse(metadataHash.parameters)
					}
				}
			}
		} catch (error) {
			console.error(`🎯 FunctionRegistry[${WORKER_ID}]: Error getting function parameters from Redis:`, error)
		}

		return []
	}

	// Return value methods (keeping existing implementation)
	async setFunctionReturnValue(executionId: string, returnValue: any): Promise<void> {
		console.log(`🎯 FunctionRegistry[${WORKER_ID}]: ⭐ SETTING return value for execution: ${executionId}`)

		try {
			await this.ensureRedisConnection()
			if (!this.client) throw new Error("Redis client not available")

			const redisKey = `return:${executionId}`
			await this.client.set(redisKey, JSON.stringify(returnValue), { EX: 300 }) // 5 minute expiry
			console.log(`🎯 FunctionRegistry[${WORKER_ID}]: ⭐ Return value stored in Redis: ${redisKey}`)

			// Publish to notify waiting processes
			await this.client.publish(`return-pubsub:${executionId}`, JSON.stringify(returnValue))
			console.log(`🎯 FunctionRegistry[${WORKER_ID}]: ⭐ Return value published to pubsub`)
		} catch (error) {
			console.error(`🎯 FunctionRegistry[${WORKER_ID}]: Failed to store return value in Redis:`, error)
		}
	}

	async getFunctionReturnValue(executionId: string): Promise<any | null> {
		console.log(`🎯 FunctionRegistry[${WORKER_ID}]: 🔍 GETTING return value for execution: ${executionId}`)

		try {
			await this.ensureRedisConnection()
			if (!this.client) throw new Error("Redis client not available")

			const redisKey = `return:${executionId}`
			const returnValueJson = await this.client.get(redisKey)

			if (returnValueJson) {
				const returnValue = JSON.parse(returnValueJson)
				console.log(`🎯 FunctionRegistry[${WORKER_ID}]: 🔍 Return value found in Redis:`, returnValue)
				return returnValue
			}
		} catch (error) {
			console.error(`🎯 FunctionRegistry[${WORKER_ID}]: Error getting return value from Redis:`, error)
		}

		console.log(`🎯 FunctionRegistry[${WORKER_ID}]: 🔍 No return value found`)
		return null
	}

	async clearFunctionReturnValue(executionId: string): Promise<void> {
		console.log(`🎯 FunctionRegistry[${WORKER_ID}]: 🗑️ CLEARING return value for execution: ${executionId}`)

		try {
			await this.ensureRedisConnection()
			if (!this.client) throw new Error("Redis client not available")

			const redisKey = `return:${executionId}`
			await this.client.del(redisKey)
			console.log(`🎯 FunctionRegistry[${WORKER_ID}]: 🗑️ Return value cleared from Redis`)
		} catch (error) {
			console.error(`🎯 FunctionRegistry[${WORKER_ID}]: Error clearing return value from Redis:`, error)
		}
	}

	// Stack management methods (keeping existing implementation)
	pushCurrentFunctionExecution(executionId: string): void {
		console.log(`🎯 FunctionRegistry[${WORKER_ID}]: Pushing function execution to stack: ${executionId}`)
		this.currentFunctionExecutionStack.push(executionId)
	}

	getCurrentFunctionExecution(): string | null {
		const current = this.currentFunctionExecutionStack[this.currentFunctionExecutionStack.length - 1] ?? null
		console.log(`🎯 FunctionRegistry[${WORKER_ID}]: Getting current function execution: ${current}`)
		return current
	}

	popCurrentFunctionExecution(): string | null {
		const popped = this.currentFunctionExecutionStack.pop() ?? null
		console.log(`🎯 FunctionRegistry[${WORKER_ID}]: Popped function execution from stack: ${popped}`)
		return popped
	}

	clearCurrentFunctionExecution(): void {
		console.log(`🎯 FunctionRegistry[${WORKER_ID}]: Clearing entire function execution stack`)
		this.currentFunctionExecutionStack = []
	}

	generateNestedCallId(baseExecutionId: string): string {
		const nestedId = `${baseExecutionId}_nested_${this.nextCallId++}`
		console.log(`🎯 FunctionRegistry[${WORKER_ID}]: Generated nested call ID: ${nestedId}`)
		return nestedId
	}

	getCurrentCallContext(): string | undefined {
		return this.callContextStack[this.callContextStack.length - 1]
	}

	// Promise-based return handling methods
	async createReturnPromise(executionId: string): Promise<any> {
		console.log(`🎯 FunctionRegistry[${WORKER_ID}]: ⭐ Creating return promise for execution: ${executionId}`)

		if (this.returnPromises.has(executionId)) {
			console.warn(`🎯 FunctionRegistry[${WORKER_ID}]: ⚠️ Promise already exists for execution: ${executionId}`)
			return this.waitForReturn(executionId)
		}

		return new Promise(async (resolve, reject) => {
			console.log(`🎯 FunctionRegistry[${WORKER_ID}]: ⭐ Promise created, storing resolve/reject handlers`)
			this.returnPromises.set(executionId, { resolve, reject })

			// Also set up Redis subscription for cross-process return values
			try {
				await this.ensureRedisConnection()
				if (this.client) {
					const subscriber = this.client.duplicate()
					await subscriber.connect()

					await subscriber.subscribe(`return-pubsub:${executionId}`, (message) => {
						console.log(`🎯 FunctionRegistry[${WORKER_ID}]: ⭐ Received return value via pubsub:`, message)
						try {
							const returnValue = JSON.parse(message)
							const promiseHandlers = this.returnPromises.get(executionId)
							if (promiseHandlers) {
								promiseHandlers.resolve(returnValue)
								this.returnPromises.delete(executionId)
							}
						} catch (error) {
							console.error(`🎯 FunctionRegistry[${WORKER_ID}]: Error parsing pubsub message:`, error)
						}
						subscriber.disconnect()
					})
				}
			} catch (error) {
				console.error(`🎯 FunctionRegistry[${WORKER_ID}]: Error setting up Redis subscription:`, error)
			}
		})
	}

	async waitForReturn(executionId: string): Promise<any> {
		console.log(`🎯 FunctionRegistry[${WORKER_ID}]: 🔍 Getting return promise for execution: ${executionId}`)

		// Check if value is already available in Redis
		const existingValue = await this.getFunctionReturnValue(executionId)
		if (existingValue !== null) {
			console.log(`🎯 FunctionRegistry[${WORKER_ID}]: 🔍 Return value already available:`, existingValue)
			return existingValue
		}

		// Check if promise exists
		const promiseHandlers = this.returnPromises.get(executionId)
		if (!promiseHandlers) {
			console.log(`🎯 FunctionRegistry[${WORKER_ID}]: 🔍 No promise found, creating new one`)
			return this.createReturnPromise(executionId)
		}

		// Return a new promise that will be resolved/rejected when the stored handlers are called
		return new Promise((resolve, reject) => {
			const originalResolve = promiseHandlers.resolve
			const originalReject = promiseHandlers.reject

			promiseHandlers.resolve = (value: any) => {
				originalResolve(value)
				resolve(value)
			}

			promiseHandlers.reject = (error: any) => {
				originalReject(error)
				reject(error)
			}
		})
	}

	async resolveReturn(executionId: string, value: any): Promise<void> {
		console.log(`🎯 FunctionRegistry[${WORKER_ID}]: ✅ Resolving return promise for execution: ${executionId} with value:`, value)

		// Store the value in Redis
		await this.setFunctionReturnValue(executionId, value)

		// Resolve the promise if it exists
		const promiseHandlers = this.returnPromises.get(executionId)
		if (promiseHandlers) {
			console.log(`🎯 FunctionRegistry[${WORKER_ID}]: ✅ Promise found, resolving...`)
			promiseHandlers.resolve(value)
			this.returnPromises.delete(executionId)
			console.log(`🎯 FunctionRegistry[${WORKER_ID}]: ✅ Promise resolved and cleaned up`)
		} else {
			console.log(`🎯 FunctionRegistry[${WORKER_ID}]: 🟡 No promise found for execution, value stored for later retrieval`)
		}
	}

	async rejectReturn(executionId: string, error: any): Promise<void> {
		console.log(`🎯 FunctionRegistry[${WORKER_ID}]: ❌ Rejecting return promise for execution: ${executionId} with error:`, error)

		// Reject the promise if it exists
		const promiseHandlers = this.returnPromises.get(executionId)
		if (promiseHandlers) {
			console.log(`🎯 FunctionRegistry[${WORKER_ID}]: ❌ Promise found, rejecting...`)
			promiseHandlers.reject(error)
			this.returnPromises.delete(executionId)
			console.log(`🎯 FunctionRegistry[${WORKER_ID}]: ❌ Promise rejected and cleaned up`)
		} else {
			console.log(`🎯 FunctionRegistry[${WORKER_ID}]: 🟡 No promise found for execution, error not propagated`)
		}
	}

	cleanupReturnPromise(executionId: string): void {
		console.log(`🎯 FunctionRegistry[${WORKER_ID}]: 🗑️ Cleaning up return promise for execution: ${executionId}`)
		this.returnPromises.delete(executionId)
	}

	async disconnect(): Promise<void> {
		console.log(`🎯 FunctionRegistry[${WORKER_ID}]: Disconnecting from Redis`)

		try {
			// Stop all heartbeats
			for (const [, interval] of this.heartbeatIntervals) {
				clearInterval(interval)
			}
			this.heartbeatIntervals.clear()

			// Clear stream consumers tracking
			this.streamConsumers.clear()

			if (this.client && this.isConnected) {
				await this.client.disconnect()
			}
			if (this.publisher) {
				await this.publisher.disconnect()
			}
			if (this.subscriber) {
				await this.subscriber.disconnect()
			}
			this.isConnected = false
			this.isSubscriberSetup = false
			console.log(`🎯 FunctionRegistry[${WORKER_ID}]: Disconnected from Redis`)
		} catch (error) {
			console.error(`🎯 FunctionRegistry[${WORKER_ID}]: Error disconnecting from Redis:`, error)
		}
	}
}

// Export singleton instance getter
export function getInstance(): FunctionRegistry {
	return FunctionRegistry.getInstance()
}

export { FunctionRegistry }
