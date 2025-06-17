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
			{
				displayName: "Scope",
				name: "scope",
				type: "string",
				default: "global",
				description: "The scope of the function (e.g., global, user, workflow)",
			},
			{
				displayName: "Code",
				name: "code",
				type: "string",
				typeOptions: {
					editor: "codeNodeEditor",
					editorLanguage: "javaScript",
				},
				default: `// Function code here
// Input data is available as 'input'
// Return the result

return {
	message: "Hello from function!",
	input: input
};`,
				description: "The JavaScript code to execute",
				noDataExpression: true,
			},
		],
	}

	async trigger(this: ITriggerFunctions): Promise<ITriggerResponse> {
		const functionName = this.getNodeParameter("functionName") as string
		const scope = this.getNodeParameter("scope") as string
		const code = this.getNodeParameter("code") as string

		if (!functionName) {
			throw new NodeOperationError(this.getNode(), "Function name is required")
		}

		logger.log("🚀 FUNCTION: Starting Function node trigger")
		logger.log("🚀 FUNCTION: Function name:", functionName)
		logger.log("🚀 FUNCTION: Scope:", scope)

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

		try {
			// Get Redis configuration
			const redisConfig = getRedisConfig()
			if (!redisConfig) {
				throw new NodeOperationError(this.getNode(), "Redis configuration not available")
			}

			// Initialize connection manager (singleton, shared across nodes)
			RedisConnectionManager.getInstance(redisConfig)

			// Create consumer configuration
			const consumerConfig: ConsumerConfig = {
				functionName,
				scope,
				streamKey: `function_calls:${functionName}:${scope}`,
				groupName: `function_group:${functionName}:${scope}`,
				processId: process.pid.toString(),
				workerId: this.getInstanceId() || "unknown",
			}

			// Create message handler
			const messageHandler = async (messageData: any) => {
				return await processMessage(messageData, code)
			}

			// Register function in registry so CallFunction can find it
			const registry = await getFunctionRegistry()
			await registry.registerFunction({
				name: functionName,
				scope: scope,
				code: code,
				parameters: [], // TODO: Extract parameters from code if needed
				workflowId: this.getWorkflow().id || "unknown",
				nodeId: this.getNode().id,
			})
			logger.log("🚀 FUNCTION: ✅ Function registered in registry")

			// Create and start lifecycle manager
			lifecycleManager = new ConsumerLifecycleManager(consumerConfig, redisConfig, messageHandler)

			await lifecycleManager.start()

			logger.log("🚀 FUNCTION: ✅ Function node started successfully")
			logger.log("🚀 FUNCTION: Consumer ID:", lifecycleManager.getConsumerId())

			return {
				closeFunction: async () => {
					logger.log("🚀 FUNCTION: Closing Function node...")

					try {
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
		// This should not be called for trigger nodes
		throw new NodeOperationError(this.getNode(), "Function node should be used as a trigger, not executed directly")
	}
}

/**
 * Process a message from the Redis stream
 */
async function processMessage(messageData: any, code: string): Promise<any> {
	const startTime = Date.now()

	try {
		logger.log("🚀 FUNCTION: Processing message:", messageData)

		// Parse message data
		const { input, callId } = messageData

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

		// Execute the function code
		const result = await executeFunction(code, parsedInput)

		// Send result back via Redis
		await sendResult(callId, result, null)

		const processingTime = Date.now() - startTime
		logger.log("🚀 FUNCTION: ✅ Message processed successfully in", processingTime, "ms")

		return result
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
 * Execute the function code safely
 */
async function executeFunction(code: string, input: any): Promise<any> {
	try {
		// Create a safe execution context
		const context = {
			input,
			console: {
				log: (...args: any[]) => logger.log("🚀 FUNCTION: [USER]", ...args),
				error: (...args: any[]) => logger.error("🚀 FUNCTION: [USER]", ...args),
				warn: (...args: any[]) => logger.log("🚀 FUNCTION: [USER] WARN:", ...args),
				info: (...args: any[]) => logger.log("🚀 FUNCTION: [USER] INFO:", ...args),
			},
			// Add other safe globals as needed
		}

		// Create function with context
		const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
		const func = new AsyncFunction("input", "console", code)

		// Execute function
		const result = await func(input, context.console)

		logger.log("🚀 FUNCTION: Function executed successfully, result:", result)
		return result
	} catch (error) {
		logger.error("🚀 FUNCTION: ❌ Error executing function code:", error)
		throw new NodeOperationError(null as any, `Function execution failed: ${error}`)
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
				result: result ? JSON.stringify(result) : null,
				error,
				timestamp: Date.now(),
				status: error ? "error" : "success",
			}

			// Send to result stream
			await client.xAdd(`function_results:${callId}`, "*", resultData)

			// Also set as a key for immediate retrieval
			await client.setEx(`result:${callId}`, 300, JSON.stringify(resultData)) // 5 minute expiry

			logger.log("🚀 FUNCTION: ✅ Result sent successfully for call:", callId)
		}, `send-result-${callId}`)
	} catch (error) {
		logger.error("🚀 FUNCTION: ❌ Error sending result:", error)
		throw error
	}
}
