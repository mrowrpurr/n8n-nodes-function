import { type INodeExecutionData, NodeConnectionType, type IExecuteFunctions, type INodeType, type INodeTypeDescription } from "n8n-workflow"
import { FunctionRegistry } from "../FunctionRegistry"

export class ReturnFromFunction implements INodeType {
	description: INodeTypeDescription = {
		displayName: "Return from Function",
		name: "returnFromFunction",
		icon: "fa:sign-out-alt",
		group: ["transform"],
		version: 1,
		description: "Return a value from a Function node",
		defaults: {
			name: "Return from Function",
			color: "#28a745",
		},
		inputs: [NodeConnectionType.Main],
		outputs: [NodeConnectionType.Main],
		properties: [
			{
				displayName: "Return Code",
				name: "returnCode",
				type: "string",
				typeOptions: {
					editor: "jsEditor",
					rows: 15,
				},
				default: "// Return any value from this function\nreturn $json;",
				description: "JavaScript code to determine the return value. Use 'return' statement to specify what to return.",
				placeholder: "return { message: 'Hello', timestamp: Date.now() };",
			},
		],
	}

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		console.log("🎯 ReturnFromFunction: Starting execution")
		const items = this.getInputData()
		const returnData: INodeExecutionData[] = []

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			const returnCode = this.getNodeParameter("returnCode", itemIndex) as string
			const item = items[itemIndex]

			console.log("🎯 ReturnFromFunction: Return code =", returnCode)

			// Execute the JavaScript code to get the return value
			let parsedReturnValue: any
			try {
				// Create execution context with available variables
				const context = {
					$json: item.json,
					$binary: item.binary,
					$index: itemIndex,
					$item: item,
					console: {
						log: (...args: any[]) => console.log("🎯 ReturnFromFunction Code:", ...args),
						error: (...args: any[]) => console.error("🎯 ReturnFromFunction Code:", ...args),
						warn: (...args: any[]) => console.warn("🎯 ReturnFromFunction Code:", ...args),
					},
					Date,
					Math,
					JSON,
				}

				// Wrap the code in a function to capture the return value
				const wrappedCode = `
					(function() {
						// Set up context variables
						${Object.keys(context)
							.map((key) => `var ${key} = arguments[0]["${key}"];`)
							.join("\n\t\t\t\t\t\t")}
						
						// Execute user code
						${returnCode}
					})
				`

				parsedReturnValue = eval(wrappedCode)(context)
				console.log("🎯 ReturnFromFunction: Code execution result =", parsedReturnValue)
			} catch (error) {
				console.error("🎯 ReturnFromFunction: Code execution error:", error)
				parsedReturnValue = {
					_error: "Return code execution failed",
					_errorMessage: error.message,
					_errorCode: returnCode,
				}
			}

			console.log("🎯 ReturnFromFunction: Final return value =", parsedReturnValue)

			// Get execution ID from the registry (set by the Function node)
			const registry = FunctionRegistry.getInstance()
			const functionExecutionId = registry.getCurrentFunctionExecution()
			console.log("🎯 ReturnFromFunction: Function execution ID from registry:", functionExecutionId)

			if (!functionExecutionId) {
				console.warn("🎯 ReturnFromFunction: No current function execution found - this ReturnFromFunction may not be connected to a Function node")
			}

			const effectiveExecutionId = String(functionExecutionId || this.getExecutionId() || "__active__")
			console.log("🎯 ReturnFromFunction: Setting function return value for execution:", effectiveExecutionId)

			// Store the return value in the registry so the Function node can pick it up
			registry.setFunctionReturnValue(effectiveExecutionId, parsedReturnValue)

			// Pass through the item unchanged (no more internal fields to clean)
			const resultItem: INodeExecutionData = {
				json: item.json,
				index: itemIndex,
				binary: item.binary,
			}

			returnData.push(resultItem)
		}

		console.log("🎯 ReturnFromFunction: Execution complete")
		return [returnData]
	}
}
