import { INodeExecutionData } from "n8n-workflow"

interface ParameterDefinition {
	name: string
	type: string
	required: boolean
	defaultValue: string
	description: string
}

interface FunctionListener {
	functionName: string
	executionId: string
	nodeId: string
	parameters: ParameterDefinition[]
	callback: (parameters: Record<string, any>, inputItem: INodeExecutionData) => Promise<INodeExecutionData[]>
}

class FunctionRegistry {
	private static instance: FunctionRegistry
	private listeners: Map<string, FunctionListener> = new Map()

	static getInstance(): FunctionRegistry {
		if (!FunctionRegistry.instance) {
			FunctionRegistry.instance = new FunctionRegistry()
		}
		return FunctionRegistry.instance
	}

	registerFunction(
		functionName: string,
		executionId: string,
		nodeId: string,
		parameters: ParameterDefinition[],
		callback: (parameters: Record<string, any>, inputItem: INodeExecutionData) => Promise<INodeExecutionData[]>
	): void {
		const key = `${functionName}-${executionId}`
		console.log("🎯 FunctionRegistry: Registering function:", key)
		console.log("🎯 FunctionRegistry: Parameters:", parameters)

		this.listeners.set(key, {
			functionName,
			executionId,
			nodeId,
			parameters,
			callback,
		})
	}

	unregisterFunction(functionName: string, executionId: string): void {
		const key = `${functionName}-${executionId}`
		console.log("🎯 FunctionRegistry: Unregistering function:", key)
		this.listeners.delete(key)
	}

	async callFunction(functionName: string, executionId: string, parameters: Record<string, any>, inputItem: INodeExecutionData): Promise<INodeExecutionData[] | null> {
		const key = `${functionName}-${executionId}`
		console.log("🔧 FunctionRegistry: Looking for function:", key)
		console.log("🔧 FunctionRegistry: Available functions:", Array.from(this.listeners.keys()))

		const listener = this.listeners.get(key)
		if (!listener) {
			console.log("🔧 FunctionRegistry: Function not found:", key)
			return null
		}

		console.log("🔧 FunctionRegistry: Calling function:", key, "with parameters:", parameters)
		try {
			const result = await listener.callback(parameters, inputItem)
			console.log("🔧 FunctionRegistry: Function result:", result)
			return result
		} catch (error) {
			console.error("🔧 FunctionRegistry: Error calling function:", error)
			throw error
		}
	}

	listFunctions(): void {
		console.log("🎯 FunctionRegistry: Registered functions:")
		for (const [key, listener] of this.listeners.entries()) {
			console.log(`  - ${key}: ${listener.functionName} (node: ${listener.nodeId})`)
		}
	}

	getAvailableFunctions(): Array<{ name: string; value: string }> {
		const functionNames = new Set<string>()

		// Extract unique function names from registered listeners
		for (const listener of this.listeners.values()) {
			functionNames.add(listener.functionName)
		}

		// Convert to array of options for n8n dropdown
		return Array.from(functionNames).map((name) => ({
			name,
			value: name,
		}))
	}

	getFunctionParameters(functionName: string): ParameterDefinition[] {
		// Look for the function with __active__ execution ID first
		const activeKey = `${functionName}-__active__`
		const activeListener = this.listeners.get(activeKey)
		if (activeListener) {
			return activeListener.parameters
		}

		// If not found, look for any instance of this function
		for (const listener of this.listeners.values()) {
			if (listener.functionName === functionName) {
				return listener.parameters
			}
		}

		return []
	}
}

export { FunctionRegistry, type ParameterDefinition }
