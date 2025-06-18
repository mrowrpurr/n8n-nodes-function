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
		console.log(`🎯🎯🎯 COORDINATOR: waitForWorkerAvailability CALLED`)
		console.log(`🎯🎯🎯 COORDINATOR: Function name: ${functionName}`)
		console.log(`🎯🎯🎯 COORDINATOR: Workflow ID: ${workflowId}`)
		console.log(`🎯🎯🎯 COORDINATOR: Timeout: ${timeout}ms`)
		logger.log(`🎯 COORDINATOR: Checking worker availability for ${functionName}`)

		console.log(`🎯🎯🎯 COORDINATOR: Checking immediate availability...`)
		// Check immediate availability first
		const workers = await this.registry.getAvailableWorkers(functionName)
		console.log(`🎯🎯🎯 COORDINATOR: Found ${workers.length} workers:`, workers)

		if (workers.length > 0) {
			console.log(`🎯🎯🎯 COORDINATOR: Checking worker health...`)
			// Check if any worker is healthy
			for (const workerId of workers) {
				console.log(`🎯🎯🎯 COORDINATOR: Checking health of worker: ${workerId}`)
				const isHealthy = await this.registry.isWorkerHealthy(workerId, functionName)
				console.log(`🎯🎯🎯 COORDINATOR: Worker ${workerId} healthy: ${isHealthy}`)
				if (isHealthy) {
					console.log(`🎯🎯🎯 COORDINATOR: Found healthy worker immediately: ${workerId}`)
					logger.log(`🎯 COORDINATOR: Found healthy worker immediately: ${workerId}`)
					return {
						workerId,
						functionName,
						workflowId,
						timestamp: Date.now(),
					}
				}
			}
			console.log(`🎯🎯🎯 COORDINATOR: No healthy workers found among available workers`)
		} else {
			console.log(`🎯🎯🎯 COORDINATOR: No workers available at all`)
		}

		// No healthy workers available - wait for instant notification
		console.log(`🎯🎯🎯 COORDINATOR: No healthy workers available, waiting for instant notification`)
		console.log(`🎯🎯🎯 COORDINATOR: This usually means the Function node is restarting after workflow save`)
		console.log(`🎯🎯🎯 COORDINATOR: Will wait up to ${timeout}ms for Function node to come online`)
		console.log(`🎯🎯🎯 COORDINATOR: About to call readinessWatcher.waitForFunction...`)
		logger.log(`🎯 COORDINATOR: No healthy workers available, waiting for instant notification`)

		try {
			const result = await this.readinessWatcher.waitForFunction(functionName, workflowId, timeout)
			console.log(`🎯🎯🎯 COORDINATOR: readinessWatcher.waitForFunction completed:`, result)
			return result
		} catch (error) {
			console.log(`🎯🎯🎯 COORDINATOR: ERROR in readinessWatcher.waitForFunction:`, error)
			console.log(`🎯🎯🎯 COORDINATOR: This likely means Function node didn't come online within ${timeout}ms`)
			throw error
		}
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
			// CRITICAL: Immediately mark worker as unhealthy in Redis so health checks fail
			await this.registry.markWorkerUnhealthy(workerId, functionName, reason)
			// Also send pub/sub notification
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
