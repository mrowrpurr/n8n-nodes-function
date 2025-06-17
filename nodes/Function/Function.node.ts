import { IExecuteFunctions, INodeExecutionData, INodeType, INodeTypeDescription, ITriggerFunctions, ITriggerResponse, NodeOperationError, NodeConnectionType } from "n8n-workflow"

import { functionRegistryLogger as logger } from "../Logger"
import { isQueueModeEnabled, getRedisConfig, getFunctionRegistry } from "../FunctionRegistryFactory"
import { ConsumerLifecycleManager, ConsumerConfig } from "../ConsumerLifecycleManager"
import { RedisConnectionManager } from "../RedisConnectionManager"

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
				displayName: "Function Name",
				name: "functionName",
				type: "string",
				default: "",
				placeholder: "myFunction",
				description: "The name of the function",
				required: true,
			},
		],
	}

	async trigger(this: ITriggerFunctions): Promise<ITriggerResponse> {
		const functionName = this.getNodeParameter("functionName") as string

		if (!functionName) {
			throw new NodeOperationError(this.getNode(), "Function name is required")
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
				streamKey: `function_calls:${functionName}:${workflowId}`,
				groupName: `function_group:${functionName}:${workflowId}`,
				processId: process.pid.toString(),
				workerId: this.getInstanceId() || "unknown",
			}

			// Create message handler
			const messageHandler = async (messageData: any) => {
				return await processMessage(messageData, this.emit.bind(this))
			}

			// Register function in registry so CallFunction can find it
			registry = await getFunctionRegistry()
			await registry.registerFunction({
				name: functionName,
				scope: workflowId,
				code: "", // No code - this is a workflow trigger
				parameters: [], // TODO: Extract parameters from workflow if needed
				workflowId: workflowId,
				nodeId: this.getNode().id,
			})
			logger.log("🚀 FUNCTION: ✅ Function registered in registry")

			// Create and start lifecycle manager
			lifecycleManager = new ConsumerLifecycleManager(consumerConfig, redisConfig, messageHandler)

			await lifecycleManager.start()

			// CRITICAL: Register this node as a worker for the function
			workerId = lifecycleManager.getConsumerId()
			if (workerId) {
				await registry.registerWorker(workerId, functionName)
				logger.log("🚀 FUNCTION: ✅ Worker registered:", workerId)

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
					logger.log("🚀 FUNCTION: Closing Function node...")

					try {
						// Stop health updates
						if (healthUpdateInterval) {
							clearInterval(healthUpdateInterval)
							healthUpdateInterval = null
							logger.log("🚀 FUNCTION: ✅ Worker health updates stopped")
						}

						// Unregister worker
						if (workerId && registry) {
							await registry.unregisterWorker(workerId, functionName)
							logger.log("🚀 FUNCTION: ✅ Worker unregistered:", workerId)
						}

						// Stop lifecycle manager
						if (lifecycleManager) {
							await lifecycleManager.stop()
						}

						// DON'T shutdown the connection manager here - it's shared!
						// The connection manager is a singleton and may be used by other nodes
						logger.log("🚀 FUNCTION: ✅ Function node closed successfully")
					} catch (error) {
						logger.error("🚀 FUNCTION: ❌ Error closing Function node:", error)
					}
				},
			}
		} catch (error) {
			logger.error("🚀 FUNCTION: ❌ Failed to start Function node:", error)

			// Cleanup on error
			try {
				// Stop health updates
				if (healthUpdateInterval) {
					clearInterval(healthUpdateInterval)
					healthUpdateInterval = null
				}

				// Unregister worker
				if (workerId && registry) {
					await registry.unregisterWorker(workerId, functionName)
				}

				// Stop lifecycle manager
				if (lifecycleManager) {
					await lifecycleManager.stop()
				}
				// DON'T shutdown connection manager on error - it's shared!
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
			await client.xAdd(`function_results:${callId}`, "*", resultData)

			// Also set as a key for immediate retrieval
			await client.setEx(
				`result:${callId}`,
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
