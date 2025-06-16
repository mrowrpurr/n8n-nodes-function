import {
	type INodeExecutionData,
	NodeConnectionType,
	type INodeType,
	type INodeTypeDescription,
	NodeOperationError,
	type ITriggerFunctions,
	type ITriggerResponse,
} from "n8n-workflow"
import { getFunctionRegistry, isQueueModeEnabled } from "../FunctionRegistryFactory"
import { type ParameterDefinition } from "../FunctionRegistry"
import { functionNodeLogger as logger } from "../Logger"

export class Function implements INodeType {
	description: INodeTypeDescription = {
		displayName: "Function",
		name: "function",
		icon: "fa:code",
		group: ["trigger"],
		version: 1,
		description: "Define a callable function within the current workflow",
		subtitle: "={{$node.name}}",
		defaults: {
			name: "Function",
			color: "#4a90e2",
		},
		inputs: [],
		outputs: [NodeConnectionType.Main],
		properties: [
			{
				displayName: "Global Function",
				name: "globalFunction",
				type: "boolean",
				default: false,
				description: "Whether this function will be registered globally and callable from any workflow",
			},
			{
				displayName: "Function Parameters",
				name: "parameters",
				placeholder: "Add parameter",
				type: "fixedCollection",
				description: "Define the parameters this function accepts",
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
								description: "Default value if parameter is not provided",
							},
							{
								displayName: "Description",
								name: "description",
								type: "string",
								default: "",
								description: "Description of what this parameter is for",
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
								description: "Expected type of the parameter",
								required: true,
							},
						],
					},
				],
			},
			{
				displayName: "Enable Code Execution",
				name: "enableCode",
				type: "boolean",
				default: false,
				description: "Whether to enable optional JavaScript code execution with parameters available as global variables",
			},
			{
				displayName: "Code",
				name: "jsCode",
				type: "string",
				typeOptions: {
					editor: "jsEditor",
					rows: 15,
				},
				default:
					"// Parameters are available as global variables\n// Example: if you have a 'name' parameter, use it directly\n// logger.log('Hello', name);\n\n// Process your parameters, call APIs, do calculations, etc.\n// const result = someCalculation(param1, param2);\n// logger.log('Processed:', result);\n\n// Optionally return an object to add fields to the flowing item:\n// return { calculatedValue: result, timestamp: Date.now() };\n\n// To return from the function, use a 'Return from Function' node",
				description:
					"JavaScript code to execute within the function. Parameters are available as global variables. Returned objects add fields to the item flowing through the function.",
				displayOptions: {
					show: {
						enableCode: [true],
					},
				},
			},
		],
	}

	async trigger(this: ITriggerFunctions): Promise<ITriggerResponse> {
		logger.info("Starting stream-based trigger setup")

		// Get function configuration
		const globalFunction = this.getNodeParameter("globalFunction", 0) as boolean
		const functionName = this.getNode().name
		const parameters = this.getNodeParameter("parameters", 0, {}) as any
		const parameterList = parameters.parameter || []
		const enableCode = this.getNodeParameter("enableCode", 0) as boolean
		const code = enableCode ? (this.getNodeParameter("jsCode", 0) as string) : ""

		// Get execution and node IDs for context tracking
		// const executionId = this.getExecutionId() // Not needed for stream-based approach
		const nodeId = this.getNode().id
		const workflowId = this.getWorkflow().id || "unknown"

		// Determine scope for stream registration
		const scope = globalFunction ? "__global__" : workflowId

		logger.info("Registering function:", functionName, "with scope:", scope)
		logger.debug("Global function:", globalFunction)
		logger.debug("Workflow ID:", workflowId)
		logger.debug("Parameter list:", parameterList)

		// Get the registry - Redis configuration comes from bootstrap
		const registry = getFunctionRegistry()

		// Convert parameter list to ParameterDefinition format
		const parameterDefinitions: ParameterDefinition[] = parameterList.map((param: any) => ({
			name: param.name,
			type: param.type,
			required: param.required,
			defaultValue: param.defaultValue,
			description: param.description,
		}))

		// Check if queue mode is enabled for Redis operations
		const useRedisStreams = isQueueModeEnabled()

		if (useRedisStreams) {
			logger.debug("Queue mode enabled, setting up Redis streams")

			// Declare variables outside try block for proper scope
			let streamKey: string
			let groupName: string
			let consumerName: string

			try {
				// Create stream and register function metadata
				streamKey = await registry.createStream(functionName, scope)
				groupName = `group:${functionName}`
				consumerName = `consumer-${Date.now()}-${Math.random().toString(36).slice(2)}`

				// Store function metadata in Redis (force Redis storage since we're using streams)
				await registry.registerFunction(functionName, scope, nodeId, parameterDefinitions, async () => [], true)

				// Start heartbeat
				registry.startHeartbeat(functionName, scope)

				logger.debug("Stream created and function registered, starting consumer loop")
			} catch (error) {
				logger.error("Failed to set up Redis streams during activation:", error.message)
				logger.info("Function will fall back to in-memory mode")
				// Fall back to in-memory mode
				await registry.registerFunction(
					functionName,
					scope,
					nodeId,
					parameterDefinitions,
					async (parameters: Record<string, any>, inputItem: INodeExecutionData) => {
						logger.log("🌊 Function: In-memory fallback function called:", functionName, "with parameters:", parameters)
						return [inputItem]
					},
					false
				)

				return {
					closeFunction: async () => {
						logger.log("🌊 Function: Trigger closing, cleaning up in-memory fallback function")
						await registry.unregisterFunction(functionName, scope)
					},
					manualTriggerFunction: async () => {
						throw new NodeOperationError(
							this.getNode(),
							`❌ Cannot execute Function node directly!\n\n` +
								`Function nodes are designed to be called by "Call Function" nodes, not executed directly.\n\n` +
								`To use this function:\n` +
								`1. Add a "Call Function" node to your workflow\n` +
								`2. Configure it to call "${functionName}"\n` +
								`3. Execute the workflow from the Call Function node instead\n\n` +
								`Function nodes are triggers that wait for calls - they don't execute on their own.`
						)
					},
				}
			}

			// Check if there's already an active consumer for this function
			if (registry.isConsumerActive(functionName, scope)) {
				logger.log("🔍 DIAGNOSTIC: Found existing consumer for this function, stopping it first")
				registry.stopConsumer(functionName, scope)
				// Give it a moment to stop
				await new Promise((resolve) => setTimeout(resolve, 100))
			}

			// Register this consumer
			registry.registerConsumer(functionName, scope, streamKey, groupName, consumerName)

			// Start the instant-response stream consumer with dedicated connection
			let isActive = true
			const controlChannel = `control:stop:${functionName}:${scope}:${consumerName}`

			const processStreamMessages = async () => {
				logger.log("🚀 INSTANT: Starting instant-response consumer with dedicated connection")
				logger.log("🚀 INSTANT: Stream key:", streamKey)
				logger.log("🚀 INSTANT: Group name:", groupName)
				logger.log("🚀 INSTANT: Consumer name:", consumerName)
				logger.log("🚀 INSTANT: Control channel:", controlChannel)

				// Create dedicated blocking connection for instant response
				let blockingConnection = null
				let controlSubscriber = null

				try {
					// Set up dedicated blocking connection
					blockingConnection = await registry.createDedicatedBlockingConnection()
					logger.log("🚀 INSTANT: Dedicated blocking connection created")

					// Set up control subscriber for graceful shutdown
					controlSubscriber = await registry.createControlSubscriber(controlChannel, () => {
						logger.log("🚀 INSTANT: Received stop signal, ending consumer")
						isActive = false
					})
					logger.log("🚀 INSTANT: Control subscriber ready")

					// Main consumer loop with instant response
					logger.log("🚀 INSTANT: Starting main consumer loop")
					while (isActive && registry.isConsumerActive(functionName, scope)) {
						try {
							logger.log("🚀 INSTANT: About to call readCallsInstant with BLOCK 0...")
							// Read messages with INFINITE blocking (BLOCK 0) for instant response
							const messages = await registry.readCallsInstant(blockingConnection, streamKey, groupName, consumerName)
							logger.log("🚀 INSTANT: readCallsInstant returned with", messages.length, "messages")

							if (!isActive) break // Check if we should stop

							if (messages.length > 0) {
								logger.log("🚀 INSTANT: Message received INSTANTLY!")
								logger.log("🚀 INSTANT: Processing", messages.length, "messages")
							}

							for (const message of messages) {
								if (!isActive) break

								try {
									logger.log("🌊 Function: Processing stream message:", message.id)

									// Parse message fields
									const callId = message.message.callId
									const params = JSON.parse(message.message.params)
									const inputItem = JSON.parse(message.message.inputItem)
									const responseChannel = message.message.responseChannel

									logger.log("🌊 Function: Call ID:", callId)
									logger.log("🌊 Function: Parameters:", params)

									// Process parameters according to function definition
									const locals: Record<string, any> = {}

									for (const param of parameterList) {
										const paramName = param.name
										const paramType = param.type
										const required = param.required
										const defaultValue = param.defaultValue

										let value = params[paramName]
										logger.log("🌊 Function: Processing parameter", paramName, "=", value)

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

									logger.log("🌊 Function: Final locals =", locals)

									// Create the output item
									let outputItem: INodeExecutionData = {
										json: {
											...inputItem.json,
											...locals,
											_functionCall: {
												callId,
												functionName,
												timestamp: Date.now(),
												// Embed call context for ReturnFromFunction
												responseChannel,
												messageId: message.id,
												streamKey,
												groupName,
											},
										},
										index: 0,
										binary: inputItem.binary,
									}

									// Execute user code if enabled
									if (enableCode && code.trim()) {
										logger.log("🌊 Function: Executing JavaScript code")

										try {
											// Execute JavaScript code with parameters as global variables
											const context = {
												...locals,
												item: outputItem.json,
												console: {
													log: (...args: any[]) => logger.log("🌊 Function Code:", ...args),
													error: (...args: any[]) => logger.error("🌊 Function Code:", ...args),
													warn: (...args: any[]) => logger.warn("🌊 Function Code:", ...args),
												},
											}

											// Execute JavaScript code directly (n8n already provides sandboxing)
											const wrappedCode = `
											(function() {
												// Set up context variables
												${Object.keys(context)
													.map((key) => `var ${key} = arguments[0]["${key}"];`)
													.join("\n\t\t\t\t\t\t\t")}
												
												// Execute user code
												${code}
											})
										`

											const result = eval(wrappedCode)(context)

											logger.log("🌊 Function: Code execution result =", result)

											// If code returns a value, merge it with locals
											if (result !== undefined) {
												if (typeof result === "object" && result !== null) {
													// Merge locals (parameters) first, then returned object (returned object wins conflicts)
													outputItem.json = {
														...outputItem.json,
														...result,
													}
												} else {
													// For non-object returns, include the result
													outputItem.json = {
														...outputItem.json,
														result,
													}
												}
											}
										} catch (error) {
											logger.error("🌊 Function: Code execution error:", error)
											outputItem.json = {
												...outputItem.json,
												_codeError: error.message,
											}
										}
									}

									logger.log("🌊 Function: Emitting output item:", outputItem)

									// Emit the item to continue the workflow
									this.emit([[outputItem]])

									// Function execution complete - ReturnFromFunction node is responsible for sending response
									logger.log("🌊 Function: Function execution completed, waiting for ReturnFromFunction node")
									logger.log("🌊 Function: Response channel:", responseChannel)
									logger.log("🌊 Function: Call ID:", callId)
									logger.log("🌊 Function: Note: Function will wait FOREVER until ReturnFromFunction sends response")
								} catch (error) {
									logger.error("🌊 Function: Error processing message:", error)

									// Send error response
									try {
										const callId = message.message.callId
										const responseChannel = message.message.responseChannel

										await registry.publishResponse(responseChannel, {
											success: false,
											error: error.message,
											callId,
											timestamp: Date.now(),
										})

										// Acknowledge the message even on error to prevent reprocessing
										await registry.acknowledgeCall(streamKey, groupName, message.id)

										logger.log("🔍 DIAGNOSTIC: Error occurred, sending error response")
										logger.log("🔍 DIAGNOSTIC: This is the ONLY time Function sends responses!")
									} catch (responseError) {
										logger.error("🌊 Function: Error sending error response:", responseError)
									}
								}
							}
						} catch (error) {
							if (isActive) {
								logger.error("🌊 Function: Error in instant consumer:", error)
								// Brief pause before retrying to avoid tight error loops
								await new Promise((resolve) => setTimeout(resolve, 100))
							}
						}
					}
				} catch (error) {
					logger.error("🌊 Function: Fatal error setting up instant consumer:", error)
				} finally {
					// Clean up connections
					if (controlSubscriber) {
						try {
							await controlSubscriber.disconnect()
							logger.log("🚀 INSTANT: Control subscriber disconnected")
						} catch (error) {
							logger.error("🚀 INSTANT: Error disconnecting control subscriber:", error)
						}
					}
					if (blockingConnection) {
						try {
							await blockingConnection.disconnect()
							logger.log("🚀 INSTANT: Blocking connection disconnected")
						} catch (error) {
							logger.error("🚀 INSTANT: Error disconnecting blocking connection:", error)
						}
					}
					logger.log("🚀 INSTANT: Consumer cleanup complete")
				}

				logger.log("🌊 Function: Instant consumer loop ended")
			}

			// Start the consumer loop
			processStreamMessages().catch((error) => {
				logger.error("🌊 Function: Fatal error in stream consumer:", error)
			})

			logger.log("🔍 DIAGNOSTIC: Stream consumer loop started asynchronously")
			logger.log("🔍 DIAGNOSTIC: Consumer might not be ready immediately!")
			logger.log("🔍 DIAGNOSTIC: This could cause first calls to fail")

			logger.info("Function registered successfully, starting stream consumer")

			// Return trigger response with cleanup for queue mode
			return {
				closeFunction: async () => {
					logger.log("🌊 Function: Trigger closing, cleaning up")

					// Stop the consumer loop
					isActive = false
					registry.stopConsumer(functionName, scope)

					// Send stop signal to instant consumer
					try {
						await registry.sendStopSignal(controlChannel)
						logger.log("🚀 INSTANT: Stop signal sent")
					} catch (error) {
						logger.error("🚀 INSTANT: Error sending stop signal:", error)
					}

					// Give consumer time to stop
					await new Promise((resolve) => setTimeout(resolve, 200))

					// Stop heartbeat
					registry.stopHeartbeat(functionName, scope)

					// Unregister function
					await registry.unregisterFunction(functionName, scope)

					// Clean up stream
					await registry.cleanupStream(streamKey, groupName)

					logger.log("🌊 Function: Cleanup complete")
				},
				// Emit initial trigger data to activate the workflow
				manualTriggerFunction: async () => {
					throw new NodeOperationError(
						this.getNode(),
						`❌ Cannot execute Function node directly!\n\n` +
							`Function nodes are designed to be called by "Call Function" nodes, not executed directly.\n\n` +
							`To use this function:\n` +
							`1. Add a "Call Function" node to your workflow\n` +
							`2. Configure it to call "${functionName}"\n` +
							`3. Execute the workflow from the Call Function node instead\n\n` +
							`Function nodes are triggers that wait for calls - they don't execute on their own.`
					)
				},
			}
		} else {
			logger.debug("Queue mode disabled, using in-memory registration")

			// Register function in memory only
			await registry.registerFunction(
				functionName,
				scope,
				nodeId,
				parameterDefinitions,
				async (parameters: Record<string, any>, inputItem: INodeExecutionData) => {
					logger.log("🌊 Function: In-memory function called:", functionName, "with parameters:", parameters)

					// Process parameters according to function definition
					const locals: Record<string, any> = {}

					for (const param of parameterList) {
						const paramName = param.name
						const paramType = param.type
						const required = param.required
						const defaultValue = param.defaultValue

						let value = parameters[paramName]

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
					registry.clearFunctionReturnValue(callId)

					// Create the output item
					let outputItem: INodeExecutionData = {
						json: {
							...inputItem.json,
							...locals,
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

					// Execute user code if enabled
					if (enableCode && code.trim()) {
						logger.log("🌊 Function: Executing JavaScript code in in-memory mode")

						try {
							// Execute JavaScript code with parameters as global variables
							const context = {
								...locals,
								item: outputItem.json,
								console: {
									log: (...args: any[]) => logger.log("🌊 Function Code:", ...args),
									error: (...args: any[]) => logger.error("🌊 Function Code:", ...args),
									warn: (...args: any[]) => logger.warn("🌊 Function Code:", ...args),
								},
							}

							// Execute JavaScript code directly (n8n already provides sandboxing)
							const wrappedCode = `
							(function() {
								// Set up context variables
								${Object.keys(context)
									.map((key) => `var ${key} = arguments[0]["${key}"];`)
									.join("\n\t\t\t\t\t\t\t")}
								
								// Execute user code
								${code}
							})
						`

							const result = eval(wrappedCode)(context)

							logger.log("🌊 Function: Code execution result =", result)

							// If code returns a value, merge it with locals
							if (result !== undefined) {
								if (typeof result === "object" && result !== null) {
									// Merge locals (parameters) first, then returned object (returned object wins conflicts)
									outputItem.json = {
										...outputItem.json,
										...result,
									}
								} else {
									// For non-object returns, include the result
									outputItem.json = {
										...outputItem.json,
										result,
									}
								}
							}
						} catch (error) {
							logger.error("🌊 Function: Code execution error:", error)
							outputItem.json = {
								...outputItem.json,
								_codeError: error.message,
							}
						}
					}

					logger.log("🌊 Function: Emitting output item to downstream nodes")
					this.emit([[outputItem]])

					// Function execution complete - ReturnFromFunction node is responsible for handling return value
					logger.log("🌊 Function: Function execution completed, waiting for ReturnFromFunction node")
					logger.log("🌊 Function: Call ID:", callId)
					logger.log("🌊 Function: Note: Function will wait FOREVER until ReturnFromFunction resolves return value")

					// Wait forever for ReturnFromFunction to resolve the return value
					const returnValue = await registry.waitForReturn(callId)
					logger.log("🌊 Function: ✅ Return value received:", returnValue)

					return [outputItem]
				},
				false
			)

			logger.info("Function registered successfully in in-memory mode")

			// Return trigger response with cleanup for in-memory mode
			return {
				closeFunction: async () => {
					logger.log("🌊 Function: Trigger closing, cleaning up in-memory function")
					await registry.unregisterFunction(functionName, scope)
				},
				// Emit initial trigger data to activate the workflow
				manualTriggerFunction: async () => {
					throw new NodeOperationError(
						this.getNode(),
						`❌ Cannot execute Function node directly!\n\n` +
							`Function nodes are designed to be called by "Call Function" nodes, not executed directly.\n\n` +
							`To use this function:\n` +
							`1. Add a "Call Function" node to your workflow\n` +
							`2. Configure it to call "${functionName}"\n` +
							`3. Execute the workflow from the Call Function node instead\n\n` +
							`Function nodes are triggers that wait for calls - they don't execute on their own.`
					)
				},
			}
		}
	}
}
