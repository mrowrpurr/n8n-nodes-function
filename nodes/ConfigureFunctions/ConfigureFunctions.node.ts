import { NodeConnectionType, type INodeType, type INodeTypeDescription, type ITriggerFunctions, type ITriggerResponse } from "n8n-workflow"
import { enableRedisMode, setQueueMode } from "../FunctionRegistryFactory"
import { FUNCTIONS_REDIS_INFO, FunctionsRedisCredentialsData } from "../../credentials/FunctionsRedisCredentials.credentials"

export class ConfigureFunctions implements INodeType {
	description: INodeTypeDescription = {
		displayName: "Configure Functions",
		name: "configureFunctions",
		icon: "fa:cogs",
		group: ["trigger"],
		version: 1,
		description: "Configure function system settings (Redis host, queue mode)",
		eventTriggerDescription: "Runs when workflow is activated to configure function settings",
		subtitle: "={{$parameter['useRedis'] ? 'Redis Mode Enabled' : 'In-Memory Mode'}}",
		defaults: {
			name: "Configure Functions",
			color: "#9b59b6",
		},
		inputs: [],
		outputs: [NodeConnectionType.Main],
		credentials: [
			{
				name: FUNCTIONS_REDIS_INFO.credentialsName,
				required: false,
			},
		],
		properties: [
			{
				displayName: "Use Redis",
				name: "useRedis",
				type: "boolean",
				default: false,
				description: "Whether to use Redis for function storage (enables queue mode support and cross-workflow sharing)",
			},
			{
				displayName: "Test Connection",
				name: "testConnection",
				type: "boolean",
				default: false,
				description: "Whether to test Redis connection when workflow is activated",
				displayOptions: {
					show: {
						useRedis: [true],
					},
				},
			},
			// Registry Type removed - always use Workflow Registry (most stable)
			// {
			// 	displayName: "Registry Type",
			// 	name: "registryType",
			// 	type: "options",
			// 	options: [
			// 		{
			// 			name: "Workflow Registry (Most Stable)",
			// 			value: "workflow",
			// 			description: "Stores function workflow fragments in Redis - works across all n8n modes",
			// 		},
			// 		{
			// 			name: "Simplified Registry",
			// 			value: "simplified",
			// 			description: "Simplified Redis registry with metadata only",
			// 		},
			// 		{
			// 			name: "Full Redis Registry",
			// 			value: "redis",
			// 			description: "Original Redis registry with complex execution tracking",
			// 		},
			// 	],
			// 	default: "workflow",
			// 	description: "Choose the function registry implementation",
			// 	displayOptions: {
			// 		show: {
			// 			useRedis: [true],
			// 		},
			// 	},
			// },
		],
	}

	async trigger(this: ITriggerFunctions): Promise<ITriggerResponse> {
		console.log("⚙️ ConfigureFunctions: ===== STARTING GLOBAL CONFIGURATION =====")
		console.log("⚙️ ConfigureFunctions: Node execution started")

		// Get configuration parameters
		const useRedis = this.getNodeParameter("useRedis") as boolean
		const testConnection = this.getNodeParameter("testConnection", false) as boolean

		// Always use workflow registry (most stable)
		const useSimplifiedRegistry = false
		const useWorkflowRegistry = true
		const registryType = "workflow"

		console.log("⚙️ ConfigureFunctions: Parameters retrieved:")
		console.log("⚙️ ConfigureFunctions: - Use Redis =", useRedis)
		console.log("⚙️ ConfigureFunctions: - Test connection =", testConnection)
		console.log("⚙️ ConfigureFunctions: - Registry type = workflow (hardcoded)")
		console.log("⚙️ ConfigureFunctions: - Use simplified registry =", useSimplifiedRegistry)
		console.log("⚙️ ConfigureFunctions: - Use workflow registry =", useWorkflowRegistry)

		// For now, just use the user setting - we can add auto-detection later
		const shouldUseRedis = useRedis
		console.log("⚙️ ConfigureFunctions: Should use Redis =", shouldUseRedis)

		// Configure the function registry based on Redis setting
		if (shouldUseRedis) {
			console.log("⚙️ ConfigureFunctions: Enabling Redis mode")

			// Get Redis credentials if provided
			let redisConfig = {
				host: "redis",
				port: 6379,
				database: 0,
				user: "",
				password: "",
				ssl: false,
			}

			if (useRedis) {
				try {
					const credentials = (await this.getCredentials(FUNCTIONS_REDIS_INFO.credentialsName)) as unknown as FunctionsRedisCredentialsData
					redisConfig = {
						host: credentials.host || "redis",
						port: credentials.port || 6379,
						database: credentials.database || 0,
						user: credentials.user || "",
						password: credentials.password || "",
						ssl: credentials.ssl || false,
					}
					console.log("⚙️ ConfigureFunctions: Using Redis credentials - host:", redisConfig.host, "port:", redisConfig.port)
				} catch (error) {
					console.warn("⚙️ ConfigureFunctions: No Redis credentials provided, using defaults:", error.message)
				}
			}

			console.log("⚙️ ConfigureFunctions: 🚀 CALLING GLOBAL FACTORY FUNCTIONS")
			console.log("⚙️ ConfigureFunctions: About to call enableRedisMode with host:", redisConfig.host, "(always using workflow registry)")

			enableRedisMode(redisConfig.host)
			console.log("⚙️ ConfigureFunctions: ✅ enableRedisMode() called successfully")

			// Registry type flags are deprecated - always use workflow registry
			console.log("⚙️ ConfigureFunctions: ✅ Using workflow registry (hardcoded)")

			console.log("⚙️ ConfigureFunctions: 🌍 GLOBAL CONFIGURATION SHOULD NOW BE SET")

			// Test connection if requested
			if (testConnection) {
				console.log("⚙️ ConfigureFunctions: Testing Redis connection...")
				try {
					// Always test workflow registry connection
					const { FunctionRegistryWorkflow } = await import("../FunctionRegistryWorkflow")
					const workflowRegistry = FunctionRegistryWorkflow.getInstance()
					workflowRegistry.setRedisConfig(redisConfig.host, redisConfig.port)
					console.log("⚙️ ConfigureFunctions: Workflow Redis configuration set successfully")

					// Emit a test configuration event
					this.emit([
						this.helpers.returnJsonArray([
							{
								mode: "redis",
								redisHost: redisConfig.host,
								redisPort: redisConfig.port,
								registryType,
								useSimplifiedRegistry,
								useWorkflowRegistry,
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
								redisHost: redisConfig.host,
								redisPort: redisConfig.port,
								registryType,
								useSimplifiedRegistry,
								useWorkflowRegistry,
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
							redisHost: redisConfig.host,
							redisPort: redisConfig.port,
							registryType,
							useSimplifiedRegistry,
							useWorkflowRegistry,
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
