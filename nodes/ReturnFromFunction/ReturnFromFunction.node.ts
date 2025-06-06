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
				displayName: "Return Value",
				name: "returnValue",
				type: "json",
				default: "{}",
				description: "The value to return from the function. Can be a JSON object or expression.",
				placeholder: '{"result": "success", "data": {...}}',
			},
		],
	}

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		console.log("🎯 ReturnFromFunction: Starting execution")
		const items = this.getInputData()
		const returnData: INodeExecutionData[] = []

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			const returnValue = this.getNodeParameter("returnValue", itemIndex) as string
			const item = items[itemIndex]

			console.log("🎯 ReturnFromFunction: Raw return value =", returnValue)

			// Parse the return value
			let parsedReturnValue: any
			try {
				parsedReturnValue = JSON.parse(returnValue)
			} catch (error) {
				// If it's not valid JSON, treat it as a string
				parsedReturnValue = returnValue
			}

			console.log("🎯 ReturnFromFunction: Parsed return value =", parsedReturnValue)

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
