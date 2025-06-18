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

			// Set up message handler - node-redis v4 uses different syntax
			// We need to handle messages after subscribing
			logger.log("📢 NOTIFICATIONS: Subscriber client created")
		}
	}

	/**
	 * Handle incoming pub/sub messages
	 */
	private handleMessage(channel: string, message: string): void {
		console.log(`📢📢📢 NOTIFICATIONS: handleMessage CALLED`)
		console.log(`📢📢📢 NOTIFICATIONS: Channel: ${channel}`)
		console.log(`📢📢📢 NOTIFICATIONS: Raw message: ${message}`)

		try {
			const parsedMessage = JSON.parse(message)
			console.log(`📢📢📢 NOTIFICATIONS: Parsed message:`, parsedMessage)

			const listeners = this.subscribers.get(channel)
			console.log(`📢📢📢 NOTIFICATIONS: Found ${listeners?.size || 0} listeners for channel ${channel}`)

			if (listeners) {
				logger.log(`📢 NOTIFICATIONS: Received message on ${channel}:`, parsedMessage)

				// Call all listeners for this channel
				listeners.forEach((listener) => {
					console.log(`📢📢📢 NOTIFICATIONS: Calling listener for ${channel}`)
					try {
						listener(parsedMessage)
						console.log(`📢📢📢 NOTIFICATIONS: Listener called successfully`)
					} catch (error) {
						console.log(`📢📢📢 NOTIFICATIONS: ERROR in listener:`, error)
						logger.error(`📢 NOTIFICATIONS: Error in listener for ${channel}:`, error)
					}
				})
			} else {
				console.log(`📢📢📢 NOTIFICATIONS: No listeners found for channel ${channel}`)
			}
		} catch (error) {
			console.log(`📢📢📢 NOTIFICATIONS: ERROR parsing message:`, error)
			logger.error(`📢 NOTIFICATIONS: Error parsing message on ${channel}:`, error)
		}
	}

	/**
	 * Publish a notification to a channel
	 */
	async publish(channel: string, message: object): Promise<void> {
		console.log(`📢📢📢 NOTIFICATIONS: publish CALLED`)
		console.log(`📢📢📢 NOTIFICATIONS: Channel: ${channel}`)
		console.log(`📢📢📢 NOTIFICATIONS: Message:`, message)

		await this.ensureClients()
		console.log(`📢📢📢 NOTIFICATIONS: Clients ensured for publish`)

		const messageStr = JSON.stringify(message)
		console.log(`📢📢📢 NOTIFICATIONS: Message stringified:`, messageStr)

		console.log(`📢📢📢 NOTIFICATIONS: About to publish to Redis...`)
		await this.publisherClient!.publish(channel, messageStr)
		console.log(`📢📢📢 NOTIFICATIONS: Published to Redis successfully`)

		logger.log(`📢 NOTIFICATIONS: Published to ${channel}:`, message)
	}

	/**
	 * Subscribe to notifications on a channel
	 */
	async subscribe(channel: string, listener: NotificationListener): Promise<void> {
		console.log(`📢📢📢 NOTIFICATIONS: subscribe CALLED`)
		console.log(`📢📢📢 NOTIFICATIONS: Channel: ${channel}`)
		console.log(`📢📢📢 NOTIFICATIONS: Listener type: ${typeof listener}`)

		console.log(`📢📢📢 NOTIFICATIONS: Ensuring clients...`)
		await this.ensureClients()
		console.log(`📢📢📢 NOTIFICATIONS: Clients ensured`)

		// Add listener to our map
		if (!this.subscribers.has(channel)) {
			console.log(`📢📢📢 NOTIFICATIONS: First subscription to channel: ${channel}`)
			this.subscribers.set(channel, new Set())

			console.log(`📢📢📢 NOTIFICATIONS: About to subscribe to Redis channel: ${channel}`)
			// Subscribe to Redis channel with node-redis v4 syntax
			await this.subscriberClient!.subscribe(channel, (message: string) => {
				console.log(`📢📢📢 NOTIFICATIONS: RECEIVED MESSAGE on ${channel}:`, message)
				this.handleMessage(channel, message)
			})
			console.log(`📢📢📢 NOTIFICATIONS: Redis subscription completed for: ${channel}`)
			logger.log(`📢 NOTIFICATIONS: Subscribed to channel: ${channel}`)
		} else {
			console.log(`📢📢📢 NOTIFICATIONS: Channel ${channel} already has Redis subscription`)
		}

		console.log(`📢📢📢 NOTIFICATIONS: Adding listener to subscribers map`)
		this.subscribers.get(channel)!.add(listener)
		console.log(`📢📢📢 NOTIFICATIONS: Listener added. Total listeners for ${channel}: ${this.subscribers.get(channel)!.size}`)
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
