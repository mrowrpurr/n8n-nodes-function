import {
	type INodeExecutionData,
	NodeConnectionType,
	type IExecuteFunctions,
	type INodeType,
	type INodeTypeDescription,
	type ILoadOptionsFunctions,
	NodeOperationError,
} from "n8n-workflow"
import { FunctionRegistry } from "../FunctionRegistry"

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
				displayName: "Function Name or ID",
				name: "functionName",
				type: "options",
				typeOptions: {
					loadOptionsMethod: "getAvailableFunctions",
				},
				default: "",
				required: true,
				description:
					'Name of the function to call (must match a Function node in this workflow). Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
				placeholder: "Select a function...",
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
		],
	}

	methods = {
		loadOptions: {
			async getAvailableFunctions(this: ILoadOptionsFunctions) {
				console.log("🔧 CallFunction: Loading available functions for dropdown")
				const registry = FunctionRegistry.getInstance()
				const availableFunctions = registry.getAvailableFunctions()
				console.log("🔧 CallFunction: Available functions:", availableFunctions)
				return availableFunctions
			},
			async getFunctionParameters(this: ILoadOptionsFunctions) {
				const functionName = this.getCurrentNodeParameter("functionName") as string
				console.log("🔧 CallFunction: Loading parameters for function:", functionName)

				if (!functionName) {
					return []
				}

				const registry = FunctionRegistry.getInstance()
				const parameters = registry.getFunctionParameters(functionName)
				console.log("🔧 CallFunction: Found parameters:", parameters)

				// Get currently selected parameters to filter them out
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

				// Filter out already-selected parameters
				const availableParameters = parameters.filter((param) => !selectedParameterNames.has(param.name))
				console.log("🔧 CallFunction: Available parameters after filtering:", availableParameters)

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
			const functionName = this.getNodeParameter("functionName", itemIndex) as string
			const parameterMode = this.getNodeParameter("parameterMode", itemIndex) as string

			console.log("🔧 CallFunction: Function name =", functionName)
			console.log("🔧 CallFunction: Parameter mode =", parameterMode)

			if (!functionName) {
				throw new NodeOperationError(this.getNode(), "Function name is required")
			}

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

				for (const param of parameterList) {
					const paramName = param.name
					const paramValue = param.value

					// Try to parse the value as JSON first, fall back to string
					let parsedValue: any
					try {
						parsedValue = JSON.parse(paramValue)
					} catch {
						parsedValue = paramValue
					}

					functionParameters[paramName] = parsedValue
				}
			}

			console.log("🔧 CallFunction: Final parameters =", functionParameters)

			console.log("🔧 CallFunction: Implementing actual function triggering")
			console.log("🔧 CallFunction: Calling function:", functionName, "with params:", functionParameters)

			// Get the execution ID to find the correct function instance
			const executionId = this.getExecutionId()
			// Use same fallback as Function node for active workflows
			const effectiveExecutionId = executionId ?? "__active__"
			console.log("🔧 CallFunction: Execution ID =", effectiveExecutionId)
			console.log("🔧 CallFunction: Raw execution ID =", executionId)

			// Use the FunctionRegistry to call the function
			const registry = FunctionRegistry.getInstance()
			const item = items[itemIndex]

			try {
				// Try to call the function with current execution ID first, then fallback to "__active__"
				let functionResult = await registry.callFunction(functionName, effectiveExecutionId, functionParameters, item)

				// If not found with current execution ID, try with "__active__" fallback
				if (functionResult === null && effectiveExecutionId !== "__active__") {
					console.log("🔧 CallFunction: Function not found with execution ID, trying __active__ fallback")
					functionResult = await registry.callFunction(functionName, "__active__", functionParameters, item)
				}

				if (functionResult === null) {
					throw new NodeOperationError(this.getNode(), `Function '${functionName}' not found or not registered in this execution`)
				}

				console.log("🔧 CallFunction: Function returned result =", functionResult)

				// Use the result from the function call
				// The function result should contain the processed data with locals
				const resultItem: INodeExecutionData = {
					json: {
						...item.json,
						// Include the function result data
						...functionResult[0]?.json,
						// Add metadata about the function call
						_functionCall: {
							functionName,
							parameters: functionParameters,
							success: true,
						},
					},
					index: itemIndex,
					binary: functionResult[0]?.binary || item.binary,
				}

				console.log("🔧 CallFunction: Created result item =", resultItem)
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
