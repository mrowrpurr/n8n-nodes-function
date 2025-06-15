import { INodeExecutionData } from "n8n-workflow"
import { createClient, RedisClientType } from "redis"

interface ParameterDefinition {
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

// Configuration: Set to true for Redis, false for in-memory
const USE_REDIS = true
const REDIS_HOST = "redis"
const REDIS_PORT = 6379

class FunctionRegistry {
	private static instance: FunctionRegistry

	// In-memory storage (fallback or when USE_REDIS = false)
	private listeners: Map<string, FunctionListener> = new Map()
	private returnValues: Map<string, any> = new Map()

	// Redis clients
	private redisClient: RedisClientType | null = null
	private redisSubscriber: RedisClientType | null = null
	private redisPublisher: RedisClientType | null = null
	private isRedisConnected: boolean = false

	// Function call subscribers (one per function)
	private functionSubscribers: Map<string, RedisClientType> = new Map()

	// Common properties
	private currentFunctionExecutionStack: string[] = []
	private nextCallId: number = 1
	private callContextStack: string[] = []
	private returnPromises: Map<string, { resolve: (value: any) => void; reject: (error: any) => void }> = new Map()

	static getInstance(): FunctionRegistry {
		if (!FunctionRegistry.instance) {
			FunctionRegistry.instance = new FunctionRegistry()
		}
		return FunctionRegistry.instance
	}

	private async ensureRedisConnection(): Promise<void> {
		if (!USE_REDIS) return

		if (this.redisClient && this.isRedisConnected) {
			return
		}

		try {
			console.log("🔴 FunctionRegistry: Connecting to Redis at", `redis://${REDIS_HOST}:${REDIS_PORT}`)

			// Main client for metadata storage
			this.redisClient = createClient({
				url: `redis://${REDIS_HOST}:${REDIS_PORT}`,
			})

			// Dedicated publisher for sending messages
			this.redisPublisher = createClient({
				url: `redis://${REDIS_HOST}:${REDIS_PORT}`,
			})

			// Dedicated subscriber for receiving responses
			this.redisSubscriber = createClient({
				url: `redis://${REDIS_HOST}:${REDIS_PORT}`,
			})

			await this.redisClient.connect()
			await this.redisPublisher.connect()
			await this.redisSubscriber.connect()

			this.isRedisConnected = true
			console.log("🔴 FunctionRegistry: Successfully connected to Redis")
		} catch (error) {
			console.error("🔴 FunctionRegistry: Failed to connect to Redis:", error)
			this.isRedisConnected = false
			throw error
		}
	}

	private async disconnectRedis(): Promise<void> {
		if (!USE_REDIS) return

		try {
			// Disconnect function subscribers
			for (const [, subscriber] of this.functionSubscribers.entries()) {
				await subscriber.disconnect()
			}
			this.functionSubscribers.clear()

			// Disconnect main clients
			if (this.redisClient) await this.redisClient.disconnect()
			if (this.redisPublisher) await this.redisPublisher.disconnect()
			if (this.redisSubscriber) await this.redisSubscriber.disconnect()

			this.isRedisConnected = false
			console.log("🔴 FunctionRegistry: Disconnected from Redis")
		} catch (error) {
			console.error("🔴 FunctionRegistry: Error disconnecting from Redis:", error)
		}
	}

	async registerFunction(
		functionName: string,
		executionId: string,
		nodeId: string,
		parameters: ParameterDefinition[],
		callback: (parameters: Record<string, any>, inputItem: INodeExecutionData) => Promise<INodeExecutionData[]>
	): Promise<void> {
		const key = `${functionName}-${executionId}`
		console.log("🎯 FunctionRegistry: Registering function:", key)
		console.log("🎯 FunctionRegistry: Parameters:", parameters)

		// Always store in memory for direct callback access
		this.listeners.set(key, {
			functionName,
			executionId,
			nodeId,
			parameters,
			callback,
		})

		if (USE_REDIS) {
			try {
				await this.ensureRedisConnection()
				if (!this.redisClient) throw new Error("Redis client not available")

				// Store function metadata in Redis
				const metadata = {
					functionName,
					executionId,
					nodeId,
					parameters,
					registeredAt: new Date().toISOString(),
				}

				const redisKey = `function:${functionName}:${executionId}`
				await this.redisClient.set(redisKey, JSON.stringify(metadata), { EX: 3600 }) // 1 hour expiry
				console.log("🎯 FunctionRegistry: Function metadata stored in Redis:", redisKey)

				// Set up pub/sub listener for this function (if not already exists)
				if (!this.functionSubscribers.has(functionName)) {
					const subscriber = createClient({ url: `redis://${REDIS_HOST}:${REDIS_PORT}` })
					await subscriber.connect()

					const callChannel = `function:call:${functionName}`
					console.log("🔔 FunctionRegistry: Subscribing to function call channel:", callChannel)

					await subscriber.subscribe(callChannel, async (message) => {
						try {
							console.log(`🔔 FunctionRegistry: Received function call request for ${functionName}:`, message)
							const { callId, parameters: callParams, inputItem, responseChannel, callerExecutionId } = JSON.parse(message)

							// Find the callback in local memory
							const listener = this.listeners.get(key)
							if (!listener) {
								console.warn(`🔔 FunctionRegistry: No local callback for function ${functionName}, cannot execute`)
								return
							}

							// Execute the callback directly (like in-memory registry!)
							console.log(`🔔 FunctionRegistry: Executing callback for ${functionName} with params:`, callParams)
							console.log(`🔔 FunctionRegistry: Using caller execution ID for context:`, callerExecutionId)

							// Set up execution context for this function call
							if (callerExecutionId) {
								this.pushCurrentFunctionExecution(callerExecutionId)
								await this.clearFunctionReturnValue(callerExecutionId)

								// Store execution context in Redis for cross-worker coordination
								await this.redisClient!.set(`execution:context:${callId}`, callerExecutionId, { EX: 300 }) // 5 minute expiry
								console.log(`🔔 FunctionRegistry: Stored execution context in Redis: ${callId} -> ${callerExecutionId}`)
							}

							const result = await listener.callback(callParams, inputItem)
							console.log(`🔔 FunctionRegistry: Callback result:`, result)

							// Send result back via pub/sub
							const response = { callId, result, executionId: callerExecutionId }
							if (this.redisPublisher) {
								await this.redisPublisher.publish(responseChannel, JSON.stringify(response))
								console.log(`🔔 FunctionRegistry: Published result to ${responseChannel}:`, response)
							}
						} catch (error) {
							console.error(`🔔 FunctionRegistry: Error handling function call request:`, error)
						}
					})

					this.functionSubscribers.set(functionName, subscriber as any)
				}
			} catch (error) {
				console.error("🎯 FunctionRegistry: Failed to register function in Redis:", error)
				// Continue with in-memory only
			}
		}
	}

	async unregisterFunction(functionName: string, executionId: string): Promise<void> {
		const key = `${functionName}-${executionId}`
		console.log("🎯 FunctionRegistry: Unregistering function:", key)

		// Remove from memory
		this.listeners.delete(key)

		if (USE_REDIS) {
			try {
				await this.ensureRedisConnection()
				if (!this.redisClient) throw new Error("Redis client not available")

				// Remove metadata from Redis
				const redisKey = `function:${functionName}:${executionId}`
				await this.redisClient.del(redisKey)
				console.log("🎯 FunctionRegistry: Function metadata removed from Redis:", redisKey)

				// Check if we should cleanup the subscriber
				// (Only if no other instances of this function exist)
				const hasOtherInstances = Array.from(this.listeners.keys()).some((k) => k.startsWith(`${functionName}-`))
				if (!hasOtherInstances) {
					const subscriber = this.functionSubscribers.get(functionName)
					if (subscriber) {
						await subscriber.disconnect()
						this.functionSubscribers.delete(functionName)
						console.log("🎯 FunctionRegistry: Cleaned up subscriber for function:", functionName)
					}
				}
			} catch (error) {
				console.error("🎯 FunctionRegistry: Failed to unregister function from Redis:", error)
			}
		}
	}

	async callFunction(
		functionName: string,
		executionId: string,
		parameters: Record<string, any>,
		inputItem: INodeExecutionData
	): Promise<{ result: INodeExecutionData[] | null; actualExecutionId: string }> {
		const key = `${functionName}-${executionId}`
		console.log("🔧 FunctionRegistry: Looking for function:", key)
		console.log("🔧 FunctionRegistry: Available functions:", Array.from(this.listeners.keys()))

		// Generate a unique call ID for this specific function invocation
		const uniqueCallId = `${executionId}_call_${this.nextCallId++}`
		console.log("🔧 FunctionRegistry: Generated unique call ID:", uniqueCallId, "for function:", key)

		// First try local (in-memory) execution
		const listener = this.listeners.get(key)
		if (listener) {
			console.log("🔧 FunctionRegistry: Found function locally, executing directly")
			try {
				// Push the unique call ID to the stack
				this.callContextStack.push(uniqueCallId)
				console.log("🔧 FunctionRegistry: Pushed call context:", uniqueCallId)

				const result = await listener.callback(parameters, inputItem)
				console.log("🔧 FunctionRegistry: Local function result:", result)

				// Pop the call context
				const poppedCallId = this.callContextStack.pop()
				console.log("🔧 FunctionRegistry: Popped call context:", poppedCallId)

				return { result, actualExecutionId: uniqueCallId }
			} catch (error) {
				console.error("🔧 FunctionRegistry: Error calling local function:", error)
				this.callContextStack.pop()
				throw error
			}
		}

		// If not found locally and Redis is enabled, try cross-process call
		if (USE_REDIS) {
			console.log("🔧 FunctionRegistry: Function not found locally, trying Redis pub/sub")
			try {
				await this.ensureRedisConnection()
				if (!this.redisClient || !this.redisPublisher || !this.redisSubscriber) {
					throw new Error("Redis clients not available")
				}

				// Check if function exists in Redis
				const redisKeys = await this.redisClient.keys(`function:${functionName}:*`)
				if (redisKeys.length === 0) {
					console.log("🔧 FunctionRegistry: Function not found in Redis either:", functionName)
					return { result: null, actualExecutionId: uniqueCallId }
				}

				console.log("🔧 FunctionRegistry: Function found in Redis, initiating pub/sub call")

				// Set up response channel and timeout
				const callId = `${functionName}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
				const responseChannel = `function:response:${callId}`
				const timeoutMs = 10000 // 10 second timeout

				return new Promise(async (resolve, reject) => {
					let resolved = false

					// Set up timeout
					const timeout = setTimeout(() => {
						if (!resolved) {
							resolved = true
							console.error(`🔧 FunctionRegistry: Pub/sub call timed out for ${functionName} (callId: ${callId})`)
							resolve({ result: null, actualExecutionId: uniqueCallId })
						}
					}, timeoutMs)

					// Subscribe to response channel
					const responseSubscriber = createClient({ url: `redis://${REDIS_HOST}:${REDIS_PORT}` })
					await responseSubscriber.connect()

					await responseSubscriber.subscribe(responseChannel, async (message) => {
						if (resolved) return
						resolved = true
						clearTimeout(timeout)

						try {
							const response = JSON.parse(message)
							console.log(`🔧 FunctionRegistry: Received pub/sub response for ${functionName}:`, response)
							await responseSubscriber.disconnect()
							// Use the execution ID from the response for return value coordination
							const responseExecutionId = response.executionId || uniqueCallId
							resolve({ result: response.result, actualExecutionId: responseExecutionId })
						} catch (error) {
							console.error(`🔧 FunctionRegistry: Error parsing pub/sub response:`, error)
							await responseSubscriber.disconnect()
							resolve({ result: null, actualExecutionId: uniqueCallId })
						}
					})

					// Send function call request
					const request = {
						callId,
						parameters,
						inputItem,
						responseChannel,
						callerExecutionId: executionId, // Pass the caller's execution ID
					}
					const callChannel = `function:call:${functionName}`
					console.log(`🔧 FunctionRegistry: Publishing call request to ${callChannel}:`, request)
					await this.redisPublisher!.publish(callChannel, JSON.stringify(request))
				})
			} catch (error) {
				console.error("🔧 FunctionRegistry: Error with Redis pub/sub call:", error)
				return { result: null, actualExecutionId: uniqueCallId }
			}
		}

		console.log("🔧 FunctionRegistry: Function not found:", key)
		return { result: null, actualExecutionId: uniqueCallId }
	}

	listFunctions(): void {
		console.log("🎯 FunctionRegistry: Registered functions:")
		for (const [key, listener] of this.listeners.entries()) {
			console.log(`  - ${key}: ${listener.functionName} (node: ${listener.nodeId})`)
		}
	}

	async getAvailableFunctions(executionId?: string): Promise<Array<{ name: string; value: string }>> {
		const functionNames = new Set<string>()

		// Get functions from local memory
		for (const listener of this.listeners.values()) {
			// If executionId is specified, only include functions for that execution
			if (executionId && listener.executionId !== executionId) {
				continue
			}
			functionNames.add(listener.functionName)
		}

		// Get functions from Redis if enabled
		if (USE_REDIS) {
			try {
				await this.ensureRedisConnection()
				if (this.redisClient) {
					const redisKeys = await this.redisClient.keys("function:*")
					for (const key of redisKeys) {
						const parts = key.split(":")
						if (parts.length >= 2) {
							const functionName = parts[1]
							const keyExecutionId = parts[2]

							// If executionId is specified, only include functions for that execution
							if (executionId && keyExecutionId !== executionId) {
								continue
							}
							functionNames.add(functionName)
						}
					}
				}
			} catch (error) {
				console.error("🎯 FunctionRegistry: Error getting functions from Redis:", error)
			}
		}

		// Convert to array of options for n8n dropdown
		return Array.from(functionNames).map((name) => ({
			name,
			value: name,
		}))
	}

	async getFunctionParameters(functionName: string, executionId?: string): Promise<ParameterDefinition[]> {
		// If executionId is specified, look for that specific function instance
		if (executionId) {
			const key = `${functionName}-${executionId}`
			const listener = this.listeners.get(key)
			if (listener) {
				return listener.parameters
			}
		}

		// Look for the function with __active__ execution ID first
		const activeKey = `${functionName}-__active__`
		const activeListener = this.listeners.get(activeKey)
		if (activeListener) {
			return activeListener.parameters
		}

		// If not found locally, look for any instance of this function in memory
		for (const listener of this.listeners.values()) {
			if (listener.functionName === functionName) {
				return listener.parameters
			}
		}

		// If not found in memory and Redis is enabled, check Redis
		if (USE_REDIS) {
			try {
				await this.ensureRedisConnection()
				if (this.redisClient) {
					const redisKeys = await this.redisClient.keys(`function:${functionName}:*`)
					for (const key of redisKeys) {
						const metadataJson = await this.redisClient.get(key)
						if (metadataJson) {
							const metadata = JSON.parse(metadataJson)
							return metadata.parameters || []
						}
					}
				}
			} catch (error) {
				console.error("🎯 FunctionRegistry: Error getting function parameters from Redis:", error)
			}
		}

		return []
	}

	async setFunctionReturnValue(executionId: string, returnValue: any): Promise<void> {
		console.log("🎯 FunctionRegistry: ⭐ SETTING return value for execution:", executionId)

		if (USE_REDIS) {
			try {
				await this.ensureRedisConnection()
				if (!this.redisClient) throw new Error("Redis client not available")

				const redisKey = `return:${executionId}`
				await this.redisClient.set(redisKey, JSON.stringify(returnValue), { EX: 300 }) // 5 minute expiry
				console.log("🎯 FunctionRegistry: ⭐ Return value stored in Redis:", redisKey)

				// Publish to notify waiting processes
				await this.redisClient.publish(`return-pubsub:${executionId}`, JSON.stringify(returnValue))
				console.log("🎯 FunctionRegistry: ⭐ Return value published to pubsub")
			} catch (error) {
				console.error("🎯 FunctionRegistry: Failed to store return value in Redis:", error)
			}
		} else {
			// Fallback to in-memory storage
			console.log("🎯 FunctionRegistry: ⭐ Return value being stored:", returnValue)
			console.log("🎯 FunctionRegistry: ⭐ Return value type:", typeof returnValue)
			console.log("🎯 FunctionRegistry: ⭐ Registry size before:", this.returnValues.size)

			this.returnValues.set(executionId, returnValue)

			console.log("🎯 FunctionRegistry: ⭐ Registry size after:", this.returnValues.size)
			console.log("🎯 FunctionRegistry: ⭐ Return value stored successfully!")

			// Verify it was stored
			const verification = this.returnValues.get(executionId)
			console.log("🎯 FunctionRegistry: ⭐ Verification - can retrieve:", verification)
		}
	}

	async getFunctionReturnValue(executionId: string): Promise<any | null> {
		console.log("🎯 FunctionRegistry: 🔍 GETTING return value for execution:", executionId)

		if (USE_REDIS) {
			try {
				await this.ensureRedisConnection()
				if (!this.redisClient) throw new Error("Redis client not available")

				const redisKey = `return:${executionId}`
				const returnValueJson = await this.redisClient.get(redisKey)

				if (returnValueJson) {
					const returnValue = JSON.parse(returnValueJson)
					console.log("🎯 FunctionRegistry: 🔍 Return value found in Redis:", returnValue)
					return returnValue
				}
			} catch (error) {
				console.error("🎯 FunctionRegistry: Error getting return value from Redis:", error)
			}

			console.log("🎯 FunctionRegistry: 🔍 No return value found in Redis")
			return null
		} else {
			// Fallback to in-memory storage
			console.log("🎯 FunctionRegistry: 🔍 Registry size:", this.returnValues.size)
			console.log("🎯 FunctionRegistry: 🔍 All keys in registry:", Array.from(this.returnValues.keys()))

			const returnValue = this.returnValues.get(executionId)
			console.log("🎯 FunctionRegistry: 🔍 Raw value from map:", returnValue)
			console.log("🎯 FunctionRegistry: 🔍 Value type:", typeof returnValue)
			console.log("🎯 FunctionRegistry: 🔍 Value === undefined?", returnValue === undefined)

			const result = returnValue || null
			console.log("🎯 FunctionRegistry: 🔍 Final result (with null fallback):", result)
			return result
		}
	}

	async clearFunctionReturnValue(executionId: string): Promise<void> {
		console.log("🎯 FunctionRegistry: 🗑️  CLEARING return value for execution:", executionId)

		if (USE_REDIS) {
			try {
				await this.ensureRedisConnection()
				if (!this.redisClient) throw new Error("Redis client not available")

				const redisKey = `return:${executionId}`
				await this.redisClient.del(redisKey)
				console.log("🎯 FunctionRegistry: 🗑️  Return value cleared from Redis")
			} catch (error) {
				console.error("🎯 FunctionRegistry: Error clearing return value from Redis:", error)
			}
		} else {
			// Fallback to in-memory storage
			console.log("🎯 FunctionRegistry: 🗑️  Registry size before:", this.returnValues.size)

			const existed = this.returnValues.has(executionId)
			this.returnValues.delete(executionId)

			console.log("🎯 FunctionRegistry: 🗑️  Value existed?", existed)
			console.log("🎯 FunctionRegistry: 🗑️  Registry size after:", this.returnValues.size)
		}
	}

	pushCurrentFunctionExecution(executionId: string): void {
		console.log("🎯 FunctionRegistry: Pushing function execution to stack:", executionId)
		console.log("🎯 FunctionRegistry: Stack before push:", this.currentFunctionExecutionStack)
		this.currentFunctionExecutionStack.push(executionId)
		console.log("🎯 FunctionRegistry: Stack after push:", this.currentFunctionExecutionStack)
	}

	getCurrentFunctionExecution(): string | null {
		const current = this.currentFunctionExecutionStack[this.currentFunctionExecutionStack.length - 1] ?? null
		console.log("🎯 FunctionRegistry: Getting current function execution:", current)
		console.log("🎯 FunctionRegistry: Current stack:", this.currentFunctionExecutionStack)
		return current
	}

	popCurrentFunctionExecution(): string | null {
		const popped = this.currentFunctionExecutionStack.pop() ?? null
		console.log("🎯 FunctionRegistry: Popped function execution from stack:", popped)
		console.log("🎯 FunctionRegistry: Stack after pop:", this.currentFunctionExecutionStack)
		return popped
	}

	clearCurrentFunctionExecution(): void {
		console.log("🎯 FunctionRegistry: Clearing entire function execution stack")
		console.log("🎯 FunctionRegistry: Stack before clear:", this.currentFunctionExecutionStack)
		this.currentFunctionExecutionStack = []
	}

	generateNestedCallId(baseExecutionId: string): string {
		const nestedId = `${baseExecutionId}_nested_${this.nextCallId++}`
		console.log("🎯 FunctionRegistry: Generated nested call ID:", nestedId, "from base:", baseExecutionId)
		return nestedId
	}

	getCurrentCallContext(): string | undefined {
		return this.callContextStack[this.callContextStack.length - 1]
	}

	getAllReturnValues(): Map<string, any> {
		console.log("🎯 FunctionRegistry: Getting all return values, total entries:", this.returnValues.size)
		for (const [key, value] of this.returnValues.entries()) {
			console.log("🎯 FunctionRegistry: Return value entry:", key, "=", value)
		}
		return new Map(this.returnValues)
	}

	// Promise-based return handling methods
	createReturnPromise(executionId: string): Promise<any> {
		console.log("🎯 FunctionRegistry: ⭐ Creating return promise for execution:", executionId)

		if (this.returnPromises.has(executionId)) {
			console.warn("🎯 FunctionRegistry: ⚠️  Promise already exists for execution:", executionId)
			return this.waitForReturn(executionId)
		}

		return new Promise((resolve, reject) => {
			console.log("🎯 FunctionRegistry: ⭐ Promise created, storing resolve/reject handlers")
			this.returnPromises.set(executionId, { resolve, reject })
		})
	}

	waitForReturn(executionId: string): Promise<any> {
		console.log("🎯 FunctionRegistry: 🔍 Getting return promise for execution:", executionId)

		// Check if value is already available (for immediate returns)
		const existingValue = this.returnValues.get(executionId)
		if (existingValue !== undefined) {
			console.log("🎯 FunctionRegistry: 🔍 Return value already available:", existingValue)
			return Promise.resolve(existingValue)
		}

		// Check if promise exists
		const promiseHandlers = this.returnPromises.get(executionId)
		if (!promiseHandlers) {
			console.log("🎯 FunctionRegistry: 🔍 No promise found, creating new one")
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
		console.log("🎯 FunctionRegistry: ✅ Resolving return promise for execution:", executionId, "with value:", value)

		// Store the value using the new async method
		await this.setFunctionReturnValue(executionId, value)

		// Resolve the promise if it exists
		const promiseHandlers = this.returnPromises.get(executionId)
		if (promiseHandlers) {
			console.log("🎯 FunctionRegistry: ✅ Promise found, resolving...")
			promiseHandlers.resolve(value)
			this.returnPromises.delete(executionId)
			console.log("🎯 FunctionRegistry: ✅ Promise resolved and cleaned up")
		} else {
			console.log("🎯 FunctionRegistry: 🟡 No promise found for execution, value stored for later retrieval")
		}
	}

	rejectReturn(executionId: string, error: any): void {
		console.log("🎯 FunctionRegistry: ❌ Rejecting return promise for execution:", executionId, "with error:", error)

		// Reject the promise if it exists
		const promiseHandlers = this.returnPromises.get(executionId)
		if (promiseHandlers) {
			console.log("🎯 FunctionRegistry: ❌ Promise found, rejecting...")
			promiseHandlers.reject(error)
			this.returnPromises.delete(executionId)
			console.log("🎯 FunctionRegistry: ❌ Promise rejected and cleaned up")
		} else {
			console.log("🎯 FunctionRegistry: 🟡 No promise found for execution, error not propagated")
		}
	}

	cleanupReturnPromise(executionId: string): void {
		console.log("🎯 FunctionRegistry: 🗑️  Cleaning up return promise for execution:", executionId)
		this.returnPromises.delete(executionId)
	}

	// Cleanup method for graceful shutdown
	async cleanup(): Promise<void> {
		console.log("🎯 FunctionRegistry: Starting cleanup...")
		await this.disconnectRedis()
		this.listeners.clear()
		this.returnValues.clear()
		this.returnPromises.clear()
		this.currentFunctionExecutionStack = []
		this.callContextStack = []
		console.log("🎯 FunctionRegistry: Cleanup completed")
	}
}

export { FunctionRegistry, type ParameterDefinition }
