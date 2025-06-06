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

			// Get execution ID from the item (injected by Function node)
			const functionExecutionId = item.json.__functionExecutionId
			console.log("🎯 ReturnFromFunction: Function execution ID from item:", functionExecutionId)

			if (!functionExecutionId) {
				console.warn("🎯 ReturnFromFunction: No __functionExecutionId found in item - this ReturnFromFunction may not be connected to a Function node")
			}

			const effectiveExecutionId = String(functionExecutionId || this.getExecutionId() || "__active__")
			console.log("🎯 ReturnFromFunction: Setting function return value for execution:", effectiveExecutionId)

			// Store the return value in the registry so the Function node can pick it up
			const registry = FunctionRegistry.getInstance()
			registry.setFunctionReturnValue(effectiveExecutionId, parsedReturnValue)

			// Pass through the item but remove the internal __functionExecutionId
			const cleanedJson = { ...item.json }
			delete cleanedJson.__functionExecutionId

			const resultItem: INodeExecutionData = {
				json: cleanedJson,
				index: itemIndex,
				binary: item.binary,
			}

			returnData.push(resultItem)
		}

		console.log("🎯 ReturnFromFunction: Execution complete")
		return [returnData]
	}
}
