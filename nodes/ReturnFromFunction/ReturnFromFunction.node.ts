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
				type: "string",
				typeOptions: {
					alwaysOpenEditWindow: true,
				},
				default: "{{ $json }}",
				description: "The value to return from the function. Supports expressions and literal values.",
				placeholder: 'Enter return value, e.g. "Hello, world", 42, or {{ $json }}',
			},
		],
	}

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		console.log("🎯 ReturnFromFunction: Starting execution")
		const items = this.getInputData()
		const returnData: INodeExecutionData[] = []

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			const returnValue = this.getNodeParameter("returnValue", itemIndex)
			const item = items[itemIndex]

			console.log("🎯 ReturnFromFunction: Return value (already evaluated) =", returnValue)

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
			registry.setFunctionReturnValue(effectiveExecutionId, returnValue)

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
