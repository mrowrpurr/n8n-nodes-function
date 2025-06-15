import { NodeConnectionType, type INodeType, type INodeTypeDescription, type ITriggerFunctions, type ITriggerResponse, NodeOperationError } from "n8n-workflow"
import { FUNCTIONS_REDIS_INFO, FunctionsRedisCredentialsData } from "../../credentials/FunctionsRedisCredentials.credentials"
import { disableRedisMode, getFunctionRegistry, setRedisConfig, setQueueMode, resetGlobalConfig } from "../FunctionRegistryFactory"
import { configureFunctionsLogger as logger } from "../Logger"

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
		logger.info("===== STARTING GLOBAL CONFIGURATION =====")
		logger.debug("Node execution started")

		// Reset any cached global configuration to ensure fresh start
		resetGlobalConfig()
		logger.debug("Global configuration state reset")

		// Clear any existing global config from Redis to prevent stale config
		// Use default connection parameters to avoid chicken-and-egg problem
		try {
			const { createClient } = await import("redis")
			const client = createClient({
				socket: {
					host: "redis",
					port: 6379,
					tls: false,
					reconnectStrategy: (retries: number) => Math.min(retries * 50, 500),
					connectTimeout: 1000,
					commandTimeout: 1000,
				},
				database: 0,
			})

			await client.connect()
			await client.del("function:global_config")
			await client.disconnect()
			logger.debug("✅ Cleared existing global config from Redis using default connection")
		} catch (error) {
			logger.debug("Could not clear global config from Redis (this is normal if Redis is not available):", error.message)
		}

		// Get configuration parameters
		const useRedis = this.getNodeParameter("useRedis") as boolean
		const testConnection = this.getNodeParameter("testConnection", false) as boolean

		logger.debug("Parameters retrieved:")
		logger.debug("- Use Redis =", useRedis)
		logger.debug("- Test connection =", testConnection)

		// Configure the function registry based on Redis setting
		if (useRedis) {
			logger.info("Enabling Redis mode")

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
				logger.debug("Using Redis credentials - host:", redisConfig.host, "port:", redisConfig.port)
			} catch (error) {
				logger.warn("No Redis credentials provided, using defaults:", error.message)
			}

			logger.debug("🚀 CONFIGURING GLOBAL REDIS SETTINGS")
			logger.debug("About to configure Redis with host:", redisConfig.host, "port:", redisConfig.port)

			// Enable Redis mode using the factory
			logger.info("🔧 About to enable Redis mode with config:", redisConfig)
			setRedisConfig(redisConfig)
			setQueueMode(true)
			logger.info("✅ Redis mode enabled via FunctionRegistryFactory with config:", redisConfig)

			// Test Redis connection and fail activation if it doesn't work
			try {
				const registry = await getFunctionRegistry()
				logger.info("🔍 Testing Redis connection before activation...")
				await registry.testRedisConnection() // This will throw if connection fails
				logger.info("✅ Redis connection test successful")

				// Store global configuration that workers will read
				const globalConfig = {
					queueMode: true,
					redisHost: redisConfig.host,
					timestamp: new Date().toISOString(),
				}

				logger.debug("Storing global config in Redis:", globalConfig)

				// Use the registry's Redis client to store config
				const client = (registry as any).client
				if (client) {
					await client.set("function:global_config", JSON.stringify(globalConfig), { EX: 86400 }) // 24 hour expiry
					logger.info("✅ Global config stored in Redis")
				}
			} catch (error) {
				logger.error("❌ Redis connection test failed:", error.message)
				throw new NodeOperationError(
					this.getNode(),
					`Failed to connect to Redis at ${redisConfig.host}:${redisConfig.port}. Please check your Redis credentials and ensure Redis is running. Error: ${error.message}`
				)
			}

			logger.debug("🌍 GLOBAL CONFIGURATION SHOULD NOW BE SET")

			// Test connection if requested
			if (testConnection) {
				logger.debug("Testing Redis connection...")
				try {
					// Get the registry and test the connection
					const registry = await getFunctionRegistry()
					await registry.testRedisConnection()
					logger.info("Redis connection test successful")

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
					logger.error("Redis connection test failed:", error)

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
			logger.info("Using in-memory mode")

			// Disable Redis mode using the factory
			disableRedisMode()
			logger.info("✅ Redis mode disabled via FunctionRegistryFactory")

			// Try to clear global config from Redis if it exists
			try {
				// Since we're in memory mode, we need to temporarily connect to Redis to clear the config
				const { createClient } = await import("redis")
				const { getRedisConfig } = await import("../FunctionRegistryFactory")
				const currentConfig = getRedisConfig()
				const client = createClient({
					socket: {
						host: currentConfig.host,
						port: currentConfig.port,
						tls: currentConfig.ssl === true,
						reconnectStrategy: (retries: number) => Math.min(retries * 50, 500),
						connectTimeout: 1000,
						commandTimeout: 1000,
					},
					database: currentConfig.database,
					username: currentConfig.user || undefined,
					password: currentConfig.password || undefined,
				})

				await client.connect()
				await client.del("function:global_config")
				await client.disconnect()
				logger.debug("✅ Global config cleared from Redis")
			} catch (error) {
				logger.debug("Could not clear global config from Redis (this is normal if Redis is not available):", error.message)
			}

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
			logger.debug("Cleaning up configuration")
		}

		return {
			closeFunction,
		}
	}
}
