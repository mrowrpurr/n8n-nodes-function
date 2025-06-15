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
	if (!redisConfigOverride?.host) {
		throw new Error("Redis host not configured. Please configure Redis credentials.")
	}
	return redisConfigOverride.host
}

export function getRedisConfig(): RedisConfig {
	if (!redisConfigOverride) {
		throw new Error("Redis configuration not set. Please configure Redis credentials.")
	}
	return redisConfigOverride
}

export function isQueueModeEnabled(): boolean {
	return queueModeEnabled
}

export function resetGlobalConfig(): void {
	logger.info("Resetting global configuration state")
	globalConfigLoaded = false
	redisConfigOverride = null
	queueModeEnabled = false
}

// Load global configuration from Redis synchronously on first access
async function loadGlobalConfigAsync(): Promise<void> {
	if (globalConfigLoaded) {
		return
	}
	logger.debug("Loading global configuration from Redis...")

	try {
		// Skip loading if no Redis config is available
		if (!redisConfigOverride) {
			logger.debug("No Redis config available, skipping global config load")
			return
		}

		// Try to connect to Redis with configured settings
		const socketConfig: any = {
			host: redisConfigOverride.host,
			port: redisConfigOverride.port,
			reconnectStrategy: (retries: number) => Math.min(retries * 50, 500),
			connectTimeout: 500, // 500ms timeout for config loading
		}

		// Only add tls property if it's true
		if (redisConfigOverride.ssl === true) {
			socketConfig.tls = true
		}

		const client = createClient({
			socket: socketConfig,
			database: redisConfigOverride.database,
			username: redisConfigOverride.user || undefined,
			password: redisConfigOverride.password || undefined,
		})

		await client.connect()

		// Try to get global config
		const configJson = await client.get("function:global_config")

		if (configJson) {
			const config = JSON.parse(configJson)
			logger.info("Found global config in Redis:", config)

			if (config.queueMode === true) {
				logger.info("Enabling queue mode from global config")
				queueModeEnabled = true

				if (config.redisHost) {
					logger.info("Setting Redis host from global config:", config.redisHost)
					if (!redisConfigOverride) {
						redisConfigOverride = {
							host: config.redisHost,
							port: config.redisPort || 6379,
							database: config.redisDatabase || 0,
							user: config.redisUser || "",
							password: config.redisPassword || "",
							ssl: config.redisSsl || false,
						}
					} else {
						redisConfigOverride.host = config.redisHost
						if (config.redisPort) redisConfigOverride.port = config.redisPort
						if (config.redisDatabase !== undefined) redisConfigOverride.database = config.redisDatabase
						if (config.redisUser) redisConfigOverride.user = config.redisUser
						if (config.redisPassword) redisConfigOverride.password = config.redisPassword
						if (config.redisSsl !== undefined) redisConfigOverride.ssl = config.redisSsl
					}
				}
			}
		} else {
			logger.debug("No global config found, using defaults")
		}

		await client.disconnect()

		// Only mark as loaded after successful Redis connection and config retrieval
		globalConfigLoaded = true
	} catch (error) {
		logger.debug("Could not load global config from Redis (will retry on next access):", error.message)
		// Don't set globalConfigLoaded = true here, so it will retry next time
		// Also clear the promise cache so next attempt creates a new promise
		configLoadingPromise = null
	}
}

// Cache for the config loading promise to avoid multiple simultaneous loads
let configLoadingPromise: Promise<void> | null = null

export async function getFunctionRegistry(): Promise<FunctionRegistry> {
	// Load global config from Redis on first access if not already loaded
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

// Separate function for loading global config - only used by ConfigureFunctions
export async function loadGlobalConfig(): Promise<void> {
	if (!globalConfigLoaded) {
		if (!configLoadingPromise) {
			configLoadingPromise = loadGlobalConfigAsync()
		}
		await configLoadingPromise
	}
}
// Convenience function to enable Redis mode and set host in one call
export function enableRedisMode(host?: string): void {
	if (!host) {
		throw new Error("Redis host is required to enable Redis mode")
	}
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
	resetGlobalConfig()
	setQueueMode(false)
}
