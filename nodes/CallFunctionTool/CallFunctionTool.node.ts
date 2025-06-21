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
				displayName: "ℹ️ This tool allows AI agents to call Function nodes. Configure which function to call and how parameters should be handled.",
				name: "notice",
				type: "notice",
				default: "",
			},
			{
				displayName: "Tool Description",
				name: "toolDescription",
				type: "string",
				description: "Explain to the AI agent what this function does and when to use it",
				placeholder: "e.g. Calculate the total price including tax for a given amount",
				default: "",
				typeOptions: {
					rows: 3,
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
				displayName: "Parameter Schema",
				name: "parameterSchema",
				type: "options",
				options: [
					{
						name: "Auto-Detect From Function",
						value: "auto",
						description: "Automatically detect parameters from the selected function",
					},
					{
						name: "Custom Schema",
						value: "custom",
						description: "Define a custom parameter schema for the AI agent",
					},
				],
				default: "auto",
				description: "How to define the parameters that the AI agent can pass to the function",
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
				displayName: "Custom Parameters",
				name: "customParameters",
				placeholder: "Add parameter",
				type: "fixedCollection",
				description: "Define the parameters that the AI agent can pass to the function",
				typeOptions: {
					multipleValues: true,
					sortable: true,
				},
				default: {},
				displayOptions: {
					show: {
						parameterSchema: ["custom"],
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
								displayName: "Parameter Name",
								name: "name",
								type: "string",
								default: "",
								description: "Name of the parameter that the AI agent will provide",
								required: true,
							},
							{
								displayName: "Description",
								name: "description",
								type: "string",
								default: "",
								description: "Description of what this parameter is for (helps the AI agent understand when to use it)",
								placeholder: "e.g. The amount to calculate tax for",
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
								description: "The type of data this parameter expects",
							},
							{
								displayName: "Required",
								name: "required",
								type: "boolean",
								default: true,
								description: "Whether this parameter is required for the function to work",
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
		},
	}

	async supplyData(this: ISupplyDataFunctions): Promise<SupplyData> {
		const toolDescription = this.getNodeParameter("toolDescription", 0) as string
		const workflowSelector = this.getNodeParameter("workflowId", 0) as any
		const functionName = this.getNodeParameter("functionName", 0) as string
		const parameterSchema = this.getNodeParameter("parameterSchema", 0, "auto") as string

		// Extract the actual workflow ID from the selector object
		let workflowId: string = ""
		if (workflowSelector && typeof workflowSelector === "object" && workflowSelector.value) {
			workflowId = workflowSelector.value
		} else if (typeof workflowSelector === "string") {
			workflowId = workflowSelector
		}

		logger.log("🔧 CallFunctionTool: Creating tool for function:", functionName)
		logger.log("🔧 CallFunctionTool: Workflow ID:", workflowId)
		logger.log("🔧 CallFunctionTool: Parameter schema mode:", parameterSchema)

		if (!workflowId) {
			throw new NodeOperationError(this.getNode(), "Please select a workflow first.")
		}

		if (!functionName || functionName === "__no_functions__" || functionName === "__no_workflow_selected__" || functionName === "__activate_workflow__") {
			throw new NodeOperationError(
				this.getNode(),
				"Please select a valid function. If no functions are available, make sure the selected workflow is active and contains Function nodes."
			)
		}

		// Get parameter definitions
		let parameterDefinitions: Array<{ name: string; description?: string; type: string; required: boolean }> = []

		if (parameterSchema === "auto") {
			// Auto-detect parameters from the function
			try {
				const registry = await getFunctionRegistry()
				const functionParams = await registry.getFunctionParameters(functionName, workflowId)
				parameterDefinitions = functionParams.map((param: any) => ({
					name: param.name,
					description: param.description || `${param.type} parameter`,
					type: param.type || "string",
					required: param.required || false,
				}))
				logger.log("🔧 CallFunctionTool: Auto-detected parameters:", parameterDefinitions)
			} catch (error) {
				logger.warn("🔧 CallFunctionTool: Failed to auto-detect parameters:", error)
				parameterDefinitions = []
			}
		} else {
			// Use custom parameter definitions
			const customParameters = this.getNodeParameter("customParameters", 0, {}) as any
			const parameterList = customParameters.parameter || []
			parameterDefinitions = parameterList.map((param: any) => ({
				name: param.name,
				description: param.description || `${param.type} parameter`,
				type: param.type || "string",
				required: param.required !== false,
			}))
			logger.log("🔧 CallFunctionTool: Custom parameters:", parameterDefinitions)
		}

		// Build the tool description
		let finalDescription = toolDescription || `Call the ${functionName} function`

		if (parameterDefinitions.length > 0) {
			finalDescription += "\n\nParameters:"
			parameterDefinitions.forEach((param) => {
				const requiredText = param.required ? " (required)" : " (optional)"
				finalDescription += `\n- ${param.name} (${param.type})${requiredText}: ${param.description || "No description"}`
			})
		}

		// Log the complete tool schema that the AI agent will see
		logger.log("🔧 CallFunctionTool: Complete tool schema for AI agent:", {
			toolName: this.getNode().name.replace(/ /g, "_"),
			functionName,
			workflowId,
			schemaMode: parameterSchema,
			parameterDefinitions,
			finalDescription,
			parameterCount: parameterDefinitions.length,
			requiredParameters: parameterDefinitions.filter((p) => p.required).map((p) => p.name),
			optionalParameters: parameterDefinitions.filter((p) => !p.required).map((p) => p.name),
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

			let parameters: Record<string, any> = {}

			// Parse input - it could be a JSON string or an object
			if (typeof input === "string") {
				try {
					parameters = JSON.parse(input)
				} catch (error) {
					// If it's not JSON, treat it as a single parameter
					if (parameterDefinitions.length === 1) {
						parameters[parameterDefinitions[0].name] = input
					} else {
						throw new NodeOperationError(baseContext.getNode(), `Invalid input format. Expected JSON object with parameters: ${parameterDefinitions.map((p) => p.name).join(", ")}`)
					}
				}
			} else if (typeof input === "object" && input !== null) {
				parameters = input
			} else {
				throw new NodeOperationError(baseContext.getNode(), "Invalid input type. Expected string or object.")
			}

			logger.log("🔧 CallFunctionTool: Parsed parameters:", parameters)

			// Validate required parameters
			for (const paramDef of parameterDefinitions) {
				if (paramDef.required && !(paramDef.name in parameters)) {
					throw new NodeOperationError(baseContext.getNode(), `Missing required parameter: ${paramDef.name}`)
				}
			}

			try {
				// Call the function using FunctionCallService
				const result = await FunctionCallService.callFunction({
					functionName,
					workflowId,
					parameters,
					inputData: { json: parameters }, // Provide the parameters as input data
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
							parameters,
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
							parameters,
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
			name: this.getNode().name.replace(/ /g, "_"),
			description: finalDescription,
			func: toolFunction,
		})

		logger.log("🔧 CallFunctionTool: Tool created successfully")

		// Apply the log wrapper to make the tool visible in AI Agent logs
		const wrappedTool = toolLogWrapper(tool, this)

		return {
			response: wrappedTool,
		}
	}
}
