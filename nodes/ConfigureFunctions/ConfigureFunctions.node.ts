import { type INodeExecutionData, NodeConnectionType, type INodeType, type INodeTypeDescription, type ITriggerFunctions, type ITriggerResponse } from "n8n-workflow"
import { enableRedisMode, setRedisHost, setQueueMode, setUseSimplifiedRegistry } from "../FunctionRegistryFactory"

export class ConfigureFunctions implements INodeType {
	description: INodeTypeDescription = {
		displayName: "Configure Functions",
		name: "configureFunctions",
		icon: "fa:cogs",
		group: ["trigger"],
		version: 1,
		description: "Configure function system settings (Redis host, queue mode)",
		eventTriggerDescription: "Runs when workflow is activated to configure function settings",
		subtitle: "={{$parameter['mode'] === 'redis' ? 'Redis Mode: ' + $parameter['redisHost'] : 'In-Memory Mode'}}",
		defaults: {
			name: "Configure Functions",
			color: "#9b59b6",
		},
		inputs: [],
		outputs: [NodeConnectionType.Main],
		properties: [
			{
				displayName: "Function Registry Mode",
				name: "mode",
				type: "options",
				options: [
					{
						name: "In-Memory (Default)",
						value: "memory",
						description: "Use in-memory function registry (single process)",
					},
					{
						name: "Redis (Queue Mode)",
						value: "redis",
						description: "Use Redis-backed function registry for queue mode",
					},
				],
				default: "memory",
				description: "Choose how functions are stored and shared",
			},
			{
				displayName: "Redis Host",
				name: "redisHost",
				type: "string",
				default: "redis",
				description: "Redis server hostname or IP address",
				placeholder: "redis",
				displayOptions: {
					show: {
						mode: ["redis"],
					},
				},
			},
			{
				displayName: "Redis Port",
				name: "redisPort",
				type: "number",
				default: 6379,
				description: "Redis server port",
				displayOptions: {
					show: {
						mode: ["redis"],
					},
				},
			},
			{
				displayName: "Test Connection",
				name: "testConnection",
				type: "boolean",
				default: false,
				description: "Whether to test Redis connection when workflow is activated",
				displayOptions: {
					show: {
						mode: ["redis"],
					},
				},
			},
			{
				displayName: "Use Simplified Registry",
				name: "useSimplifiedRegistry",
				type: "boolean",
				default: false,
				description: "Whether to use the simplified Redis registry (experimental - cleaner logic, same isolation)",
				displayOptions: {
					show: {
						mode: ["redis"],
					},
				},
			},
		],
	}

	async trigger(this: ITriggerFunctions): Promise<ITriggerResponse> {
		console.log("⚙️ ConfigureFunctions: Starting configuration")

		// Get configuration parameters
		const mode = this.getNodeParameter("mode") as string
		const redisHost = this.getNodeParameter("redisHost", "redis") as string
		const redisPort = this.getNodeParameter("redisPort", 6379) as number
		const testConnection = this.getNodeParameter("testConnection", false) as boolean
		const useSimplifiedRegistry = this.getNodeParameter("useSimplifiedRegistry", false) as boolean

		console.log("⚙️ ConfigureFunctions: Mode =", mode)
		console.log("⚙️ ConfigureFunctions: Redis host =", redisHost)
		console.log("⚙️ ConfigureFunctions: Redis port =", redisPort)
		console.log("⚙️ ConfigureFunctions: Test connection =", testConnection)
		console.log("⚙️ ConfigureFunctions: Use simplified registry =", useSimplifiedRegistry)

		// Configure the function registry based on mode
		if (mode === "redis") {
			console.log("⚙️ ConfigureFunctions: Enabling Redis mode")
			enableRedisMode(redisHost, useSimplifiedRegistry)

			// Also set the simplified registry flag directly
			setUseSimplifiedRegistry(useSimplifiedRegistry)

			// Test connection if requested
			if (testConnection) {
				console.log("⚙️ ConfigureFunctions: Testing Redis connection...")
				try {
					if (useSimplifiedRegistry) {
						// Import and test simplified Redis connection
						const { FunctionRegistrySimplified } = await import("../FunctionRegistrySimplified")
						const simplifiedRegistry = FunctionRegistrySimplified.getInstance()
						simplifiedRegistry.setRedisConfig(redisHost, redisPort)
						console.log("⚙️ ConfigureFunctions: Simplified Redis configuration set successfully")
					} else {
						// Import and test Redis connection
						const { FunctionRegistryRedis } = await import("../FunctionRegistryRedis")
						const redisRegistry = FunctionRegistryRedis.getInstance()
						redisRegistry.setRedisConfig(redisHost, redisPort)
						console.log("⚙️ ConfigureFunctions: Redis configuration set successfully")
					}

					// Emit a test configuration event
					this.emit([
						this.helpers.returnJsonArray([
							{
								mode: "redis",
								redisHost,
								redisPort,
								useSimplifiedRegistry,
								status: "configured",
								timestamp: new Date().toISOString(),
							},
						]),
					])
				} catch (error) {
					console.error("⚙️ ConfigureFunctions: Redis connection test failed:", error)

					// Emit error event
					this.emit([
						this.helpers.returnJsonArray([
							{
								mode: "redis",
								redisHost,
								redisPort,
								useSimplifiedRegistry,
								status: "error",
								error: error.message,
								timestamp: new Date().toISOString(),
							},
						]),
					])
				}
			} else {
				// Just emit configuration without testing
				this.emit([
					this.helpers.returnJsonArray([
						{
							mode: "redis",
							redisHost,
							redisPort,
							useSimplifiedRegistry,
							status: "configured",
							timestamp: new Date().toISOString(),
						},
					]),
				])
			}
		} else {
			console.log("⚙️ ConfigureFunctions: Using in-memory mode")
			setQueueMode(false)

			// Emit configuration event
			this.emit([
				this.helpers.returnJsonArray([
					{
						mode: "memory",
						status: "configured",
						timestamp: new Date().toISOString(),
					},
				]),
			])
		}

		// Define cleanup function
		const closeFunction = async () => {
			console.log("⚙️ ConfigureFunctions: Cleaning up configuration")
		}

		return {
			closeFunction,
		}
	}
}
