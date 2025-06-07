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
	private returnValues: Map<string, any> = new Map()
	private currentFunctionExecutionStack: string[] = []
	private nextCallId: number = 1
	private callContextStack: string[] = [] // Stack of unique call IDs for function invocations

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

	async callFunction(
		functionName: string,
		executionId: string,
		parameters: Record<string, any>,
		inputItem: INodeExecutionData
	): Promise<{ result: INodeExecutionData[] | null; actualExecutionId: string }> {
		const key = `${functionName}-${executionId}`
		console.log("🔧 FunctionRegistry: Looking for function:", key)
		console.log("🔧 FunctionRegistry: Available functions:", Array.from(this.listeners.keys()))

		const listener = this.listeners.get(key)
		if (!listener) {
			console.log("🔧 FunctionRegistry: Function not found:", key)
			return { result: null, actualExecutionId: executionId }
		}

		// Generate a unique call ID for this specific function invocation
		const uniqueCallId = `${executionId}_call_${this.nextCallId++}`
		console.log("🔧 FunctionRegistry: Generated unique call ID:", uniqueCallId, "for function:", key)

		console.log("🔧 FunctionRegistry: Calling function:", key, "with parameters:", parameters)
		try {
			// Push the unique call ID to the stack so the Function callback can use it
			this.callContextStack.push(uniqueCallId)
			console.log("🔧 FunctionRegistry: Pushed call context:", uniqueCallId, "Stack:", this.callContextStack)

			const result = await listener.callback(parameters, inputItem)
			console.log("🔧 FunctionRegistry: Function result:", result)

			// Pop the call context
			const poppedCallId = this.callContextStack.pop()
			console.log("🔧 FunctionRegistry: Popped call context:", poppedCallId, "Stack:", this.callContextStack)

			return { result, actualExecutionId: uniqueCallId }
		} catch (error) {
			console.error("🔧 FunctionRegistry: Error calling function:", error)
			// Clean up the stack on error
			this.callContextStack.pop()
			throw error
		}
	}

	listFunctions(): void {
		console.log("🎯 FunctionRegistry: Registered functions:")
		for (const [key, listener] of this.listeners.entries()) {
			console.log(`  - ${key}: ${listener.functionName} (node: ${listener.nodeId})`)
		}
	}

	getAvailableFunctions(executionId?: string): Array<{ name: string; value: string }> {
		const functionNames = new Set<string>()

		// Extract unique function names from registered listeners
		for (const listener of this.listeners.values()) {
			// If executionId is specified, only include functions for that execution
			if (executionId && listener.executionId !== executionId) {
				continue
			}
			functionNames.add(listener.functionName)
		}

		// Convert to array of options for n8n dropdown
		return Array.from(functionNames).map((name) => ({
			name,
			value: name,
		}))
	}

	getFunctionParameters(functionName: string, executionId?: string): ParameterDefinition[] {
		// If executionId is specified, look for that specific function instance
		if (executionId) {
			const key = `${functionName}-${executionId}`
			const listener = this.listeners.get(key)
			if (listener) {
				return listener.parameters
			}
		}

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

	setFunctionReturnValue(executionId: string, returnValue: any): void {
		console.log("🎯 FunctionRegistry: Setting return value for execution:", executionId, "value:", returnValue)
		this.returnValues.set(executionId, returnValue)
	}

	getFunctionReturnValue(executionId: string): any | null {
		const returnValue = this.returnValues.get(executionId)
		console.log("🎯 FunctionRegistry: Getting return value for execution:", executionId, "value:", returnValue)
		return returnValue || null
	}

	clearFunctionReturnValue(executionId: string): void {
		console.log("🎯 FunctionRegistry: Clearing return value for execution:", executionId)
		this.returnValues.delete(executionId)
	}

	pushCurrentFunctionExecution(executionId: string): void {
		console.log("🎯 FunctionRegistry: Pushing function execution to stack:", executionId)
		console.log("🎯 FunctionRegistry: Stack before push:", this.currentFunctionExecutionStack)
		this.currentFunctionExecutionStack.push(executionId)
		console.log("🎯 FunctionRegistry: Stack after push:", this.currentFunctionExecutionStack)
	}

	getCurrentFunctionExecution(): string | null {
		const current = this.currentFunctionExecutionStack[this.currentFunctionExecutionStack.length - 1] ?? null
		console.log("🎯 FunctionRegistry: Getting current function execution:", current)
		console.log("🎯 FunctionRegistry: Current stack:", this.currentFunctionExecutionStack)
		return current
	}

	popCurrentFunctionExecution(): string | null {
		const popped = this.currentFunctionExecutionStack.pop() ?? null
		console.log("🎯 FunctionRegistry: Popped function execution from stack:", popped)
		console.log("🎯 FunctionRegistry: Stack after pop:", this.currentFunctionExecutionStack)
		return popped
	}

	clearCurrentFunctionExecution(): void {
		console.log("🎯 FunctionRegistry: Clearing entire function execution stack")
		console.log("🎯 FunctionRegistry: Stack before clear:", this.currentFunctionExecutionStack)
		this.currentFunctionExecutionStack = []
	}

	generateNestedCallId(baseExecutionId: string): string {
		const nestedId = `${baseExecutionId}_nested_${this.nextCallId++}`
		console.log("🎯 FunctionRegistry: Generated nested call ID:", nestedId, "from base:", baseExecutionId)
		return nestedId
	}

	getCurrentCallContext(): string | undefined {
		return this.callContextStack[this.callContextStack.length - 1]
	}
}

export { FunctionRegistry, type ParameterDefinition }
