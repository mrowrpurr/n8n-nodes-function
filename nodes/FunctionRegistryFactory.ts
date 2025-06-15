import { FunctionRegistry } from "./FunctionRegistry"
import { FunctionRegistryRedis } from "./FunctionRegistryRedis"
import { FunctionRegistrySimplified } from "./FunctionRegistrySimplified"

// Global configuration that persists across the entire n8n process
// This makes ConfigureFunctions truly global - once set, it affects ALL workflows
declare global {
	var __n8nFunctionsGlobalConfig:
		| {
				redisHost?: string
				queueMode?: boolean
				useSimplified?: boolean
		  }
		| undefined
}

// Initialize global config if not exists
if (typeof globalThis.__n8nFunctionsGlobalConfig === "undefined") {
	globalThis.__n8nFunctionsGlobalConfig = {}
}

// Static configuration for Redis host and queue mode
let redisHostOverride: string | null = globalThis.__n8nFunctionsGlobalConfig.redisHost || null
let queueModeEnabled: boolean = globalThis.__n8nFunctionsGlobalConfig.queueMode || false
let useSimplifiedRegistry: boolean = globalThis.__n8nFunctionsGlobalConfig.useSimplified || false

console.log("🏭 FunctionRegistryFactory: Initialized with global config - Redis:", redisHostOverride, "Queue:", queueModeEnabled, "Simplified:", useSimplifiedRegistry)

export function setRedisHost(host: string): void {
	console.log("🏭 FunctionRegistryFactory: Setting Redis host override:", host)
	redisHostOverride = host

	// Persist to global config
	if (globalThis.__n8nFunctionsGlobalConfig) {
		globalThis.__n8nFunctionsGlobalConfig.redisHost = host
	}
	console.log("🏭 FunctionRegistryFactory: ✅ Redis host saved globally - will affect ALL workflows")

	// Update existing Redis registry instance if it exists
	const redisRegistry = FunctionRegistryRedis.getInstance()
	redisRegistry.setRedisConfig(host)
}

export function setQueueMode(enabled: boolean): void {
	console.log("🏭 FunctionRegistryFactory: Setting queue mode:", enabled)
	queueModeEnabled = enabled

	// Persist to global config
	if (globalThis.__n8nFunctionsGlobalConfig) {
		globalThis.__n8nFunctionsGlobalConfig.queueMode = enabled
	}
	console.log("🏭 FunctionRegistryFactory: ✅ Queue mode saved globally - will affect ALL workflows")
}

export function setUseSimplifiedRegistry(enabled: boolean): void {
	console.log("🏭 FunctionRegistryFactory: Setting use simplified registry:", enabled)
	useSimplifiedRegistry = enabled

	// Persist to global config
	if (globalThis.__n8nFunctionsGlobalConfig) {
		globalThis.__n8nFunctionsGlobalConfig.useSimplified = enabled
	}
	console.log("🏭 FunctionRegistryFactory: ✅ Simplified registry setting saved globally - will affect ALL workflows")
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
	console.log("🏭 FunctionRegistryFactory: ===== REGISTRY SELECTION DEBUG =====")
	console.log("🏭 FunctionRegistryFactory: Explicit queue mode enabled =", queueModeEnabled)
	console.log("🏭 FunctionRegistryFactory: Use simplified registry =", useSimplifiedRegistry)
	console.log("🏭 FunctionRegistryFactory: Redis host override =", redisHostOverride)
	console.log("🏭 FunctionRegistryFactory: Global config =", globalThis.__n8nFunctionsGlobalConfig)

	// Auto-detect queue mode: if Redis host is configured, assume we want Redis mode
	const autoDetectedQueueMode = redisHostOverride !== null
	console.log("🏭 FunctionRegistryFactory: Auto-detected queue mode (Redis configured) =", autoDetectedQueueMode)

	const effectiveQueueMode = queueModeEnabled || autoDetectedQueueMode
	console.log("🏭 FunctionRegistryFactory: Effective queue mode =", effectiveQueueMode)

	if (effectiveQueueMode) {
		if (useSimplifiedRegistry) {
			console.log("🏭 FunctionRegistryFactory: ✅ Using Simplified Redis-backed FunctionRegistry")
			const simplifiedRegistry = FunctionRegistrySimplified.getInstance()

			// Apply Redis host override if set, otherwise use default
			const effectiveHost = redisHostOverride || "redis"
			console.log("🏭 FunctionRegistryFactory: Setting Redis host to:", effectiveHost)
			simplifiedRegistry.setRedisConfig(effectiveHost)

			return simplifiedRegistry
		} else {
			console.log("🏭 FunctionRegistryFactory: ✅ Using Redis-backed FunctionRegistry")
			const redisRegistry = FunctionRegistryRedis.getInstance()

			// Apply Redis host override if set, otherwise use default
			const effectiveHost = redisHostOverride || "redis"
			console.log("🏭 FunctionRegistryFactory: Setting Redis host to:", effectiveHost)
			redisRegistry.setRedisConfig(effectiveHost)

			return redisRegistry
		}
	} else {
		console.log("🏭 FunctionRegistryFactory: ❌ Using in-memory FunctionRegistry")
		console.log("🏭 FunctionRegistryFactory: 💡 To enable Redis mode globally, activate any workflow with ConfigureFunctions node once")
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
