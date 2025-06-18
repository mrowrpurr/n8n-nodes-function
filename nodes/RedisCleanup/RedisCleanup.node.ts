import { IExecuteFunctions, INodeExecutionData, INodeType, INodeTypeDescription, NodeOperationError, NodeConnectionType } from "n8n-workflow"

import { functionRegistryLogger as logger } from "../Logger"
import { isQueueModeEnabled, getRedisConfig, REDIS_KEY_PREFIX } from "../FunctionRegistryFactory"
import { RedisConnectionManager } from "../RedisConnectionManager"

export class RedisCleanup implements INodeType {
	description: INodeTypeDescription = {
		displayName: "Redis Cleanup (DEBUG ONLY)",
		name: "redisCleanup",
		icon: "fa:trash",
		group: ["utility"],
		version: 1,
		description: "DEBUG UTILITY: Clean up Redis function keys - NOT FOR PRODUCTION",
		defaults: {
			name: "Redis Cleanup",
		},
		inputs: [NodeConnectionType.Main],
		outputs: [NodeConnectionType.Main],
		credentials: [],
		properties: [
			{
				displayName: "⚠️ DEBUG UTILITY - NOT FOR PRODUCTION",
				name: "debugWarning",
				type: "notice",
				default: "",
			},
			{
				displayName: "Cleanup Type",
				name: "cleanupType",
				type: "options",
				options: [
					{
						name: "All Function Workers",
						value: "allWorkers",
						description: "Remove all worker registrations for all functions",
					},
					{
						name: "Specific Function Workers",
						value: "specificFunction",
						description: "Remove all workers for a specific function",
					},
					{
						name: "All Function Keys",
						value: "allFunctionKeys",
						description: "Nuclear option: Remove ALL function-related Redis keys",
					},
					{
						name: "Stale Workers Only",
						value: "staleOnly",
						description: "Remove only stale/unhealthy workers (safe cleanup)",
					},
				],
				default: "staleOnly",
				description: "Type of cleanup to perform",
			},
			{
				displayName: "Function Name",
				name: "functionName",
				type: "string",
				default: "",
				placeholder: "Test Fn",
				description: "Name of the function to clean up (for specific function cleanup)",
				displayOptions: {
					show: {
						cleanupType: ["specificFunction"],
					},
				},
			},
			{
				displayName: "Confirm Cleanup",
				name: "confirmCleanup",
				type: "boolean",
				default: false,
				description: "Whether to confirm you want to perform the cleanup",
			},
		],
	}

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const cleanupType = this.getNodeParameter("cleanupType", 0) as string
		const functionName = this.getNodeParameter("functionName", 0) as string
		const confirmCleanup = this.getNodeParameter("confirmCleanup", 0) as boolean

		if (!confirmCleanup) {
			throw new NodeOperationError(this.getNode(), "Please confirm cleanup by checking the 'Confirm Cleanup' checkbox")
		}

		if (!isQueueModeEnabled()) {
			logger.log("🧹 CLEANUP: Queue mode disabled, no cleanup needed")
			return [
				[
					{
						json: {
							message: "Queue mode disabled, no cleanup needed",
							cleanupType,
							timestamp: new Date().toISOString(),
						},
					},
				],
			]
		}

		logger.log(`🧹 CLEANUP: Starting ${cleanupType} cleanup`)

		try {
			const redisConfig = getRedisConfig()
			if (!redisConfig) {
				throw new NodeOperationError(this.getNode(), "Redis configuration not available")
			}

			const connectionManager = RedisConnectionManager.getInstance(redisConfig)
			let cleanedCount = 0
			let details: any = {}

			await connectionManager.executeOperation(async (client) => {
				switch (cleanupType) {
					case "allWorkers":
						cleanedCount = await cleanupAllWorkers(client)
						details = { type: "All workers removed" }
						break

					case "specificFunction":
						if (!functionName) {
							throw new NodeOperationError(this.getNode(), "Function name is required for specific function cleanup")
						}
						cleanedCount = await cleanupSpecificFunctionWorkers(client, functionName)
						details = { type: "Specific function workers removed", functionName }
						break

					case "allFunctionKeys":
						cleanedCount = await cleanupAllFunctionKeys(client)
						details = { type: "ALL function keys removed (nuclear option)" }
						break

					case "staleOnly":
						const result = await cleanupStaleWorkersOnly(client)
						cleanedCount = result.totalCleaned
						details = result.details
						break

					default:
						throw new NodeOperationError(this.getNode(), `Unknown cleanup type: ${cleanupType}`)
				}
			}, `redis-cleanup-${cleanupType}`)

			logger.log(`🧹 CLEANUP: ✅ Cleanup completed - removed ${cleanedCount} items`)

			return [
				[
					{
						json: {
							success: true,
							message: `Cleanup completed successfully`,
							cleanupType,
							cleanedCount,
							details,
							timestamp: new Date().toISOString(),
						},
					},
				],
			]
		} catch (error) {
			logger.error("🧹 CLEANUP: ❌ Cleanup failed:", error)
			throw new NodeOperationError(this.getNode(), `Cleanup failed: ${error}`)
		}
	}
}

async function cleanupAllWorkers(client: any): Promise<number> {
	let cleanedCount = 0

	// Get all worker keys
	const workerKeys = await client.keys(`${REDIS_KEY_PREFIX}workers:*`)
	const individualWorkerKeys = await client.keys(`${REDIS_KEY_PREFIX}worker:*`)

	// Remove worker sets
	for (const key of workerKeys) {
		await client.del(key)
		cleanedCount++
	}

	// Remove individual worker health keys
	for (const key of individualWorkerKeys) {
		await client.del(key)
		cleanedCount++
	}

	logger.log(`🧹 CLEANUP: Removed ${cleanedCount} worker keys`)
	return cleanedCount
}

async function cleanupSpecificFunctionWorkers(client: any, functionName: string): Promise<number> {
	let cleanedCount = 0

	// Get workers for this specific function
	const workersKey = `${REDIS_KEY_PREFIX}workers:${functionName}`
	const workers = await client.sMembers(workersKey)

	// Remove individual worker health keys
	for (const workerId of workers) {
		const workerKey = `${REDIS_KEY_PREFIX}worker:${workerId}:${functionName}`
		await client.del(workerKey)
		cleanedCount++
	}

	// Remove the workers set
	await client.del(workersKey)
	cleanedCount++

	logger.log(`🧹 CLEANUP: Removed ${cleanedCount} keys for function ${functionName}`)
	return cleanedCount
}

async function cleanupAllFunctionKeys(client: any): Promise<number> {
	let cleanedCount = 0

	// Get all function-related keys
	const allKeys = await client.keys(`${REDIS_KEY_PREFIX}*`)

	// Remove all function-related keys
	for (const key of allKeys) {
		await client.del(key)
		cleanedCount++
	}

	logger.log(`🧹 CLEANUP: NUCLEAR CLEANUP - Removed ${cleanedCount} function keys`)
	return cleanedCount
}

async function cleanupStaleWorkersOnly(client: any): Promise<{ totalCleaned: number; details: any }> {
	let totalCleaned = 0
	const functionDetails: any = {}

	// Get all worker sets
	const workerKeys = await client.keys(`${REDIS_KEY_PREFIX}workers:*`)

	for (const workersKey of workerKeys) {
		const functionName = workersKey.replace(`${REDIS_KEY_PREFIX}workers:`, "")
		const workers = await client.sMembers(workersKey)
		let functionCleaned = 0

		for (const workerId of workers) {
			const workerKey = `${REDIS_KEY_PREFIX}worker:${workerId}:${functionName}`
			const lastSeen = await client.get(workerKey)

			// Check if worker is stale (older than 30 seconds)
			const isStale = !lastSeen || Date.now() - parseInt(lastSeen) > 30000

			if (isStale) {
				// Remove from workers set
				await client.sRem(workersKey, workerId)
				// Remove worker health key
				await client.del(workerKey)
				functionCleaned++
				totalCleaned++
				logger.log(`🧹 CLEANUP: Removed stale worker: ${workerId}`)
			}
		}

		if (functionCleaned > 0) {
			functionDetails[functionName] = functionCleaned
		}
	}

	logger.log(`🧹 CLEANUP: Removed ${totalCleaned} stale workers`)
	return { totalCleaned, details: { type: "Stale workers only", functions: functionDetails } }
}
