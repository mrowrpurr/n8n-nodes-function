import { FunctionRegistry } from "./FunctionRegistry"
import { FunctionRegistryRedis } from "./FunctionRegistryRedis"

// Static configuration for Redis host and queue mode
let redisHostOverride: string | null = null
let queueModeEnabled: boolean = false

export function setRedisHost(host: string): void {
	console.log("🏭 FunctionRegistryFactory: Setting Redis host override:", host)
	redisHostOverride = host

	// Update existing Redis registry instance if it exists
	const redisRegistry = FunctionRegistryRedis.getInstance()
	redisRegistry.setRedisConfig(host)
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

export function getFunctionRegistry(): FunctionRegistry | FunctionRegistryRedis {
	console.log("🏭 FunctionRegistryFactory: Queue mode enabled =", queueModeEnabled)

	if (queueModeEnabled) {
		console.log("🏭 FunctionRegistryFactory: Using Redis-backed FunctionRegistry")
		const redisRegistry = FunctionRegistryRedis.getInstance()

		// Apply Redis host override if set
		if (redisHostOverride) {
			redisRegistry.setRedisConfig(redisHostOverride)
		}

		return redisRegistry
	} else {
		console.log("🏭 FunctionRegistryFactory: Using in-memory FunctionRegistry with Redis support")
		// The current FunctionRegistry has Redis support built-in when USE_REDIS = true
		// This allows global functions to work even in "in-memory" mode
		return FunctionRegistry.getInstance()
	}
}

// Convenience function to enable Redis mode and set host in one call
export function enableRedisMode(host: string = "redis"): void {
	console.log("🏭 FunctionRegistryFactory: Enabling Redis mode with host:", host)
	setRedisHost(host)
	setQueueMode(true)
}

// Type guard to check if registry is Redis-backed
export function isRedisRegistry(registry: any): registry is FunctionRegistryRedis {
	return registry instanceof FunctionRegistryRedis
}
