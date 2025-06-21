import { getFunctionRegistry, getEnhancedFunctionRegistry, isQueueModeEnabled, REDIS_KEY_PREFIX } from "../FunctionRegistryFactory"
import { functionRegistryLogger as logger } from "../Logger"
import { EnhancedFunctionRegistry } from "../EnhancedFunctionRegistry"

export interface FunctionCallOptions {
	functionName: string
	workflowId: string
	parameters: Record<string, any>
	inputData?: any
	timeout?: number
}

export interface FunctionCallResult {
	success: boolean
	data?: any
	error?: string
	metadata?: {
		callId?: string
		executionId?: string
		mode: "in-memory" | "queue"
	}
}

export class FunctionCallService {
	private static logger = logger

	/**
	 * Main function calling method - extracted from CallFunction.execute()
	 */
	static async callFunction(options: FunctionCallOptions): Promise<FunctionCallResult> {
		const { functionName, workflowId, parameters } = options

		try {
			// Validate inputs (extracted from CallFunction validation logic)
			await this.validateFunctionCall(functionName, workflowId, parameters)

			// Detect mode and branch (extracted from CallFunction mode detection)
			const queueModeStatus = isQueueModeEnabled()

			if (!queueModeStatus) {
				return await this.callFunctionInMemory(options)
			} else {
				return await this.callFunctionQueue(options)
			}
		} catch (error) {
			return {
				success: false,
				error: error.message,
				metadata: { mode: isQueueModeEnabled() ? "queue" : "in-memory" },
			}
		}
	}

	/**
	 * In-memory mode function calling (extracted from lines 530-614)
	 */
	private static async callFunctionInMemory(options: FunctionCallOptions): Promise<FunctionCallResult> {
		const { functionName, workflowId, parameters, inputData } = options

		this.logger.log("🔧 FunctionCallService: Using direct in-memory call")

		const registry = await getFunctionRegistry()
		const callResult = await registry.callFunction(functionName, workflowId, parameters, inputData)

		if (!callResult.result) {
			throw new Error(`Function '${functionName}' not found or no workers available`)
		}

		// Extract return value logic (lines 547-592)
		let finalReturnValue = null

		for (const resultItem of callResult.result) {
			if (resultItem.json._functionReturn !== undefined) {
				this.logger.log("🔧 FunctionCallService: Found _functionReturn in result:", resultItem.json._functionReturn)
				finalReturnValue = resultItem.json._functionReturn
				break
			} else {
				// Fallback: try to get return value from registry (old method)
				this.logger.log("🔧 FunctionCallService: No _functionReturn found, trying registry lookup...")

				// Extract the callId from the _functionCall metadata in the result
				let returnValueKey = callResult.actualExecutionId
				if (resultItem.json._functionCall && typeof resultItem.json._functionCall === "object") {
					const functionCallData = resultItem.json._functionCall as any
					if (functionCallData.callId) {
						returnValueKey = functionCallData.callId
						this.logger.log("🔧 FunctionCallService: Using callId from _functionCall metadata:", returnValueKey)
					} else {
						this.logger.log("🔧 FunctionCallService: No callId in _functionCall metadata, using actualExecutionId:", returnValueKey)
					}
				} else {
					this.logger.log("🔧 FunctionCallService: No _functionCall metadata found, using actualExecutionId:", returnValueKey)
				}

				const returnValue = returnValueKey ? await registry.getFunctionReturnValue(returnValueKey) : null
				this.logger.log("🔧 FunctionCallService: Function return value retrieved =", returnValue)

				// Clear the return value from registry after retrieving it
				if (returnValue !== null) {
					this.logger.log("🔧 FunctionCallService: Clearing return value from registry...")
					await registry.clearFunctionReturnValue(returnValueKey!)
					this.logger.log("🔧 FunctionCallService: Return value cleared")
					finalReturnValue = returnValue
					break
				} else {
					// Clean up any _functionCall metadata from the result
					const cleanedJson = { ...resultItem.json }
					delete cleanedJson._functionCall
					delete cleanedJson._functionReturn
					finalReturnValue = cleanedJson
				}
			}
		}

		return {
			success: true,
			data: finalReturnValue,
			metadata: {
				callId: callResult.actualExecutionId,
				mode: "in-memory",
			},
		}
	}

	/**
	 * Queue mode function calling (extracted from lines 616-921)
	 */
	private static async callFunctionQueue(options: FunctionCallOptions): Promise<FunctionCallResult> {
		const { functionName, workflowId, parameters, inputData, timeout = 10000 } = options

		this.logger.log("🌊 FunctionCallService: Using Redis streams for function call")

		const enhancedRegistry = await getEnhancedFunctionRegistry()

		// Try enhanced registry first (lines 660-727)
		if (enhancedRegistry instanceof EnhancedFunctionRegistry) {
			try {
				this.logger.log("⚡ FunctionCallService: Using enhanced registry with instant readiness")

				const response = await enhancedRegistry.callFunctionWithInstantReadiness(functionName, workflowId, parameters, inputData, timeout)

				this.logger.log("⚡ FunctionCallService: Received instant response:", response)

				return {
					success: response.success,
					data: response.data,
					error: response.error,
					metadata: {
						mode: "queue",
					},
				}
			} catch (error) {
				if (error.message.includes("not ready after")) {
					throw new Error(`Function '${functionName}' not available. Function node may not be running.`)
				}
				throw error
			}
		}

		// Fallback to polling logic (lines 735-921)
		return await this.callFunctionQueueFallback(options)
	}

	/**
	 * Queue mode fallback with polling (extracted from lines 735-921)
	 */
	private static async callFunctionQueueFallback(options: FunctionCallOptions): Promise<FunctionCallResult> {
		const { functionName, workflowId, parameters, inputData } = options

		this.logger.log("🔄 FunctionCallService: Falling back to polling logic")

		const registry = await getFunctionRegistry()

		// Worker availability and health check logic (lines 736-861)
		const healthyWorkers = await this.ensureHealthyWorkers(functionName, registry)

		if (healthyWorkers.length === 0) {
			throw new Error(`Function '${functionName}' has no healthy workers available`)
		}

		this.logger.log("🌊 FunctionCallService: Healthy workers available:", healthyWorkers.length)

		// Stream call logic (lines 865-920)
		const callId = `call-${Date.now()}-${Math.random().toString(36).slice(2)}`
		const responseChannel = `${REDIS_KEY_PREFIX}function:response:${callId}`
		const streamKey = `${REDIS_KEY_PREFIX}function_calls:${functionName}:${workflowId}`

		this.logger.log("🌊 FunctionCallService: Call ID:", callId)
		this.logger.log("🌊 FunctionCallService: Stream key:", streamKey)
		this.logger.log("🌊 FunctionCallService: Response channel:", responseChannel)

		// Check if stream is ready before making the call
		const groupName = `${REDIS_KEY_PREFIX}function_group:${functionName}:${workflowId}`
		const startTime = Date.now()
		const isReady = await registry.waitForStreamReady(streamKey, groupName, 3000) // 3 seconds
		const checkDuration = Date.now() - startTime

		this.logger.log("🔍 FunctionCallService: Stream ready check completed")
		this.logger.log("🔍 FunctionCallService: Is ready:", isReady)
		this.logger.log("🔍 FunctionCallService: Check duration:", checkDuration, "ms")

		if (!isReady) {
			this.logger.warn("🔍 FunctionCallService: Stream not ready after 3000ms - consumer may have issues")
		}

		// Add call to stream
		await registry.addCall(streamKey, callId, functionName, parameters, inputData, responseChannel)

		this.logger.log("🌊 FunctionCallService: Call added to stream, waiting for response...")

		// Wait for response with NO timeout - will wait forever until ReturnFromFunction responds
		const response = await registry.waitForResponse(responseChannel, 0) // 0 = infinite wait

		this.logger.log("🌊 FunctionCallService: Received response:", response)

		return {
			success: response.success,
			data: response.data,
			error: response.error,
			metadata: {
				callId,
				mode: "queue",
			},
		}
	}

	/**
	 * Validation logic extracted from CallFunction
	 */
	private static async validateFunctionCall(functionName: string, workflowId: string, parameters: Record<string, any>): Promise<void> {
		if (!workflowId) {
			throw new Error("Workflow ID is required")
		}

		if (!functionName || functionName === "__no_functions__" || functionName === "__no_workflow_selected__" || functionName === "__activate_workflow__") {
			throw new Error("Please select a valid function")
		}

		// Parameter validation (lines 448-508)
		const registry = await getFunctionRegistry()
		const functionParameterDefs = await registry.getFunctionParameters(functionName, workflowId)
		const validParameterNames = new Set(functionParameterDefs.map((p: any) => p.name))

		// Validate all provided parameters are valid for this function
		for (const paramName of Object.keys(parameters)) {
			if (!validParameterNames.has(paramName)) {
				throw new Error(`Invalid parameter '${paramName}' for function '${functionName}'`)
			}
		}
	}

	/**
	 * Worker health management (extracted from lines 775-861)
	 */
	private static async ensureHealthyWorkers(functionName: string, registry: any): Promise<string[]> {
		let availableWorkers = await registry.getAvailableWorkers(functionName)
		let retryCount = 0
		const maxRetries = 4
		const retryDelay = 1000

		// Retry logic for worker availability
		while (availableWorkers.length === 0 && retryCount < maxRetries) {
			this.logger.log(`🔄 FunctionCallService: No workers found (attempt ${retryCount + 1}/${maxRetries})`)
			await new Promise((resolve) => setTimeout(resolve, retryDelay))
			availableWorkers = await registry.getAvailableWorkers(functionName)
			retryCount++
		}

		if (availableWorkers.length === 0) {
			throw new Error(`Function '${functionName}' not found or no workers available after ${maxRetries} retries`)
		}

		// CRITICAL: Clean up stale workers BEFORE health check to prevent accumulation
		this.logger.log(`🧹 FunctionCallService: Cleaning up stale workers for function ${functionName} before health check`)
		const cleanedStaleCount = await registry.cleanupStaleWorkers(functionName, 30000) // 30 second timeout
		if (cleanedStaleCount > 0) {
			this.logger.log(`🧹 FunctionCallService: Cleaned up ${cleanedStaleCount} stale workers before health check`)
			// Refresh worker list after cleanup
			availableWorkers = await registry.getAvailableWorkers(functionName)
		}

		// Enhanced worker health check with diagnostic logging
		const healthyWorkers = []
		const staleWorkers = []

		this.logger.log(`🔍 FunctionCallService: Checking health of ${availableWorkers.length} workers for function ${functionName}`)
		for (const workerId of availableWorkers) {
			const isHealthy = await registry.isWorkerHealthy(workerId, functionName)
			this.logger.log("🔍 FunctionCallService: Worker health check - Worker:", workerId, "Healthy:", isHealthy)
			if (isHealthy) {
				healthyWorkers.push(workerId)
			} else {
				staleWorkers.push(workerId)
			}
		}

		// Log diagnostic information
		if (staleWorkers.length > 0) {
			this.logger.log(`🧹 FunctionCallService: Found ${staleWorkers.length} remaining stale workers: [${staleWorkers.join(", ")}]`)
		}
		this.logger.log(`✅ FunctionCallService: Found ${healthyWorkers.length} healthy workers: [${healthyWorkers.join(", ")}]`)

		// RECOVERY MECHANISM: If no healthy workers, attempt recovery
		if (healthyWorkers.length === 0) {
			const recoverySuccess = await this.attemptWorkerRecovery(functionName, registry)
			if (!recoverySuccess) {
				throw new Error(`Function '${functionName}' has no healthy workers and recovery failed`)
			}
			// Re-check for healthy workers after recovery
			return await this.ensureHealthyWorkers(functionName, registry)
		}

		return healthyWorkers
	}

	/**
	 * Recovery logic (extracted from lines 812-857)
	 */
	private static async attemptWorkerRecovery(functionName: string, registry: any): Promise<boolean> {
		this.logger.warn("🚨 FunctionCallService: Attempting worker recovery...")

		// Show detailed diagnostics before recovery
		const diagnostics = await registry.listAllWorkersAndFunctions()
		const functionWorkers = diagnostics.workers.filter((w: any) => w.functionName === functionName)
		this.logger.log(`🚨 FunctionCallService: Detailed worker status for function ${functionName}:`)
		functionWorkers.forEach((w: any) => {
			this.logger.log(`🚨 FunctionCallService:   - Worker ${w.workerId}: ${w.isHealthy ? "healthy" : "stale"} (last seen: ${w.lastSeen}, age: ${w.age})`)
		})

		// Clean up stale workers first
		const cleanedCount = await registry.cleanupStaleWorkers(functionName, 30000) // 30 second timeout
		this.logger.log(`🚨 FunctionCallService: Cleaned up ${cleanedCount} stale workers`)

		// Check if the function needs recovery
		const recoveryCheck = await registry.detectMissingConsumer(functionName, functionName)
		this.logger.log(`🚨 FunctionCallService: Recovery check result:`, recoveryCheck)

		if (recoveryCheck.needsRecovery) {
			this.logger.warn(`🚨 FunctionCallService: Function needs recovery - ${recoveryCheck.reason}`)

			// Attempt to recover the function
			const recoverySuccess = await registry.attemptFunctionRecovery(functionName, functionName)

			if (recoverySuccess) {
				this.logger.log("🚨 FunctionCallService: Recovery attempt completed, waiting for function to restart...")

				// Wait a bit for the function to potentially restart
				await new Promise((resolve) => setTimeout(resolve, 2000))

				// Check again for healthy workers
				const newAvailableWorkers = await registry.getAvailableWorkers(functionName)
				const newHealthyWorkers = []
				for (const workerId of newAvailableWorkers) {
					const isHealthy = await registry.isWorkerHealthy(workerId, functionName)
					if (isHealthy) {
						newHealthyWorkers.push(workerId)
					}
				}

				if (newHealthyWorkers.length > 0) {
					this.logger.log("🚨 FunctionCallService: Recovery successful! Found healthy workers:", newHealthyWorkers.length)
					return true
				} else {
					this.logger.error("🚨 FunctionCallService: Recovery failed - still no healthy workers")
					return false
				}
			} else {
				this.logger.error("🚨 FunctionCallService: Recovery attempt failed")
				return false
			}
		}

		return false
	}
}
