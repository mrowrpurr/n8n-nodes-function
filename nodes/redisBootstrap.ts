/**
 * Bootstrap module that reads n8n queue mode Redis environment variables
 * and configures the FunctionRegistry to use the same Redis instance.
 * This runs on process startup before any nodes are executed.
 */

import { setRedisConfig, setQueueMode } from "./FunctionRegistryFactory"
import { functionRegistryFactoryLogger as logger } from "./Logger"

// Check if we're running in n8n queue mode by looking for Redis configuration
const redisHost = process.env.QUEUE_BULL_REDIS_HOST
const redisPort = process.env.QUEUE_BULL_REDIS_PORT ? parseInt(process.env.QUEUE_BULL_REDIS_PORT, 10) : 6379
const redisDb = process.env.QUEUE_BULL_REDIS_DB ? parseInt(process.env.QUEUE_BULL_REDIS_DB, 10) : 0
const redisUsername = process.env.QUEUE_BULL_REDIS_USERNAME || ""
const redisPassword = process.env.QUEUE_BULL_REDIS_PASSWORD || ""
const redisTls = process.env.QUEUE_BULL_REDIS_TLS === "true"

// If Redis host is configured, we assume we're in queue mode
if (redisHost) {
	logger.info("Redis bootstrap: Detected n8n queue mode Redis configuration")
	logger.info(`Redis bootstrap: Configuring FunctionRegistry to use Redis at ${redisHost}:${redisPort}`)

	// Configure the FunctionRegistry to use the same Redis instance
	setRedisConfig({
		host: redisHost,
		port: redisPort,
		database: redisDb,
		user: redisUsername,
		password: redisPassword,
		ssl: redisTls,
	})

	// Enable queue mode
	setQueueMode(true)

	logger.info("Redis bootstrap: FunctionRegistry configured for queue mode")
} else {
	logger.debug("Redis bootstrap: No QUEUE_BULL_REDIS_HOST found, FunctionRegistry will use in-memory mode unless configured otherwise")
}
