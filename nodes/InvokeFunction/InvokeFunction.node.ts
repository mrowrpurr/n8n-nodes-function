import {
	type INodeExecutionData,
	NodeConnectionType,
	type IExecuteFunctions,
	type INodeType,
	type INodeTypeDescription,
	type ILoadOptionsFunctions,
	NodeOperationError,
} from "n8n-workflow"
import { getFunctionRegistry } from "../FunctionRegistryFactory"
import { functionRegistryLogger as logger } from "../Logger"
import { FunctionCallService } from "../services/FunctionCallService"

export class InvokeFunction implements INodeType {
	description: INodeTypeDescription = {
		displayName: "Invoke Function",
		name: "invokeFunction",
		icon: "fa:rocket",
		group: ["transform"],
		version: 1,
		description: "Invoke a Function node defined in the current workflow (usable as AI tool)",
		subtitle: '={{$parameter["functionName"] ? $parameter["functionName"] : ""}}',
		defaults: {
			name: "Invoke Function",
			color: "#9b59b6",
		},
		inputs: [NodeConnectionType.Main],
		outputs: [NodeConnectionType.Main],
		usableAsTool: true,
		properties: [
			{
				displayName: "ℹ️ This node can be used as an AI tool. If function details are out-of-date, toggle Active off/on for the workflow containing the function",
				name: "functionRefreshNotice",
				type: "notice",
				default: "",
			},
			{
				displayName: "Workflow",
				name: "workflowId",
				type: "workflowSelector",
				default: "",
				required: true,
				description: "Select the workflow containing the function to invoke",
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
				description: 'Name of the function to invoke. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
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
					show: {
						functionName: [{ _cnd: { exists: true } }],
					},
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
						functionName: [{ _cnd: { exists: true } }],
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
						functionName: [{ _cnd: { exists: true } }],
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
					show: {
						functionName: [{ _cnd: { exists: true } }],
					},
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
						functionName: [{ _cnd: { exists: true } }],
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
				logger.log("🚀 InvokeFunction: Loading available functions for dropdown")

				// Get the selected workflow ID from the workflowSelector
				const workflowSelector = this.getCurrentNodeParameter("workflowId") as any
				logger.log("🚀 InvokeFunction: Selected workflow selector:", workflowSelector)

				// Extract the actual workflow ID from the selector object
				let workflowId: string = ""
				if (workflowSelector && typeof workflowSelector === "object" && workflowSelector.value) {
					workflowId = workflowSelector.value
				} else if (typeof workflowSelector === "string") {
					workflowId = workflowSelector
				}

				logger.log("🚀 InvokeFunction: Extracted workflow ID:", workflowId)

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

				// Enhanced diagnostic logging before cleanup
				try {
					logger.log("🔍 PREVENTION: Checking for stale resources before loading functions...")
					const diagnostics = await registry.listAllWorkersAndFunctions()

					// Log what would be garbage collected
					const wouldGCFunctions = diagnostics.wouldGC.filter((item: any) => item.type === "function")
					const wouldGCWorkers = diagnostics.wouldGC.filter((item: any) => item.type === "worker")

					if (wouldGCFunctions.length > 0) {
						logger.log(`🧹 PREVENTION: Would GC ${wouldGCFunctions.length} stale functions:`)
						wouldGCFunctions.forEach((item: any) => {
							logger.log(`🧹 PREVENTION:   - Function ${item.name} (${item.scope}): ${item.reason}`)
						})
					}

					if (wouldGCWorkers.length > 0) {
						logger.log(`🧹 PREVENTION: Would GC ${wouldGCWorkers.length} stale workers:`)
						wouldGCWorkers.forEach((item: any) => {
							logger.log(`🧹 PREVENTION:   - Worker ${item.workerId} (${item.functionName}): ${item.reason}`)
						})
					}

					// Conservative cleanup - only remove functions without healthy workers
					const cleanedCount = await registry.cleanupStaleFunctions()
					if (cleanedCount > 0) {
						logger.log("🚀 InvokeFunction: Cleaned up", cleanedCount, "stale functions")
					}
				} catch (error) {
					logger.warn("🚀 InvokeFunction: Error during diagnostic check or cleanup:", error)
				}

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

				logger.log("🚀 InvokeFunction: Available functions:", availableFunctions)
				return availableFunctions
			},
			async getFunctionParameters(this: ILoadOptionsFunctions) {
				const functionName = this.getCurrentNodeParameter("functionName") as string
				const lastConfiguredFunction = this.getCurrentNodeParameter("lastConfiguredFunction") as string
				const workflowSelector = this.getCurrentNodeParameter("workflowId") as any

				logger.log("🚀 InvokeFunction: Loading parameters for function:", functionName)
				logger.log("🚀 InvokeFunction: Last configured function:", lastConfiguredFunction)
				logger.log("🚀 InvokeFunction: Selected workflow selector:", workflowSelector)

				// Extract the actual workflow ID from the selector object
				let workflowId: string = ""
				if (workflowSelector && typeof workflowSelector === "object" && workflowSelector.value) {
					workflowId = workflowSelector.value
				} else if (typeof workflowSelector === "string") {
					workflowId = workflowSelector
				}

				logger.log("🚀 InvokeFunction: Extracted workflow ID:", workflowId)

				if (!functionName || functionName === "__no_functions__" || functionName === "__no_workflow_selected__" || functionName === "__activate_workflow__") {
					return []
				}

				if (!workflowId) {
					return []
				}

				const registry = await getFunctionRegistry()
				const parameters = await registry.getFunctionParameters(functionName, workflowId)

				logger.log("🚀 InvokeFunction: Found parameters:", parameters)

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

				logger.log("🚀 InvokeFunction: Already selected parameters:", Array.from(selectedParameterNames))

				// Check if the function has changed from what was last configured
				const functionChanged = lastConfiguredFunction && lastConfiguredFunction !== functionName

				// Check if any of the currently selected parameters are NOT valid for this function
				const validParameterNames = new Set(parameters.map((p) => p.name))
				const hasInvalidParameters = Array.from(selectedParameterNames).some((name) => !validParameterNames.has(name))

				if (functionChanged || hasInvalidParameters) {
					logger.log("🚀 InvokeFunction: Detected function change - showing reset warning")

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
				logger.log("🚀 InvokeFunction: Available parameters after filtering:", availableParameters)

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
		logger.log(`🚀🚀🚀 INVOKEFUNCTION: ===== EXECUTION STARTED =====`)
		logger.log(`🚀🚀🚀 INVOKEFUNCTION: Starting execution`)

		const items = this.getInputData()
		logger.log(`🚀🚀🚀 INVOKEFUNCTION: Input items count =`, items.length)

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

			// Prepare parameters to pass to the function
			let functionParameters: Record<string, any> = {}

			if (parameterMode === "json") {
				const parametersJson = this.getNodeParameter("parametersJson", itemIndex) as string
				logger.log("🚀 InvokeFunction: Raw JSON parameters =", parametersJson)
				try {
					functionParameters = JSON.parse(parametersJson)
				} catch (error) {
					throw new NodeOperationError(this.getNode(), `Invalid JSON in parameters: ${error}`)
				}
			} else {
				// Individual parameters mode
				const parameters = this.getNodeParameter("parameters", itemIndex, {}) as any
				const parameterList = parameters.parameter || []
				logger.log("🚀 InvokeFunction: Parameter list =", parameterList)

				// Get function parameter definitions for validation
				const registry = await getFunctionRegistry()
				const functionParameterDefs = await registry.getFunctionParameters(functionName, workflowId)
				const validParameterNames = new Set(functionParameterDefs.map((p: any) => p.name))

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
					logger.warn("🚀 InvokeFunction: Invalid parameters detected (function may have changed):", invalidParameters)
					logger.log("🚀 InvokeFunction: Valid parameters for function:", Array.from(validParameterNames))
				}

				logger.log("🚀 InvokeFunction: Valid parameters used:", validParameters)
			}

			logger.log("🚀 InvokeFunction: Final parameters =", functionParameters)

			const item = items[itemIndex]

			try {
				// Use the FunctionCallService to handle the function call
				const result = await FunctionCallService.callFunction({
					functionName,
					workflowId,
					parameters: functionParameters,
					inputData: item,
				})

				if (!result.success) {
					throw new NodeOperationError(this.getNode(), result.error || `Function call failed`)
				}

				// Start with the original item
				let resultJson: any = { ...item.json }

				// Store response ONLY if requested
				if (result.data !== null && storeResponse && responseVariableName && responseVariableName.trim()) {
					// Store under specific variable name
					resultJson[responseVariableName] = result.data
				}
				// If storeResponse is false, don't include the function return value at all

				const resultItem: INodeExecutionData = {
					json: resultJson,
					index: itemIndex,
					binary: item.binary,
				}

				logger.log("🚀 InvokeFunction: Created result item =", resultItem)
				returnData.push(resultItem)
			} catch (error) {
				logger.error("🚀 InvokeFunction: Error calling function:", error)

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
					logger.log("⚠️ InvokeFunction: Continue on fail enabled, adding error item")
					returnData.push(errorItem)
				} else {
					logger.log("❌ InvokeFunction: Continue on fail disabled, rethrowing error")
					throw error
				}
			}
		}

		logger.log("🚀🚀🚀 INVOKEFUNCTION: ===== EXECUTION COMPLETED =====")
		logger.log("🚀 InvokeFunction: Returning data =", returnData)
		return [returnData]
	}
}
