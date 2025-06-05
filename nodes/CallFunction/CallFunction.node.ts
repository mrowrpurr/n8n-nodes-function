import { type INodeExecutionData, NodeConnectionType, type IExecuteFunctions, type INodeType, type INodeTypeDescription, NodeOperationError } from "n8n-workflow"

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
		const items = this.getInputData()
		const returnData: INodeExecutionData[] = []

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			const functionName = this.getNodeParameter("functionName", itemIndex) as string
			const parameterMode = this.getNodeParameter("parameterMode", itemIndex) as string

			if (!functionName) {
				throw new NodeOperationError(this.getNode(), "Function name is required")
			}

			// Prepare parameters to pass to the function
			let functionParameters: Record<string, any> = {}

			if (parameterMode === "json") {
				const parametersJson = this.getNodeParameter("parametersJson", itemIndex) as string
				try {
					functionParameters = JSON.parse(parametersJson)
				} catch (error) {
					throw new NodeOperationError(this.getNode(), `Invalid JSON in parameters: ${error}`)
				}
			} else {
				// Individual parameters mode
				const parameters = this.getNodeParameter("parameters", itemIndex, {}) as any
				const parameterList = parameters.parameter || []

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

			// TODO: Implement the actual function calling mechanism
			// This is where we need to:
			// 1. Find the Function node with the matching name in the current workflow
			// 2. Trigger that Function node with our parameters
			// 3. Wait for the execution to complete
			// 4. Get the result back

			// For now, we'll create a placeholder result that shows what we're trying to do
			const item = items[itemIndex]

			// This is a simplified implementation - in reality, we need to:
			// - Trigger the Function node
			// - Set up $json.locals with our parameters
			// - Execute the downstream nodes from the Function
			// - Collect the results
			// - Clean up $json.locals

			const resultItem: INodeExecutionData = {
				json: {
					...item.json,
					// This would be replaced with actual function execution results
					_functionCall: {
						functionName,
						parameters: functionParameters,
						// TODO: Replace with actual function execution result
						result: "Function execution not yet implemented",
					},
				},
				index: itemIndex,
				binary: item.binary,
			}

			returnData.push(resultItem)
		}

		return [returnData]
	}
}
