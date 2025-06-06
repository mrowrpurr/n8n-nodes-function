import {
	type INodeExecutionData,
	NodeConnectionType,
	type INodeType,
	type INodeTypeDescription,
	NodeOperationError,
	type ITriggerFunctions,
	type ITriggerResponse,
} from "n8n-workflow"
import { FunctionRegistry, type ParameterDefinition } from "../FunctionRegistry"

export class Function implements INodeType {
	description: INodeTypeDescription = {
		displayName: "Function",
		name: "function",
		icon: "fa:code",
		group: ["trigger"],
		version: 1,
		description: "Define a callable function within the current workflow",
		eventTriggerDescription: "Called by a Call Function node",
		subtitle: '={{$parameter["functionName"] ? $parameter["functionName"] : ""}}',
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
			{
				displayName: "Enable Code Execution",
				name: "enableCode",
				type: "boolean",
				default: false,
				description: "Whether to enable optional JavaScript or Python code execution with parameters available as global variables",
			},
			{
				displayName: "Language",
				name: "language",
				type: "options",
				options: [
					{
						name: "JavaScript",
						value: "javaScript",
					},
					{
						name: "Python (Beta)",
						value: "python",
					},
				],
				default: "javaScript",
				displayOptions: {
					show: {
						enableCode: [true],
					},
				},
			},
			{
				displayName: "Code",
				name: "jsCode",
				type: "string",
				typeOptions: {
					editor: "jsEditor",
					rows: 15,
				},
				default:
					"// Parameters are available as global variables\n// Example: if you have a 'name' parameter, use it directly\n// console.log('Hello', name);\n\n// Return data by modifying the item\nreturn { ...item, processed: true };",
				description: "JavaScript code to execute. Parameters are available as global variables. Return an object to modify the output.",
				displayOptions: {
					show: {
						enableCode: [true],
						language: ["javaScript"],
					},
				},
			},
			{
				displayName: "Code",
				name: "pythonCode",
				type: "string",
				typeOptions: {
					editor: "jsEditor",
					rows: 15,
				},
				default:
					"# Parameters are available as global variables\n# Example: if you have a 'name' parameter, use it directly\n# print('Hello', name)\n\n# Return data by modifying the item\nreturn {**item, 'processed': True}",
				description: "Python code to execute. Parameters are available as global variables. Return a dict to modify the output.",
				displayOptions: {
					show: {
						enableCode: [true],
						language: ["python"],
					},
				},
			},
		],
	}

	async trigger(this: ITriggerFunctions): Promise<ITriggerResponse> {
		console.log("🎯 Function: Starting trigger setup")

		// Get function configuration
		const functionName = this.getNodeParameter("functionName") as string
		const parameters = this.getNodeParameter("parameters", {}) as any
		const parameterList = parameters.parameter || []
		const enableCode = this.getNodeParameter("enableCode") as boolean
		const language = enableCode ? (this.getNodeParameter("language") as string) : "javaScript"
		const code = enableCode ? (this.getNodeParameter(language === "python" ? "pythonCode" : "jsCode") as string) : ""

		// Get execution and node IDs for context tracking
		const executionId = this.getExecutionId()
		const nodeId = this.getNode().id

		// Use fallback execution ID when workflow is active (executionId is undefined)
		const effectiveExecutionId = executionId ?? "__active__"

		console.log("🎯 Function: Registering function:", functionName, "with execution:", effectiveExecutionId)
		console.log("🎯 Function: Raw execution ID:", executionId)
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

			// Create the initial output item with locals set
			let outputItem: INodeExecutionData = {
				json: {
					...inputItem.json,
					locals,
				},
				index: 0,
				binary: inputItem.binary,
			}

			// Execute user code if enabled
			if (enableCode && code.trim()) {
				console.log("🎯 Function: Executing user code:", language)

				try {
					if (language === "javaScript") {
						// Execute JavaScript code with parameters as global variables
						const context = {
							...locals,
							item: outputItem.json,
							console: {
								log: (...args: any[]) => console.log("🎯 Function Code:", ...args),
								error: (...args: any[]) => console.error("🎯 Function Code:", ...args),
								warn: (...args: any[]) => console.warn("🎯 Function Code:", ...args),
							},
						}

						// Create execution context with parameters as variables
						const paramNames = Object.keys(context)
						const paramValues = Object.values(context)

						// Build function code with parameter declarations
						const functionCode = `
							// Declare parameters as local variables
							${paramNames.map((name, index) => `var ${name} = arguments[${index}];`).join("\n")}
							
							// Execute user code and return result
							try {
								${code}
							} catch (e) {
								throw e;
							}
						`

						// Create function using eval (simpler approach)
						const userFunction = eval(`(function(${paramNames.join(", ")}) { ${functionCode} })`)
						const result = userFunction.apply(null, paramValues)

						console.log("🎯 Function: Code execution result =", result)

						// If code returns a value, use it as the new output
						if (result !== undefined) {
							if (typeof result === "object" && result !== null) {
								outputItem.json = {
									...outputItem.json,
									...result,
								}
							} else {
								outputItem.json = {
									...outputItem.json,
									result,
								}
							}
						}
					} else if (language === "python") {
						// For now, just log that Python is not yet implemented
						console.warn("🎯 Function: Python execution not yet implemented")
						outputItem.json = {
							...outputItem.json,
							_codeError: "Python execution not yet implemented",
						}
					}
				} catch (error) {
					console.error("🎯 Function: Code execution error:", error)
					outputItem.json = {
						...outputItem.json,
						_codeError: error.message,
					}
				}
			}

			console.log("🎯 Function: Final output item =", outputItem)

			// Emit the data to trigger downstream nodes
			this.emit([this.helpers.returnJsonArray([outputItem])])

			// Return the result for the CallFunction node
			return [outputItem]
		}

		// Convert parameter list to ParameterDefinition format
		const parameterDefinitions: ParameterDefinition[] = parameterList.map((param: any) => ({
			name: param.name,
			type: param.type,
			required: param.required,
			defaultValue: param.defaultValue,
			description: param.description,
		}))

		// Register the function with the registry
		registry.registerFunction(functionName, effectiveExecutionId, nodeId, parameterDefinitions, functionCallback)

		// Define cleanup function
		const closeFunction = async () => {
			console.log("🎯 Function: Cleaning up function:", functionName)
			registry.unregisterFunction(functionName, effectiveExecutionId)
		}

		return {
			closeFunction,
		}
	}
}
