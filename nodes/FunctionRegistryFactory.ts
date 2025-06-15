import { FunctionRegistry } from "./FunctionRegistry"
import { FunctionRegistryRedis } from "./FunctionRegistryRedis"
import { FunctionRegistrySimplified } from "./FunctionRegistrySimplified"

// Static configuration for Redis host and queue mode
let redisHostOverride: string | null = null
let queueModeEnabled: boolean = false
let useSimplifiedRegistry: boolean = false

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

export function setUseSimplifiedRegistry(enabled: boolean): void {
	console.log("🏭 FunctionRegistryFactory: Setting use simplified registry:", enabled)
	useSimplifiedRegistry = enabled
}

export function getRedisHost(): string {
	return redisHostOverride || "redis"
}

export function isQueueModeEnabled(): boolean {
	return queueModeEnabled
}

export function isUsingSimplifiedRegistry(): boolean {
	return useSimplifiedRegistry
}

export function getFunctionRegistry(): FunctionRegistry | FunctionRegistryRedis | FunctionRegistrySimplified {
	console.log("🏭 FunctionRegistryFactory: Queue mode enabled =", queueModeEnabled)
	console.log("🏭 FunctionRegistryFactory: Use simplified registry =", useSimplifiedRegistry)

	if (queueModeEnabled) {
		if (useSimplifiedRegistry) {
			console.log("🏭 FunctionRegistryFactory: Using Simplified Redis-backed FunctionRegistry")
			const simplifiedRegistry = FunctionRegistrySimplified.getInstance()

			// Apply Redis host override if set
			if (redisHostOverride) {
				simplifiedRegistry.setRedisConfig(redisHostOverride)
			}

			return simplifiedRegistry
		} else {
			console.log("🏭 FunctionRegistryFactory: Using Redis-backed FunctionRegistry")
			const redisRegistry = FunctionRegistryRedis.getInstance()

			// Apply Redis host override if set
			if (redisHostOverride) {
				redisRegistry.setRedisConfig(redisHostOverride)
			}

			return redisRegistry
		}
	} else {
		console.log("🏭 FunctionRegistryFactory: Using in-memory FunctionRegistry")
		return FunctionRegistry.getInstance()
	}
}

// Convenience function to enable Redis mode and set host in one call
export function enableRedisMode(host: string = "redis", simplified: boolean = false): void {
	console.log("🏭 FunctionRegistryFactory: Enabling Redis mode with host:", host, "simplified:", simplified)
	setRedisHost(host)
	setQueueMode(true)
	setUseSimplifiedRegistry(simplified)
}

// Type guard to check if registry is Redis-backed
export function isRedisRegistry(registry: any): registry is FunctionRegistryRedis {
	return registry instanceof FunctionRegistryRedis
}

// Type guard to check if registry is simplified Redis-backed
export function isSimplifiedRedisRegistry(registry: any): registry is FunctionRegistrySimplified {
	return registry instanceof FunctionRegistrySimplified
}

// Type guard to check if registry is any Redis-backed registry
export function isAnyRedisRegistry(registry: any): registry is FunctionRegistryRedis | FunctionRegistrySimplified {
	return registry instanceof FunctionRegistryRedis || registry instanceof FunctionRegistrySimplified
}
