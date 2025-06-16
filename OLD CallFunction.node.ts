import {
	type INodeExecutionData,
	NodeConnectionType,
	type IExecuteFunctions,
	type INodeType,
	type INodeTypeDescription,
	type ILoadOptionsFunctions,
	NodeOperationError,
} from "n8n-workflow"
import { getInstance as getFunctionRegistry } from "../FunctionRegistry"

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
				console.log("🔧 CallFunction: Loading available functions for dropdown")
				const globalFunction = this.getCurrentNodeParameter("globalFunction") as boolean
				console.log("🔧 CallFunction: Global function mode:", globalFunction)

				const registry = getFunctionRegistry()
				let availableFunctions

				if (globalFunction) {
					// Only show global functions
					availableFunctions = await registry.getAvailableFunctions("__global__")
				} else {
					// Show local functions (current workflow scope)
					const workflowId = this.getWorkflow().id || "unknown"
					availableFunctions = await registry.getAvailableFunctions(workflowId)

					// If no local functions found, add a helpful message
					if (availableFunctions.length === 0) {
						return [
							{
								name: "⚠️ No Functions Available",
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

				console.log("🔧 CallFunction: Available functions:", availableFunctions)
				return availableFunctions
			},
			async getFunctionParameters(this: ILoadOptionsFunctions) {
				const functionName = this.getCurrentNodeParameter("functionName") as string
				const lastConfiguredFunction = this.getCurrentNodeParameter("lastConfiguredFunction") as string
				const globalFunction = this.getCurrentNodeParameter("globalFunction") as boolean

				console.log("🔧 CallFunction: Loading parameters for function:", functionName)
				console.log("🔧 CallFunction: Last configured function:", lastConfiguredFunction)
				console.log("🔧 CallFunction: Global function mode:", globalFunction)

				if (!functionName) {
					return []
				}

				const registry = getFunctionRegistry()
				let parameters

				if (globalFunction) {
					parameters = await registry.getFunctionParameters(functionName, "__global__")
				} else {
					const workflowId = this.getWorkflow().id || "unknown"
					parameters = await registry.getFunctionParameters(functionName, workflowId)
				}

				console.log("🔧 CallFunction: Found parameters:", parameters)

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

				console.log("🔧 CallFunction: Already selected parameters:", Array.from(selectedParameterNames))

				// Check if the function has changed from what was last configured
				const functionChanged = lastConfiguredFunction && lastConfiguredFunction !== functionName

				// Check if any of the currently selected parameters are NOT valid for this function
				const validParameterNames = new Set(parameters.map((p) => p.name))
				const hasInvalidParameters = Array.from(selectedParameterNames).some((name) => !validParameterNames.has(name))

				if (functionChanged || hasInvalidParameters) {
					console.log("🔧 CallFunction: Detected function change - showing reset warning")

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
				console.log("🔧 CallFunction: Available parameters after filtering:", availableParameters)

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
		console.log("🔧 CallFunction: Starting execution")
		const items = this.getInputData()
		console.log("🔧 CallFunction: Input items count =", items.length)
		const returnData: INodeExecutionData[] = []

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			const globalFunction = this.getNodeParameter("globalFunction", itemIndex) as boolean
			const functionName = this.getNodeParameter("functionName", itemIndex) as string
			const parameterMode = this.getNodeParameter("parameterMode", itemIndex) as string
			const storeResponse = this.getNodeParameter("storeResponse", itemIndex) as boolean
			const responseVariableName = this.getNodeParameter("responseVariableName", itemIndex, "") as string

			console.log("🔧 CallFunction: Global function =", globalFunction)
			console.log("🔧 CallFunction: Function name =", functionName)
			console.log("🔧 CallFunction: Parameter mode =", parameterMode)
			console.log("🔧 CallFunction: Store response =", storeResponse)
			console.log("🔧 CallFunction: Response variable name =", responseVariableName)

			if (!functionName || functionName === "__no_local_functions__" || functionName === "__activate_workflow__") {
				throw new NodeOperationError(this.getNode(), "Please select a valid function. If no functions are available, activate the workflow first.")
			}

			// Get function parameter definitions for validation
			const registry = getFunctionRegistry()
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
				console.log("🔧 CallFunction: Raw JSON parameters =", parametersJson)
				try {
					functionParameters = JSON.parse(parametersJson)
				} catch (error) {
					throw new NodeOperationError(this.getNode(), `Invalid JSON in parameters: ${error}`)
				}
			} else {
				// Individual parameters mode
				const parameters = this.getNodeParameter("parameters", itemIndex, {}) as any
				const parameterList = parameters.parameter || []
				console.log("🔧 CallFunction: Parameter list =", parameterList)

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
					console.warn("🔧 CallFunction: Invalid parameters detected (function may have changed):", invalidParameters)
					console.log("🔧 CallFunction: Valid parameters for function:", Array.from(validParameterNames))
				}

				console.log("🔧 CallFunction: Valid parameters used:", validParameters)
			}

			console.log("🔧 CallFunction: Final parameters =", functionParameters)

			console.log("🌊 CallFunction: Implementing stream-based function call")
			console.log("🌊 CallFunction: Calling function:", functionName, "with params:", functionParameters)

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

			console.log("🌊 CallFunction: Target scope =", targetScope)
			console.log("🌊 CallFunction: Global function =", globalFunction)

			// Use the registry instance to call the function via streams
			const item = items[itemIndex]

			try {
				// Generate unique call ID
				const callId = `call-${Date.now()}-${Math.random().toString(36).slice(2)}`
				const responseChannel = `function:response:${callId}`
				const streamKey = `function:stream:${targetScope}:${functionName}`

				console.log("🌊 CallFunction: Call ID:", callId)
				console.log("🌊 CallFunction: Stream key:", streamKey)
				console.log("🌊 CallFunction: Response channel:", responseChannel)

				// Check if any workers are available for this function
				const availableWorkers = await registry.getAvailableWorkers(functionName)

				if (availableWorkers.length === 0) {
					throw new NodeOperationError(this.getNode(), `Function '${functionName}' not found or no workers available`)
				}

				// Filter workers by health check
				const healthyWorkers = []
				for (const workerId of availableWorkers) {
					const isHealthy = await registry.isWorkerHealthy(workerId, functionName)
					if (isHealthy) {
						healthyWorkers.push(workerId)
					}
				}

				if (healthyWorkers.length === 0) {
					throw new NodeOperationError(this.getNode(), `Function '${functionName}' has no healthy workers available`)
				}

				console.log("🌊 CallFunction: Healthy workers available:", healthyWorkers.length)

				// Add call to stream
				await registry.addCall(streamKey, callId, functionName, functionParameters, item, responseChannel, 30000)

				console.log("🌊 CallFunction: Call added to stream, waiting for response...")

				// Wait for response
				const response = await registry.waitForResponse(responseChannel, 30) // 30 second timeout

				console.log("🌊 CallFunction: Received response:", response)

				if (!response.success) {
					throw new NodeOperationError(this.getNode(), `Function call failed: ${response.error}`)
				}

				// Start with the original item
				let resultJson: any = { ...item.json }

				// Store the response if requested
				if (storeResponse && response.data !== null && responseVariableName && responseVariableName.trim()) {
					resultJson[responseVariableName] = response.data
				}

				const resultItem: INodeExecutionData = {
					json: resultJson,
					index: itemIndex,
					binary: item.binary,
				}

				console.log("🌊 CallFunction: Created result item =", resultItem)
				returnData.push(resultItem)
			} catch (error) {
				console.error("🔧 CallFunction: Error calling function:", error)

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

		console.log("🔧 CallFunction: Returning data =", returnData)
		return [returnData]
	}
}
