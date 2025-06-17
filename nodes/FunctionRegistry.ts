import { isQueueModeEnabled, RedisConfig } from "./FunctionRegistryFactory"
import { functionRegistryLogger as logger } from "./Logger"
import { RedisConnectionManager } from "./RedisConnectionManager"
import { CircuitBreaker } from "./CircuitBreaker"

export interface FunctionDefinition {
	name: string
	scope: string
	code: string
	parameters: FunctionParameter[]
	workflowId: string
	nodeId: string
}

export interface FunctionParameter {
	name: string
	type: string
	required: boolean
	description?: string
}

export interface CallResult {
	success: boolean
	result?: any
	error?: string
	actualExecutionId?: string
}

export interface WorkerInfo {
	id: string
	functionName: string
	scope: string
	lastSeen: number
	isHealthy: boolean
}

/**
 * Production-hardened Function Registry with Redis-based coordination
 * Eliminates race conditions and provides robust function management
 */
export class FunctionRegistry {
	private static instance: FunctionRegistry | null = null
	private connectionManager: RedisConnectionManager
	private circuitBreaker: CircuitBreaker
	private returnValues: Map<string, any> = new Map()
	private readonly WORKER_TIMEOUT = 30000 // 30 seconds
	private readonly CALL_TIMEOUT = 300000 // 5 minutes
	private readonly STREAM_READY_TIMEOUT = 5000 // 5 seconds

	constructor(redisConfig: RedisConfig) {
		this.connectionManager = RedisConnectionManager.getInstance(redisConfig)
		this.circuitBreaker = new CircuitBreaker({
			failureThreshold: 3,
			recoveryTimeout: 30000,
			monitoringPeriod: 300000,
			halfOpenMaxCalls: 2,
		})
		logger.log("🏗️ REGISTRY: Function registry initialized with hardened architecture")
	}

	/**
	 * Get singleton instance
	 */
	static getInstance(redisConfig?: RedisConfig): FunctionRegistry {
		if (!FunctionRegistry.instance && redisConfig) {
			FunctionRegistry.instance = new FunctionRegistry(redisConfig)
		}
		if (!FunctionRegistry.instance) {
			throw new Error("FunctionRegistry not initialized")
		}
		return FunctionRegistry.instance
	}

	/**
	 * Register a function with robust state management
	 */
	async registerFunction(definition: FunctionDefinition): Promise<void> {
		if (!isQueueModeEnabled()) {
			logger.log("🏗️ REGISTRY: Queue mode disabled, skipping function registration")
			return
		}

		await this.circuitBreaker.execute(async () => {
			await this.connectionManager.executeOperation(async (client) => {
				const functionKey = `function:${definition.name}:${definition.scope}`
				const registryKey = `registry:functions`

				// Store function definition
				await client.hSet(functionKey, {
					name: definition.name,
					scope: definition.scope,
					code: definition.code,
					parameters: JSON.stringify(definition.parameters),
					workflowId: definition.workflowId,
					nodeId: definition.nodeId,
					registeredAt: Date.now().toString(),
				})

				// Add to global registry
				await client.sAdd(registryKey, `${definition.name}:${definition.scope}`)

				// Set expiration
				await client.expire(functionKey, 3600) // 1 hour

				logger.log("🏗️ REGISTRY: ✅ Function registered:", definition.name, "scope:", definition.scope)
			}, `register-function-${definition.name}`)
		}, `register-function-${definition.name}`)
	}

	/**
	 * Unregister a function
	 */
	async unregisterFunction(functionName: string, scope: string): Promise<void> {
		if (!isQueueModeEnabled()) {
			return
		}

		await this.circuitBreaker.execute(async () => {
			await this.connectionManager.executeOperation(async (client) => {
				const functionKey = `function:${functionName}:${scope}`
				const registryKey = `registry:functions`

				// Remove from global registry
				await client.sRem(registryKey, `${functionName}:${scope}`)

				// Remove function definition
				await client.del(functionKey)

				// Clean up workers for this function
				const workersKey = `workers:${functionName}`
				const workers = await client.sMembers(workersKey)
				for (const workerId of workers) {
					const workerKey = `worker:${workerId}:${functionName}`
					await client.del(workerKey)
				}
				await client.del(workersKey)

				logger.log("🏗️ REGISTRY: ✅ Function unregistered:", functionName, "scope:", scope)
			}, `unregister-function-${functionName}`)
		}, `unregister-function-${functionName}`)
	}

	/**
	 * Clean up stale functions (functions without active workers)
	 */
	async cleanupStaleFunctions(): Promise<number> {
		if (!isQueueModeEnabled()) {
			return 0
		}

		return await this.circuitBreaker.execute(async () => {
			return await this.connectionManager.executeOperation(async (client) => {
				const registryKey = `registry:functions`
				const functionKeys = await client.sMembers(registryKey)
				let cleanedCount = 0

				for (const functionKey of functionKeys) {
					const [name, scope] = functionKey.split(":")
					const workersKey = `workers:${name}`
					const workers = await client.sMembers(workersKey)

					// Check if any workers are healthy
					let hasHealthyWorkers = false
					for (const workerId of workers) {
						const isHealthy = await this.isWorkerHealthy(workerId, name)
						if (isHealthy) {
							hasHealthyWorkers = true
							break
						}
					}

					// If no healthy workers, remove the function
					if (!hasHealthyWorkers && workers.length === 0) {
						await this.unregisterFunction(name, scope)
						cleanedCount++
						logger.log("🏗️ REGISTRY: ✅ Cleaned up stale function:", name, "scope:", scope)
					}
				}

				return cleanedCount
			}, `cleanup-stale-functions`)
		}, `cleanup-stale-functions`)
	}

	/**
	 * Get available functions for a workflow
	 */
	async getAvailableFunctions(workflowId: string): Promise<Array<{ name: string; value: string; description: string }>> {
		if (!isQueueModeEnabled()) {
			return []
		}

		return await this.circuitBreaker.execute(async () => {
			return await this.connectionManager.executeOperation(async (client) => {
				const registryKey = `registry:functions`
				const functionKeys = await client.sMembers(registryKey)
				const functions: Array<{ name: string; value: string; description: string }> = []

				for (const functionKey of functionKeys) {
					const [name, scope] = functionKey.split(":")
					const fullKey = `function:${name}:${scope}`
					const functionData = await client.hGetAll(fullKey)

					if (functionData && functionData.workflowId === workflowId) {
						functions.push({
							name: `${name} (${scope})`,
							value: name,
							description: `Function: ${name}, Scope: ${scope}`,
						})
					}
				}

				logger.log("🏗️ REGISTRY: Available functions for workflow", workflowId, ":", functions.length)
				return functions
			}, `get-available-functions-${workflowId}`)
		}, `get-available-functions-${workflowId}`)
	}

	/**
	 * Get function parameters
	 */
	async getFunctionParameters(functionName: string, workflowId: string): Promise<FunctionParameter[]> {
		if (!isQueueModeEnabled()) {
			return []
		}

		return await this.circuitBreaker.execute(async () => {
			return await this.connectionManager.executeOperation(async (client) => {
				// Find function by name and workflow
				const registryKey = `registry:functions`
				const functionKeys = await client.sMembers(registryKey)

				for (const functionKey of functionKeys) {
					const [name, scope] = functionKey.split(":")
					if (name === functionName) {
						const fullKey = `function:${name}:${scope}`
						const functionData = await client.hGetAll(fullKey)

						if (functionData && functionData.workflowId === workflowId) {
							try {
								const parameters = JSON.parse(functionData.parameters || "[]")
								logger.log("🏗️ REGISTRY: Function parameters for", functionName, ":", parameters)
								return parameters
							} catch (error) {
								logger.error("🏗️ REGISTRY: Error parsing parameters:", error)
								return []
							}
						}
					}
				}

				return []
			}, `get-function-parameters-${functionName}`)
		}, `get-function-parameters-${functionName}`)
	}

	/**
	 * Add a function call to Redis stream
	 */
	async addCall(streamKey: string, callId: string, functionName: string, parameters: any, item: any, responseChannel: string): Promise<void> {
		await this.circuitBreaker.execute(async () => {
			await this.connectionManager.executeOperation(async (client) => {
				const callData = {
					callId,
					functionName,
					input: JSON.stringify(parameters),
					item: JSON.stringify(item),
					responseChannel,
					timestamp: Date.now().toString(),
				}

				await client.xAdd(streamKey, "*", callData)
				logger.log("🏗️ REGISTRY: ✅ Call added to stream:", callId)
			}, `add-call-${callId}`)
		}, `add-call-${callId}`)
	}

	/**
	 * Wait for function response
	 */
	async waitForResponse(responseChannel: string, timeout: number = this.CALL_TIMEOUT): Promise<{ success: boolean; data?: any; error?: string }> {
		return await this.circuitBreaker.execute(async () => {
			return await this.connectionManager.executeOperation(async (client) => {
				const startTime = Date.now()

				while (timeout === 0 || Date.now() - startTime < timeout) {
					// Check for result in Redis key
					const resultKey = `result:${responseChannel.replace("function:response:", "")}`
					const result = await client.get(resultKey)

					if (result) {
						try {
							const parsedResult = JSON.parse(result)
							logger.log("🏗️ REGISTRY: ✅ Response received:", parsedResult)

							// Clean up the result
							await client.del(resultKey)

							return {
								success: parsedResult.status === "success",
								data: parsedResult.result ? JSON.parse(parsedResult.result) : null,
								error: parsedResult.error,
							}
						} catch (error) {
							logger.error("🏗️ REGISTRY: Error parsing response:", error)
							return { success: false, error: `Failed to parse response: ${error}` }
						}
					}

					// Wait a bit before checking again
					await new Promise((resolve) => setTimeout(resolve, 100))
				}

				// Timeout
				return { success: false, error: "Function call timeout" }
			}, `wait-response-${responseChannel}`)
		}, `wait-response-${responseChannel}`)
	}

	/**
	 * Get available workers for a function
	 */
	async getAvailableWorkers(functionName: string): Promise<string[]> {
		if (!isQueueModeEnabled()) {
			return []
		}

		return await this.circuitBreaker.execute(async () => {
			return await this.connectionManager.executeOperation(async (client) => {
				const workersKey = `workers:${functionName}`
				const workers = await client.sMembers(workersKey)
				logger.log("🏗️ REGISTRY: Available workers for", functionName, ":", workers)
				return workers
			}, `get-workers-${functionName}`)
		}, `get-workers-${functionName}`)
	}

	/**
	 * Register a worker for a function
	 */
	async registerWorker(workerId: string, functionName: string): Promise<void> {
		if (!isQueueModeEnabled()) {
			return
		}

		await this.circuitBreaker.execute(async () => {
			await this.connectionManager.executeOperation(async (client) => {
				const workersKey = `workers:${functionName}`
				const workerKey = `worker:${workerId}:${functionName}`

				// Add worker to the set
				await client.sAdd(workersKey, workerId)

				// Set worker health timestamp
				await client.setEx(workerKey, this.WORKER_TIMEOUT / 1000, Date.now().toString())

				logger.log("🏗️ REGISTRY: ✅ Worker registered:", workerId, "for function:", functionName)
			}, `register-worker-${workerId}`)
		}, `register-worker-${workerId}`)
	}

	/**
	 * Unregister a worker for a function
	 */
	async unregisterWorker(workerId: string, functionName: string): Promise<void> {
		if (!isQueueModeEnabled()) {
			return
		}

		await this.circuitBreaker.execute(async () => {
			await this.connectionManager.executeOperation(async (client) => {
				const workersKey = `workers:${functionName}`
				const workerKey = `worker:${workerId}:${functionName}`

				// Remove worker from the set
				await client.sRem(workersKey, workerId)

				// Remove worker health key
				await client.del(workerKey)

				logger.log("🏗️ REGISTRY: ✅ Worker unregistered:", workerId, "for function:", functionName)
			}, `unregister-worker-${workerId}`)
		}, `unregister-worker-${workerId}`)
	}

	/**
	 * Update worker health timestamp
	 */
	async updateWorkerHealth(workerId: string, functionName: string): Promise<void> {
		if (!isQueueModeEnabled()) {
			return
		}

		await this.circuitBreaker.execute(async () => {
			await this.connectionManager.executeOperation(async (client) => {
				const workerKey = `worker:${workerId}:${functionName}`
				await client.setEx(workerKey, this.WORKER_TIMEOUT / 1000, Date.now().toString())
			}, `update-worker-health-${workerId}`)
		}, `update-worker-health-${workerId}`)
	}

	/**
	 * Check if worker is healthy
	 */
	async isWorkerHealthy(workerId: string, functionName: string): Promise<boolean> {
		if (!isQueueModeEnabled()) {
			return false
		}

		return await this.circuitBreaker.execute(async () => {
			return await this.connectionManager.executeOperation(async (client) => {
				const workerKey = `worker:${workerId}:${functionName}`
				const lastSeen = await client.get(workerKey)

				if (!lastSeen) {
					return false
				}

				const age = Date.now() - parseInt(lastSeen)
				const isHealthy = age < this.WORKER_TIMEOUT

				logger.log("🏗️ REGISTRY: Worker health check:", workerId, "age:", age, "healthy:", isHealthy)
				return isHealthy
			}, `check-worker-${workerId}`)
		}, `check-worker-${workerId}`)
	}

	/**
	 * Wait for stream to be ready
	 */
	async waitForStreamReady(streamKey: string, groupName: string, timeout: number = this.STREAM_READY_TIMEOUT): Promise<boolean> {
		return await this.circuitBreaker.execute(async () => {
			return await this.connectionManager.executeOperation(async (client) => {
				const startTime = Date.now()

				while (Date.now() - startTime < timeout) {
					try {
						// Check if group exists and has consumers
						const groups = await client.xInfoGroups(streamKey)
						const group = groups.find((g: any) => g.name === groupName)

						if (group && group.consumers > 0) {
							logger.log("🏗️ REGISTRY: ✅ Stream ready:", streamKey, "consumers:", group.consumers)
							return true
						}
					} catch (error) {
						// Stream or group might not exist yet
						logger.log("🏗️ REGISTRY: Stream not ready yet:", error.message)
					}

					await new Promise((resolve) => setTimeout(resolve, 100))
				}

				logger.log("🏗️ REGISTRY: ❌ Stream not ready after timeout:", streamKey)
				return false
			}, `wait-stream-ready-${streamKey}`)
		}, `wait-stream-ready-${streamKey}`)
	}

	/**
	 * Cleanup stale workers
	 */
	async cleanupStaleWorkers(functionName: string, timeout: number = this.WORKER_TIMEOUT): Promise<number> {
		if (!isQueueModeEnabled()) {
			return 0
		}

		return await this.circuitBreaker.execute(async () => {
			return await this.connectionManager.executeOperation(async (client) => {
				const workersKey = `workers:${functionName}`
				const workers = await client.sMembers(workersKey)
				let cleanedCount = 0

				for (const workerId of workers) {
					const workerKey = `worker:${workerId}:${functionName}`
					const lastSeen = await client.get(workerKey)

					if (!lastSeen || Date.now() - parseInt(lastSeen) > timeout) {
						await client.sRem(workersKey, workerId)
						await client.del(workerKey)
						cleanedCount++
						logger.log("🏗️ REGISTRY: ✅ Cleaned up stale worker:", workerId)
					}
				}

				return cleanedCount
			}, `cleanup-workers-${functionName}`)
		}, `cleanup-workers-${functionName}`)
	}

	/**
	 * Detect missing consumer
	 */
	async detectMissingConsumer(functionName: string, scope: string): Promise<{ needsRecovery: boolean; reason: string }> {
		if (!isQueueModeEnabled()) {
			return { needsRecovery: false, reason: "Queue mode disabled" }
		}

		return await this.circuitBreaker.execute(async () => {
			return await this.connectionManager.executeOperation(async (client) => {
				const streamKey = `function_calls:${functionName}:${scope}`
				const groupName = `function_group:${functionName}:${scope}`

				try {
					// Check if group exists
					const groups = await client.xInfoGroups(streamKey)
					const group = groups.find((g: any) => g.name === groupName)

					if (!group) {
						return { needsRecovery: true, reason: "Consumer group does not exist" }
					}

					if (group.consumers === 0) {
						return { needsRecovery: true, reason: "No active consumers in group" }
					}

					return { needsRecovery: false, reason: "Consumer group is healthy" }
				} catch (error) {
					if (error.message.includes("no such key")) {
						return { needsRecovery: true, reason: "Stream does not exist" }
					}
					throw error
				}
			}, `detect-missing-consumer-${functionName}`)
		}, `detect-missing-consumer-${functionName}`)
	}

	/**
	 * Attempt function recovery
	 */
	async attemptFunctionRecovery(functionName: string, scope: string): Promise<boolean> {
		if (!isQueueModeEnabled()) {
			return false
		}

		return await this.circuitBreaker.execute(async () => {
			return await this.connectionManager.executeOperation(async (client) => {
				const streamKey = `function_calls:${functionName}:${scope}`
				const groupName = `function_group:${functionName}:${scope}`

				try {
					// Ensure stream exists
					await client.xAdd(streamKey, "*", { recovery: "ping", timestamp: Date.now().toString() })

					// Ensure group exists
					try {
						await client.xGroupCreate(streamKey, groupName, "0", { MKSTREAM: true })
					} catch (error) {
						if (!error.message.includes("BUSYGROUP")) {
							throw error
						}
					}

					logger.log("🏗️ REGISTRY: ✅ Recovery attempt completed for:", functionName)
					return true
				} catch (error) {
					logger.error("🏗️ REGISTRY: ❌ Recovery attempt failed:", error)
					return false
				}
			}, `recover-function-${functionName}`)
		}, `recover-function-${functionName}`)
	}

	/**
	 * Store function return value
	 */
	setFunctionReturnValue(callId: string, value: any): void {
		this.returnValues.set(callId, value)
		logger.log("🏗️ REGISTRY: ✅ Return value stored for call:", callId)
	}

	/**
	 * Get function return value
	 */
	async getFunctionReturnValue(callId: string): Promise<any> {
		const value = this.returnValues.get(callId)
		logger.log("🏗️ REGISTRY: Return value retrieved for call:", callId, "value:", value)
		return value || null
	}

	/**
	 * Clear function return value
	 */
	async clearFunctionReturnValue(callId: string): Promise<void> {
		this.returnValues.delete(callId)
		logger.log("🏗️ REGISTRY: ✅ Return value cleared for call:", callId)
	}

	/**
	 * Direct function call (fallback for non-queue mode)
	 */
	async callFunction(functionName: string, scope: string, parameters: any, item: any): Promise<CallResult> {
		// This is a fallback method for non-queue mode
		// In the new architecture, all calls should go through Redis streams
		logger.log("🏗️ REGISTRY: Direct function call not supported in hardened architecture")
		return {
			success: false,
			error: "Direct function calls not supported. Use queue mode with Redis streams.",
		}
	}

	/**
	 * Publish response (for ReturnFromFunction compatibility)
	 */
	async publishResponse(responseChannel: string, response: any): Promise<void> {
		await this.circuitBreaker.execute(async () => {
			await this.connectionManager.executeOperation(async (client) => {
				const callId = responseChannel.replace("function:response:", "")
				const resultData = {
					callId,
					result: JSON.stringify(response.data),
					error: response.error,
					timestamp: Date.now(),
					status: response.success ? "success" : "error",
				}

				await client.setEx(`result:${callId}`, 300, JSON.stringify(resultData))
				logger.log("🏗️ REGISTRY: ✅ Response published for:", callId)
			}, `publish-response-${responseChannel}`)
		}, `publish-response-${responseChannel}`)
	}

	/**
	 * Acknowledge call (for ReturnFromFunction compatibility)
	 */
	async acknowledgeCall(streamKey: string, groupName: string, messageId: string): Promise<void> {
		await this.circuitBreaker.execute(async () => {
			await this.connectionManager.executeOperation(async (client) => {
				await client.xAck(streamKey, groupName, messageId)
				logger.log("🏗️ REGISTRY: ✅ Call acknowledged:", messageId)
			}, `ack-call-${messageId}`)
		}, `ack-call-${messageId}`)
	}

	/**
	 * Mark response sent (for ReturnFromFunction compatibility)
	 */
	async markResponseSent(callId: string): Promise<void> {
		logger.log("🏗️ REGISTRY: Response marked as sent:", callId)
		// This is handled by publishResponse in the new architecture
	}

	/**
	 * Pop current function execution (for ReturnFromFunction compatibility)
	 */
	popCurrentFunctionExecution(): void {
		logger.log("🏗️ REGISTRY: Function execution popped (compatibility method)")
		// This is handled by the new lifecycle manager
	}

	/**
	 * Resolve return (for ReturnFromFunction compatibility)
	 */
	async resolveReturn(callId: string, value: any): Promise<void> {
		this.setFunctionReturnValue(callId, value)
		logger.log("🏗️ REGISTRY: ✅ Return resolved for:", callId)
	}

	/**
	 * Health check
	 */
	async healthCheck(): Promise<{ healthy: boolean; details: any }> {
		const connectionHealth = await this.connectionManager.healthCheck()
		const circuitBreakerMetrics = this.circuitBreaker.getMetrics()

		return {
			healthy: connectionHealth.healthy && this.circuitBreaker.isHealthy(),
			details: {
				connection: connectionHealth,
				circuitBreaker: circuitBreakerMetrics,
				returnValues: this.returnValues.size,
			},
		}
	}

	/**
	 * Shutdown gracefully
	 */
	async shutdown(): Promise<void> {
		logger.log("🏗️ REGISTRY: Shutting down function registry...")
		await this.connectionManager.shutdown()
		this.returnValues.clear()
		logger.log("🏗️ REGISTRY: ✅ Function registry shutdown completed")
	}
}
