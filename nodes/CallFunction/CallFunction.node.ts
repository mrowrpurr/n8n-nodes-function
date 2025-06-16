import {
	type INodeExecutionData,
	NodeConnectionType,
	type IExecuteFunctions,
	type INodeType,
	type INodeTypeDescription,
	type ILoadOptionsFunctions,
	NodeOperationError,
} from "n8n-workflow"
import { getFunctionRegistry, isQueueModeEnabled } from "../FunctionRegistryFactory"
import { functionRegistryLogger as logger } from "../Logger"

export class CallFunction implements INodeType {
	description: INodeTypeDescription = {
		displayName: "Call Function",
		name: "callFunction",
		icon: "fa:play",
		group: ["transform"],
		version: 1,
		description: "Call a Function node defined in the current workflow",
		subtitle: '={{$parameter["functionName"] ? $parameter["functionName"] : ""}}',
		defaults: {
			name: "Call Function",
			color: "#ff6d5a",
		},
		inputs: [NodeConnectionType.Main],
		outputs: [NodeConnectionType.Main],
		properties: [
			{
				displayName: "Global Function",
				name: "globalFunction",
				type: "boolean",
				default: false,
				description: "Whether to call a globally registered function from any workflow",
			},
			{
				displayName: "Function Name or ID",
				name: "functionName",
				type: "options",
				typeOptions: {
					loadOptionsMethod: "getAvailableFunctions",
					dependsOn: ["globalFunction"],
				},
				default: "",
				required: true,
				description: 'Name of the function to call. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
				placeholder: "Select a function...",
			},
			{
				displayName: "Last Configured Function",
				name: "lastConfiguredFunction",
				type: "hidden",
				default: "",
				description: "Internal field to track function changes",
			},
			{
				displayName: "Parameter Mode",
				name: "parameterMode",
				type: "options",
				options: [
					{
						name: "Individual Parameters",
						value: "individual",
						description: "Specify each parameter individually",
					},
					{
						name: "JSON Object",
						value: "json",
						description: "Pass all parameters as a single JSON object",
					},
				],
				default: "individual",
				description: "How to specify the function parameters",
				displayOptions: {
					hide: {
						functionName: [""],
					},
				},
			},
			{
				displayName: "Parameters JSON",
				name: "parametersJson",
				type: "json",
				default: "{}",
				description: "JSON object containing all parameters to pass to the function",
				displayOptions: {
					show: {
						parameterMode: ["json"],
					},
				},
			},
			{
				displayName: "Function Parameters",
				name: "parameters",
				placeholder: "Add parameter",
				type: "fixedCollection",
				description: "Parameters to pass to the function",
				typeOptions: {
					multipleValues: true,
					sortable: true,
				},
				default: {},
				displayOptions: {
					show: {
						parameterMode: ["individual"],
					},
					hide: {
						functionName: [""],
					},
				},
				options: [
					{
						name: "parameter",
						displayName: "Parameter",
						values: [
							{
								displayName: "Parameter Name or ID",
								name: "name",
								type: "options",
								typeOptions: {
									loadOptionsMethod: "getFunctionParameters",
								},
								default: "",
								description: 'Select the parameter to set. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
								required: true,
							},
							{
								displayName: "Value",
								name: "value",
								type: "string",
								default: "",
								description: "Value to pass for this parameter",
							},
						],
					},
				],
			},
			{
				displayName: "Store Response",
				name: "storeResponse",
				type: "boolean",
				default: false,
				description: "Whether to store the function's return value in the output item",
				displayOptions: {
					hide: {
						functionName: [""],
					},
				},
			},
			{
				displayName: "Response Variable Name",
				name: "responseVariableName",
				type: "string",
				default: "functionResult",
				description: "Name of the variable to store the function response under",
				placeholder: "functionResult",
				displayOptions: {
					show: {
						storeResponse: [true],
					},
					hide: {
						functionName: [""],
					},
				},
			},
		],
	}

	methods = {
		loadOptions: {
			async getAvailableFunctions(this: ILoadOptionsFunctions) {
				logger.log("🔧 CallFunction: Loading available functions for dropdown")
				const globalFunction = this.getCurrentNodeParameter("globalFunction") as boolean
				logger.log("🔧 CallFunction: Global function mode:", globalFunction)

				const registry = await getFunctionRegistry()
				let availableFunctions

				if (globalFunction) {
					// Only show global functions (scope = "__global__")
					availableFunctions = await registry.getAvailableFunctions("__global__")

					// If no global functions found, add a helpful message
					if (availableFunctions.length === 0) {
						return [
							{
								name: "⚠️ No Global Functions Available",
								value: "__no_global_functions__",
								description: "No global functions found. Create and activate a workflow with a global Function node.",
							},
						]
					}
				} else {
					// Show local functions - get functions for current workflow scope
					logger.log("🔧 CallFunction: Getting functions for current workflow scope")

					// Try to get the current workflow ID
					let workflowId = "unknown"
					try {
						workflowId = this.getWorkflow().id || "unknown"
					} catch (error) {
						logger.log("🔧 CallFunction: Could not get workflow ID:", error.message)
					}

					logger.log("🔧 CallFunction: Current workflow ID:", workflowId)

					if (workflowId !== "unknown") {
						// Get functions specifically for this workflow
						availableFunctions = await registry.getAvailableFunctions(workflowId)
						logger.log("🔧 CallFunction: Found functions for workflow scope:", availableFunctions)
					} else {
						// Fallback: get all functions and filter out globals manually
						logger.log("🔧 CallFunction: Workflow ID unknown, getting all functions and filtering")
						const allFunctions = await registry.getAvailableFunctions()

						// Get actual global functions to filter them out
						const globalFunctions = await registry.getAvailableFunctions("__global__")
						const globalNames = new Set(globalFunctions.map((f) => f.value))

						// Filter to only show non-global functions
						availableFunctions = allFunctions.filter((func) => !globalNames.has(func.value))
						logger.log("🔧 CallFunction: Found local functions after filtering:", availableFunctions)
					}

					// If no local functions found, add a helpful message
					if (availableFunctions.length === 0) {
						return [
							{
								name: "⚠️ No Local Functions Available",
								value: "__no_local_functions__",
								description: "No local functions found. Activate the workflow to register Function nodes and refresh this list.",
							},
							{
								name: "🔄 Activate Workflow to Refresh",
								value: "__activate_workflow__",
								description: "Click the workflow's Active toggle, then reopen this node to see available functions",
							},
						]
					}
				}

				logger.log("🔧 CallFunction: Available functions:", availableFunctions)
				return availableFunctions
			},
			async getFunctionParameters(this: ILoadOptionsFunctions) {
				const functionName = this.getCurrentNodeParameter("functionName") as string
				const lastConfiguredFunction = this.getCurrentNodeParameter("lastConfiguredFunction") as string
				const globalFunction = this.getCurrentNodeParameter("globalFunction") as boolean

				logger.log("🔧 CallFunction: Loading parameters for function:", functionName)
				logger.log("🔧 CallFunction: Last configured function:", lastConfiguredFunction)
				logger.log("🔧 CallFunction: Global function mode:", globalFunction)

				if (!functionName || functionName === "__no_local_functions__" || functionName === "__no_global_functions__" || functionName === "__activate_workflow__") {
					return []
				}

				const registry = await getFunctionRegistry()
				let parameters

				if (globalFunction) {
					parameters = await registry.getFunctionParameters(functionName, "__global__")
				} else {
					// Try multiple ways to get the workflow ID
					let workflowId = "unknown"
					try {
						workflowId = this.getWorkflow().id || "unknown"
					} catch (error) {
						logger.log("🔧 CallFunction: Could not get workflow ID from getWorkflow():", error.message)
					}

					// If still unknown, try to get from static data
					if (workflowId === "unknown") {
						try {
							const staticData = this.getWorkflowStaticData("global")
							if (staticData && staticData.workflowId) {
								workflowId = String(staticData.workflowId)
							}
						} catch (error) {
							logger.log("🔧 CallFunction: Could not get workflow ID from static data:", error.message)
						}
					}

					logger.log("🔧 CallFunction: Using workflow ID for parameters:", workflowId)
					parameters = await registry.getFunctionParameters(functionName, workflowId)

					// Fallback: if no parameters found with specific scope (e.g., workflowId is "unknown" during design-time)
					// try to get parameters without scope filtering
					if (parameters.length === 0 && (workflowId === "unknown" || workflowId === "")) {
						logger.log("🔧 CallFunction: No parameters found with scope, trying fallback without scope")
						parameters = await registry.getFunctionParameters(functionName)
					}
				}

				logger.log("🔧 CallFunction: Found parameters:", parameters)

				// Get currently selected parameters
				const currentParameters = this.getCurrentNodeParameter("parameters") as any
				const selectedParameterNames = new Set<string>()

				if (currentParameters && currentParameters.parameter) {
					for (const param of currentParameters.parameter) {
						if (param.name) {
							selectedParameterNames.add(param.name)
						}
					}
				}

				logger.log("🔧 CallFunction: Already selected parameters:", Array.from(selectedParameterNames))

				// Check if the function has changed from what was last configured
				const functionChanged = lastConfiguredFunction && lastConfiguredFunction !== functionName

				// Check if any of the currently selected parameters are NOT valid for this function
				const validParameterNames = new Set(parameters.map((p) => p.name))
				const hasInvalidParameters = Array.from(selectedParameterNames).some((name) => !validParameterNames.has(name))

				if (functionChanged || hasInvalidParameters) {
					logger.log("🔧 CallFunction: Detected function change - showing reset warning")

					// If there are existing parameters that need to be cleared
					if (selectedParameterNames.size > 0) {
						return [
							{
								name: "⚠️ Function Changed - Clear Existing Parameters",
								value: "__function_changed__",
								description: "Function changed. Please remove all existing parameters before adding new ones.",
							},
							{
								name: "🔄 Clear All Parameters (Select This)",
								value: "__clear_parameters__",
								description: "Select this to indicate you want to start fresh with parameters for the new function",
							},
						]
					}

					// No existing parameters, show all available ones
					return parameters.map((param) => ({
						name: `${param.name} (${param.type})${param.required ? " *" : ""}`,
						value: param.name,
						description: param.description || `${param.type} parameter${param.required ? " (required)" : ""}`,
					}))
				}

				// Filter out already-selected parameters (normal case)
				const availableParameters = parameters.filter((param) => !selectedParameterNames.has(param.name))
				logger.log("🔧 CallFunction: Available parameters after filtering:", availableParameters)

				// If no parameters are available, return a descriptive message
				if (availableParameters.length === 0) {
					return [
						{
							name: "All Parameters Have Been Set",
							value: "__no_params_available__",
							description: "All function parameters are already configured",
						},
					]
				}

				return availableParameters.map((param) => ({
					name: `${param.name} (${param.type})${param.required ? " *" : ""}`,
					value: param.name,
					description: param.description || `${param.type} parameter${param.required ? " (required)" : ""}`,
				}))
			},
		},
	}

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		logger.log(`Starting execution`)
		const items = this.getInputData()
		logger.log(`Input items count =`, items.length)

		// Debug: Log all node parameters
		try {
			const nodeParams = this.getNode().parameters
			logger.log(`Node parameters:`, JSON.stringify(nodeParams, null, 2))
		} catch (error) {
			logger.log(`Could not get node parameters:`, error.message)
		}

		const returnData: INodeExecutionData[] = []

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			logger.log(`Processing item ${itemIndex + 1}/${items.length}`)

			const globalFunction = this.getNodeParameter("globalFunction", itemIndex) as boolean
			const functionName = this.getNodeParameter("functionName", itemIndex) as string
			const parameterMode = this.getNodeParameter("parameterMode", itemIndex) as string
			const storeResponse = this.getNodeParameter("storeResponse", itemIndex) as boolean
			const responseVariableName = this.getNodeParameter("responseVariableName", itemIndex, "") as string

			logger.log(`Global function =`, globalFunction)
			logger.log(`Function name =`, functionName)
			logger.log(`Parameter mode =`, parameterMode)
			logger.log(`Store response =`, storeResponse)
			logger.log(`Response variable name =`, responseVariableName)

			// Debug: Log the raw parameter value
			logger.log(`Raw globalFunction parameter:`, typeof globalFunction, globalFunction)

			if (!functionName || functionName === "__no_local_functions__" || functionName === "__activate_workflow__") {
				throw new NodeOperationError(this.getNode(), "Please select a valid function. If no functions are available, activate the workflow first.")
			}

			// Get function parameter definitions for validation
			const registry = await getFunctionRegistry()
			let functionParameterDefs

			if (globalFunction) {
				functionParameterDefs = await registry.getFunctionParameters(functionName, "__global__")
			} else {
				const workflowId = this.getWorkflow().id || "unknown"
				functionParameterDefs = await registry.getFunctionParameters(functionName, workflowId)
			}

			const validParameterNames = new Set(functionParameterDefs.map((p: any) => p.name))

			// Prepare parameters to pass to the function
			let functionParameters: Record<string, any> = {}

			if (parameterMode === "json") {
				const parametersJson = this.getNodeParameter("parametersJson", itemIndex) as string
				logger.log("🔧 CallFunction: Raw JSON parameters =", parametersJson)
				try {
					functionParameters = JSON.parse(parametersJson)
				} catch (error) {
					throw new NodeOperationError(this.getNode(), `Invalid JSON in parameters: ${error}`)
				}
			} else {
				// Individual parameters mode
				const parameters = this.getNodeParameter("parameters", itemIndex, {}) as any
				const parameterList = parameters.parameter || []
				logger.log("🔧 CallFunction: Parameter list =", parameterList)

				// Validate parameters and filter out invalid ones
				const validParameters = []
				const invalidParameters = []

				for (const param of parameterList) {
					const paramName = param.name
					const paramValue = param.value

					// Skip special placeholder values
					if (paramName === "__no_params_available__" || paramName === "__function_changed__" || paramName === "__clear_parameters__") {
						continue
					}

					// Check if parameter is valid for this function
					if (!validParameterNames.has(paramName)) {
						invalidParameters.push(paramName)
						continue
					}

					// Try to parse the value as JSON first, fall back to string
					let parsedValue: any
					try {
						parsedValue = JSON.parse(paramValue)
					} catch {
						parsedValue = paramValue
					}

					functionParameters[paramName] = parsedValue
					validParameters.push(paramName)
				}

				// Warn about invalid parameters
				if (invalidParameters.length > 0) {
					logger.warn("🔧 CallFunction: Invalid parameters detected (function may have changed):", invalidParameters)
					logger.log("🔧 CallFunction: Valid parameters for function:", Array.from(validParameterNames))
				}

				logger.log("🔧 CallFunction: Valid parameters used:", validParameters)
			}

			logger.log("🔧 CallFunction: Final parameters =", functionParameters)

			// Determine the scope to use based on global function setting
			let targetScope: string
			let workflowId: string

			if (globalFunction) {
				targetScope = "__global__"
			} else {
				// For non-global functions, use the current workflow ID
				workflowId = this.getWorkflow().id || "unknown"
				targetScope = workflowId
			}

			logger.log("🔧 CallFunction: Target scope =", targetScope)
			logger.log("🔧 CallFunction: Global function =", globalFunction)

			// Use the registry instance to call the function
			const item = items[itemIndex]

			try {
				// Check if queue mode is enabled to determine call method
				logger.debug("🔍 CallFunction: Checking queue mode status...")
				const queueModeStatus = isQueueModeEnabled()
				logger.debug("🔍 CallFunction: Queue mode enabled =", queueModeStatus)

				// In queue mode, also check if we have Redis configuration
				const registry = await getFunctionRegistry()
				const useRedisStreams = queueModeStatus

				if (useRedisStreams) {
					logger.log("🌊 CallFunction: Using Redis streams for function call")

					// Generate unique call ID
					const callId = `call-${Date.now()}-${Math.random().toString(36).slice(2)}`
					const responseChannel = `function:response:${callId}`
					const streamKey = `function:stream:${targetScope}:${functionName}`

					logger.log("🌊 CallFunction: Call ID:", callId)
					logger.log("🌊 CallFunction: Stream key:", streamKey)
					logger.log("🌊 CallFunction: Response channel:", responseChannel)

					// Check if any workers are available for this function
					const availableWorkers = await registry.getAvailableWorkers(functionName)

					if (availableWorkers.length === 0) {
						throw new NodeOperationError(this.getNode(), `Function '${functionName}' not found or no workers available`)
					}

					// Filter workers by health check
					const healthyWorkers = []
					for (const workerId of availableWorkers) {
						const isHealthy = await registry.isWorkerHealthy(workerId, functionName)
						logger.log("🔍 DIAGNOSTIC: Worker health check - Worker:", workerId, "Healthy:", isHealthy)
						if (isHealthy) {
							healthyWorkers.push(workerId)
						}
					}

					if (healthyWorkers.length === 0) {
						throw new NodeOperationError(this.getNode(), `Function '${functionName}' has no healthy workers available`)
					}

					logger.log("🌊 CallFunction: Healthy workers available:", healthyWorkers.length)

					// Check if stream is ready before making the call
					const groupName = `group:${functionName}`
					logger.log("🔍 DIAGNOSTIC: Checking if stream is ready")
					logger.log("🔍 DIAGNOSTIC: Stream key:", streamKey)
					logger.log("🔍 DIAGNOSTIC: Group name:", groupName)
					logger.log("🔍 DIAGNOSTIC: Timeout: 3000ms (increased from 500ms)")

					const startTime = Date.now()
					const isReady = await registry.waitForStreamReady(streamKey, groupName, 3000) // Increased to 3 seconds
					const checkDuration = Date.now() - startTime

					logger.log("🔍 DIAGNOSTIC: Stream ready check completed")
					logger.log("🔍 DIAGNOSTIC: Is ready:", isReady)
					logger.log("🔍 DIAGNOSTIC: Check duration:", checkDuration, "ms")

					if (!isReady) {
						logger.warn("🔍 DIAGNOSTIC: Stream not ready after 3000ms - consumer may have issues")
						logger.warn("🔍 DIAGNOSTIC: Function consumer might still be starting up or not running")
						// Don't throw error immediately, try the call - it might work if function is just starting
					} else {
						logger.log("🔍 DIAGNOSTIC: Stream is ready, proceeding with call")
					}

					// Add call to stream
					await registry.addCall(streamKey, callId, functionName, functionParameters, item, responseChannel, 30000)

					logger.log("🌊 CallFunction: Call added to stream, waiting for response...")

					// Wait for response with retry logic for the first call
					let response
					let retryCount = 0
					const maxRetries = 2
					let currentResponseChannel = responseChannel

					while (retryCount <= maxRetries) {
						try {
							logger.log("🔍 DIAGNOSTIC: Waiting for response on channel:", currentResponseChannel)
							logger.log("🔍 DIAGNOSTIC: Timeout: 15 seconds")
							logger.log("🔍 DIAGNOSTIC: If Function doesn't have ReturnFromFunction, this WILL timeout!")

							response = await registry.waitForResponse(currentResponseChannel, 15) // 15 second timeout per attempt
							break // Success, exit retry loop
						} catch (error) {
							retryCount++
							logger.log(`🌊 CallFunction: Attempt ${retryCount} failed:`, error.message)

							logger.log("🔍 DIAGNOSTIC: Response timeout or error occurred")
							logger.log("🔍 DIAGNOSTIC: Error message:", error.message)
							logger.log("🔍 DIAGNOSTIC: Is this 'Response timeout'?", error.message.includes("timeout"))
							logger.log("🔍 DIAGNOSTIC: This confirms Function didn't send a response")

							if (retryCount <= maxRetries) {
								logger.log(`🌊 CallFunction: Retrying in 2 seconds... (${retryCount}/${maxRetries})`)
								await new Promise((resolve) => setTimeout(resolve, 2000))

								// Generate new call ID for retry
								const retryCallId = `call-${Date.now()}-${Math.random().toString(36).slice(2)}`
								const retryResponseChannel = `function:response:${retryCallId}`

								logger.log("🌊 CallFunction: Retry call ID:", retryCallId)

								// Add retry call to stream
								await registry.addCall(streamKey, retryCallId, functionName, functionParameters, item, retryResponseChannel, 30000)

								// Update response channel for this attempt
								currentResponseChannel = retryResponseChannel
							} else {
								throw error // Re-throw the last error if all retries failed
							}
						}
					}

					logger.log("🌊 CallFunction: Received response:", response)

					if (!response.success) {
						throw new NodeOperationError(this.getNode(), `Function call failed: ${response.error}`)
					}

					// Start with the original item
					let resultJson: any = { ...item.json }

					// Always include the function result, but how it's stored depends on storeResponse setting
					if (response.data !== null) {
						if (storeResponse && responseVariableName && responseVariableName.trim()) {
							// Store under specific variable name
							resultJson[responseVariableName] = response.data
						} else {
							// Default behavior: merge the function result directly into the item
							if (typeof response.data === "object" && response.data !== null && !Array.isArray(response.data)) {
								// If result is an object, merge its properties
								resultJson = { ...resultJson, ...response.data }
							} else {
								// If result is not an object, store under 'result' key
								resultJson.result = response.data
							}
						}
					}

					const resultItem: INodeExecutionData = {
						json: resultJson,
						index: itemIndex,
						binary: item.binary,
					}

					logger.log("🌊 CallFunction: Created result item =", resultItem)
					returnData.push(resultItem)
				} else {
					logger.log("🔧 CallFunction: Using direct in-memory call")

					// Call function directly via registry
					const callResult = await registry.callFunction(functionName, targetScope, functionParameters, item)

					if (!callResult.result) {
						throw new NodeOperationError(this.getNode(), `Function '${functionName}' not found or no workers available`)
					}

					logger.log("🔧 CallFunction: Direct call result:", callResult.result)

					// Process the result - callResult.result is an array of INodeExecutionData
					for (const resultItem of callResult.result) {
						// Check if function returned a value via ReturnFromFunction node
						logger.log("🔧 CallFunction: About to check for return value...")

						// Extract the callId from the _functionCall metadata in the result
						let returnValueKey = callResult.actualExecutionId
						if (resultItem.json._functionCall && typeof resultItem.json._functionCall === "object") {
							const functionCallData = resultItem.json._functionCall as any
							if (functionCallData.callId) {
								returnValueKey = functionCallData.callId
								logger.log("🔧 CallFunction: Using callId from _functionCall metadata:", returnValueKey)
							} else {
								logger.log("🔧 CallFunction: No callId in _functionCall metadata, using actualExecutionId:", returnValueKey)
							}
						} else {
							logger.log("🔧 CallFunction: No _functionCall metadata found, using actualExecutionId:", returnValueKey)
						}

						const returnValue = await registry.getFunctionReturnValue(returnValueKey)
						logger.log("🔧 CallFunction: Function return value retrieved =", returnValue)

						let finalReturnValue = resultItem.json

						// Clear the return value from registry after retrieving it
						if (returnValue !== null) {
							logger.log("🔧 CallFunction: Clearing return value from registry...")
							await registry.clearFunctionReturnValue(returnValueKey)
							logger.log("🔧 CallFunction: Return value cleared")
							finalReturnValue = returnValue
						} else {
							// Clean up any _functionCall metadata from the result
							const cleanedJson = { ...resultItem.json }
							delete cleanedJson._functionCall
							finalReturnValue = cleanedJson
						}

						// Start with the original item
						let resultJson: any = { ...item.json }

						// Store response if requested
						if (storeResponse && responseVariableName && responseVariableName.trim()) {
							// Store under specific variable name
							resultJson[responseVariableName] = finalReturnValue
						} else {
							// Default behavior: merge the function result directly into the item
							if (typeof finalReturnValue === "object" && finalReturnValue !== null && !Array.isArray(finalReturnValue)) {
								// If result is an object, merge its properties
								resultJson = { ...resultJson, ...finalReturnValue }
							} else {
								// If result is not an object, store under 'result' key
								resultJson.result = finalReturnValue
							}
						}

						const finalResultItem: INodeExecutionData = {
							json: resultJson,
							index: itemIndex,
							binary: resultItem.binary || item.binary,
						}

						logger.log("🔧 CallFunction: Created result item =", finalResultItem)
						returnData.push(finalResultItem)
					}
				}
			} catch (error) {
				logger.error("🔧 CallFunction: Error calling function:", error)

				// Create an error result item
				const errorItem: INodeExecutionData = {
					json: {
						...item.json,
						_functionCall: {
							functionName,
							parameters: functionParameters,
							success: false,
							error: error.message,
						},
					},
					index: itemIndex,
					binary: item.binary,
				}

				if (this.continueOnFail()) {
					returnData.push(errorItem)
				} else {
					throw error
				}
			}
		}

		logger.log("🔧 CallFunction: Returning data =", returnData)
		return [returnData]
	}
}
