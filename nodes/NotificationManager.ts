import { RedisConnectionManager } from "./RedisConnectionManager"
import { functionRegistryLogger as logger } from "./Logger"

export type NotificationListener = (message: any) => void

/**
 * Manages Redis pub/sub connections for instant notifications
 * Provides a clean abstraction over Redis pub/sub with automatic reconnection
 */
export class NotificationManager {
	private connectionManager: RedisConnectionManager
	private subscribers: Map<string, Set<NotificationListener>> = new Map()
	private publisherClient: any | null = null
	private subscriberClient: any | null = null
	private isShuttingDown = false

	constructor(connectionManager: RedisConnectionManager) {
		this.connectionManager = connectionManager
	}

	/**
	 * Initialize pub/sub clients
	 */
	private async ensureClients(): Promise<void> {
		if (this.isShuttingDown) {
			throw new Error("NotificationManager is shutting down")
		}

		// Create publisher client if needed
		if (!this.publisherClient) {
			this.publisherClient = await this.connectionManager.createClient("notification-publisher")
			logger.log("📢 NOTIFICATIONS: Publisher client created")
		}

		// Create subscriber client if needed
		if (!this.subscriberClient) {
			this.subscriberClient = await this.connectionManager.createClient("notification-subscriber")

			// Set up message handler
			this.subscriberClient.on("message", (channel: string, message: string) => {
				this.handleMessage(channel, message)
			})

			logger.log("📢 NOTIFICATIONS: Subscriber client created")
		}
	}

	/**
	 * Handle incoming pub/sub messages
	 */
	private handleMessage(channel: string, message: string): void {
		try {
			const parsedMessage = JSON.parse(message)
			const listeners = this.subscribers.get(channel)

			if (listeners) {
				logger.log(`📢 NOTIFICATIONS: Received message on ${channel}:`, parsedMessage)

				// Call all listeners for this channel
				listeners.forEach((listener) => {
					try {
						listener(parsedMessage)
					} catch (error) {
						logger.error(`📢 NOTIFICATIONS: Error in listener for ${channel}:`, error)
					}
				})
			}
		} catch (error) {
			logger.error(`📢 NOTIFICATIONS: Error parsing message on ${channel}:`, error)
		}
	}

	/**
	 * Publish a notification to a channel
	 */
	async publish(channel: string, message: object): Promise<void> {
		await this.ensureClients()

		const messageStr = JSON.stringify(message)
		await this.publisherClient!.publish(channel, messageStr)

		logger.log(`📢 NOTIFICATIONS: Published to ${channel}:`, message)
	}

	/**
	 * Subscribe to notifications on a channel
	 */
	async subscribe(channel: string, listener: NotificationListener): Promise<void> {
		await this.ensureClients()

		// Add listener to our map
		if (!this.subscribers.has(channel)) {
			this.subscribers.set(channel, new Set())

			// Subscribe to Redis channel
			await this.subscriberClient!.subscribe(channel)
			logger.log(`📢 NOTIFICATIONS: Subscribed to channel: ${channel}`)
		}

		this.subscribers.get(channel)!.add(listener)
		logger.log(`📢 NOTIFICATIONS: Added listener for channel: ${channel}`)
	}

	/**
	 * Unsubscribe from notifications on a channel
	 */
	async unsubscribe(channel: string, listener: NotificationListener): Promise<void> {
		const listeners = this.subscribers.get(channel)

		if (listeners) {
			listeners.delete(listener)

			// If no more listeners, unsubscribe from Redis
			if (listeners.size === 0) {
				this.subscribers.delete(channel)

				if (this.subscriberClient) {
					await this.subscriberClient.unsubscribe(channel)
					logger.log(`📢 NOTIFICATIONS: Unsubscribed from channel: ${channel}`)
				}
			}
		}
	}

	/**
	 * Graceful shutdown
	 */
	async shutdown(): Promise<void> {
		logger.log("📢 NOTIFICATIONS: Shutting down notification manager...")
		this.isShuttingDown = true

		// Clear all subscribers
		this.subscribers.clear()

		// Close clients
		if (this.publisherClient) {
			await this.publisherClient.quit()
			this.publisherClient = null
		}

		if (this.subscriberClient) {
			await this.subscriberClient.quit()
			this.subscriberClient = null
		}

		logger.log("📢 NOTIFICATIONS: ✅ Notification manager shutdown complete")
	}
}
