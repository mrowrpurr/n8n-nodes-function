import { FunctionLifecycleNotifier } from "./FunctionLifecycleNotifier"
import { FunctionReadinessWatcher, WorkerInfo } from "./FunctionReadinessWatcher"
import { FunctionRegistry } from "./FunctionRegistry"
import { NotificationManager } from "./NotificationManager"
import { functionRegistryLogger as logger } from "./Logger"

/**
 * Coordinates worker lifecycle with instant notifications
 * Bridges the gap between Function nodes and CallFunction nodes
 */
export class WorkerCoordinator {
	private notificationManager: NotificationManager
	private registry: FunctionRegistry
	private functionNotifiers: Map<string, FunctionLifecycleNotifier> = new Map()
	private readinessWatcher: FunctionReadinessWatcher

	constructor(notificationManager: NotificationManager, registry: FunctionRegistry) {
		this.notificationManager = notificationManager
		this.registry = registry
		this.readinessWatcher = new FunctionReadinessWatcher(notificationManager)
	}

	/**
	 * Get or create a notifier for a function
	 */
	private getNotifier(functionName: string, workflowId: string, workerId: string): FunctionLifecycleNotifier {
		const key = `${functionName}:${workflowId}:${workerId}`

		if (!this.functionNotifiers.has(key)) {
			const notifier = new FunctionLifecycleNotifier(this.notificationManager, functionName, workflowId, workerId)
			this.functionNotifiers.set(key, notifier)
		}

		return this.functionNotifiers.get(key)!
	}

	/**
	 * Register worker and notify readiness instantly
	 */
	async registerWorkerWithNotification(workerId: string, functionName: string, workflowId: string): Promise<void> {
		logger.log(`🎯 COORDINATOR: Registering worker ${workerId} for ${functionName} with instant notification`)

		// Register in Redis (existing functionality)
		await this.registry.registerWorker(workerId, functionName)

		// Get notifier for this function
		const notifier = this.getNotifier(functionName, workflowId, workerId)

		// Notify instant readiness (new functionality)
		await notifier.notifyReady()

		logger.log(`🎯 COORDINATOR: ✅ Worker registered and ready notification sent`)
	}

	/**
	 * Unregister worker with graceful notification
	 */
	async unregisterWorkerWithNotification(workerId: string, functionName: string, workflowId: string): Promise<void> {
		logger.log(`🎯 COORDINATOR: Starting graceful unregistration for worker ${workerId}`)

		// Get notifier for this function
		const notifier = this.getNotifier(functionName, workflowId, workerId)

		// Notify planned shutdown first
		await notifier.notifyShuttingDown(2000) // 2 second estimate
		logger.log(`🎯 COORDINATOR: Shutdown notification sent, waiting 100ms for coordination`)

		// Wait a moment for coordination
		await new Promise((resolve) => setTimeout(resolve, 100))

		// Unregister from Redis
		await this.registry.unregisterWorker(workerId, functionName)

		// Notify offline
		await notifier.notifyOffline("graceful_shutdown")

		// Clean up notifier
		const key = `${functionName}:${workflowId}:${workerId}`
		this.functionNotifiers.delete(key)

		logger.log(`🎯 COORDINATOR: ✅ Worker unregistered gracefully`)
	}

	/**
	 * Wait for worker with instant notification
	 */
	async waitForWorkerAvailability(functionName: string, workflowId: string, timeout: number = 10000): Promise<WorkerInfo> {
		logger.log(`🎯 COORDINATOR: Checking worker availability for ${functionName}`)

		// Check immediate availability first
		const workers = await this.registry.getAvailableWorkers(functionName)

		if (workers.length > 0) {
			// Check if any worker is healthy
			for (const workerId of workers) {
				const isHealthy = await this.registry.isWorkerHealthy(workerId, functionName)
				if (isHealthy) {
					logger.log(`🎯 COORDINATOR: Found healthy worker immediately: ${workerId}`)
					return {
						workerId,
						functionName,
						workflowId,
						timestamp: Date.now(),
					}
				}
			}
		}

		// No healthy workers available - wait for instant notification
		logger.log(`🎯 COORDINATOR: No healthy workers available, waiting for instant notification`)
		return await this.readinessWatcher.waitForFunction(functionName, workflowId, timeout)
	}

	/**
	 * Coordinate graceful shutdown with notifications
	 */
	async coordinateGracefulShutdown(functionName: string, workflowId: string, workerId: string, estimatedDowntime: number = 3000): Promise<void> {
		logger.log(`🎯 COORDINATOR: Coordinating graceful shutdown for ${functionName}`)

		const notifier = this.getNotifier(functionName, workflowId, workerId)

		// Step 1: Notify shutdown is starting
		await notifier.notifyShuttingDown(estimatedDowntime)

		// Step 2: Stop health updates
		// (This is handled by the Function node)

		// Step 3: Wait for in-flight messages
		logger.log(`🎯 COORDINATOR: Waiting 2 seconds for in-flight messages`)
		await new Promise((resolve) => setTimeout(resolve, 2000))

		// Step 4: Unregister worker
		await this.registry.unregisterWorker(workerId, functionName)

		// Step 5: Notify offline
		await notifier.notifyOffline("coordinated_shutdown")

		// Clean up notifier
		const key = `${functionName}:${workflowId}:${workerId}`
		this.functionNotifiers.delete(key)

		logger.log(`🎯 COORDINATOR: ✅ Graceful shutdown completed`)
	}

	/**
	 * Send health notification
	 */
	async notifyHealth(functionName: string, workflowId: string, workerId: string, isHealthy: boolean, reason?: string): Promise<void> {
		const notifier = this.getNotifier(functionName, workflowId, workerId)

		if (isHealthy) {
			await notifier.notifyHealthy()
		} else {
			await notifier.notifyUnhealthy(reason || "unknown")
		}
	}

	/**
	 * Cleanup all resources
	 */
	async cleanup(): Promise<void> {
		logger.log(`🎯 COORDINATOR: Cleaning up coordinator resources`)

		// Clean up all notifiers
		this.functionNotifiers.clear()

		// Clean up readiness watcher
		await this.readinessWatcher.cleanupAll()

		logger.log(`🎯 COORDINATOR: ✅ Cleanup completed`)
	}
}
