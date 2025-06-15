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
	parameters: ParameterDefinition[]
	callback: (parameters: Record<string, any>, inputItem: INodeExecutionData) => Promise<INodeExecutionData[]>
}

/**
 * Simplified Redis-backed Function Registry
 *
 * This version eliminates the complex __active__ vs executionId logic by:
 * 1. Using simple function names as keys (no execution ID prefixes)
 * 2. Storing functions by name only in Redis
 * 3. Using workflow ID for scoping instead of execution ID
 * 4. Automatic cleanup and simpler lookup
 */
class FunctionRegistrySimplified {
	private static instance: FunctionRegistrySimplified
	private client: RedisClientType | null = null
	private listeners: Map<string, FunctionListener> = new Map()
	private currentFunctionExecutionStack: string[] = []
	private nextCallId: number = 1
	private callContextStack: string[] = []
	private returnPromises: Map<string, { resolve: (value: any) => void; reject: (error: any) => void }> = new Map()
	private redisHost: string = "redis"
	private redisPort: number = 6379
	private isConnected: boolean = false

	static getInstance(): FunctionRegistrySimplified {
		if (!FunctionRegistrySimplified.instance) {
			FunctionRegistrySimplified.instance = new FunctionRegistrySimplified()
		}
		return FunctionRegistrySimplified.instance
	}

	private async ensureRedisConnection(): Promise<void> {
		if (this.client && this.isConnected) {
			return
		}

		try {
			console.log("🔴 FunctionRegistrySimplified: Connecting to Redis at", `redis://${this.redisHost}:${this.redisPort}`)
			this.client = createClient({
				url: `redis://${this.redisHost}:${this.redisPort}`,
			})

			await this.client.connect()
			this.isConnected = true
			console.log("🔴 FunctionRegistrySimplified: Successfully connected to Redis")
		} catch (error) {
			console.error("🔴 FunctionRegistrySimplified: Failed to connect to Redis:", error)
			this.isConnected = false
			throw error
		}
	}

	setRedisConfig(host: string, port: number = 6379): void {
		console.log("🔴 FunctionRegistrySimplified: Setting Redis config:", host, port)
		this.redisHost = host
		this.redisPort = port
		// Reset connection to use new config
		this.isConnected = false
		if (this.client) {
			this.client.disconnect().catch(console.error)
			this.client = null
		}
	}

	/**
	 * SIMPLIFIED: Register function by name only
	 * No more complex execution ID logic!
	 */
	async registerFunction(
		functionName: string,
		executionId: string,
		nodeId: string,
		parameters: ParameterDefinition[],
		callback: (parameters: Record<string, any>, inputItem: INodeExecutionData) => Promise<INodeExecutionData[]>
	): Promise<void> {
		// Extract workflowId from executionId or use a default
		const workflowId = executionId === "__global__" ? "__global__" : executionId === "__active__" ? "__active__" : executionId?.split("_")[0] || "default"
		const isGlobal = executionId === "__global__"
		console.log("🎯 FunctionRegistrySimplified: Registering function:", functionName, "workflow:", workflowId, "global:", isGlobal)

		// Store callback in memory (callbacks can't be serialized to Redis)
		this.listeners.set(functionName, {
			functionName,
			parameters,
			callback,
		})

		// Store metadata in Redis with simple keys
		try {
			await this.ensureRedisConnection()
			if (!this.client) throw new Error("Redis client not available")

			const metadata = {
				functionName,
				workflowId,
				isGlobal,
				parameters,
				registeredAt: new Date().toISOString(),
			}

			// Simple Redis keys - no more execution ID complexity!
			const redisKey = isGlobal ? `function:global:${functionName}` : `function:workflow:${workflowId}:${functionName}`
			await this.client.set(redisKey, JSON.stringify(metadata), { EX: 3600 }) // 1 hour expiry
			console.log("🎯 FunctionRegistrySimplified: Function metadata stored in Redis:", redisKey)
		} catch (error) {
			console.error("🎯 FunctionRegistrySimplified: Failed to store function metadata in Redis:", error)
		}
	}

	/**
	 * SIMPLIFIED: Unregister function by name only
	 */
	async unregisterFunction(functionName: string, executionId: string): Promise<void> {
		const workflowId = executionId === "__global__" ? "__global__" : executionId === "__active__" ? "__active__" : executionId?.split("_")[0] || "default"
		const isGlobal = executionId === "__global__"
		console.log("🎯 FunctionRegistrySimplified: Unregistering function:", functionName)

		// Remove from memory
		this.listeners.delete(functionName)

		// Remove from Redis
		try {
			await this.ensureRedisConnection()
			if (!this.client) throw new Error("Redis client not available")

			const redisKey = isGlobal ? `function:global:${functionName}` : `function:workflow:${workflowId}:${functionName}`
			await this.client.del(redisKey)
			console.log("🎯 FunctionRegistrySimplified: Function metadata removed from Redis:", redisKey)
		} catch (error) {
			console.error("🎯 FunctionRegistrySimplified: Failed to remove function metadata from Redis:", error)
		}
	}

	/**
	 * SIMPLIFIED: Call function by name with automatic lookup
	 * No more complex execution ID fallback logic!
	 */
	async callFunction(
		functionName: string,
		workflowId: string,
		parameters: Record<string, any>,
		inputItem: INodeExecutionData
	): Promise<{ result: INodeExecutionData[] | null; callId: string }> {
		console.log("🔧 FunctionRegistrySimplified: Looking for function:", functionName, "in workflow:", workflowId)

		// Generate unique call ID for this invocation
		const callId = `${workflowId}_${functionName}_${this.nextCallId++}`
		console.log("🔧 FunctionRegistrySimplified: Generated call ID:", callId)

		// First try to find the function in memory (same process)
		let listener = this.listeners.get(functionName)

		if (!listener) {
			console.log("🔧 FunctionRegistrySimplified: Function not found in memory, checking Redis...")
			// Try to find function metadata in Redis with simple lookup order:
			// 1. Workflow-specific function
			// 2. Global function
			try {
				await this.ensureRedisConnection()
				if (!this.client) throw new Error("Redis client not available")

				const workflowKey = `function:workflow:${workflowId}:${functionName}`
				const globalKey = `function:global:${functionName}`

				let metadataJson = await this.client.get(workflowKey)
				if (!metadataJson) {
					metadataJson = await this.client.get(globalKey)
				}

				if (metadataJson) {
					console.log("🔧 FunctionRegistrySimplified: Function metadata found in Redis but no local callback")
					console.log("🔧 FunctionRegistrySimplified: This suggests the function is registered in a different process")
					return { result: null, callId }
				}
			} catch (error) {
				console.error("🔧 FunctionRegistrySimplified: Error checking Redis for function:", error)
			}

			console.log("🔧 FunctionRegistrySimplified: Function not found:", functionName)
			return { result: null, callId }
		}

		console.log("🔧 FunctionRegistrySimplified: Calling function:", functionName, "with parameters:", parameters)
		try {
			// Push the call ID to the stack
			this.callContextStack.push(callId)
			console.log("🔧 FunctionRegistrySimplified: Pushed call context:", callId)

			const result = await listener.callback(parameters, inputItem)
			console.log("🔧 FunctionRegistrySimplified: Function result:", result)

			// Pop the call context
			const poppedCallId = this.callContextStack.pop()
			console.log("🔧 FunctionRegistrySimplified: Popped call context:", poppedCallId)

			return { result, callId }
		} catch (error) {
			console.error("🔧 FunctionRegistrySimplified: Error calling function:", error)
			this.callContextStack.pop()
			throw error
		}
	}

	/**
	 * SIMPLIFIED: Get available functions with simple lookup
	 */
	async getAvailableFunctions(workflowId: string): Promise<Array<{ name: string; value: string }>> {
		const functionNames = new Set<string>()

		// Get functions from memory (local process)
		for (const listener of this.listeners.values()) {
			functionNames.add(listener.functionName)
		}

		// Get functions from Redis (other processes)
		try {
			await this.ensureRedisConnection()
			if (this.client) {
				// Get workflow-specific functions
				const workflowKeys = await this.client.keys(`function:workflow:${workflowId}:*`)
				// Get global functions
				const globalKeys = await this.client.keys(`function:global:*`)

				for (const key of [...workflowKeys, ...globalKeys]) {
					const parts = key.split(":")
					if (parts.length >= 3) {
						const functionName = parts[parts.length - 1] // Last part is function name
						functionNames.add(functionName)
					}
				}
			}
		} catch (error) {
			console.error("🎯 FunctionRegistrySimplified: Error getting functions from Redis:", error)
		}

		return Array.from(functionNames).map((name) => ({
			name,
			value: name,
		}))
	}

	/**
	 * SIMPLIFIED: Get function parameters with simple lookup
	 */
	async getFunctionParameters(functionName: string, workflowId: string): Promise<ParameterDefinition[]> {
		// Check memory first
		const listener = this.listeners.get(functionName)
		if (listener) {
			return listener.parameters
		}

		// Check Redis with simple lookup order
		try {
			await this.ensureRedisConnection()
			if (this.client) {
				const workflowKey = `function:workflow:${workflowId}:${functionName}`
				const globalKey = `function:global:${functionName}`

				let metadataJson = await this.client.get(workflowKey)
				if (!metadataJson) {
					metadataJson = await this.client.get(globalKey)
				}

				if (metadataJson) {
					const metadata = JSON.parse(metadataJson)
					return metadata.parameters || []
				}
			}
		} catch (error) {
			console.error("🎯 FunctionRegistrySimplified: Error getting function parameters from Redis:", error)
		}

		return []
	}

	/**
	 * SIMPLIFIED: Return value handling with call ID
	 */
	async setFunctionReturnValue(callId: string, returnValue: any): Promise<void> {
		console.log("🎯 FunctionRegistrySimplified: ⭐ SETTING return value for call:", callId)

		try {
			await this.ensureRedisConnection()
			if (!this.client) throw new Error("Redis client not available")

			const redisKey = `return:${callId}`
			await this.client.set(redisKey, JSON.stringify(returnValue), { EX: 300 }) // 5 minute expiry
			console.log("🎯 FunctionRegistrySimplified: ⭐ Return value stored in Redis:", redisKey)

			// Publish to notify waiting processes
			await this.client.publish(`return-pubsub:${callId}`, JSON.stringify(returnValue))
			console.log("🎯 FunctionRegistrySimplified: ⭐ Return value published to pubsub")
		} catch (error) {
			console.error("🎯 FunctionRegistrySimplified: Failed to store return value in Redis:", error)
		}
	}

	async getFunctionReturnValue(callId: string): Promise<any | null> {
		console.log("🎯 FunctionRegistrySimplified: 🔍 GETTING return value for call:", callId)

		try {
			await this.ensureRedisConnection()
			if (!this.client) throw new Error("Redis client not available")

			const redisKey = `return:${callId}`
			const returnValueJson = await this.client.get(redisKey)

			if (returnValueJson) {
				const returnValue = JSON.parse(returnValueJson)
				console.log("🎯 FunctionRegistrySimplified: 🔍 Return value found in Redis:", returnValue)
				return returnValue
			}
		} catch (error) {
			console.error("🎯 FunctionRegistrySimplified: Error getting return value from Redis:", error)
		}

		console.log("🎯 FunctionRegistrySimplified: 🔍 No return value found")
		return null
	}

	// Simplified stack management
	getCurrentCallContext(): string | undefined {
		return this.callContextStack[this.callContextStack.length - 1]
	}

	pushCurrentFunctionExecution(callId: string): void {
		this.currentFunctionExecutionStack.push(callId)
	}

	getCurrentFunctionExecution(): string | null {
		return this.currentFunctionExecutionStack[this.currentFunctionExecutionStack.length - 1] ?? null
	}

	popCurrentFunctionExecution(): string | null {
		return this.currentFunctionExecutionStack.pop() ?? null
	}

	// Promise-based return handling (simplified)
	async createReturnPromise(callId: string): Promise<any> {
		return new Promise(async (resolve, reject) => {
			this.returnPromises.set(callId, { resolve, reject })

			try {
				await this.ensureRedisConnection()
				if (this.client) {
					const subscriber = this.client.duplicate()
					await subscriber.connect()

					await subscriber.subscribe(`return-pubsub:${callId}`, (message) => {
						try {
							const returnValue = JSON.parse(message)
							const promiseHandlers = this.returnPromises.get(callId)
							if (promiseHandlers) {
								promiseHandlers.resolve(returnValue)
								this.returnPromises.delete(callId)
							}
						} catch (error) {
							console.error("🎯 FunctionRegistrySimplified: Error parsing pubsub message:", error)
						}
						subscriber.disconnect()
					})
				}
			} catch (error) {
				console.error("🎯 FunctionRegistrySimplified: Error setting up Redis subscription:", error)
			}
		})
	}

	async resolveReturn(callId: string, value: any): Promise<void> {
		await this.setFunctionReturnValue(callId, value)

		const promiseHandlers = this.returnPromises.get(callId)
		if (promiseHandlers) {
			promiseHandlers.resolve(value)
			this.returnPromises.delete(callId)
		}
	}

	cleanupReturnPromise(callId: string): void {
		this.returnPromises.delete(callId)
	}

	async disconnect(): Promise<void> {
		if (this.client && this.isConnected) {
			await this.client.disconnect()
			this.isConnected = false
		}
	}
}

export { FunctionRegistrySimplified, type ParameterDefinition }
