import { FunctionRegistry } from "./FunctionRegistry"
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

export function setRedisConfig(config: RedisConfig): void {
	logger.info("Setting Redis config override:", config)
	redisConfigOverride = config
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

export function getRedisConfig(): RedisConfig | null {
	return redisConfigOverride
}

export function isQueueModeEnabled(): boolean {
	return queueModeEnabled
}

export async function getFunctionRegistry(): Promise<FunctionRegistry> {
	logger.debug("Queue mode enabled =", queueModeEnabled)

	if (queueModeEnabled && redisConfigOverride) {
		logger.debug("Using Redis-backed FunctionRegistry")
		return FunctionRegistry.getInstance(redisConfigOverride)
	} else {
		logger.debug("Using in-memory FunctionRegistry (Redis disabled)")
		// For non-queue mode, we still need a registry but it won't use Redis
		const dummyConfig: RedisConfig = {
			host: "localhost",
			port: 6379,
			database: 0,
			user: "",
			password: "",
			ssl: false,
		}
		return FunctionRegistry.getInstance(dummyConfig)
	}
}

// Auto-bootstrap from queue-mode environment variables if present
// This runs after all exports are defined to avoid circular dependencies
;(function bootstrapFromQueueEnv() {
	const host = process.env.QUEUE_BULL_REDIS_HOST
	if (!host) return // Not in queue mode, nothing to do

	// Check if already configured to avoid duplicate bootstrapping
	if (redisConfigOverride) return

	const port = Number(process.env.QUEUE_BULL_REDIS_PORT || 6379)
	const db = Number(process.env.QUEUE_BULL_REDIS_DB || 0)
	const user = process.env.QUEUE_BULL_REDIS_USER || ""
	const pass = process.env.QUEUE_BULL_REDIS_PASSWORD || ""
	const ssl = (process.env.QUEUE_BULL_REDIS_SSL || "false") === "true"

	logger.info("🚀 FunctionRegistryFactory: Auto-bootstrapping from queue environment variables")
	logger.info(`🚀 FunctionRegistryFactory: Redis host: ${host}, port: ${port}, db: ${db}, ssl: ${ssl}`)

	setRedisConfig({
		host,
		port,
		database: db,
		user,
		password: pass,
		ssl,
	})
	setQueueMode(true)

	logger.info("🚀 FunctionRegistryFactory: Bootstrap complete - queue mode enabled")
})()
