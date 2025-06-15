import { type INodeExecutionData, NodeConnectionType, type IExecuteFunctions, type INodeType, type INodeTypeDescription, NodeOperationError } from "n8n-workflow"
import { getFunctionRegistry, isQueueModeEnabled } from "../FunctionRegistryFactory"

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
		console.log("🌊 ReturnFromFunction: ===== STARTING EXECUTION =====")
		console.log("🌊 ReturnFromFunction: Node execution started at:", new Date().toISOString())

		const items = this.getInputData()
		console.log("🌊 ReturnFromFunction: Input items count:", items.length)
		console.log("🌊 ReturnFromFunction: Input items:", items)

		const returnData: INodeExecutionData[] = []
		const registry = getFunctionRegistry()

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			console.log(`🌊 ReturnFromFunction: Processing item ${itemIndex + 1}/${items.length}`)

			const returnCode = this.getNodeParameter("returnCode", itemIndex) as string
			const item = items[itemIndex]

			console.log("🌊 ReturnFromFunction: Return code =", returnCode)
			console.log("🌊 ReturnFromFunction: Processing item =", item)

			// Get call context from the item's _functionCall field
			const functionCallData = item.json._functionCall as
				| {
						callId: string
						functionName: string
						timestamp: number
						responseChannel: string
						messageId: string
						streamKey: string
						groupName: string
				  }
				| undefined

			if (!functionCallData) {
				throw new NodeOperationError(this.getNode(), "ReturnFromFunction must be used within a Function that was called via CallFunction")
			}

			console.log("🌊 ReturnFromFunction: Function call data:", functionCallData)

			// Extract call context
			const callContext = {
				callId: functionCallData.callId,
				responseChannel: functionCallData.responseChannel,
				messageId: functionCallData.messageId,
				streamKey: functionCallData.streamKey,
				groupName: functionCallData.groupName,
				functionName: functionCallData.functionName,
			}

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
						log: (...args: any[]) => console.log("🌊 ReturnFromFunction Code:", ...args),
						error: (...args: any[]) => console.error("🌊 ReturnFromFunction Code:", ...args),
						warn: (...args: any[]) => console.warn("🌊 ReturnFromFunction Code:", ...args),
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
				console.log("🌊 ReturnFromFunction: Code execution result =", parsedReturnValue)
			} catch (error) {
				console.error("🌊 ReturnFromFunction: Code execution error:", error)

				// Send error response
				await registry.publishResponse(callContext.responseChannel, {
					success: false,
					error: error.message,
					callId: callContext.callId,
					timestamp: Date.now(),
				})

				// Acknowledge the message even on error
				await registry.acknowledgeCall(callContext.streamKey, callContext.groupName, callContext.messageId)

				// Call context is embedded in the item, no need to clear static data

				throw new NodeOperationError(this.getNode(), `Return code execution failed: ${error.message}`)
			}

			// Clean up the return value by removing internal fields
			if (parsedReturnValue && typeof parsedReturnValue === "object") {
				const cleanedReturnValue = { ...parsedReturnValue }
				delete cleanedReturnValue._functionCall
				parsedReturnValue = cleanedReturnValue
			}

			console.log("🌊 ReturnFromFunction: Final return value (cleaned) =", parsedReturnValue)

			// Check if queue mode is enabled to determine how to return the value
			if (isQueueModeEnabled()) {
				console.log("🌊 ReturnFromFunction: Queue mode enabled, using Redis streams")
				try {
					// Publish successful response
					await registry.publishResponse(callContext.responseChannel, {
						success: true,
						data: parsedReturnValue,
						callId: callContext.callId,
						timestamp: Date.now(),
					})

					console.log("🌊 ReturnFromFunction: ✅ Response published successfully!")

					// Acknowledge the stream message
					await registry.acknowledgeCall(callContext.streamKey, callContext.groupName, callContext.messageId)

					console.log("🌊 ReturnFromFunction: ✅ Stream message acknowledged!")

					// Pop the current function execution from the stack
					registry.popCurrentFunctionExecution()
				} catch (error) {
					console.error("🌊 ReturnFromFunction: ❌ Error publishing response:", error)
					throw new NodeOperationError(this.getNode(), `Failed to publish response: ${error.message}`)
				}
			} else {
				console.log("🌊 ReturnFromFunction: Queue mode disabled, using direct return value resolution")
				try {
					// Resolve the return value directly for in-memory mode
					await registry.resolveReturn(callContext.callId, parsedReturnValue)
					console.log("🌊 ReturnFromFunction: ✅ Return value resolved directly!")

					// Pop the current function execution from the stack
					registry.popCurrentFunctionExecution()
				} catch (error) {
					console.error("🌊 ReturnFromFunction: ❌ Error resolving return value:", error)
					throw new NodeOperationError(this.getNode(), `Failed to resolve return value: ${error.message}`)
				}
			}

			console.log("🌊 ReturnFromFunction: ✅ Return value handled successfully")

			// Clean up the result item by removing internal fields
			const cleanedJson = { ...item.json }
			delete cleanedJson._functionCall

			const resultItem: INodeExecutionData = {
				json: cleanedJson,
				index: itemIndex,
				binary: item.binary,
			}

			returnData.push(resultItem)
		}

		console.log("🌊 ReturnFromFunction: ===== EXECUTION COMPLETE =====")
		console.log("🌊 ReturnFromFunction: Final return data:", returnData)
		console.log("🌊 ReturnFromFunction: Node execution completed at:", new Date().toISOString())
		return [returnData]
	}
}
