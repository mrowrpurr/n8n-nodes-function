import { FunctionRegistry } from "./FunctionRegistry"

// Static configuration for Redis host and queue mode
let redisHostOverride: string | null = null
let queueModeEnabled: boolean = false

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

export function getFunctionRegistry(): FunctionRegistry {
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
