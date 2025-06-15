import { FunctionRegistry } from "./FunctionRegistry"
import { createClient } from "redis"

// Static configuration for Redis host and queue mode
let redisHostOverride: string | null = null
let queueModeEnabled: boolean = false
let globalConfigLoaded: boolean = false

export function setRedisHost(host: string): void {
	console.log("🏭 FunctionRegistryFactory: Setting Redis host override:", host)
	redisHostOverride = host

	// Update existing registry instance if it exists
	const registry = FunctionRegistry.getInstance()
	registry.setRedisConfig(host)
}

export function setQueueMode(enabled: boolean): void {
	console.log("🏭 FunctionRegistryFactory: Setting queue mode:", enabled)
	queueModeEnabled = enabled
}

export function getRedisHost(): string {
	return redisHostOverride || "redis"
}

export function isQueueModeEnabled(): boolean {
	return queueModeEnabled
}

// Load global configuration from Redis synchronously on first access
async function loadGlobalConfigAsync(): Promise<void> {
	if (globalConfigLoaded) {
		return
	}

	console.log("🏭 FunctionRegistryFactory: Loading global configuration from Redis...")
	globalConfigLoaded = true // Mark as attempted to avoid multiple attempts

	try {
		// Try to connect to Redis with default host to read global config
		const client = createClient({
			url: `redis://redis:6379`,
			socket: {
				reconnectStrategy: (retries: number) => Math.min(retries * 50, 500),
				connectTimeout: 500, // 500ms timeout for config loading
				commandTimeout: 500,
			},
		})

		await client.connect()

		// Try to get global config
		const configJson = await client.get("function:global_config")

		if (configJson) {
			const config = JSON.parse(configJson)
			console.log("🏭 FunctionRegistryFactory: Found global config:", config)

			if (config.queueMode === true) {
				console.log("🏭 FunctionRegistryFactory: Enabling queue mode from global config")
				queueModeEnabled = true

				if (config.redisHost) {
					console.log("🏭 FunctionRegistryFactory: Setting Redis host from global config:", config.redisHost)
					redisHostOverride = config.redisHost
				}
			}
		} else {
			console.log("🏭 FunctionRegistryFactory: No global config found, using defaults")
		}

		await client.disconnect()
	} catch (error) {
		console.log("🏭 FunctionRegistryFactory: Could not load global config from Redis (using defaults):", error.message)
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

	console.log("🏭 FunctionRegistryFactory: Queue mode enabled =", queueModeEnabled)

	const registry = FunctionRegistry.getInstance()

	if (queueModeEnabled) {
		console.log("🏭 FunctionRegistryFactory: Using Redis-backed FunctionRegistry")

		// Apply Redis host override if set
		if (redisHostOverride) {
			registry.setRedisConfig(redisHostOverride)
		}
	} else {
		console.log("🏭 FunctionRegistryFactory: Using in-memory FunctionRegistry (Redis disabled)")
	}

	return registry
}
// Convenience function to enable Redis mode and set host in one call
export function enableRedisMode(host: string = "redis"): void {
	console.log("🏭 FunctionRegistryFactory: Enabling Redis mode with host:", host)
	setRedisHost(host)
	setQueueMode(true)
}

// Convenience function to disable Redis mode
export function disableRedisMode(): void {
	console.log("🏭 FunctionRegistryFactory: Disabling Redis mode")
	setQueueMode(false)
}
