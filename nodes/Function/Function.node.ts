import { type INodeExecutionData, NodeConnectionType, type IExecuteFunctions, type INodeType, type INodeTypeDescription, NodeOperationError } from "n8n-workflow"

export class Function implements INodeType {
	description: INodeTypeDescription = {
		displayName: "Function",
		name: "function",
		icon: "fa:code",
		group: ["trigger"],
		version: 1,
		description: "Define a callable function within the current workflow",
		eventTriggerDescription: "Called by a Call Function node",
		defaults: {
			name: "Function",
			color: "#4a90e2",
		},
		inputs: [],
		outputs: [NodeConnectionType.Main],
		properties: [
			{
				displayName: "Function Name",
				name: "functionName",
				type: "string",
				default: "myFunction",
				required: true,
				description: "Unique name for this function within the workflow",
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
		],
	}

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		console.log("🎯 Function: Starting execution")

		// This function is called when the function is invoked by a Call Function node
		// The input data will contain the parameters passed from the Call Function node
		const inputData = this.getInputData()
		console.log("🎯 Function: Input data =", inputData)

		// Get the function parameters configuration
		const parameters = this.getNodeParameter("parameters", 0, {}) as any
		const parameterList = parameters.parameter || []
		console.log("🎯 Function: Parameter list =", parameterList)

		// Process the input data and set up locals
		const returnData: INodeExecutionData[] = []

		for (let itemIndex = 0; itemIndex < inputData.length; itemIndex++) {
			console.log("🎯 Function: Processing item", itemIndex)
			const item = inputData[itemIndex]
			const locals: Record<string, any> = {}

			// Extract parameters from the input item
			if (item.json && typeof item.json === "object") {
				console.log("🎯 Function: Item JSON =", item.json)
				for (const param of parameterList) {
					const paramName = param.name
					const paramType = param.type
					const required = param.required
					const defaultValue = param.defaultValue

					let value = (item.json as any)[paramName]
					console.log("🎯 Function: Processing parameter", paramName, "=", value)

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
			}

			console.log("🎯 Function: Final locals =", locals)

			// Create the output item with locals set
			const outputItem = {
				json: {
					...item.json,
					locals,
				},
				index: itemIndex,
				binary: item.binary,
			}

			console.log("🎯 Function: Output item =", outputItem)
			returnData.push(outputItem)
		}

		console.log("🎯 Function: Returning data =", returnData)
		return [returnData]
	}
}
