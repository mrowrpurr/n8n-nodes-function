import { type INodeExecutionData, NodeConnectionType, type IExecuteFunctions, type INodeType, type INodeTypeDescription } from "n8n-workflow"
import { getFunctionRegistry } from "../FunctionRegistryFactory"

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
		console.log("🔴 ReturnFromFunction: ===== STARTING EXECUTION =====")
		console.log("🔴 ReturnFromFunction: Node execution started at:", new Date().toISOString())

		const items = this.getInputData()
		console.log("🔴 ReturnFromFunction: Input items count:", items.length)
		console.log("🔴 ReturnFromFunction: Input items:", items)

		const returnData: INodeExecutionData[] = []

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			console.log(`🔴 ReturnFromFunction: Processing item ${itemIndex + 1}/${items.length}`)

			const returnCode = this.getNodeParameter("returnCode", itemIndex) as string
			const item = items[itemIndex]

			console.log("🔴 ReturnFromFunction: Return code =", returnCode)
			console.log("🔴 ReturnFromFunction: Processing item =", item)

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
				console.error("🔴 ReturnFromFunction: Code execution error:", error)

				// Get execution ID for error handling
				const registry = getFunctionRegistry()
				const functionExecutionId = registry.getCurrentFunctionExecution()
				const effectiveExecutionId = String(functionExecutionId || this.getExecutionId() || "__active__")

				console.log("🔴 ReturnFromFunction: Rejecting return promise due to code execution error")

				// Reject the promise with the error
				try {
					registry.rejectReturn(effectiveExecutionId, error)
					console.log("🔴 ReturnFromFunction: ❌ Return promise rejected with error")
				} catch (rejectError) {
					console.error("🔴 ReturnFromFunction: ❌ Error rejecting return promise:", rejectError)
				}

				// Also create an error value for compatibility
				parsedReturnValue = {
					_error: "Return code execution failed",
					_errorMessage: error.message,
					_errorCode: returnCode,
				}

				// Continue with normal flow to clean up the stack
			}

			// Clean up the return value by removing internal fields
			if (parsedReturnValue && typeof parsedReturnValue === "object") {
				const cleanedReturnValue = { ...parsedReturnValue }
				delete cleanedReturnValue._functionCallId
				delete cleanedReturnValue._functionExecutionId
				parsedReturnValue = cleanedReturnValue
			}

			console.log("🔴 ReturnFromFunction: Final return value (cleaned) =", parsedReturnValue)

			// Get execution ID from the registry (set by the Function node)
			const registry = getFunctionRegistry()
			console.log("🔴 ReturnFromFunction: Getting current function execution from registry...")

			let functionExecutionId = registry.getCurrentFunctionExecution()
			console.log("🔴 ReturnFromFunction: Function execution ID from registry:", functionExecutionId)
			console.log("🔴 ReturnFromFunction: Raw execution ID from this context:", this.getExecutionId())

			// Check if we have function call context info in the item
			const functionCallId = item.json._functionCallId
			const functionExecutionIdFromItem = item.json._functionExecutionId
			console.log("🔴 ReturnFromFunction: Function call ID from item:", functionCallId)
			console.log("🔴 ReturnFromFunction: Function execution ID from item:", functionExecutionIdFromItem)

			// If we have function context from the item, use that (for cross-worker coordination)
			if (functionExecutionIdFromItem && !functionExecutionId) {
				functionExecutionId = String(functionExecutionIdFromItem)
				console.log("🔴 ReturnFromFunction: Using function execution ID from item for cross-worker coordination:", functionExecutionId)
			}

			if (!functionExecutionId) {
				console.warn("🔴 ReturnFromFunction: ⚠️  NO CURRENT FUNCTION EXECUTION FOUND!")
				console.warn("🔴 ReturnFromFunction: ⚠️  This suggests the ReturnFromFunction is not properly connected to a Function node")
				console.warn("🔴 ReturnFromFunction: ⚠️  Or the Function node didn't push its execution ID to the stack")
			}

			const effectiveExecutionId = String(functionExecutionId || this.getExecutionId() || "__active__")
			console.log("🔴 ReturnFromFunction: Effective execution ID for storing return value:", effectiveExecutionId)
			console.log("🔴 ReturnFromFunction: About to resolve return promise with value:", parsedReturnValue)

			// Resolve the return promise (this will also store the value for compatibility)
			console.log("🔴 ReturnFromFunction: Resolving return promise...")

			try {
				await registry.resolveReturn(effectiveExecutionId, parsedReturnValue)
				console.log("🔴 ReturnFromFunction: ✅ Return promise resolved successfully!")

				// Verify the value was actually stored
				const verifyValue = await registry.getFunctionReturnValue(effectiveExecutionId)
				console.log("🔴 ReturnFromFunction: Verification - stored value retrieval:", verifyValue)
			} catch (error) {
				console.error("🔴 ReturnFromFunction: ❌ Error resolving return promise:", error)
				// Fall back to direct storage if promise resolution fails
				await registry.setFunctionReturnValue(effectiveExecutionId, parsedReturnValue)
				console.log("🔴 ReturnFromFunction: 🟡 Fell back to direct value storage")
			}

			// Pop the current function execution from the stack now that we've stored the return value
			if (functionExecutionId) {
				console.log("🔴 ReturnFromFunction: Popping function execution from stack...")
				const poppedId = registry.popCurrentFunctionExecution()
				console.log("🔴 ReturnFromFunction: ✅ Popped function execution from stack:", poppedId)
			} else {
				console.log("🔴 ReturnFromFunction: ⚠️  No function execution ID to pop from stack")
			}

			// Clean up the result item by removing internal fields
			const cleanedJson = { ...item.json }
			delete cleanedJson._functionCallId
			delete cleanedJson._functionExecutionId

			const resultItem: INodeExecutionData = {
				json: cleanedJson,
				index: itemIndex,
				binary: item.binary,
			}

			returnData.push(resultItem)
		}

		console.log("🔴 ReturnFromFunction: ===== EXECUTION COMPLETE =====")
		console.log("🔴 ReturnFromFunction: Final return data:", returnData)
		console.log("🔴 ReturnFromFunction: Node execution completed at:", new Date().toISOString())
		return [returnData]
	}
}
