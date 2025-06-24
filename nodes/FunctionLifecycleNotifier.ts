import { NotificationManager } from "./NotificationManager"
import { REDIS_KEY_PREFIX } from "./FunctionRegistryFactory"
import { functionRegistryLogger as logger } from "./Logger"

/**
 * Publishes function lifecycle events to Redis pub/sub
 * Used by Function nodes to notify their state changes instantly
 */
export class FunctionLifecycleNotifier {
	private notificationManager: NotificationManager
	private functionName: string
	private workflowId: string
	private workerId: string

	constructor(notificationManager: NotificationManager, functionName: string, workflowId: string, workerId: string) {
		this.notificationManager = notificationManager
		this.functionName = functionName
		this.workflowId = workflowId
		this.workerId = workerId
	}

	/**
	 * Notify that function is ready to receive calls
	 */
	async notifyReady(): Promise<void> {
		// console.log(`🚀🚀🚀 LIFECYCLE: notifyReady CALLED`)
		// console.log(`🚀🚀🚀 LIFECYCLE: Function name: ${this.functionName}`)
		// console.log(`🚀🚀🚀 LIFECYCLE: Workflow ID: ${this.workflowId}`)
		// console.log(`🚀🚀🚀 LIFECYCLE: Worker ID: ${this.workerId}`)

		const channel = `${REDIS_KEY_PREFIX}function:ready:${this.functionName}:${this.workflowId}`
		const message = {
			workerId: this.workerId,
			functionName: this.functionName,
			workflowId: this.workflowId,
			timestamp: Date.now(),
			status: "ready",
		}

		// console.log(`🚀🚀🚀 LIFECYCLE: Channel: ${channel}`)
		// console.log(`🚀🚀🚀 LIFECYCLE: Message:`, message)
		// console.log(`🚀🚀🚀 LIFECYCLE: About to publish notification...`)

		await this.notificationManager.publish(channel, message)

		// console.log(`🚀🚀🚀 LIFECYCLE: Notification published successfully`)
		logger.log(`🚀 LIFECYCLE: Published ready notification for ${this.functionName}`)
	}

	/**
	 * Notify planned shutdown with estimated downtime
	 */
	async notifyShuttingDown(estimatedDowntime: number): Promise<void> {
		const channel = `${REDIS_KEY_PREFIX}function:shutdown:${this.functionName}:${this.workflowId}`
		const message = {
			workerId: this.workerId,
			functionName: this.functionName,
			workflowId: this.workflowId,
			timestamp: Date.now(),
			status: "shutting_down",
			estimatedDowntime,
		}

		await this.notificationManager.publish(channel, message)
		logger.log(`🚀 LIFECYCLE: Published shutdown notification for ${this.functionName} (estimated downtime: ${estimatedDowntime}ms)`)
	}

	/**
	 * Notify immediate offline status
	 */
	async notifyOffline(reason: string): Promise<void> {
		const channel = `${REDIS_KEY_PREFIX}function:offline:${this.functionName}:${this.workflowId}`
		const message = {
			workerId: this.workerId,
			functionName: this.functionName,
			workflowId: this.workflowId,
			timestamp: Date.now(),
			status: "offline",
			reason,
		}

		await this.notificationManager.publish(channel, message)
		logger.log(`🚀 LIFECYCLE: Published offline notification for ${this.functionName} (reason: ${reason})`)
	}

	/**
	 * Notify healthy status
	 */
	async notifyHealthy(): Promise<void> {
		const channel = `worker:health:${this.functionName}:${this.workflowId}`
		const message = {
			workerId: this.workerId,
			functionName: this.functionName,
			workflowId: this.workflowId,
			timestamp: Date.now(),
			status: "healthy",
		}

		await this.notificationManager.publish(channel, message)
		logger.log(`🚀 LIFECYCLE: Published healthy notification for ${this.functionName}`)
	}

	/**
	 * Notify unhealthy status
	 */
	async notifyUnhealthy(reason: string): Promise<void> {
		const channel = `worker:health:${this.functionName}:${this.workflowId}`
		const message = {
			workerId: this.workerId,
			functionName: this.functionName,
			workflowId: this.workflowId,
			timestamp: Date.now(),
			status: "unhealthy",
			reason,
		}

		await this.notificationManager.publish(channel, message)
		logger.log(`🚀 LIFECYCLE: Published unhealthy notification for ${this.functionName} (reason: ${reason})`)
	}
}
