import { type INodeExecutionData, NodeConnectionType, type IExecuteFunctions, type INodeType, type INodeTypeDescription, NodeOperationError } from "n8n-workflow"
import { FunctionRegistry } from "../FunctionRegistry"

export class CallFunction implements INodeType {
	description: INodeTypeDescription = {
		displayName: "Call Function",
		name: "callFunction",
		icon: "fa:play",
		group: ["transform"],
		version: 1,
		description: "Call a Function node defined in the current workflow",
		defaults: {
			name: "Call Function",
			color: "#ff6d5a",
		},
		inputs: [NodeConnectionType.Main],
		outputs: [NodeConnectionType.Main],
		properties: [
			{
				displayName: "Function Name",
				name: "functionName",
				type: "string",
				default: "",
				required: true,
				description: "Name of the function to call (must match a Function node in this workflow)",
				placeholder: "myFunction",
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
								displayName: "Name",
								name: "name",
								type: "string",
								default: "",
								placeholder: "parameterName",
								description: "Name of the parameter",
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
			console.log("🔧 CallFunction: Execution ID =", executionId)

			// Use the FunctionRegistry to call the function
			const registry = FunctionRegistry.getInstance()
			const item = items[itemIndex]

			try {
				// Call the function through the registry
				const functionResult = await registry.callFunction(functionName, executionId, functionParameters, item)

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
