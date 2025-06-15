import { FunctionRegistry } from "./FunctionRegistry"
import { createClient } from "redis"
import { functionRegistryFactoryLogger as logger } from "./Logger"

// Redis configuration interface
export interface RedisConfig {
	host: string
	port: number
	database: number
	user: string
	password: string
	ssl: boolean
}

// Static configuration for Redis and queue mode
let redisConfigOverride: RedisConfig | null = null
let queueModeEnabled: boolean = false
let globalConfigLoaded: boolean = false

export function setRedisConfig(config: RedisConfig): void {
	logger.info("Setting Redis config override:", config)
	redisConfigOverride = config

	// Update existing registry instance if it exists
	const registry = FunctionRegistry.getInstance()
	registry.setRedisConfig(config)
}

export function setRedisHost(host: string): void {
	logger.info("Setting Redis host override:", host)
	if (!redisConfigOverride) {
		redisConfigOverride = {
			host,
			port: 6379,
			database: 0,
			user: "",
			password: "",
			ssl: false,
		}
	} else {
		redisConfigOverride.host = host
	}

	// Update existing registry instance if it exists
	const registry = FunctionRegistry.getInstance()
	registry.setRedisConfig(redisConfigOverride)
}

export function setQueueMode(enabled: boolean): void {
	logger.info("Setting queue mode:", enabled)
	queueModeEnabled = enabled
}

export function getRedisHost(): string {
	return redisConfigOverride?.host || "redis"
}

export function getRedisConfig(): RedisConfig {
	return (
		redisConfigOverride || {
			host: "redis",
			port: 6379,
			database: 0,
			user: "",
			password: "",
			ssl: false,
		}
	)
}

export function isQueueModeEnabled(): boolean {
	return queueModeEnabled
}

// Load global configuration from Redis synchronously on first access
async function loadGlobalConfigAsync(): Promise<void> {
	if (globalConfigLoaded) {
		return
	}
	logger.debug("Loading global configuration from Redis...")
	globalConfigLoaded = true // Mark as attempted to avoid multiple attempts

	try {
		// Try to connect to Redis with current config to read global config
		const currentConfig = getRedisConfig()
		const client = createClient({
			socket: {
				host: currentConfig.host,
				port: currentConfig.port,
				tls: currentConfig.ssl === true,
				reconnectStrategy: (retries: number) => Math.min(retries * 50, 500),
				connectTimeout: 500, // 500ms timeout for config loading
				commandTimeout: 500,
			},
			database: currentConfig.database,
			username: currentConfig.user || undefined,
			password: currentConfig.password || undefined,
		})

		await client.connect()

		// Try to get global config
		const configJson = await client.get("function:global_config")

		if (configJson) {
			const config = JSON.parse(configJson)
			logger.debug("Found global config:", config)

			if (config.queueMode === true) {
				logger.info("Enabling queue mode from global config")
				queueModeEnabled = true

				if (config.redisHost) {
					logger.info("Setting Redis host from global config:", config.redisHost)
					if (!redisConfigOverride) {
						redisConfigOverride = {
							host: config.redisHost,
							port: 6379,
							database: 0,
							user: "",
							password: "",
							ssl: false,
						}
					} else {
						redisConfigOverride.host = config.redisHost
					}
				}
			}
		} else {
			logger.debug("No global config found, using defaults")
		}

		await client.disconnect()
	} catch (error) {
		logger.debug("Could not load global config from Redis (using defaults):", error.message)
	}
}

// Cache for the config loading promise to avoid multiple simultaneous loads
let configLoadingPromise: Promise<void> | null = null

export async function getFunctionRegistry(): Promise<FunctionRegistry> {
	// Ensure global config is loaded before proceeding
	if (!globalConfigLoaded) {
		if (!configLoadingPromise) {
			configLoadingPromise = loadGlobalConfigAsync()
		}
		await configLoadingPromise
	}

	logger.debug("Queue mode enabled =", queueModeEnabled)

	const registry = FunctionRegistry.getInstance()

	if (queueModeEnabled) {
		logger.debug("Using Redis-backed FunctionRegistry")

		// Apply Redis config override if set
		if (redisConfigOverride) {
			registry.setRedisConfig(redisConfigOverride)
		}
	} else {
		logger.debug("Using in-memory FunctionRegistry (Redis disabled)")
	}

	return registry
}
// Convenience function to enable Redis mode and set host in one call
export function enableRedisMode(host: string = "redis"): void {
	logger.info("Enabling Redis mode with host:", host)
	setRedisHost(host)
	setQueueMode(true)

	// Immediately update any existing registry instance
	try {
		const registry = FunctionRegistry.getInstance()
		registry.setRedisConfig(redisConfigOverride!)
		logger.info("Updated existing registry with new Redis config:", redisConfigOverride)
	} catch (error) {
		logger.debug("No existing registry to update (this is normal):", error.message)
	}
}

// Convenience function to disable Redis mode
export function disableRedisMode(): void {
	logger.info("Disabling Redis mode")
	setQueueMode(false)
}
