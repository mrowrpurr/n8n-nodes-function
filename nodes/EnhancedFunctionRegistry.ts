import { FunctionRegistry, FunctionDefinition } from "./FunctionRegistry"
import { WorkerCoordinator } from "./WorkerCoordinator"
import { NotificationManager } from "./NotificationManager"
import { RedisConnectionManager } from "./RedisConnectionManager"
import { RedisConfig } from "./FunctionRegistryFactory"
import { functionRegistryLogger as logger } from "./Logger"

/**
 * Enhanced Function Registry with instant pub/sub notifications
 * Extends the existing registry with zero-delay coordination
 */
export class EnhancedFunctionRegistry extends FunctionRegistry {
	private notificationManager: NotificationManager
	private coordinator: WorkerCoordinator
	private static enhancedInstance: EnhancedFunctionRegistry | null = null

	constructor(redisConfig: RedisConfig) {
		super(redisConfig)

		// Initialize notification infrastructure
		const connectionManager = RedisConnectionManager.getInstance(redisConfig)
		this.notificationManager = new NotificationManager(connectionManager)
		this.coordinator = new WorkerCoordinator(this.notificationManager, this)

		logger.log("🚀 ENHANCED REGISTRY: Initialized with pub/sub notifications")
	}

	/**
	 * Get enhanced singleton instance
	 */
	static getEnhancedInstance(redisConfig?: RedisConfig): EnhancedFunctionRegistry {
		if (!EnhancedFunctionRegistry.enhancedInstance && redisConfig) {
			EnhancedFunctionRegistry.enhancedInstance = new EnhancedFunctionRegistry(redisConfig)
		}
		if (!EnhancedFunctionRegistry.enhancedInstance) {
			throw new Error("EnhancedFunctionRegistry not initialized")
		}
		return EnhancedFunctionRegistry.enhancedInstance
	}

	/**
	 * Enhanced function registration with notifications
	 */
	async registerFunctionWithNotification(definition: FunctionDefinition): Promise<void> {
		logger.log(`🚀 ENHANCED: Registering function ${definition.name} with instant notifications`)

		// Register function using parent method
		await super.registerFunction(definition)

		// No need to create notifier here - it will be created when worker registers
		logger.log(`🚀 ENHANCED: ✅ Function registered, ready for instant notifications`)
	}

	/**
	 * Enhanced worker registration with instant notifications
	 */
	async registerWorkerWithInstantNotification(workerId: string, functionName: string, workflowId: string): Promise<void> {
		await this.coordinator.registerWorkerWithNotification(workerId, functionName, workflowId)
	}

	/**
	 * Enhanced worker unregistration with graceful notifications
	 */
	async unregisterWorkerWithNotification(workerId: string, functionName: string, workflowId: string): Promise<void> {
		await this.coordinator.unregisterWorkerWithNotification(workerId, functionName, workflowId)
	}

	/**
	 * Enhanced function calling with instant readiness (no polling!)
	 */
	async callFunctionWithInstantReadiness(functionName: string, workflowId: string, parameters: any, item: any, timeout: number = 10000): Promise<any> {
		logger.log(`🚀 ENHANCED: Calling ${functionName} with instant readiness check`)

		// Wait for worker availability (instant via pub/sub)
		const workerInfo = await this.coordinator.waitForWorkerAvailability(functionName, workflowId, timeout)
		logger.log(`🚀 ENHANCED: Worker ready instantly: ${workerInfo.workerId}`)

		// Execute call via streams (existing functionality)
		const callId = `call-${Date.now()}-${Math.random().toString(36).slice(2)}`
		const streamKey = `function_calls:${functionName}:${workflowId}`
		const responseChannel = `function:response:${callId}`

		// Add call to stream
		await this.addCall(streamKey, callId, functionName, parameters, item, responseChannel)

		// Wait for response (existing functionality)
		const response = await this.waitForResponse(responseChannel, 0) // 0 = infinite wait

		return response
	}

	/**
	 * Coordinate graceful shutdown
	 */
	async coordinateShutdown(functionName: string, workflowId: string, workerId: string): Promise<void> {
		await this.coordinator.coordinateGracefulShutdown(functionName, workflowId, workerId)
	}

	/**
	 * Send health notification
	 */
	async notifyWorkerHealth(functionName: string, workflowId: string, workerId: string, isHealthy: boolean, reason?: string): Promise<void> {
		await this.coordinator.notifyHealth(functionName, workflowId, workerId, isHealthy, reason)
	}

	/**
	 * Enhanced shutdown with cleanup
	 */
	async shutdown(): Promise<void> {
		logger.log("🚀 ENHANCED: Starting enhanced registry shutdown")

		// Clean up coordinator
		await this.coordinator.cleanup()

		// Shutdown notification manager
		await this.notificationManager.shutdown()

		// Call parent shutdown
		await super.shutdown()

		logger.log("🚀 ENHANCED: ✅ Enhanced registry shutdown complete")
	}

	/**
	 * Get instant worker status via notifications
	 */
	async getInstantWorkerStatus(
		functionName: string,
		workflowId: string
	): Promise<{
		available: boolean
		workers: string[]
		healthyWorkers: string[]
		isWaitingForWorker: boolean
	}> {
		const workers = await this.getAvailableWorkers(functionName)
		const healthyWorkers: string[] = []

		for (const workerId of workers) {
			if (await this.isWorkerHealthy(workerId, functionName)) {
				healthyWorkers.push(workerId)
			}
		}

		// Check if we're currently waiting for this function
		const isWaiting = this.coordinator["readinessWatcher"].isWatching(functionName, workflowId)

		return {
			available: healthyWorkers.length > 0,
			workers,
			healthyWorkers,
			isWaitingForWorker: isWaiting,
		}
	}
}
