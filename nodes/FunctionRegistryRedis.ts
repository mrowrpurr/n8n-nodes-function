import { createClient, RedisClientType } from "redis"
import { INodeExecutionData } from "n8n-workflow"

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

interface FunctionMetadata {
	functionName: string
	executionId: string
	nodeId: string
	parameters: ParameterDefinition[]
}

class FunctionRegistryRedis {
	private static instance: FunctionRegistryRedis
	private client: RedisClientType | null = null
	private listeners: Map<string, FunctionListener> = new Map()
	private currentFunctionExecutionStack: string[] = []
	private nextCallId: number = 1
	private callContextStack: string[] = []
	private returnPromises: Map<string, { resolve: (value: any) => void; reject: (error: any) => void }> = new Map()
	private redisHost: string = "redis"
	private redisPort: number = 6379
	private isConnected: boolean = false

	static getInstance(): FunctionRegistryRedis {
		if (!FunctionRegistryRedis.instance) {
			FunctionRegistryRedis.instance = new FunctionRegistryRedis()
		}
		return FunctionRegistryRedis.instance
	}

	private async ensureRedisConnection(): Promise<void> {
		if (this.client && this.isConnected) {
			return
		}

		try {
			console.log("🔴 FunctionRegistryRedis: Connecting to Redis at", `redis://${this.redisHost}:${this.redisPort}`)
			this.client = createClient({
				url: `redis://${this.redisHost}:${this.redisPort}`,
				socket: {
					reconnectStrategy: (retries: number) => Math.min(retries * 50, 500),
				},
			})
			;(this.client as any).on("error", (err: any) => {
				console.error("🔴 FunctionRegistryRedis: Redis Client Error", err)
				this.isConnected = false
			})
			;(this.client as any).on("connect", () => {
				console.log("🔴 FunctionRegistryRedis: Redis Client Connected")
				this.isConnected = true
			})
			;(this.client as any).on("disconnect", () => {
				console.log("🔴 FunctionRegistryRedis: Redis Client Disconnected")
				this.isConnected = false
			})

			await this.client.connect()
			this.isConnected = true
			console.log("🔴 FunctionRegistryRedis: Successfully connected to Redis")
		} catch (error) {
			console.error("🔴 FunctionRegistryRedis: Failed to connect to Redis:", error)
			this.isConnected = false
			throw error
		}
	}

	setRedisConfig(host: string, port: number = 6379): void {
		console.log("🔴 FunctionRegistryRedis: Setting Redis config:", host, port)
		this.redisHost = host
		this.redisPort = port
		// Reset connection to use new config
		this.isConnected = false
		if (this.client) {
			this.client.disconnect().catch(console.error)
			this.client = null
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
		console.log("🎯 FunctionRegistryRedis: Registering function:", key)
		console.log("🎯 FunctionRegistryRedis: Parameters:", parameters)

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
			}

			const redisKey = `function:${executionId}:${functionName}`
			await this.client.set(redisKey, JSON.stringify(metadata))
			console.log("🎯 FunctionRegistryRedis: Function metadata stored in Redis:", redisKey)
		} catch (error) {
			console.error("🎯 FunctionRegistryRedis: Failed to store function metadata in Redis:", error)
			// Continue with in-memory only if Redis fails
		}

		// Subscribe to the function call channel for cross-process calls
		try {
			await this.ensureRedisConnection()
			if (!this.client) throw new Error("Redis client not available")
			const callChannel = `function-call:${functionName}:${executionId}`
			const subscriber = this.client.duplicate()
			await subscriber.connect()
			await subscriber.subscribe(callChannel, async (message) => {
				console.log("🎯 FunctionRegistryRedis: Received function call request on", callChannel, message)
				try {
					const req = JSON.parse(message)
					const { callId, parameters, inputItem, responseChannel } = req
					console.log("🎯 FunctionRegistryRedis: Executing callback for callId", callId)
					const result = await callback(parameters, inputItem)
					const response = {
						result,
						actualExecutionId: callId,
					}
					console.log("🎯 FunctionRegistryRedis: Publishing function result to", responseChannel)
					await this.client!.publish(responseChannel, JSON.stringify(response))
				} catch (err) {
					console.error("🎯 FunctionRegistryRedis: Error handling function call request:", err)
				}
			})
			console.log("🎯 FunctionRegistryRedis: Subscribed to function call channel:", callChannel)
		} catch (err) {
			console.error("🎯 FunctionRegistryRedis: Error subscribing to function call channel:", err)
		}
	}

	async unregisterFunction(functionName: string, executionId: string): Promise<void> {
		const key = `${functionName}-${executionId}`
		console.log("🎯 FunctionRegistryRedis: Unregistering function:", key)

		// Remove from memory
		this.listeners.delete(key)

		// Remove from Redis
		try {
			await this.ensureRedisConnection()
			if (!this.client) throw new Error("Redis client not available")

			const redisKey = `function:${executionId}:${functionName}`
			await this.client.del(redisKey)
			console.log("🎯 FunctionRegistryRedis: Function metadata removed from Redis:", redisKey)
		} catch (error) {
			console.error("🎯 FunctionRegistryRedis: Failed to remove function metadata from Redis:", error)
		}
	}

	async callFunction(
		functionName: string,
		executionId: string,
		parameters: Record<string, any>,
		inputItem: INodeExecutionData
	): Promise<{ result: INodeExecutionData[] | null; actualExecutionId: string }> {
		const key = `${functionName}-${executionId}`
		console.log("🔧 FunctionRegistryRedis: Looking for function:", key)

		// First try to find the function in memory (same process)
		let listener = this.listeners.get(key)

		if (listener) {
			// Local callback: execute directly
			const uniqueCallId = `${executionId}_call_${this.nextCallId++}`
			console.log("🔧 FunctionRegistryRedis: Generated unique call ID:", uniqueCallId, "for function:", key)
			console.log("🔧 FunctionRegistryRedis: Calling function:", key, "with parameters:", parameters)
			try {
				this.callContextStack.push(uniqueCallId)
				console.log("🔧 FunctionRegistryRedis: Pushed call context:", uniqueCallId, "Stack:", this.callContextStack)
				const result = await listener.callback(parameters, inputItem)
				console.log("🔧 FunctionRegistryRedis: Function result:", result)
				const poppedCallId = this.callContextStack.pop()
				console.log("🔧 FunctionRegistryRedis: Popped call context:", poppedCallId, "Stack:", this.callContextStack)
				return { result, actualExecutionId: uniqueCallId }
			} catch (error) {
				console.error("🔧 FunctionRegistryRedis: Error calling function:", error)
				this.callContextStack.pop()
				throw error
			}
		}

		// Not local: cross-process call via Redis pub/sub
		console.log("🔧 FunctionRegistryRedis: Function not found in memory, attempting cross-process call via Redis...")
		await this.ensureRedisConnection()
		if (!this.client) throw new Error("Redis client not available")

		const callId = `call_${Date.now()}_${Math.floor(Math.random() * 100000)}`
		const requestChannel = `function-call:${functionName}:${executionId}`
		const responseChannel = `function-response:${callId}`

		// Publish the call request
		const callRequest = {
			callId,
			functionName,
			executionId,
			parameters,
			inputItem,
			responseChannel,
		}
		console.log("🔧 FunctionRegistryRedis: Publishing call request to", requestChannel, callRequest)

		// Set up a subscriber for the response
		const subscriber = this.client.duplicate()
		await subscriber.connect()

		const responsePromise = new Promise<{ result: INodeExecutionData[] | null; actualExecutionId: string }>((resolve, reject) => {
			const timeout = setTimeout(() => {
				console.error("🔧 FunctionRegistryRedis: Timeout waiting for function response on", responseChannel)
				subscriber.unsubscribe(responseChannel)
				subscriber.disconnect()
				resolve({ result: null, actualExecutionId: executionId })
			}, 30000) // 30s timeout

			subscriber.subscribe(responseChannel, (message) => {
				console.log("🔧 FunctionRegistryRedis: Received function response on", responseChannel, message)
				clearTimeout(timeout)
				try {
					const parsed = JSON.parse(message)
					resolve({ result: parsed.result, actualExecutionId: parsed.actualExecutionId })
				} catch (err) {
					console.error("🔧 FunctionRegistryRedis: Error parsing function response:", err)
					resolve({ result: null, actualExecutionId: executionId })
				}
				subscriber.unsubscribe(responseChannel)
				subscriber.disconnect()
			})
		})

		// Publish the call request
		await this.client.publish(requestChannel, JSON.stringify(callRequest))

		return responsePromise
	}

	listFunctions(): void {
		console.log("🎯 FunctionRegistryRedis: Registered functions (in memory):")
		for (const [key, listener] of this.listeners.entries()) {
			console.log(`  - ${key}: ${listener.functionName} (node: ${listener.nodeId})`)
		}
	}

	async getAvailableFunctions(executionId?: string): Promise<Array<{ name: string; value: string }>> {
		const functionNames = new Set<string>()

		// Get functions from memory (local process)
		for (const listener of this.listeners.values()) {
			if (executionId && listener.executionId !== executionId) {
				continue
			}
			functionNames.add(listener.functionName)
		}

		// Get functions from Redis (other processes)
		try {
			await this.ensureRedisConnection()
			if (this.client) {
				const pattern = executionId ? `function:${executionId}:*` : `function:*`
				const keys = await this.client.keys(pattern)

				for (const key of keys) {
					const parts = key.split(":")
					if (parts.length >= 3) {
						const functionName = parts.slice(2).join(":") // Handle function names with colons
						functionNames.add(functionName)
					}
				}
			}
		} catch (error) {
			console.error("🎯 FunctionRegistryRedis: Error getting functions from Redis:", error)
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

			// Try Redis
			try {
				await this.ensureRedisConnection()
				if (this.client) {
					const redisKey = `function:${executionId}:${functionName}`
					const metadataJson = await this.client.get(redisKey)
					if (metadataJson) {
						const metadata: FunctionMetadata = JSON.parse(metadataJson)
						return metadata.parameters
					}
				}
			} catch (error) {
				console.error("🎯 FunctionRegistryRedis: Error getting function parameters from Redis:", error)
			}
		}

		// Look for the function with __active__ execution ID first
		const activeKey = `${functionName}-__active__`
		const activeListener = this.listeners.get(activeKey)
		if (activeListener) {
			return activeListener.parameters
		}

		// Try Redis for __active__
		try {
			await this.ensureRedisConnection()
			if (this.client) {
				const redisKey = `function:__active__:${functionName}`
				const metadataJson = await this.client.get(redisKey)
				if (metadataJson) {
					const metadata: FunctionMetadata = JSON.parse(metadataJson)
					return metadata.parameters
				}
			}
		} catch (error) {
			console.error("🎯 FunctionRegistryRedis: Error getting __active__ function parameters from Redis:", error)
		}

		// If not found, look for any instance of this function
		for (const listener of this.listeners.values()) {
			if (listener.functionName === functionName) {
				return listener.parameters
			}
		}

		// Try Redis for any instance
		try {
			await this.ensureRedisConnection()
			if (this.client) {
				const keys = await this.client.keys(`function:*:${functionName}`)
				if (keys.length > 0) {
					const metadataJson = await this.client.get(keys[0])
					if (metadataJson) {
						const metadata: FunctionMetadata = JSON.parse(metadataJson)
						return metadata.parameters
					}
				}
			}
		} catch (error) {
			console.error("🎯 FunctionRegistryRedis: Error getting any function parameters from Redis:", error)
		}

		return []
	}

	async setFunctionReturnValue(executionId: string, returnValue: any): Promise<void> {
		console.log("🎯 FunctionRegistryRedis: ⭐ SETTING return value for execution:", executionId)
		console.log("🎯 FunctionRegistryRedis: ⭐ Return value being stored:", returnValue)

		try {
			await this.ensureRedisConnection()
			if (!this.client) throw new Error("Redis client not available")

			const redisKey = `return:${executionId}`
			await this.client.set(redisKey, JSON.stringify(returnValue), { EX: 300 }) // 5 minute expiry
			console.log("🎯 FunctionRegistryRedis: ⭐ Return value stored in Redis:", redisKey)

			// Publish to notify waiting processes
			await this.client.publish(`return-pubsub:${executionId}`, JSON.stringify(returnValue))
			console.log("🎯 FunctionRegistryRedis: ⭐ Return value published to pubsub")
		} catch (error) {
			console.error("🎯 FunctionRegistryRedis: Failed to store return value in Redis:", error)
		}
	}

	async getFunctionReturnValue(executionId: string): Promise<any | null> {
		console.log("🎯 FunctionRegistryRedis: 🔍 GETTING return value for execution:", executionId)

		try {
			await this.ensureRedisConnection()
			if (!this.client) throw new Error("Redis client not available")

			const redisKey = `return:${executionId}`
			const returnValueJson = await this.client.get(redisKey)

			if (returnValueJson) {
				const returnValue = JSON.parse(returnValueJson)
				console.log("🎯 FunctionRegistryRedis: 🔍 Return value found in Redis:", returnValue)
				return returnValue
			}
		} catch (error) {
			console.error("🎯 FunctionRegistryRedis: Error getting return value from Redis:", error)
		}

		console.log("🎯 FunctionRegistryRedis: 🔍 No return value found")
		return null
	}

	async clearFunctionReturnValue(executionId: string): Promise<void> {
		console.log("🎯 FunctionRegistryRedis: 🗑️  CLEARING return value for execution:", executionId)

		try {
			await this.ensureRedisConnection()
			if (!this.client) throw new Error("Redis client not available")

			const redisKey = `return:${executionId}`
			await this.client.del(redisKey)
			console.log("🎯 FunctionRegistryRedis: 🗑️  Return value cleared from Redis")
		} catch (error) {
			console.error("🎯 FunctionRegistryRedis: Error clearing return value from Redis:", error)
		}
	}

	pushCurrentFunctionExecution(executionId: string): void {
		console.log("🎯 FunctionRegistryRedis: Pushing function execution to stack:", executionId)
		console.log("🎯 FunctionRegistryRedis: Stack before push:", this.currentFunctionExecutionStack)
		this.currentFunctionExecutionStack.push(executionId)
		console.log("🎯 FunctionRegistryRedis: Stack after push:", this.currentFunctionExecutionStack)
	}

	getCurrentFunctionExecution(): string | null {
		const current = this.currentFunctionExecutionStack[this.currentFunctionExecutionStack.length - 1] ?? null
		console.log("🎯 FunctionRegistryRedis: Getting current function execution:", current)
		console.log("🎯 FunctionRegistryRedis: Current stack:", this.currentFunctionExecutionStack)
		return current
	}

	popCurrentFunctionExecution(): string | null {
		const popped = this.currentFunctionExecutionStack.pop() ?? null
		console.log("🎯 FunctionRegistryRedis: Popped function execution from stack:", popped)
		console.log("🎯 FunctionRegistryRedis: Stack after pop:", this.currentFunctionExecutionStack)
		return popped
	}

	clearCurrentFunctionExecution(): void {
		console.log("🎯 FunctionRegistryRedis: Clearing entire function execution stack")
		console.log("🎯 FunctionRegistryRedis: Stack before clear:", this.currentFunctionExecutionStack)
		this.currentFunctionExecutionStack = []
	}

	generateNestedCallId(baseExecutionId: string): string {
		const nestedId = `${baseExecutionId}_nested_${this.nextCallId++}`
		console.log("🎯 FunctionRegistryRedis: Generated nested call ID:", nestedId, "from base:", baseExecutionId)
		return nestedId
	}

	getCurrentCallContext(): string | undefined {
		return this.callContextStack[this.callContextStack.length - 1]
	}

	async getAllReturnValues(): Promise<Map<string, any>> {
		console.log("🎯 FunctionRegistryRedis: Getting all return values from Redis")
		const returnValues = new Map<string, any>()

		try {
			await this.ensureRedisConnection()
			if (this.client) {
				const keys = await this.client.keys("return:*")
				for (const key of keys) {
					const valueJson = await this.client.get(key)
					if (valueJson) {
						const executionId = key.replace("return:", "")
						returnValues.set(executionId, JSON.parse(valueJson))
					}
				}
			}
		} catch (error) {
			console.error("🎯 FunctionRegistryRedis: Error getting all return values from Redis:", error)
		}

		console.log("🎯 FunctionRegistryRedis: Total return values found:", returnValues.size)
		return returnValues
	}

	// Promise-based return handling methods
	async createReturnPromise(executionId: string): Promise<any> {
		console.log("🎯 FunctionRegistryRedis: ⭐ Creating return promise for execution:", executionId)

		if (this.returnPromises.has(executionId)) {
			console.warn("🎯 FunctionRegistryRedis: ⚠️  Promise already exists for execution:", executionId)
			return this.waitForReturn(executionId)
		}

		return new Promise(async (resolve, reject) => {
			console.log("🎯 FunctionRegistryRedis: ⭐ Promise created, storing resolve/reject handlers")
			this.returnPromises.set(executionId, { resolve, reject })

			// Also set up Redis subscription for cross-process return values
			try {
				await this.ensureRedisConnection()
				if (this.client) {
					const subscriber = this.client.duplicate()
					await subscriber.connect()

					await subscriber.subscribe(`return-pubsub:${executionId}`, (message) => {
						console.log("🎯 FunctionRegistryRedis: ⭐ Received return value via pubsub:", message)
						try {
							const returnValue = JSON.parse(message)
							const promiseHandlers = this.returnPromises.get(executionId)
							if (promiseHandlers) {
								promiseHandlers.resolve(returnValue)
								this.returnPromises.delete(executionId)
							}
						} catch (error) {
							console.error("🎯 FunctionRegistryRedis: Error parsing pubsub message:", error)
						}
						subscriber.disconnect()
					})
				}
			} catch (error) {
				console.error("🎯 FunctionRegistryRedis: Error setting up Redis subscription:", error)
			}
		})
	}

	async waitForReturn(executionId: string): Promise<any> {
		console.log("🎯 FunctionRegistryRedis: 🔍 Getting return promise for execution:", executionId)

		// Check if value is already available in Redis
		const existingValue = await this.getFunctionReturnValue(executionId)
		if (existingValue !== null) {
			console.log("🎯 FunctionRegistryRedis: 🔍 Return value already available:", existingValue)
			return existingValue
		}

		// Check if promise exists
		const promiseHandlers = this.returnPromises.get(executionId)
		if (!promiseHandlers) {
			console.log("🎯 FunctionRegistryRedis: 🔍 No promise found, creating new one")
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
		console.log("🎯 FunctionRegistryRedis: ✅ Resolving return promise for execution:", executionId, "with value:", value)

		// Store the value in Redis
		await this.setFunctionReturnValue(executionId, value)

		// Resolve the promise if it exists
		const promiseHandlers = this.returnPromises.get(executionId)
		if (promiseHandlers) {
			console.log("🎯 FunctionRegistryRedis: ✅ Promise found, resolving...")
			promiseHandlers.resolve(value)
			this.returnPromises.delete(executionId)
			console.log("🎯 FunctionRegistryRedis: ✅ Promise resolved and cleaned up")
		} else {
			console.log("🎯 FunctionRegistryRedis: 🟡 No promise found for execution, value stored for later retrieval")
		}
	}

	async rejectReturn(executionId: string, error: any): Promise<void> {
		console.log("🎯 FunctionRegistryRedis: ❌ Rejecting return promise for execution:", executionId, "with error:", error)

		// Reject the promise if it exists
		const promiseHandlers = this.returnPromises.get(executionId)
		if (promiseHandlers) {
			console.log("🎯 FunctionRegistryRedis: ❌ Promise found, rejecting...")
			promiseHandlers.reject(error)
			this.returnPromises.delete(executionId)
			console.log("🎯 FunctionRegistryRedis: ❌ Promise rejected and cleaned up")
		} else {
			console.log("🎯 FunctionRegistryRedis: 🟡 No promise found for execution, error not propagated")
		}
	}

	cleanupReturnPromise(executionId: string): void {
		console.log("🎯 FunctionRegistryRedis: 🗑️  Cleaning up return promise for execution:", executionId)
		this.returnPromises.delete(executionId)
	}

	async disconnect(): Promise<void> {
		if (this.client && this.isConnected) {
			await this.client.disconnect()
			this.isConnected = false
			console.log("🎯 FunctionRegistryRedis: Disconnected from Redis")
		}
	}
}

export { FunctionRegistryRedis, type ParameterDefinition }
