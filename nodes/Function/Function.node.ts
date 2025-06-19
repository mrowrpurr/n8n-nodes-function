import { IExecuteFunctions, INodeExecutionData, INodeType, INodeTypeDescription, ITriggerFunctions, ITriggerResponse, NodeOperationError, NodeConnectionType } from "n8n-workflow"

import { functionRegistryLogger as logger } from "../Logger"
import { isQueueModeEnabled, getRedisConfig, getEnhancedFunctionRegistry, REDIS_KEY_PREFIX } from "../FunctionRegistryFactory"
import { ConsumerLifecycleManager, ConsumerConfig } from "../ConsumerLifecycleManager"
import { RedisConnectionManager } from "../RedisConnectionManager"
import { EnhancedFunctionRegistry } from "../EnhancedFunctionRegistry"

export class Function implements INodeType {
	description: INodeTypeDescription = {
		displayName: "Function",
		name: "function",
		icon: "fa:code",
		group: ["trigger"],
		version: 1,
		description: "Define a function that can be called by CallFunction nodes",
		defaults: {
			name: "Function",
		},
		inputs: [],
		outputs: [NodeConnectionType.Main],
		credentials: [],
		triggerPanel: {
			header: "",
			executionsHelp: {
				inactive: "Function nodes are activated automatically when the workflow is active and will process calls from CallFunction nodes.",
				active: "Function node is active and ready to process calls from CallFunction nodes.",
			},
			activationHint: "Once you save the workflow, this Function node will be activated and ready to process calls.",
		},
		properties: [
			{
				displayName: "🏷️ To name your function, rename this Function node in your workflow.",
				name: "functionNamingNotice",
				type: "notice",
				default: "",
			},
			{
				displayName: "Function Description",
				name: "functionDescription",
				type: "string",
				default: "",
				placeholder: "Describe what this function does...",
				description: "Optional description that will be shown in the CallFunction dropdown",
			},
			{
				displayName: "Parameters",
				name: "parameters",
				placeholder: "Add parameter",
				type: "fixedCollection",
				description: "Parameters that this function accepts",
				typeOptions: {
					multipleValues: true,
					sortable: true,
				},
				default: {},
				options: [
					{
						name: "parameter",
						displayName: "Parameter",
						values: [
							{
								displayName: "Default Value",
								name: "defaultValue",
								type: "string",
								default: "",
								placeholder: "Default value (optional)",
								description: "Default value for this parameter",
							},
							{
								displayName: "Description",
								name: "description",
								type: "string",
								default: "",
								placeholder: "Parameter description",
								description: "Description of what this parameter does",
							},
							{
								displayName: "Parameter Name",
								name: "name",
								type: "string",
								default: "",
								placeholder: "parameterName",
								description: "Name of the parameter",
								required: true,
							},
							{
								displayName: "Required",
								name: "required",
								type: "boolean",
								default: false,
								description: "Whether this parameter is required",
							},
							{
								displayName: "Type",
								name: "type",
								type: "options",
								options: [
									{
										name: "Array",
										value: "array",
									},
									{
										name: "Boolean",
										value: "boolean",
									},
									{
										name: "Number",
										value: "number",
									},
									{
										name: "Object",
										value: "object",
									},
									{
										name: "String",
										value: "string",
									},
								],
								default: "string",
								description: "Type of the parameter",
							},
						],
					},
				],
			},
			{
				displayName: "⚠️ IMPORTANT: Add a 'Return from Function' node or your function will run forever!",
				name: "functionReturnNotice",
				type: "notice",
				default: "",
			},
		],
	}

	async trigger(this: ITriggerFunctions): Promise<ITriggerResponse> {
		// Use the node name as the function name
		const functionName = this.getNode().name

		if (!functionName) {
			throw new NodeOperationError(this.getNode(), "Function name is required (set the node name)")
		}

		// Extract function description
		const functionDescription = this.getNodeParameter("functionDescription") as string

		// Extract parameter definitions
		const parametersConfig = this.getNodeParameter("parameters") as any
		const parameters: Array<{
			name: string
			type: string
			required: boolean
			defaultValue: string
			description: string
		}> = []

		if (parametersConfig && parametersConfig.parameter) {
			for (const param of parametersConfig.parameter) {
				parameters.push({
					name: param.name,
					type: param.type,
					required: param.required || false,
					defaultValue: param.defaultValue || "",
					description: param.description || "",
				})
			}
		}

		logger.log("🚀 FUNCTION: ========================================")
		logger.log("🚀 FUNCTION: trigger() called by n8n")
		logger.log("🚀 FUNCTION: This happens during workflow activation or restart")
		logger.log("🚀 FUNCTION: Starting Function node trigger")
		logger.log("🚀 FUNCTION: Function name:", functionName)

		// Check if queue mode is enabled
		if (!isQueueModeEnabled()) {
			logger.log("🚀 FUNCTION: Queue mode disabled, using in-memory registry")

			// For in-memory mode, register function so CallFunction can find it in dropdown
			try {
				const { getFunctionRegistry } = await import("../FunctionRegistryFactory")
				const registry = await getFunctionRegistry()

				const workflowId = this.getWorkflow().id || "unknown"

				// Use the single object parameter interface with execution function
				await registry.registerFunction({
					name: functionName,
					scope: workflowId,
					code: "", // No code - this is a workflow trigger
					parameters: parameters,
					workflowId: workflowId,
					nodeId: this.getNode().id,
					description: functionDescription || "",
					executionFunction: async (callParameters: Record<string, any>, inputItem: any) => {
						logger.log("🚀 FUNCTION: In-memory function called:", functionName, "with parameters:", callParameters)

						// Process parameters according to function definition
						const locals: Record<string, any> = {}

						for (const param of parameters) {
							const paramName = param.name
							const paramType = param.type
							const required = param.required
							const defaultValue = param.defaultValue

							let value = callParameters[paramName]

							// Handle required parameters
							if (required && (value === undefined || value === null)) {
								throw new NodeOperationError(this.getNode(), `Required parameter '${paramName}' is missing`)
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

						// Generate a call ID for in-memory mode to track return values
						const callId = `call-${Date.now()}-${Math.random().toString(36).slice(2)}`

						// Push current function execution context for ReturnFromFunction nodes
						registry.pushCurrentFunctionExecution(callId)

						// Clear any existing return value for this execution
						await registry.clearFunctionReturnValue(callId)

						// Create the output item with proper data structure (like old working version)
						const outputItem: INodeExecutionData = {
							json: {
								...inputItem.json, // Original item data first
								...locals, // Function parameters as separate fields
								_functionCall: {
									callId,
									functionName,
									timestamp: Date.now(),
									// For in-memory mode, we don't need Redis-specific fields
									responseChannel: null,
									messageId: null,
									streamKey: null,
									groupName: null,
								},
							},
							index: 0,
							binary: inputItem.binary,
						}

						logger.log("🚀 FUNCTION: Emitting output item to downstream nodes")
						this.emit([[outputItem]])

						// Function execution complete - ReturnFromFunction node is responsible for handling return value
						logger.log("🚀 FUNCTION: Function execution completed, waiting for ReturnFromFunction node")
						logger.log("🚀 FUNCTION: Call ID:", callId)
						logger.log("🚀 FUNCTION: Note: Function will wait until ReturnFromFunction resolves return value")

						// Wait for ReturnFromFunction to resolve the return value
						const returnValue = await registry.waitForReturn(callId)
						logger.log("🚀 FUNCTION: ✅ Return value received:", returnValue)

						// Return the same structure as queue mode - array of INodeExecutionData
						// The outputItem contains the emitted data, but we need to return the final result
						const finalOutputItem: INodeExecutionData = {
							json: returnValue,
							index: 0,
							binary: inputItem.binary,
						}

						return [finalOutputItem]
					},
				})

				logger.log("🚀 FUNCTION: ✅ Function registered in in-memory registry")
				logger.log("🚀 FUNCTION: ✅ Function available for CallFunction dropdown")

				return {
					closeFunction: async () => {
						logger.log("🚀 FUNCTION: Function node closed (in-memory mode)")
						// Unregister from in-memory registry on close
						try {
							await registry.unregisterFunction(functionName, workflowId)
							logger.log("🚀 FUNCTION: ✅ Function unregistered from in-memory registry")
						} catch (error) {
							logger.warn("🚀 FUNCTION: ⚠️ Error unregistering from in-memory registry:", error)
						}
					},
				}
			} catch (error) {
				logger.error("🚀 FUNCTION: ❌ Failed to register function in in-memory mode:", error)
				return {
					closeFunction: async () => {
						logger.log("🚀 FUNCTION: Function node closed (in-memory mode - registration failed)")
					},
				}
			}
		}

		// CRITICAL: Clean up ALL existing workers for this function before starting
		// This prevents multiple Function node instances from running simultaneously
		try {
			const registry = await getEnhancedFunctionRegistry()

			// Get ALL workers for this function (healthy and stale)
			const allWorkers = await registry.getAvailableWorkers(functionName)
			logger.log(`🚀 FUNCTION: Found ${allWorkers.length} existing workers for ${functionName}: [${allWorkers.join(", ")}]`)

			// Remove ALL existing workers to prevent race conditions
			let cleanedCount = 0
			for (const workerId of allWorkers) {
				try {
					await registry.unregisterWorker(workerId, functionName)
					cleanedCount++
					logger.log(`🚀 FUNCTION: ✅ Removed existing worker: ${workerId}`)
				} catch (error) {
					logger.warn(`🚀 FUNCTION: ⚠️ Failed to remove worker ${workerId}:`, error)
				}
			}

			if (cleanedCount > 0) {
				logger.log(`🚀 FUNCTION: ✅ Cleaned up ${cleanedCount} existing workers to prevent race conditions`)
			}

			// Also clean up any stale workers that might not be in the workers set
			const staleCleanedCount = await registry.cleanupStaleWorkers(functionName)
			if (staleCleanedCount > 0) {
				logger.log(`🚀 FUNCTION: ✅ Cleaned up ${staleCleanedCount} additional stale workers`)
			}
		} catch (error) {
			logger.warn("🚀 FUNCTION: ⚠️ Failed to clean up existing workers on startup:", error)
			// Don't fail startup if cleanup fails, but log it prominently
		}

		let lifecycleManager: ConsumerLifecycleManager | null = null
		let registry: any = null
		let workerId: string | null = null
		let healthUpdateInterval: NodeJS.Timeout | null = null

		try {
			// Get Redis configuration
			const redisConfig = getRedisConfig()
			if (!redisConfig) {
				throw new NodeOperationError(this.getNode(), "Redis configuration not available")
			}

			// Initialize connection manager (singleton, shared across nodes)
			RedisConnectionManager.getInstance(redisConfig)

			// Create consumer configuration
			const workflowId = this.getWorkflow().id || "unknown"
			const consumerConfig: ConsumerConfig = {
				functionName,
				scope: workflowId,
				streamKey: `${REDIS_KEY_PREFIX}function_calls:${functionName}:${workflowId}`,
				groupName: `${REDIS_KEY_PREFIX}function_group:${functionName}:${workflowId}`,
				processId: process.pid.toString(),
				workerId: this.getInstanceId() || "unknown",
			}

			// Create message handler
			const messageHandler = async (messageData: any) => {
				return await processMessage(messageData, this.emit.bind(this))
			}

			// Register function in registry so CallFunction can find it
			registry = await getEnhancedFunctionRegistry()
			await registry.registerFunctionWithNotification({
				name: functionName,
				scope: workflowId,
				code: "", // No code - this is a workflow trigger
				parameters: parameters, // Use extracted parameters
				workflowId: workflowId,
				nodeId: this.getNode().id,
				description: functionDescription || "", // Add the function description
			})
			logger.log("🚀 FUNCTION: ✅ Function registered in registry with instant notifications")

			// Create and start lifecycle manager with notification support for instant wake-up
			const notificationManager = registry instanceof EnhancedFunctionRegistry ? registry["notificationManager"] : undefined

			lifecycleManager = new ConsumerLifecycleManager(consumerConfig, redisConfig, messageHandler, notificationManager)

			if (notificationManager) {
				logger.log("🚀 FUNCTION: ✅ Consumer will use instant wake-up notifications (99.7% less Redis traffic)")
			} else {
				logger.log("🚀 FUNCTION: ⚠️ Consumer will use 30-second polling only")
			}

			await lifecycleManager.start()

			// CRITICAL: Register this node as a worker for the function with instant notifications
			workerId = lifecycleManager.getConsumerId()
			if (workerId && registry instanceof EnhancedFunctionRegistry) {
				await registry.registerWorkerWithInstantNotification(workerId, functionName, workflowId)
				logger.log("🚀 FUNCTION: ✅ Worker registered with instant notifications:", workerId)
				logger.log("🚀 FUNCTION: ✅ Worker is now available for CallFunction to find")

				// Start periodic health updates (every 10 seconds)
				healthUpdateInterval = setInterval(async () => {
					try {
						if (workerId && registry) {
							await registry.updateWorkerHealth(workerId, functionName)
						}
					} catch (error) {
						logger.error("🚀 FUNCTION: ❌ Error updating worker health:", error)
					}
				}, 10000)
				logger.log("🚀 FUNCTION: ✅ Worker health updates started")
			}

			logger.log("🚀 FUNCTION: ✅ Function node started successfully")
			logger.log("🚀 FUNCTION: Consumer ID:", lifecycleManager.getConsumerId())

			return {
				closeFunction: async () => {
					logger.log("🚀 FUNCTION: ========================================")
					logger.log("🚀 FUNCTION: closeFunction() called by n8n")
					logger.log("🚀 FUNCTION: This happens during workflow changes or deactivation")
					logger.log("🚀 FUNCTION: Starting ultra-lightweight shutdown (keep consumer active)...")
					logger.log(`🚀 FUNCTION: Shutting down function: ${functionName}, worker: ${workerId}`)

					try {
						// Stop health updates - prevents worker from being marked healthy during shutdown
						if (healthUpdateInterval) {
							clearInterval(healthUpdateInterval)
							healthUpdateInterval = null
							logger.log("🚀 FUNCTION: ✅ Health updates stopped")
						}

						// DON'T stop the lifecycle manager - keep consumer active to process messages
						// This is the key difference from Redis trigger - we need the consumer to stay alive
						// because CallFunction might send messages immediately after closeFunction
						logger.log("🚀 FUNCTION: ✅ Consumer lifecycle manager kept ACTIVE (not stopped)")
						logger.log("🚀 FUNCTION: ✅ Consumer can still process function calls after closeFunction")

						// ULTRA-LIGHTWEIGHT SHUTDOWN:
						// - Don't unregister workers or clean registry
						// - Don't stop lifecycle manager (keep consumer active)
						// - Only stop health updates
						logger.log("🚀 FUNCTION: ✅ Ultra-lightweight shutdown complete - consumer stays active")
						logger.log("🚀 FUNCTION: Worker remains available and consumer ready for immediate calls")
					} catch (error) {
						logger.error("🚀 FUNCTION: ❌ Error during ultra-lightweight shutdown:", error)
						// Even if cleanup fails, don't prevent n8n from continuing
					}
				},
			}
		} catch (error) {
			logger.error("🚀 FUNCTION: ❌ Failed to start Function node:", error)

			// Clean up any resources that were created before the error
			try {
				logger.log("🚀 FUNCTION: Starting error cleanup...")

				// Stop health updates
				if (healthUpdateInterval) {
					clearInterval(healthUpdateInterval)
					healthUpdateInterval = null
					logger.log("🚀 FUNCTION: ✅ Health updates stopped during error cleanup")
				}

				// Stop lifecycle manager
				if (lifecycleManager) {
					await lifecycleManager.stop()
					logger.log("🚀 FUNCTION: ✅ Lifecycle manager stopped during error cleanup")
				}

				logger.log("🚀 FUNCTION: ✅ Error cleanup completed")
			} catch (cleanupError) {
				logger.error("🚀 FUNCTION: ❌ Error during cleanup:", cleanupError)
			}

			throw new NodeOperationError(this.getNode(), `Failed to start function: ${error}`)
		}
	}

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		// Function nodes are triggers, but n8n may try to execute them during workflow execution
		// When this happens, we should just pass through the input data or return empty data

		logger.log("🚀 FUNCTION: Execute method called (likely during workflow execution)")

		// Get input data if any
		const inputData = this.getInputData()

		if (inputData && inputData.length > 0) {
			// Pass through input data unchanged
			logger.log("🚀 FUNCTION: Passing through input data during workflow execution")
			return [inputData]
		} else {
			// Return empty data to avoid breaking the workflow
			logger.log("🚀 FUNCTION: Returning empty data during workflow execution")
			return [[]]
		}
	}
}

/**
 * Process a message from the Redis stream by emitting data to connected nodes
 */
async function processMessage(messageData: any, emitFunction: (data: INodeExecutionData[][]) => void): Promise<any> {
	const startTime = Date.now()

	try {
		logger.log("🚀 FUNCTION: Processing message:", messageData)

		// Skip initialization messages - they're just for stream setup
		if (messageData.init === "stream_initialization") {
			logger.log("🚀 FUNCTION: ✅ Skipping initialization message")
			return { skipped: true, reason: "initialization_message" }
		}

		// Parse message data
		const { input, callId, item, responseChannel } = messageData

		if (!callId) {
			throw new NodeOperationError(null as any, "Message missing callId")
		}

		// Parse input data
		let parsedInput
		try {
			parsedInput = typeof input === "string" ? JSON.parse(input) : input
		} catch (error) {
			throw new NodeOperationError(null as any, `Failed to parse input data: ${error}`)
		}

		// Parse item data
		let parsedItem
		try {
			parsedItem = typeof item === "string" ? JSON.parse(item) : item
		} catch (error) {
			throw new NodeOperationError(null as any, `Failed to parse item data: ${error}`)
		}

		// Create output item with function call metadata (FIXED: Don't pollute with parsedInput)
		const outputItem: INodeExecutionData = {
			json: {
				...parsedItem.json, // Original item data first (like old working version)
				...parsedInput, // Function parameters as separate fields (not spread at root)
				_functionCall: {
					callId,
					functionName: messageData.functionName,
					responseChannel,
					timestamp: Date.now(),
				},
			},
			pairedItem: parsedItem.pairedItem,
		}

		// Emit data to connected nodes (this is how trigger nodes work)
		logger.log("🚀 FUNCTION: Emitting data to connected nodes with callId:", callId)
		emitFunction([[outputItem]])

		const processingTime = Date.now() - startTime
		logger.log("🚀 FUNCTION: ✅ Data emitted to workflow in", processingTime, "ms")
		logger.log("🚀 FUNCTION: ReturnFromFunction node must send response or call will hang forever")

		// Note: ReturnFromFunction node MUST send the response back
		// If no ReturnFromFunction is used, the call will hang forever (by design)
		return outputItem.json
	} catch (error) {
		const processingTime = Date.now() - startTime
		logger.error("🚀 FUNCTION: ❌ Error processing message:", error, "in", processingTime, "ms")

		// Send error back via Redis
		try {
			const { callId } = messageData
			if (callId) {
				await sendResult(callId, null, String(error))
			}
		} catch (sendError) {
			logger.error("🚀 FUNCTION: ❌ Error sending error result:", sendError)
		}

		throw error
	}
}

/**
 * Send result back via Redis
 */
async function sendResult(callId: string, result: any, error: string | null): Promise<void> {
	try {
		const redisConfig = getRedisConfig()
		if (!redisConfig) {
			throw new NodeOperationError(null as any, "Redis configuration not available")
		}

		const connectionManager = RedisConnectionManager.getInstance(redisConfig)

		await connectionManager.executeOperation(async (client) => {
			const resultData = {
				callId,
				result: result ? JSON.stringify(result) : "",
				error: error || "",
				timestamp: Date.now().toString(),
				status: error ? "error" : "success",
			}

			// Send to result stream
			await client.xAdd(`${REDIS_KEY_PREFIX}function_results:${callId}`, "*", resultData)

			// Also set as a key for immediate retrieval
			await client.setEx(
				`${REDIS_KEY_PREFIX}result:${callId}`,
				300,
				JSON.stringify({
					callId,
					result: result ? JSON.stringify(result) : null,
					error,
					timestamp: Date.now(),
					status: error ? "error" : "success",
				})
			) // 5 minute expiry

			logger.log("🚀 FUNCTION: ✅ Result sent successfully for call:", callId)
		}, `send-result-${callId}`)
	} catch (error) {
		logger.error("🚀 FUNCTION: ❌ Error sending result:", error)
		throw error
	}
}
