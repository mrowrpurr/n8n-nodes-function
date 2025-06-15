import {
	type INodeExecutionData,
	NodeConnectionType,
	type INodeType,
	type INodeTypeDescription,
	NodeOperationError,
	type ITriggerFunctions,
	type ITriggerResponse,
} from "n8n-workflow"
import { getFunctionRegistry } from "../FunctionRegistryFactory"
import { type ParameterDefinition } from "../FunctionRegistry"

export class Function implements INodeType {
	description: INodeTypeDescription = {
		displayName: "Function",
		name: "function",
		icon: "fa:code",
		group: ["trigger"],
		version: 1,
		description: "Define a callable function within the current workflow",
		eventTriggerDescription: "Called by a Call Function node",
		subtitle: "={{$node.name}}",
		defaults: {
			name: "Function",
			color: "#4a90e2",
		},
		inputs: [],
		outputs: [NodeConnectionType.Main],
		properties: [
			{
				displayName: "Global Function",
				name: "globalFunction",
				type: "boolean",
				default: false,
				description: "Whether this function will be registered globally and callable from any workflow",
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
				description: "Whether to enable optional JavaScript code execution with parameters available as global variables",
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
					"// Parameters are available as global variables\n// Example: if you have a 'name' parameter, use it directly\n// console.log('Hello', name);\n\n// Process your parameters, call APIs, do calculations, etc.\n// const result = someCalculation(param1, param2);\n// console.log('Processed:', result);\n\n// Optionally return an object to add fields to the flowing item:\n// return { calculatedValue: result, timestamp: Date.now() };\n\n// To return from the function, use a 'Return from Function' node",
				description:
					"JavaScript code to execute within the function. Parameters are available as global variables. Returned objects add fields to the item flowing through the function.",
				displayOptions: {
					show: {
						enableCode: [true],
					},
				},
			},
		],
	}

	async trigger(this: ITriggerFunctions): Promise<ITriggerResponse> {
		console.log("🎯 Function: Starting trigger setup")

		// Get function configuration
		const globalFunction = this.getNodeParameter("globalFunction") as boolean
		const functionName = this.getNode().name
		const parameters = this.getNodeParameter("parameters", {}) as any
		const parameterList = parameters.parameter || []
		const enableCode = this.getNodeParameter("enableCode") as boolean
		const code = enableCode ? (this.getNodeParameter("jsCode") as string) : ""

		// Get execution and node IDs for context tracking
		const executionId = this.getExecutionId()
		const nodeId = this.getNode().id

		// Determine effective execution ID based on global function setting
		let effectiveExecutionId: string
		if (globalFunction) {
			effectiveExecutionId = "__global__"
		} else {
			effectiveExecutionId = executionId ?? "__active__"
		}

		console.log("🎯 Function: Registering function:", functionName, "with execution:", effectiveExecutionId)
		console.log("🎯 Function: Global function:", globalFunction)
		console.log("🎯 Function: Raw execution ID:", executionId)
		console.log("🎯 Function: Parameter list:", parameterList)

		const registry = getFunctionRegistry()

		// Create the function callback that will be invoked by CallFunction
		const functionCallback = async (functionParameters: Record<string, any>, inputItem: INodeExecutionData): Promise<INodeExecutionData[]> => {
			console.log("🎯 Function: Callback invoked with parameters:", functionParameters)
			console.log("🎯 Function: Input item:", inputItem)

			// Get the unique call ID from the call context stack
			const currentCallContext = registry.getCurrentCallContext()
			const currentExecutionId = currentCallContext || effectiveExecutionId
			console.log("🎯 Function: Using execution ID:", currentExecutionId, "(call context:", currentCallContext, ")")

			// Push current function execution context for ReturnFromFunction nodes
			registry.pushCurrentFunctionExecution(currentExecutionId)

			// Clear any existing return value for this execution
			await registry.clearFunctionReturnValue(currentExecutionId)

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

			// Create the initial output item (clean, no parameter pollution)
			let outputItem: INodeExecutionData = {
				json: {
					...inputItem.json,
				},
				index: 0,
				binary: inputItem.binary,
			}

			// Execute user code if enabled
			if (enableCode && code.trim()) {
				console.log("🎯 Function: Executing JavaScript code")

				try {
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

					// Execute JavaScript code directly (n8n already provides sandboxing)
					const wrappedCode = `
						(function() {
							// Set up context variables
							${Object.keys(context)
								.map((key) => `var ${key} = arguments[0]["${key}"];`)
								.join("\n\t\t\t\t\t\t")}
							
							// Execute user code
							${code}
						})
					`

					const result = eval(wrappedCode)(context)

					console.log("🎯 Function: Code execution result =", result)

					// If code returns a value, merge it with locals
					if (result !== undefined) {
						if (typeof result === "object" && result !== null) {
							// Merge locals (parameters) first, then returned object (returned object wins conflicts)
							outputItem.json = {
								...outputItem.json,
								...locals,
								...result,
							}
						} else {
							// For non-object returns, include locals and the result
							outputItem.json = {
								...outputItem.json,
								...locals,
								result,
							}
						}
					} else {
						// If no return value, inject locals into output
						outputItem.json = {
							...outputItem.json,
							...locals,
						}
					}
				} catch (error) {
					console.error("🎯 Function: Code execution error:", error)
					outputItem.json = {
						...outputItem.json,
						_codeError: error.message,
					}
				}
			} else {
				// If code is disabled, inject locals into output
				outputItem.json = {
					...outputItem.json,
					...locals,
				}
			}

			console.log("🎯 Function: Final output item =", outputItem)

			// Emit the data to trigger downstream nodes (including potential ReturnFromFunction)
			console.log("🎯 Function: About to emit data to downstream nodes")
			console.log("🎯 Function: Current execution ID we're using:", currentExecutionId)
			console.log("🎯 Function: Output item being emitted:", outputItem)

			this.emit([this.helpers.returnJsonArray([outputItem])])
			console.log("🎯 Function: Data emitted successfully")

			// Use promise-based return handling instead of polling
			console.log("🎯 Function: Setting up promise-based return handling...")

			// Create a return promise for this execution
			const returnPromise = registry.createReturnPromise(currentExecutionId)
			console.log("🎯 Function: Return promise created")

			// Wait briefly to detect if this is a void function
			console.log("🎯 Function: Checking if this is a void function...")
			const voidDetectionTimeout = 50 // 50ms to detect void functions
			let returnValue = null

			try {
				// Race between the return promise and a timeout for void function detection
				returnValue = await Promise.race([
					returnPromise,
					new Promise<null>((resolve) => {
						setTimeout(() => {
							console.log("🎯 Function: 🟡 No return detected in", voidDetectionTimeout, "ms")
							console.log("🎯 Function: 🟡 This appears to be a VOID FUNCTION (no ReturnFromFunction node)")
							resolve(null)
						}, voidDetectionTimeout)
					}),
				])

				// If we got null from the timeout, this is a void function
				if (returnValue === null) {
					console.log("🎯 Function: 🟡 Completing immediately for void function")
					registry.cleanupReturnPromise(currentExecutionId)
				} else {
					console.log("🎯 Function: ✅ Return value received via promise:", returnValue)
				}
			} catch (error) {
				console.error("🎯 Function: ❌ Error occurred while waiting for return value:", error)
				registry.cleanupReturnPromise(currentExecutionId)
				// For errors, we'll still complete the function (could add error handling here)
				returnValue = null
			}

			console.log("🎯 Function: Function execution completed, final return value:", returnValue)

			// Note: Stack will be popped by ReturnFromFunction node when return value is stored

			// Function completed - this represents a void function (no explicit return)
			return []
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
		await registry.registerFunction(functionName, effectiveExecutionId, nodeId, parameterDefinitions, functionCallback)

		// Define cleanup function
		const closeFunction = async () => {
			console.log("🎯 Function: Cleaning up function:", functionName)
			await registry.unregisterFunction(functionName, effectiveExecutionId)
		}

		return {
			closeFunction,
		}
	}
}
