import { NodeConnectionType, type INodeType, type INodeTypeDescription, type ITriggerFunctions, type ITriggerResponse } from "n8n-workflow"
import { FUNCTIONS_REDIS_INFO, FunctionsRedisCredentialsData } from "../../credentials/FunctionsRedisCredentials.credentials"
import { enableRedisMode, disableRedisMode, getFunctionRegistry } from "../FunctionRegistryFactory"

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
		],
	}

	async trigger(this: ITriggerFunctions): Promise<ITriggerResponse> {
		console.log("⚙️ ConfigureFunctions: ===== STARTING GLOBAL CONFIGURATION =====")
		console.log("⚙️ ConfigureFunctions: Node execution started")

		// Get configuration parameters
		const useRedis = this.getNodeParameter("useRedis") as boolean
		const testConnection = this.getNodeParameter("testConnection", false) as boolean

		console.log("⚙️ ConfigureFunctions: Parameters retrieved:")
		console.log("⚙️ ConfigureFunctions: - Use Redis =", useRedis)
		console.log("⚙️ ConfigureFunctions: - Test connection =", testConnection)

		// Configure the function registry based on Redis setting
		if (useRedis) {
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

			console.log("⚙️ ConfigureFunctions: 🚀 CONFIGURING GLOBAL REDIS SETTINGS")
			console.log("⚙️ ConfigureFunctions: About to configure Redis with host:", redisConfig.host, "port:", redisConfig.port)

			// Enable Redis mode using the factory
			enableRedisMode(redisConfig.host)
			console.log("⚙️ ConfigureFunctions: ✅ Redis mode enabled via FunctionRegistryFactory")

			console.log("⚙️ ConfigureFunctions: 🌍 GLOBAL CONFIGURATION SHOULD NOW BE SET")

			// Test connection if requested
			if (testConnection) {
				console.log("⚙️ ConfigureFunctions: Testing Redis connection...")
				try {
					// Get the registry and test the connection
					const registry = getFunctionRegistry()
					await registry.testRedisConnection()
					console.log("⚙️ ConfigureFunctions: Redis connection test successful")

					// Emit a test configuration event
					this.emit([
						this.helpers.returnJsonArray([
							{
								mode: "redis",
								redisHost: redisConfig.host,
								redisPort: redisConfig.port,
								redisDatabase: redisConfig.database,
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
								redisDatabase: redisConfig.database,
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
							redisDatabase: redisConfig.database,
							status: "configured",
							timestamp: new Date().toISOString(),
						},
					]),
				])
			}
		} else {
			console.log("⚙️ ConfigureFunctions: Using in-memory mode")

			// Disable Redis mode using the factory
			disableRedisMode()
			console.log("⚙️ ConfigureFunctions: ✅ Redis mode disabled via FunctionRegistryFactory")

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
