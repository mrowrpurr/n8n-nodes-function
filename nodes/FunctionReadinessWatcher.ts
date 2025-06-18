import { NotificationManager, NotificationListener } from "./NotificationManager"
import { functionRegistryLogger as logger } from "./Logger"

export interface WorkerInfo {
	workerId: string
	functionName: string
	workflowId: string
	timestamp: number
}

/**
 * Subscribes to function readiness notifications for instant awareness
 * Used by CallFunction nodes to eliminate polling delays
 */
export class FunctionReadinessWatcher {
	private notificationManager: NotificationManager
	private pendingWaits: Map<string, Promise<WorkerInfo>> = new Map()
	private activeListeners: Map<string, NotificationListener> = new Map()

	constructor(notificationManager: NotificationManager) {
		this.notificationManager = notificationManager
	}

	/**
	 * Wait for function to become ready with instant notification
	 */
	async waitForFunction(functionName: string, workflowId: string, timeout: number = 10000): Promise<WorkerInfo> {
		console.log(`👀👀👀 WATCHER: waitForFunction CALLED`)
		console.log(`👀👀👀 WATCHER: Function name: ${functionName}`)
		console.log(`👀👀👀 WATCHER: Workflow ID: ${workflowId}`)
		console.log(`👀👀👀 WATCHER: Timeout: ${timeout}ms`)

		const key = `${functionName}:${workflowId}`
		console.log(`👀👀👀 WATCHER: Key: ${key}`)

		// Check if already waiting
		if (this.pendingWaits.has(key)) {
			console.log(`👀👀👀 WATCHER: Already waiting for ${functionName}, reusing existing wait`)
			logger.log(`👀 WATCHER: Already waiting for ${functionName}, reusing existing wait`)
			return this.pendingWaits.get(key)!
		}

		console.log(`👀👀👀 WATCHER: Starting new wait for ${functionName}`)
		logger.log(`👀 WATCHER: Starting instant wait for ${functionName} (timeout: ${timeout}ms)`)

		const promise = new Promise<WorkerInfo>((resolve, reject) => {
			console.log(`👀👀👀 WATCHER: Creating promise for ${functionName}`)

			const timeoutId = setTimeout(() => {
				console.log(`👀👀👀 WATCHER: TIMEOUT REACHED for ${functionName} after ${timeout}ms`)
				this.cleanup(key)
				reject(new Error(`Function ${functionName} not ready after ${timeout}ms`))
			}, timeout)

			console.log(`👀👀👀 WATCHER: Timeout set for ${timeout}ms`)

			const listener: NotificationListener = (message: any) => {
				console.log(`👀👀👀 WATCHER: RECEIVED NOTIFICATION for ${functionName}:`, message)
				logger.log(`👀 WATCHER: Received ready notification for ${functionName}:`, message)
				clearTimeout(timeoutId)
				this.cleanup(key)
				resolve({
					workerId: message.workerId,
					functionName: message.functionName,
					workflowId: message.workflowId,
					timestamp: message.timestamp,
				})
			}

			console.log(`👀👀👀 WATCHER: Created listener function`)

			// Store listener for cleanup
			this.activeListeners.set(key, listener)
			console.log(`👀👀👀 WATCHER: Stored listener in activeListeners`)

			// Subscribe to ready channel
			const channel = `function:ready:${functionName}:${workflowId}`
			console.log(`👀👀👀 WATCHER: About to subscribe to channel: ${channel}`)

			this.notificationManager
				.subscribe(channel, listener)
				.then(() => {
					console.log(`👀👀👀 WATCHER: Successfully subscribed to ${channel}`)
				})
				.catch((error) => {
					console.log(`👀👀👀 WATCHER: FAILED to subscribe to ${channel}:`, error)
					logger.error(`👀 WATCHER: Failed to subscribe to ${channel}:`, error)
					clearTimeout(timeoutId)
					this.cleanup(key)
					reject(error)
				})
		})

		console.log(`👀👀👀 WATCHER: Storing promise in pendingWaits`)
		this.pendingWaits.set(key, promise)
		console.log(`👀👀👀 WATCHER: Returning promise for ${functionName}`)
		return promise
	}

	/**
	 * Check if currently watching for a function
	 */
	isWatching(functionName: string, workflowId: string): boolean {
		const key = `${functionName}:${workflowId}`
		return this.pendingWaits.has(key)
	}

	/**
	 * Stop watching specific function
	 */
	async stopWatching(functionName: string, workflowId: string): Promise<void> {
		const key = `${functionName}:${workflowId}`
		await this.cleanup(key)
		logger.log(`👀 WATCHER: Stopped watching ${functionName}`)
	}

	/**
	 * Cleanup specific watcher
	 */
	private async cleanup(key: string): Promise<void> {
		// Remove from pending waits
		this.pendingWaits.delete(key)

		// Unsubscribe listener
		const listener = this.activeListeners.get(key)
		if (listener) {
			const [functionName, workflowId] = key.split(":")
			const channel = `function:ready:${functionName}:${workflowId}`

			try {
				await this.notificationManager.unsubscribe(channel, listener)
			} catch (error) {
				logger.error(`👀 WATCHER: Error unsubscribing from ${channel}:`, error)
			}

			this.activeListeners.delete(key)
		}
	}

	/**
	 * Cleanup all watchers
	 */
	async cleanupAll(): Promise<void> {
		logger.log(`👀 WATCHER: Cleaning up all ${this.pendingWaits.size} watchers`)

		const cleanupPromises: Promise<void>[] = []
		for (const key of this.pendingWaits.keys()) {
			cleanupPromises.push(this.cleanup(key))
		}

		await Promise.all(cleanupPromises)

		this.pendingWaits.clear()
		this.activeListeners.clear()

		logger.log(`👀 WATCHER: ✅ All watchers cleaned up`)
	}
}
