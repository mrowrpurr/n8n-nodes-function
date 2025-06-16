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
				displayName: "Workflow",
				name: "workflowId",
				type: "workflowSelector",
				default: "",
				required: true,
				description: "Select the workflow containing the function to call",
			},
			{
				displayName: "Function Name or ID",
				name: "functionName",
				type: "options",
				typeOptions: {
					loadOptionsMethod: "getAvailableFunctions",
					loadOptionsDependsOn: ["workflowId.value"],
				},
				default: "",
				required: true,
				description: 'Name of the function to call. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
				placeholder: "Select a function...",
				displayOptions: {
					hide: {
						workflowId: [""],
					},
				},
			},
			{
				displayName: "Last Configured Function",
				name: "lastConfiguredFunction",
				type: "hidden",
				default: "",
				description: "Internal field to track function changes",
			},
			{
				displayName: "Last Selected Workflow",
				name: "lastSelectedWorkflow",
				type: "hidden",
				default: "",
				description: "Internal field to track workflow changes",
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
						functionName: ["", "__no_workflow_selected__", "__no_functions__", "__activate_workflow__"],
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
					hide: {
						functionName: ["", "__no_workflow_selected__", "__no_functions__", "__activate_workflow__"],
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
						functionName: ["", "__no_workflow_selected__", "__no_functions__", "__activate_workflow__"],
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
						functionName: ["", "__no_workflow_selected__", "__no_functions__", "__activate_workflow__"],
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
						functionName: ["", "__no_workflow_selected__", "__no_functions__", "__activate_workflow__"],
					},
				},
			},
		],
	}

	methods = {
		loadOptions: {
			async getAvailableFunctions(this: ILoadOptionsFunctions) {
				logger.log("🔧 CallFunction: Loading available functions for dropdown")

				// Get the selected workflow ID from the workflowSelector
				const workflowSelector = this.getCurrentNodeParameter("workflowId") as any
				logger.log("🔧 CallFunction: Selected workflow selector:", workflowSelector)

				// Extract the actual workflow ID from the selector object
				let workflowId: string = ""
				if (workflowSelector && typeof workflowSelector === "object" && workflowSelector.value) {
					workflowId = workflowSelector.value
				} else if (typeof workflowSelector === "string") {
					workflowId = workflowSelector
				}

				logger.log("🔧 CallFunction: Extracted workflow ID:", workflowId)

				if (!workflowId) {
					return [
						{
							name: "⚠️ Please Select a Workflow First",
							value: "__no_workflow_selected__",
							description: "Select a workflow to see available functions",
						},
					]
				}

				const registry = await getFunctionRegistry()
				const availableFunctions = await registry.getAvailableFunctions(workflowId)

				// If no functions found, add a helpful message
				if (availableFunctions.length === 0) {
					return [
						{
							name: "⚠️ No Functions Available in Selected Workflow",
							value: "__no_functions__",
							description: "The selected workflow has no Function nodes. Add Function nodes and activate the workflow.",
						},
						{
							name: "🔄 Activate Workflow to Refresh",
							value: "__activate_workflow__",
							description: "Make sure the selected workflow is active and contains Function nodes",
						},
					]
				}

				logger.log("🔧 CallFunction: Available functions:", availableFunctions)
				return availableFunctions
			},
			async getFunctionParameters(this: ILoadOptionsFunctions) {
				const functionName = this.getCurrentNodeParameter("functionName") as string
				const lastConfiguredFunction = this.getCurrentNodeParameter("lastConfiguredFunction") as string
				const workflowSelector = this.getCurrentNodeParameter("workflowId") as any

				logger.log("🔧 CallFunction: Loading parameters for function:", functionName)
				logger.log("🔧 CallFunction: Last configured function:", lastConfiguredFunction)
				logger.log("🔧 CallFunction: Selected workflow selector:", workflowSelector)

				// Extract the actual workflow ID from the selector object
				let workflowId: string = ""
				if (workflowSelector && typeof workflowSelector === "object" && workflowSelector.value) {
					workflowId = workflowSelector.value
				} else if (typeof workflowSelector === "string") {
					workflowId = workflowSelector
				}

				logger.log("🔧 CallFunction: Extracted workflow ID:", workflowId)

				if (!functionName || functionName === "__no_functions__" || functionName === "__no_workflow_selected__" || functionName === "__activate_workflow__") {
					return []
				}

				if (!workflowId) {
					return []
				}

				const registry = await getFunctionRegistry()
				const parameters = await registry.getFunctionParameters(functionName, workflowId)

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

			const workflowSelector = this.getNodeParameter("workflowId", itemIndex) as any
			const functionName = this.getNodeParameter("functionName", itemIndex) as string
			const parameterMode = this.getNodeParameter("parameterMode", itemIndex) as string
			const storeResponse = this.getNodeParameter("storeResponse", itemIndex) as boolean
			const responseVariableName = this.getNodeParameter("responseVariableName", itemIndex, "") as string

			// Extract the actual workflow ID from the selector object
			let workflowId: string = ""
			if (workflowSelector && typeof workflowSelector === "object" && workflowSelector.value) {
				workflowId = workflowSelector.value
			} else if (typeof workflowSelector === "string") {
				workflowId = workflowSelector
			}

			logger.log(`Selected workflow selector =`, workflowSelector)
			logger.log(`Extracted workflow ID =`, workflowId)
			logger.log(`Function name =`, functionName)
			logger.log(`Parameter mode =`, parameterMode)
			logger.log(`Store response =`, storeResponse)
			logger.log(`Response variable name =`, responseVariableName)

			if (!workflowId) {
				throw new NodeOperationError(this.getNode(), "Please select a workflow first.")
			}

			if (!functionName || functionName === "__no_functions__" || functionName === "__no_workflow_selected__" || functionName === "__activate_workflow__") {
				throw new NodeOperationError(
					this.getNode(),
					"Please select a valid function. If no functions are available, make sure the selected workflow is active and contains Function nodes."
				)
			}

			// Get function parameter definitions for validation
			const registry = await getFunctionRegistry()
			const functionParameterDefs = await registry.getFunctionParameters(functionName, workflowId)

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

			// Use the selected workflow ID as the target scope
			const targetScope = workflowId

			logger.log("🔧 CallFunction: Target scope =", targetScope)

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

					// Add call to stream (no timeout)
					await registry.addCall(streamKey, callId, functionName, functionParameters, item, responseChannel)

					logger.log("🌊 CallFunction: Call added to stream, waiting for response...")
					logger.log("🌊 CallFunction: Note: Function MUST use ReturnFromFunction node or this will wait FOREVER")

					// Wait for response with NO timeout - will wait forever until ReturnFromFunction responds
					const response = await registry.waitForResponse(responseChannel, 0) // 0 = infinite wait

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
