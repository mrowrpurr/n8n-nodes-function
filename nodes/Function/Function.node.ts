import { type INodeExecutionData, NodeConnectionType, type INodeType, type INodeTypeDescription, NodeOperationError, type IExecuteFunctions } from "n8n-workflow"
import { FunctionRegistry } from "../FunctionRegistry"

export class Function implements INodeType {
	description: INodeTypeDescription = {
		displayName: "Function",
		name: "function",
		icon: "fa:code",
		group: ["transform"],
		version: 1,
		description: "Define a callable function within the current workflow",
		defaults: {
			name: "Function",
			color: "#4a90e2",
		},
		inputs: [NodeConnectionType.Main],
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

		// Get input items
		const items = this.getInputData()
		console.log("🎯 Function: Input items count =", items.length)

		// Get function configuration (using first item for configuration)
		const functionName = this.getNodeParameter("functionName", 0) as string
		const parameters = this.getNodeParameter("parameters", 0, {}) as any
		const parameterList = parameters.parameter || []

		// Get execution and node IDs for context tracking
		const executionId = this.getExecutionId()
		const nodeId = this.getNode().id

		console.log("🎯 Function: Registering function:", functionName)
		console.log("🎯 Function: Execution:", executionId)
		console.log("🎯 Function: Parameter list:", parameterList)

		const registry = FunctionRegistry.getInstance()

		// Create the function callback that will be invoked by CallFunction
		const functionCallback = async (functionParameters: Record<string, any>, inputItem: INodeExecutionData): Promise<INodeExecutionData[]> => {
			console.log("🎯 Function: Callback invoked with parameters:", functionParameters)
			console.log("🎯 Function: Input item:", inputItem)

			// Process parameters according to function definition
			const locals: Record<string, any> = {}

			for (const param of parameterList) {
				const paramName = param.name
				const paramType = param.type
				const required = param.required
				const defaultValue = param.defaultValue

				let value = functionParameters[paramName]
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

			console.log("🎯 Function: Final locals =", locals)

			// Create the output item with locals set
			const outputItem: INodeExecutionData = {
				json: {
					...inputItem.json,
					locals,
				},
				index: 0,
				binary: inputItem.binary,
			}

			console.log("🎯 Function: Function executed, returning output item =", outputItem)

			// Return the result for the CallFunction node
			return [outputItem]
		}

		// Register the function with the registry
		registry.registerFunction(functionName, executionId, nodeId, functionCallback)
		console.log("🎯 Function: Function registered successfully")

		// Return the input items to pass through to next nodes
		return [items]
	}
}
