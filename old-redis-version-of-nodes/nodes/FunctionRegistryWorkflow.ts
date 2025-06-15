import { createClient, RedisClientType } from "redis"
import { INodeExecutionData, INode, IConnections } from "n8n-workflow"

interface ParameterDefinition {
	name: string
	type: string
	required: boolean
	defaultValue: string
	description: string
}

interface SerializedFunctionDefinition {
	functionName: string
	workflowId: string
	isGlobal: boolean
	parameters: ParameterDefinition[]
	nodes: INode[]
	connections: IConnections
	startNodeId: string
	returnNodeId?: string
	createdAt: string
	enableCode: boolean
	jsCode?: string
}

/**
 * Workflow-based Function Registry
 *
 * This registry stores complete function workflow definitions in Redis,
 * allowing any worker process to load and execute functions locally
 * using n8n's internal workflow execution engine.
 *
 * Benefits:
 * - True cross-process function execution
 * - No memory coupling between processes
 * - Uses n8n's battle-tested workflow engine
 * - Stateless and portable functions
 */
class FunctionRegistryWorkflow {
	private static instance: FunctionRegistryWorkflow
	private client: RedisClientType | null = null
	private currentFunctionExecutionStack: string[] = []
	private nextCallId: number = 1
	private callContextStack: string[] = []
	private returnPromises: Map<string, { resolve: (value: any) => void; reject: (error: any) => void }> = new Map()
	private redisHost: string = "redis"
	private redisPort: number = 6379
	private isConnected: boolean = false
	// Compatibility property - not used in workflow registry but required for type compatibility
	// @ts-ignore - Required for type compatibility with other registries
	private listeners: Map<string, any> = new Map()

	static getInstance(): FunctionRegistryWorkflow {
		if (!FunctionRegistryWorkflow.instance) {
			FunctionRegistryWorkflow.instance = new FunctionRegistryWorkflow()
		}
		return FunctionRegistryWorkflow.instance
	}

	private async ensureRedisConnection(): Promise<void> {
		if (this.client && this.isConnected) {
			return
		}

		try {
			console.log("🔴 FunctionRegistryWorkflow: Connecting to Redis at", `redis://${this.redisHost}:${this.redisPort}`)
			this.client = createClient({
				url: `redis://${this.redisHost}:${this.redisPort}`,
			})

			await this.client.connect()
			this.isConnected = true
			console.log("🔴 FunctionRegistryWorkflow: Successfully connected to Redis")
		} catch (error) {
			console.error("🔴 FunctionRegistryWorkflow: Failed to connect to Redis:", error)
			this.isConnected = false
			throw error
		}
	}

	setRedisConfig(host: string, port: number = 6379): void {
		console.log("🔴 FunctionRegistryWorkflow: Setting Redis config:", host, port)
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
	 * Register a function by storing its workflow metadata in Redis
	 */
	async registerFunction(
		functionName: string,
		executionId: string,
		nodeId: string,
		parameters: ParameterDefinition[],
		callback: (parameters: Record<string, any>, inputItem: INodeExecutionData) => Promise<INodeExecutionData[]>,
		workflowNodes?: INode[],
		workflowConnections?: IConnections,
		enableCode?: boolean,
		jsCode?: string,
		workflowId?: string // Add actual workflow ID parameter
	): Promise<void> {
		// Use provided workflowId or extract from executionId
		const actualWorkflowId = workflowId || (executionId === "__global__" ? "__global__" : executionId === "__active__" ? "__active__" : executionId?.split("_")[0] || "default")
		const isGlobal = executionId === "__global__"
		console.log("🎯 FunctionRegistryWorkflow: Registering function:", functionName, "workflow:", actualWorkflowId, "global:", isGlobal)

		try {
			await this.ensureRedisConnection()
			if (!this.client) throw new Error("Redis client not available")

			// Create simplified function definition - we only need metadata since we'll use executeWorkflow
			const functionDefinition: SerializedFunctionDefinition = {
				functionName,
				workflowId: actualWorkflowId,
				isGlobal,
				parameters,
				nodes: [], // Don't store full workflow - we'll use executeWorkflow API
				connections: {},
				startNodeId: nodeId,
				createdAt: new Date().toISOString(),
				enableCode: enableCode || false,
				jsCode: jsCode || "",
			}

			// Store in Redis with simple keys
			const redisKey = isGlobal ? `function:global:${functionName}` : `function:workflow:${actualWorkflowId}:${functionName}`
			await this.client.set(redisKey, JSON.stringify(functionDefinition), { EX: 3600 }) // 1 hour expiry
			console.log("🎯 FunctionRegistryWorkflow: Function metadata stored in Redis:", redisKey)
			console.log("🎯 FunctionRegistryWorkflow: Will use executeWorkflow API with workflow ID:", actualWorkflowId)
		} catch (error) {
			console.error("🎯 FunctionRegistryWorkflow: Failed to store function metadata in Redis:", error)
		}
	}

	/**
	 * Unregister a function by removing it from Redis
	 */
	async unregisterFunction(functionName: string, executionId: string): Promise<void> {
		const workflowId = executionId === "__global__" ? "__global__" : executionId === "__active__" ? "__active__" : executionId?.split("_")[0] || "default"
		const isGlobal = executionId === "__global__"
		console.log("🎯 FunctionRegistryWorkflow: Unregistering function:", functionName)

		try {
			await this.ensureRedisConnection()
			if (!this.client) throw new Error("Redis client not available")

			const redisKey = isGlobal ? `function:global:${functionName}` : `function:workflow:${workflowId}:${functionName}`
			await this.client.del(redisKey)
			console.log("🎯 FunctionRegistryWorkflow: Function definition removed from Redis:", redisKey)
		} catch (error) {
			console.error("🎯 FunctionRegistryWorkflow: Failed to remove function definition from Redis:", error)
		}
	}

	/**
	 * Call a function by executing its workflow using n8n's executeWorkflow API
	 */
	async callFunction(
		functionName: string,
		workflowId: string,
		parameters: Record<string, any>,
		inputItem: INodeExecutionData,
		executeFunctions?: any // IExecuteFunctions context for calling executeWorkflow
	): Promise<{ result: INodeExecutionData[] | null; callId: string }> {
		console.log("🔧 FunctionRegistryWorkflow: Looking for function:", functionName, "in workflow:", workflowId)

		// Generate unique call ID for this invocation
		const callId = `${workflowId}_${functionName}_${this.nextCallId++}`
		console.log("🔧 FunctionRegistryWorkflow: Generated call ID:", callId)

		try {
			await this.ensureRedisConnection()
			if (!this.client) throw new Error("Redis client not available")

			let definitionJson: string | null = null
			let foundKey: string | null = null

			if (workflowId === "__active__") {
				// For __active__, search across all workflows for this function
				console.log("🔧 FunctionRegistryWorkflow: __active__ mode - searching all workflows for function:", functionName)
				const allWorkflowKeys = await this.client.keys(`function:workflow:*:${functionName}`)
				console.log("🔧 FunctionRegistryWorkflow: Found workflow function keys:", allWorkflowKeys)

				// Try to get the function from any workflow
				for (const key of allWorkflowKeys) {
					definitionJson = await this.client.get(key)
					if (definitionJson) {
						foundKey = key
						console.log("🔧 FunctionRegistryWorkflow: Found function definition in key:", key)
						break
					}
				}
			} else {
				// For specific workflow ID, search only that workflow first
				const workflowKey = `function:workflow:${workflowId}:${functionName}`
				console.log("🔧 FunctionRegistryWorkflow: Specific workflow mode - checking key:", workflowKey)
				definitionJson = await this.client.get(workflowKey)
				if (definitionJson) {
					foundKey = workflowKey
				}
			}

			// If not found in workflows, try global
			if (!definitionJson) {
				const globalKey = `function:global:${functionName}`
				console.log("🔧 FunctionRegistryWorkflow: Checking global key:", globalKey)
				definitionJson = await this.client.get(globalKey)
				if (definitionJson) {
					foundKey = globalKey
				}
			}

			if (!definitionJson) {
				console.log("🔧 FunctionRegistryWorkflow: Function not found:", functionName)
				return { result: null, callId }
			}

			const functionDefinition: SerializedFunctionDefinition = JSON.parse(definitionJson)
			console.log("🔧 FunctionRegistryWorkflow: Function definition loaded from Redis key:", foundKey)

			// Use n8n's executeWorkflow API but with recursion protection
			if (executeFunctions && typeof executeFunctions.executeWorkflow === "function") {
				console.log("🔧 FunctionRegistryWorkflow: Executing workflow via n8n's executeWorkflow API")

				// Prepare input data with function parameters and recursion marker
				const workflowInputData = [
					{
						json: {
							...inputItem.json,
							...parameters,
							_functionCall: {
								functionName,
								callId,
								parameters,
								// Add marker to prevent recursion
								_isInternalFunctionCall: true,
							},
						},
						binary: inputItem.binary,
					},
				]

				const workflowInfo = {
					id: functionDefinition.workflowId,
				}

				console.log("🔧 FunctionRegistryWorkflow: Executing workflow with ID:", functionDefinition.workflowId)
				const executionResult = await executeFunctions.executeWorkflow(workflowInfo, workflowInputData)

				console.log("🔧 FunctionRegistryWorkflow: Workflow execution completed:", executionResult)

				// Return the workflow execution results
				return {
					result: executionResult.data || [],
					callId,
				}
			} else {
				console.warn("🔧 FunctionRegistryWorkflow: No executeWorkflow context available, falling back to local execution")
				// Fallback to local execution if no executeWorkflow context
				const result = await this.executeFunction(functionDefinition, parameters, inputItem, callId)
				return { result, callId }
			}
		} catch (error) {
			console.error("🔧 FunctionRegistryWorkflow: Error calling function:", error)
			return { result: null, callId }
		}
	}

	/**
	 * Execute a function locally using its stored workflow definition
	 */
	private async executeFunction(
		functionDefinition: SerializedFunctionDefinition,
		parameters: Record<string, any>,
		inputItem: INodeExecutionData,
		callId: string
	): Promise<INodeExecutionData[]> {
		console.log("🔧 FunctionRegistryWorkflow: Executing function:", functionDefinition.functionName)

		// Push the call ID to the stack
		this.callContextStack.push(callId)
		this.currentFunctionExecutionStack.push(callId)

		try {
			// Process parameters according to function definition
			const locals: Record<string, any> = {}

			for (const param of functionDefinition.parameters) {
				const paramName = param.name
				const paramType = param.type
				const required = param.required
				const defaultValue = param.defaultValue

				let value = parameters[paramName]
				console.log("🔧 FunctionRegistryWorkflow: Processing parameter", paramName, "=", value)

				// Handle required parameters
				if (required && (value === undefined || value === null)) {
					throw new Error(`Required parameter '${paramName}' is missing`)
				}

				// Use default value if not provided
				if (value === undefined || value === null) {
					if (defaultValue !== "") {
						try {
							// Try to parse default value based on type
							switch (paramType) {
								case "number":
									value = Number(defaultValue)
									break
								case "boolean":
									value = defaultValue.toLowerCase() === "true"
									break
								case "object":
								case "array":
									value = JSON.parse(defaultValue)
									break
								default:
									value = defaultValue
							}
						} catch (error) {
							value = defaultValue // Fall back to string if parsing fails
						}
					}
				}

				locals[paramName] = value
			}

			console.log("🔧 FunctionRegistryWorkflow: Final locals =", locals)

			// Create the output item
			let outputItem: INodeExecutionData = {
				json: {
					...inputItem.json,
					...locals,
				},
				index: 0,
				binary: inputItem.binary,
			}

			// Execute user code if enabled
			if (functionDefinition.enableCode && functionDefinition.jsCode?.trim()) {
				console.log("🔧 FunctionRegistryWorkflow: Executing JavaScript code")

				try {
					// Execute JavaScript code with parameters as global variables
					const context = {
						...locals,
						item: outputItem.json,
						console: {
							log: (...args: any[]) => console.log("🔧 FunctionRegistryWorkflow Code:", ...args),
							error: (...args: any[]) => console.error("🔧 FunctionRegistryWorkflow Code:", ...args),
							warn: (...args: any[]) => console.warn("🔧 FunctionRegistryWorkflow Code:", ...args),
						},
					}

					// Execute JavaScript code directly
					const wrappedCode = `
						(function() {
							// Set up context variables
							${Object.keys(context)
								.map((key) => `var ${key} = arguments[0]["${key}"];`)
								.join("\n\t\t\t\t\t\t")}
							
							// Execute user code
							${functionDefinition.jsCode}
						})
					`

					const result = eval(wrappedCode)(context)

					console.log("🔧 FunctionRegistryWorkflow: Code execution result =", result)

					// If code returns a value, merge it with the output
					if (result !== undefined) {
						if (typeof result === "object" && result !== null) {
							outputItem.json = {
								...outputItem.json,
								...result,
							}
						} else {
							outputItem.json = {
								...outputItem.json,
								result,
							}
						}
					}
				} catch (error) {
					console.error("🔧 FunctionRegistryWorkflow: Code execution error:", error)
					outputItem.json = {
						...outputItem.json,
						_codeError: error.message,
					}
				}
			}

			console.log("🔧 FunctionRegistryWorkflow: Function execution completed")
			console.log("🔧 FunctionRegistryWorkflow: Final output item =", outputItem)

			return [outputItem]
		} catch (error) {
			console.error("🔧 FunctionRegistryWorkflow: Error executing function:", error)
			throw error
		} finally {
			// Clean up the stacks
			this.callContextStack.pop()
			this.currentFunctionExecutionStack.pop()
		}
	}

	/**
	 * Get available functions with simple lookup
	 */
	async getAvailableFunctions(workflowId: string): Promise<Array<{ name: string; value: string }>> {
		console.log("🎯 FunctionRegistryWorkflow: Getting available functions for workflow:", workflowId)
		const functionNames = new Set<string>()

		try {
			await this.ensureRedisConnection()
			if (this.client) {
				let workflowKeys: string[] = []

				if (workflowId === "__active__") {
					// For __active__, search ALL workflow functions since functions are registered with actual workflow IDs
					console.log("🎯 FunctionRegistryWorkflow: __active__ mode - searching all workflows")
					workflowKeys = await this.client.keys(`function:workflow:*`)
				} else {
					// For specific workflow ID, search only that workflow
					console.log("🎯 FunctionRegistryWorkflow: Specific workflow mode - searching workflow:", workflowId)
					workflowKeys = await this.client.keys(`function:workflow:${workflowId}:*`)
				}

				// Always include global functions
				const globalKeys = await this.client.keys(`function:global:*`)
				console.log("🎯 FunctionRegistryWorkflow: Found workflow keys:", workflowKeys.length, "global keys:", globalKeys.length)

				for (const key of [...workflowKeys, ...globalKeys]) {
					const parts = key.split(":")
					if (parts.length >= 3) {
						const functionName = parts[parts.length - 1] // Last part is function name
						functionNames.add(functionName)
						console.log("🎯 FunctionRegistryWorkflow: Found function:", functionName, "from key:", key)
					}
				}
			}
		} catch (error) {
			console.error("🎯 FunctionRegistryWorkflow: Error getting functions from Redis:", error)
		}

		const result = Array.from(functionNames).map((name) => ({
			name,
			value: name,
		}))
		console.log("🎯 FunctionRegistryWorkflow: Returning available functions:", result)
		return result
	}

	/**
	 * Get function parameters with simple lookup
	 */
	async getFunctionParameters(functionName: string, workflowId: string): Promise<ParameterDefinition[]> {
		console.log("🎯 FunctionRegistryWorkflow: Getting parameters for function:", functionName, "workflow:", workflowId)

		try {
			await this.ensureRedisConnection()
			if (this.client) {
				let definitionJson: string | null = null

				if (workflowId === "__active__") {
					// For __active__, search across all workflows for this function
					console.log("🎯 FunctionRegistryWorkflow: __active__ mode - searching all workflows for function:", functionName)
					const allWorkflowKeys = await this.client.keys(`function:workflow:*:${functionName}`)
					console.log("🎯 FunctionRegistryWorkflow: Found workflow function keys:", allWorkflowKeys)

					// Try to get the function from any workflow
					for (const key of allWorkflowKeys) {
						definitionJson = await this.client.get(key)
						if (definitionJson) {
							console.log("🎯 FunctionRegistryWorkflow: Found function definition in key:", key)
							break
						}
					}
				} else {
					// For specific workflow ID, search only that workflow
					const workflowKey = `function:workflow:${workflowId}:${functionName}`
					console.log("🎯 FunctionRegistryWorkflow: Specific workflow mode - checking key:", workflowKey)
					definitionJson = await this.client.get(workflowKey)
				}

				// If not found in workflows, try global
				if (!definitionJson) {
					const globalKey = `function:global:${functionName}`
					console.log("🎯 FunctionRegistryWorkflow: Checking global key:", globalKey)
					definitionJson = await this.client.get(globalKey)
				}

				if (definitionJson) {
					const definition: SerializedFunctionDefinition = JSON.parse(definitionJson)
					console.log("🎯 FunctionRegistryWorkflow: Found function parameters:", definition.parameters)
					return definition.parameters || []
				}
			}
		} catch (error) {
			console.error("🎯 FunctionRegistryWorkflow: Error getting function parameters from Redis:", error)
		}

		console.log("🎯 FunctionRegistryWorkflow: No parameters found for function:", functionName)
		return []
	}

	/**
	 * Return value handling with call ID
	 */
	async setFunctionReturnValue(callId: string, returnValue: any): Promise<void> {
		console.log("🎯 FunctionRegistryWorkflow: ⭐ SETTING return value for call:", callId)

		try {
			await this.ensureRedisConnection()
			if (!this.client) throw new Error("Redis client not available")

			const redisKey = `return:${callId}`
			await this.client.set(redisKey, JSON.stringify(returnValue), { EX: 300 }) // 5 minute expiry
			console.log("🎯 FunctionRegistryWorkflow: ⭐ Return value stored in Redis:", redisKey)

			// Publish to notify waiting processes
			await this.client.publish(`return-pubsub:${callId}`, JSON.stringify(returnValue))
			console.log("🎯 FunctionRegistryWorkflow: ⭐ Return value published to pubsub")
		} catch (error) {
			console.error("🎯 FunctionRegistryWorkflow: Failed to store return value in Redis:", error)
		}
	}

	async getFunctionReturnValue(callId: string): Promise<any | null> {
		console.log("🎯 FunctionRegistryWorkflow: 🔍 GETTING return value for call:", callId)

		try {
			await this.ensureRedisConnection()
			if (!this.client) throw new Error("Redis client not available")

			const redisKey = `return:${callId}`
			const returnValueJson = await this.client.get(redisKey)

			if (returnValueJson) {
				const returnValue = JSON.parse(returnValueJson)
				console.log("🎯 FunctionRegistryWorkflow: 🔍 Return value found in Redis:", returnValue)
				return returnValue
			}
		} catch (error) {
			console.error("🎯 FunctionRegistryWorkflow: Error getting return value from Redis:", error)
		}

		console.log("🎯 FunctionRegistryWorkflow: 🔍 No return value found")
		return null
	}

	async clearFunctionReturnValue(callId: string): Promise<void> {
		console.log("🎯 FunctionRegistryWorkflow: 🗑️  CLEARING return value for call:", callId)

		try {
			await this.ensureRedisConnection()
			if (!this.client) throw new Error("Redis client not available")

			const redisKey = `return:${callId}`
			await this.client.del(redisKey)
			console.log("🎯 FunctionRegistryWorkflow: 🗑️  Return value cleared from Redis")
		} catch (error) {
			console.error("🎯 FunctionRegistryWorkflow: Error clearing return value from Redis:", error)
		}
	}

	// Stack management
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

	// Promise-based return handling
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
							console.error("🎯 FunctionRegistryWorkflow: Error parsing pubsub message:", error)
						}
						subscriber.disconnect()
					})
				}
			} catch (error) {
				console.error("🎯 FunctionRegistryWorkflow: Error setting up Redis subscription:", error)
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

	async rejectReturn(callId: string, error: any): Promise<void> {
		console.log("🎯 FunctionRegistryWorkflow: ❌ Rejecting return promise for call:", callId, "with error:", error)

		const promiseHandlers = this.returnPromises.get(callId)
		if (promiseHandlers) {
			promiseHandlers.reject(error)
			this.returnPromises.delete(callId)
		}
	}

	cleanupReturnPromise(callId: string): void {
		this.returnPromises.delete(callId)
	}

	// Additional methods for compatibility with other registries
	listFunctions(): void {
		console.log("🎯 FunctionRegistryWorkflow: Registered functions are stored in Redis")
		console.log("🎯 FunctionRegistryWorkflow: Use getAvailableFunctions() to list them")
	}

	clearCurrentFunctionExecution(): void {
		console.log("🎯 FunctionRegistryWorkflow: Clearing entire function execution stack")
		this.currentFunctionExecutionStack = []
	}

	generateNestedCallId(baseExecutionId: string): string {
		const nestedId = `${baseExecutionId}_nested_${this.nextCallId++}`
		console.log("🎯 FunctionRegistryWorkflow: Generated nested call ID:", nestedId, "from base:", baseExecutionId)
		return nestedId
	}

	async getAllReturnValues(): Promise<Map<string, any>> {
		console.log("🎯 FunctionRegistryWorkflow: Getting all return values from Redis")
		const returnValues = new Map<string, any>()

		try {
			await this.ensureRedisConnection()
			if (this.client) {
				const keys = await this.client.keys("return:*")
				for (const key of keys) {
					const valueJson = await this.client.get(key)
					if (valueJson) {
						const callId = key.replace("return:", "")
						returnValues.set(callId, JSON.parse(valueJson))
					}
				}
			}
		} catch (error) {
			console.error("🎯 FunctionRegistryWorkflow: Error getting all return values from Redis:", error)
		}

		console.log("🎯 FunctionRegistryWorkflow: Total return values found:", returnValues.size)
		return returnValues
	}

	async waitForReturn(callId: string): Promise<any> {
		console.log("🎯 FunctionRegistryWorkflow: 🔍 Getting return promise for call:", callId)

		// Check if value is already available in Redis
		const existingValue = await this.getFunctionReturnValue(callId)
		if (existingValue !== null) {
			console.log("🎯 FunctionRegistryWorkflow: 🔍 Return value already available:", existingValue)
			return existingValue
		}

		// Check if promise exists
		const promiseHandlers = this.returnPromises.get(callId)
		if (!promiseHandlers) {
			console.log("🎯 FunctionRegistryWorkflow: 🔍 No promise found, creating new one")
			return this.createReturnPromise(callId)
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

	async disconnect(): Promise<void> {
		if (this.client && this.isConnected) {
			await this.client.disconnect()
			this.isConnected = false
		}
	}
}

export { FunctionRegistryWorkflow, type ParameterDefinition }
