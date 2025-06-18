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
		const parameters = []

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

		logger.log("🚀 FUNCTION: Starting Function node trigger")
		logger.log("🚀 FUNCTION: Function name:", functionName)

		// Check if queue mode is enabled
		if (!isQueueModeEnabled()) {
			logger.log("🚀 FUNCTION: Queue mode disabled, function will not process calls")
			return {
				closeFunction: async () => {
					logger.log("🚀 FUNCTION: Function node closed (queue mode disabled)")
				},
			}
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
					logger.log("🔒 PREVENTION: Starting Function node shutdown sequence...")
					logger.log(`🔒 PREVENTION: Shutting down function: ${functionName}, worker: ${workerId}`)

					try {
						// STEP 0: Send shutdown notification to alert CallFunction nodes instantly
						if (registry instanceof EnhancedFunctionRegistry) {
							logger.log("🔒 PREVENTION: Step 0 - Sending shutdown notification for instant restart coordination")
							const notificationManager = registry["notificationManager"]
							if (notificationManager) {
								await notificationManager.publishShutdown(workflowId, "workflow-save-restart")
								logger.log("🔒 PREVENTION: ✅ Shutdown notification sent - CallFunction nodes alerted instantly")
							}
						}

						// STEP 1: Immediately mark worker as unhealthy to prevent new calls
						logger.log("🔒 PREVENTION: Step 1 - Immediately marking worker as unhealthy")
						if (workerId && registry instanceof EnhancedFunctionRegistry) {
							await registry.notifyWorkerHealth(functionName, workflowId, workerId, false, "shutdown-starting")
							logger.log("🔒 PREVENTION: ✅ Worker marked as unhealthy - CallFunction nodes will avoid this worker")
						}

						// STEP 2: Stop health updates to prevent re-marking as healthy
						logger.log("🔒 PREVENTION: Step 2 - Stopping health updates to signal unavailability")
						if (healthUpdateInterval) {
							clearInterval(healthUpdateInterval)
							healthUpdateInterval = null
							logger.log("🔒 PREVENTION: ✅ Worker health updates stopped")
						}

						// STEP 3: Stop the lifecycle manager to stop consuming messages
						logger.log("🔒 PREVENTION: Step 3 - Stopping consumer lifecycle manager")
						if (lifecycleManager) {
							await lifecycleManager.stop()
							logger.log("🔒 PREVENTION: ✅ Consumer lifecycle manager stopped")
						}

						// STEP 4: Wait a moment for any in-flight messages to complete
						logger.log("🔒 PREVENTION: Step 4 - Waiting 2 seconds for in-flight messages to complete")
						await new Promise((resolve) => setTimeout(resolve, 2000))

						// STEP 5: Use enhanced coordinator for graceful shutdown
						if (workerId && registry instanceof EnhancedFunctionRegistry) {
							logger.log("🔒 PREVENTION: Step 5 - Using enhanced coordinator for graceful shutdown")
							await registry.coordinateShutdown(functionName, workflowId, workerId)
							logger.log("🔒 PREVENTION: ✅ Coordinated shutdown complete")
						} else if (workerId && registry) {
							// Fallback to original shutdown sequence
							logger.log("🔒 PREVENTION: Step 5 - Using standard shutdown (fallback)")

							const diagnostics = await registry.listAllWorkersAndFunctions()
							const myWorkers = diagnostics.workers.filter((w: any) => w.functionName === functionName)
							logger.log(`🔒 PREVENTION: Found ${myWorkers.length} total workers for function ${functionName}:`)
							myWorkers.forEach((w: any) => {
								logger.log(`🔒 PREVENTION:   - Worker ${w.workerId}: ${w.isHealthy ? "healthy" : "stale"} (last seen: ${w.lastSeen})`)
							})

							// Unregister this specific worker
							await registry.unregisterWorker(workerId, functionName)
							logger.log("🔒 PREVENTION: ✅ Worker unregistered:", workerId)

							// Wait before function cleanup
							await new Promise((resolve) => setTimeout(resolve, 1000))

							// Unregister function from registry
							await registry.unregisterFunction(functionName, workflowId)
							logger.log("🔒 PREVENTION: ✅ Function unregistered:", functionName)
						}

						// DON'T shutdown the connection manager here - it's shared!
						// The connection manager is a singleton and may be used by other nodes
						logger.log("🔒 PREVENTION: ✅ Function node shutdown sequence completed successfully")
					} catch (error) {
						logger.error("🔒 PREVENTION: ❌ Error during shutdown sequence:", error)

						// Emergency cleanup - try to unregister even if other steps failed
						try {
							if (workerId && registry) {
								await registry.unregisterWorker(workerId, functionName)
								logger.log("🔒 PREVENTION: ✅ Emergency worker cleanup completed")
							}
							if (registry) {
								await registry.unregisterFunction(functionName, workflowId)
								logger.log("🔒 PREVENTION: ✅ Emergency function cleanup completed")
							}
						} catch (emergencyError) {
							logger.error("🔒 PREVENTION: ❌ Emergency cleanup also failed:", emergencyError)
						}
					}
				},
			}
		} catch (error) {
			logger.error("🔒 PREVENTION: ❌ Failed to start Function node:", error)

			// Enhanced cleanup on error with prevention logging
			try {
				logger.log("🔒 PREVENTION: Starting error cleanup sequence...")

				// Stop health updates
				if (healthUpdateInterval) {
					clearInterval(healthUpdateInterval)
					healthUpdateInterval = null
					logger.log("🔒 PREVENTION: ✅ Health updates stopped during error cleanup")
				}

				// Stop lifecycle manager first
				if (lifecycleManager) {
					await lifecycleManager.stop()
					logger.log("🔒 PREVENTION: ✅ Lifecycle manager stopped during error cleanup")
				}

				// Check for any workers that might have been created
				if (workerId && registry) {
					logger.log("🔒 PREVENTION: Checking for workers to clean up during error...")
					const diagnostics = await registry.listAllWorkersAndFunctions()
					const myWorkers = diagnostics.workers.filter((w: any) => w.functionName === functionName)
					logger.log(`🔒 PREVENTION: Found ${myWorkers.length} workers for function ${functionName} during error cleanup`)

					await registry.unregisterWorker(workerId, functionName)
					logger.log("🔒 PREVENTION: ✅ Worker unregistered during error cleanup:", workerId)
				}

				// Clean up function registration if it was created
				if (registry && functionName) {
					await registry.unregisterFunction(functionName, this.getWorkflow().id || "unknown")
					logger.log("🔒 PREVENTION: ✅ Function unregistered during error cleanup:", functionName)
				}

				// DON'T shutdown connection manager on error - it's shared!
				logger.log("🔒 PREVENTION: ✅ Error cleanup sequence completed")
			} catch (cleanupError) {
				logger.error("🔒 PREVENTION: ❌ Error during cleanup:", cleanupError)
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

		// Create output item with function call metadata
		const outputItem: INodeExecutionData = {
			json: {
				...parsedInput,
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
