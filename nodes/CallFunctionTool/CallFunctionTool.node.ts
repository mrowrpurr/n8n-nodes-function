import type { CallbackManagerForToolRun } from "@langchain/core/callbacks/manager"
import { DynamicTool } from "@langchain/core/tools"
import type { Tool } from "@langchain/core/tools"
import {
	NodeConnectionType,
	type INodeType,
	type INodeTypeDescription,
	type ISupplyDataFunctions,
	type SupplyData,
	type ILoadOptionsFunctions,
	type INodeExecutionData,
	type IDataObject,
	NodeOperationError,
} from "n8n-workflow"
import { getFunctionRegistry } from "../FunctionRegistryFactory"
import { functionRegistryLogger as logger } from "../Logger"
import { FunctionCallService } from "../services/FunctionCallService"

// Helper functions from logWrapper
function isToolsInstance(instance: unknown): instance is Tool {
	return typeof instance === "object" && instance !== null && "_call" in instance && typeof (instance as any)._call === "function"
}

async function callMethodAsync<T>(
	this: T,
	parameters: {
		executeFunctions: ISupplyDataFunctions
		connectionType: NodeConnectionType
		currentNodeRunIndex: number
		method: (...args: any[]) => Promise<unknown>
		arguments: unknown[]
	}
): Promise<unknown> {
	try {
		return await parameters.method.call(this, ...parameters.arguments)
	} catch (e) {
		const connectedNode = parameters.executeFunctions.getNode()

		const error = new NodeOperationError(connectedNode, e, {
			functionality: "configuration-node",
		})

		parameters.executeFunctions.addOutputData(parameters.connectionType, parameters.currentNodeRunIndex, error)

		if (error.message) {
			if (!error.description) {
				error.description = error.message
			}
			throw error
		}

		throw new NodeOperationError(connectedNode, `Error on node "${connectedNode.name}" which is connected via input "${parameters.connectionType}"`, {
			functionality: "configuration-node",
		})
	}
}

function logAiEvent(executeFunctions: ISupplyDataFunctions, eventName: string, data?: IDataObject) {
	// Simplified version - just log for now
	logger.log(`🤖 AI Event: ${eventName}`, data)
}

// Simplified logWrapper that only handles Tool case (exact copy from logWrapper.ts lines 405-436)
function toolLogWrapper<T extends Tool>(originalInstance: T, executeFunctions: ISupplyDataFunctions): T {
	return new Proxy(originalInstance, {
		get: (target, prop) => {
			// ========== Tool ==========
			if (isToolsInstance(originalInstance)) {
				if (prop === "_call" && "_call" in target) {
					return async (query: string): Promise<string> => {
						const connectionType = NodeConnectionType.AiTool
						const inputData: IDataObject = { query }

						if (target.metadata?.isFromToolkit) {
							inputData.tool = {
								name: target.name,
								description: target.description,
							}
						}
						const { index } = executeFunctions.addInputData(connectionType, [[{ json: inputData }]])

						const response = (await callMethodAsync.call(target, {
							executeFunctions,
							connectionType,
							currentNodeRunIndex: index,
							method: target[prop],
							arguments: [query],
						})) as string

						logAiEvent(executeFunctions, "ai-tool-called", { ...inputData, response })
						executeFunctions.addOutputData(connectionType, index, [[{ json: { response } }]])

						if (typeof response === "string") return response
						return JSON.stringify(response)
					}
				}
			}

			return (target as any)[prop]
		},
	})
}

export class CallFunctionTool implements INodeType {
	description: INodeTypeDescription = {
		displayName: "Call Function Tool",
		name: "callFunctionTool",
		icon: "fa:play",
		group: ["transform"],
		version: 1,
		description: "AI Tool that allows agents to call n8n Function nodes",
		subtitle: '={{$parameter["functionName"] ? $parameter["functionName"] : "Call Function"}}',
		defaults: {
			name: "Call Function Tool",
			color: "#ff6d5a",
		},
		codex: {
			categories: ["AI"],
			subcategories: {
				AI: ["Tools"],
				Tools: ["Other Tools"],
			},
		},
		// eslint-disable-next-line n8n-nodes-base/node-class-description-inputs-wrong-regular-node
		inputs: [],
		// eslint-disable-next-line n8n-nodes-base/node-class-description-outputs-wrong
		outputs: [NodeConnectionType.AiTool],
		outputNames: ["Tool"],
		properties: [
			{
				displayName:
					"ℹ️ This tool allows AI agents to call Function nodes. You can configure each parameter to be provided by the AI agent (required/optional) or set with a fixed value.",
				name: "notice",
				type: "notice",
				default: "",
			},
			{
				displayName: "Set Custom Function Name",
				name: "setCustomFunctionName",
				type: "boolean",
				default: false,
				description: "Whether to override the function name that the AI agent sees. By default, uses the Function node's name.",
			},
			{
				displayName: "Custom Function Name",
				name: "customFunctionName",
				type: "string",
				description: "Custom name for the function that the AI agent will see",
				placeholder: "e.g. calculate_tax",
				default: "",
				displayOptions: {
					show: {
						setCustomFunctionName: [true],
					},
				},
			},
			{
				displayName: "Set Custom Function Description",
				name: "setCustomFunctionDescription",
				type: "boolean",
				default: false,
				description: "Whether to override the function description that the AI agent sees. By default, uses the Function node's description.",
			},
			{
				displayName: "Custom Function Description",
				name: "customFunctionDescription",
				type: "string",
				description: "Custom description for the function that the AI agent will see",
				placeholder: "e.g. Calculate the total price including tax for a given amount",
				default: "",
				typeOptions: {
					rows: 3,
				},
				displayOptions: {
					show: {
						setCustomFunctionDescription: [true],
					},
				},
			},
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
				description:
					'Name of the function to call. Choose from the list, or specify an ID using an expression. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
				placeholder: "Select a function...",
				displayOptions: {
					hide: {
						workflowId: [""],
					},
				},
			},
			{
				displayName: "Function Parameters",
				name: "functionParameters",
				placeholder: "Add parameter",
				type: "fixedCollection",
				description: "Configure how each function parameter should be handled - by AI agent or with fixed values",
				typeOptions: {
					multipleValues: true,
					sortable: true,
				},
				default: {},
				displayOptions: {
					show: {
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
									loadOptionsDependsOn: ["workflowId.value", "functionName"],
								},
								default: "",
								description:
									'Select the function parameter to configure. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
								required: true,
							},
							{
								displayName: "Value Provided",
								name: "valueProvider",
								type: "options",
								options: [
									{
										name: "By Model (and Is Required)",
										value: "modelRequired",
									},
									{
										name: "By Model (but Is Optional)",
										value: "modelOptional",
									},
									{
										name: "Using Field Below",
										value: "fieldValue",
									},
								],
								default: "modelRequired",
								description: "How this parameter value should be provided",
							},
							{
								displayName: "Value",
								name: "value",
								type: "string",
								default: "",
								description: "Fixed value for this parameter",
								displayOptions: {
									show: {
										valueProvider: ["fieldValue"],
									},
								},
							},
						],
					},
				],
			},
		],
	}

	methods = {
		loadOptions: {
			async getAvailableFunctions(this: ILoadOptionsFunctions) {
				logger.log("🔧 CallFunctionTool: Loading available functions for dropdown")

				// Get the selected workflow ID from the workflowSelector
				const workflowSelector = this.getCurrentNodeParameter("workflowId") as any
				logger.log("🔧 CallFunctionTool: Selected workflow selector:", workflowSelector)

				// Extract the actual workflow ID from the selector object
				let workflowId: string = ""
				if (workflowSelector && typeof workflowSelector === "object" && workflowSelector.value) {
					workflowId = workflowSelector.value
				} else if (typeof workflowSelector === "string") {
					workflowId = workflowSelector
				}

				logger.log("🔧 CallFunctionTool: Extracted workflow ID:", workflowId)

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

				logger.log("🔧 CallFunctionTool: Available functions:", availableFunctions)
				return availableFunctions
			},
			async getFunctionParameters(this: ILoadOptionsFunctions) {
				const functionName = this.getCurrentNodeParameter("functionName") as string
				const workflowSelector = this.getCurrentNodeParameter("workflowId") as any

				logger.log("🔧 CallFunctionTool: Loading parameters for function:", functionName)

				// Extract the actual workflow ID from the selector object
				let workflowId: string = ""
				if (workflowSelector && typeof workflowSelector === "object" && workflowSelector.value) {
					workflowId = workflowSelector.value
				} else if (typeof workflowSelector === "string") {
					workflowId = workflowSelector
				}

				if (!functionName || functionName === "__no_functions__" || functionName === "__no_workflow_selected__" || functionName === "__activate_workflow__") {
					return []
				}

				if (!workflowId) {
					return []
				}

				const registry = await getFunctionRegistry()
				const parameters = await registry.getFunctionParameters(functionName, workflowId)

				logger.log("🔧 CallFunctionTool: Found parameters:", parameters)

				// Get currently configured parameters to filter out already selected ones
				const currentParameters = this.getCurrentNodeParameter("functionParameters") as any
				const selectedParameterNames = new Set<string>()

				if (currentParameters && currentParameters.parameter) {
					for (const param of currentParameters.parameter) {
						if (param.name) {
							selectedParameterNames.add(param.name)
						}
					}
				}

				// Filter out already-selected parameters
				const availableParameters = parameters.filter((param) => !selectedParameterNames.has(param.name))

				// If no parameters are available, return a descriptive message
				if (availableParameters.length === 0) {
					return [
						{
							name: "All Parameters Have Been Configured",
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

	async supplyData(this: ISupplyDataFunctions): Promise<SupplyData> {
		const setCustomFunctionName = this.getNodeParameter("setCustomFunctionName", 0, false) as boolean
		const customFunctionName = this.getNodeParameter("customFunctionName", 0, "") as string
		const setCustomFunctionDescription = this.getNodeParameter("setCustomFunctionDescription", 0, false) as boolean
		const customFunctionDescription = this.getNodeParameter("customFunctionDescription", 0, "") as string
		const workflowSelector = this.getNodeParameter("workflowId", 0) as any
		const functionName = this.getNodeParameter("functionName", 0) as string

		// Extract the actual workflow ID from the selector object
		let workflowId: string = ""
		if (workflowSelector && typeof workflowSelector === "object" && workflowSelector.value) {
			workflowId = workflowSelector.value
		} else if (typeof workflowSelector === "string") {
			workflowId = workflowSelector
		}

		logger.log("🔧 CallFunctionTool: Creating tool for function:", functionName)
		logger.log("🔧 CallFunctionTool: Workflow ID:", workflowId)

		if (!workflowId) {
			throw new NodeOperationError(this.getNode(), "Please select a workflow first.")
		}

		if (!functionName || functionName === "__no_functions__" || functionName === "__no_workflow_selected__" || functionName === "__activate_workflow__") {
			throw new NodeOperationError(
				this.getNode(),
				"Please select a valid function. If no functions are available, make sure the selected workflow is active and contains Function nodes."
			)
		}

		// Fetch function name and description from registry
		const registry = await getFunctionRegistry()
		let actualFunctionName = functionName
		let actualFunctionDescription = `Call the ${functionName} function`

		try {
			// Get available functions to fetch the function's name and description
			const availableFunctions = await registry.getAvailableFunctions(workflowId)
			const selectedFunction = availableFunctions.find((f) => f.value === functionName)

			if (selectedFunction) {
				actualFunctionName = selectedFunction.name
				actualFunctionDescription = selectedFunction.description
				logger.log("🔧 CallFunctionTool: Found function in registry:", {
					name: actualFunctionName,
					description: actualFunctionDescription,
				})
			} else {
				logger.warn("🔧 CallFunctionTool: Function not found in registry, using fallback")
			}
		} catch (error) {
			logger.warn("🔧 CallFunctionTool: Failed to fetch function details from registry:", error)
		}

		// Apply custom overrides if enabled
		const finalFunctionName = setCustomFunctionName && customFunctionName ? customFunctionName : actualFunctionName
		const finalFunctionDescription = setCustomFunctionDescription && customFunctionDescription ? customFunctionDescription : actualFunctionDescription

		logger.log("🔧 CallFunctionTool: Final function details:", {
			name: finalFunctionName,
			description: finalFunctionDescription,
			usingCustomName: setCustomFunctionName && customFunctionName,
			usingCustomDescription: setCustomFunctionDescription && customFunctionDescription,
		})

		// Get all function parameters from registry
		let allFunctionParams: Array<{ name: string; description?: string; type: string; required: boolean }> = []
		try {
			const functionParams = await registry.getFunctionParameters(functionName, workflowId)
			allFunctionParams = functionParams.map((param: any) => ({
				name: param.name,
				description: param.description || `${param.type} parameter`,
				type: param.type || "string",
				required: param.required || false,
			}))
			logger.log("🔧 CallFunctionTool: All function parameters:", allFunctionParams)
		} catch (error) {
			logger.warn("🔧 CallFunctionTool: Failed to get function parameters:", error)
			allFunctionParams = []
		}

		// Get configured parameter settings
		const functionParameters = this.getNodeParameter("functionParameters", 0, {}) as any
		const parameterList = functionParameters.parameter || []

		// Parse parameter configurations
		const parameterConfigs = new Map<string, { valueProvider: string; value?: string; paramDef: any }>()
		const hardCodedValues = new Map<string, any>()
		const aiParameters: Array<{ name: string; description?: string; type: string; required: boolean }> = []

		// Process configured parameters
		for (const paramConfig of parameterList) {
			const paramName = paramConfig.name
			const valueProvider = paramConfig.valueProvider
			const value = paramConfig.value

			// Skip special placeholder values
			if (paramName === "__no_params_available__") {
				continue
			}

			// Find the parameter definition
			const paramDef = allFunctionParams.find((p) => p.name === paramName)
			if (!paramDef) {
				logger.warn(`🔧 CallFunctionTool: Parameter ${paramName} not found in function definition`)
				continue
			}

			parameterConfigs.set(paramName, { valueProvider, value, paramDef })

			if (valueProvider === "fieldValue") {
				// Hard-coded value - parse it appropriately
				let parsedValue: any = value
				try {
					// Try to parse as JSON first
					parsedValue = JSON.parse(value)
				} catch {
					// If not JSON, use as string
					parsedValue = value
				}
				hardCodedValues.set(paramName, parsedValue)
				logger.log(`🔧 CallFunctionTool: Hard-coded parameter ${paramName} = ${parsedValue}`)
			} else {
				// AI-provided parameter
				const isRequired = valueProvider === "modelRequired"
				aiParameters.push({
					name: paramDef.name,
					description: paramDef.description,
					type: paramDef.type,
					required: isRequired,
				})
				logger.log(`🔧 CallFunctionTool: AI parameter ${paramName} (${isRequired ? "required" : "optional"})`)
			}
		}

		// Add any unconfigured parameters as AI-required by default
		for (const param of allFunctionParams) {
			if (!parameterConfigs.has(param.name)) {
				aiParameters.push({
					name: param.name,
					description: param.description,
					type: param.type,
					required: param.required,
				})
				logger.log(`🔧 CallFunctionTool: Unconfigured parameter ${param.name} added as AI-required`)
			}
		}

		logger.log("🔧 CallFunctionTool: Parameter configuration summary:", {
			totalParameters: allFunctionParams.length,
			hardCodedParameters: Array.from(hardCodedValues.keys()),
			aiParameters: aiParameters.map((p) => `${p.name}(${p.required ? "required" : "optional"})`),
		})

		// Build the tool description
		let finalDescription = finalFunctionDescription

		if (aiParameters.length > 0) {
			const getParametersDescription = (parameters: any[]) =>
				parameters.map((p) => `${p.name}: (description: ${p.description || ""}, type: ${p.type || "string"}, required: ${!!p.required})`).join(",\n ")

			finalDescription += `
	Tool expects valid stringified JSON object with ${aiParameters.length} properties.
	Property names with description, type and required status:
	${getParametersDescription(aiParameters)}
	ALL parameters marked as required must be provided`
		}

		// Log the complete tool schema that the AI agent will see
		logger.log("🔧 CallFunctionTool: Complete tool schema for AI agent:", {
			toolName: finalFunctionName.replace(/ /g, "_"),
			originalFunctionName: functionName,
			actualFunctionName: actualFunctionName,
			finalFunctionName: finalFunctionName,
			workflowId,
			totalFunctionParameters: allFunctionParams.length,
			aiParameters,
			hardCodedParameters: Array.from(hardCodedValues.entries()),
			finalDescription,
			aiParameterCount: aiParameters.length,
			requiredAiParameters: aiParameters.filter((p) => p.required).map((p) => p.name),
			optionalAiParameters: aiParameters.filter((p) => !p.required).map((p) => p.name),
			customOverrides: {
				name: setCustomFunctionName && customFunctionName,
				description: setCustomFunctionDescription && customFunctionDescription,
			},
		})

		logger.log("🔧 CallFunctionTool: Final tool description:", finalDescription)

		// Get the base context for proper execution tracking
		const baseContext = this

		// Track run index for multiple executions (like WorkflowToolService does)
		let runIndex: number = 0

		// Create the tool function with proper execution tracking
		const toolFunction = async (input: string | Record<string, any>, runManager?: CallbackManagerForToolRun) => {
			const localRunIndex = runIndex++
			logger.log("🔧 CallFunctionTool: Tool function called with input:", input, "runIndex:", localRunIndex)

			let aiProvidedParameters: Record<string, any> = {}

			// Parse input - it could be a JSON string or an object
			if (typeof input === "string") {
				try {
					aiProvidedParameters = JSON.parse(input)
				} catch (error) {
					// If it's not JSON, treat it as a single parameter
					if (aiParameters.length === 1) {
						aiProvidedParameters[aiParameters[0].name] = input
					} else {
						throw new NodeOperationError(baseContext.getNode(), `Invalid input format. Expected JSON object with parameters: ${aiParameters.map((p) => p.name).join(", ")}`)
					}
				}
			} else if (typeof input === "object" && input !== null) {
				aiProvidedParameters = input
			} else {
				throw new NodeOperationError(baseContext.getNode(), "Invalid input type. Expected string or object.")
			}

			logger.log("🔧 CallFunctionTool: AI-provided parameters:", aiProvidedParameters)

			// Validate required AI parameters
			for (const paramDef of aiParameters) {
				if (paramDef.required && !(paramDef.name in aiProvidedParameters)) {
					throw new NodeOperationError(baseContext.getNode(), `Missing required parameter: ${paramDef.name}`)
				}
			}

			// Merge hard-coded values with AI-provided values
			const finalParameters: Record<string, any> = {
				...Object.fromEntries(hardCodedValues),
				...aiProvidedParameters,
			}

			logger.log("🔧 CallFunctionTool: Final merged parameters:", finalParameters)

			try {
				// Call the function using FunctionCallService
				const result = await FunctionCallService.callFunction({
					functionName,
					workflowId,
					parameters: finalParameters,
					inputData: { json: finalParameters }, // Provide the parameters as input data
				})

				if (!result.success) {
					throw new NodeOperationError(baseContext.getNode(), result.error || "Function call failed")
				}

				logger.log("🔧 CallFunctionTool: Function call successful, result:", result.data)

				// Prepare response data for logging
				const responseData: INodeExecutionData[] = [
					{
						json: {
							functionName,
							workflowId,
							aiProvidedParameters,
							hardCodedParameters: Object.fromEntries(hardCodedValues),
							finalParameters,
							result: result.data,
							success: true,
						},
					},
				]

				// Add output data to register the tool execution in n8n's system (this makes it show up in AI Agent logs!)
				void baseContext.addOutputData(NodeConnectionType.AiTool, localRunIndex, [responseData])

				// Return the result data, or a success message if no data
				return result.data !== null ? JSON.stringify(result.data) : "Function executed successfully"
			} catch (error) {
				logger.error("🔧 CallFunctionTool: Function call failed:", error)

				// Prepare error data for logging
				const errorData: INodeExecutionData[] = [
					{
						json: {
							functionName,
							workflowId,
							aiProvidedParameters,
							hardCodedParameters: Object.fromEntries(hardCodedValues),
							finalParameters,
							error: error.message,
							success: false,
						},
					},
				]

				// Add error output data to register the failed execution
				void baseContext.addOutputData(NodeConnectionType.AiTool, localRunIndex, [errorData])

				throw new NodeOperationError(baseContext.getNode(), `Function call failed: ${error.message}`)
			}
		}

		// Create a DynamicTool object that can be used by AI agents
		const tool = new DynamicTool({
			name: finalFunctionName.replace(/ /g, "_"),
			description: finalDescription,
			func: toolFunction,
		})

		logger.log("🔧 CallFunctionTool: Tool created successfully with name:", finalFunctionName)

		// Apply the log wrapper to make the tool visible in AI Agent logs
		const wrappedTool = toolLogWrapper(tool, this)

		return {
			response: wrappedTool,
		}
	}
}
