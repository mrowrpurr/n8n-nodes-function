// Simple test script to verify Redis functionality
const { createClient } = require("redis")

async function testRedis() {
	console.log("🧪 Testing Redis connection...")

	const client = createClient({
		url: "redis://redis:6379",
	})

	try {
		await client.connect()
		console.log("✅ Connected to Redis")

		// Test basic operations
		await client.set(
			"test:function:hello",
			JSON.stringify({
				functionName: "hello",
				parameters: [{ name: "name", type: "string", required: true }],
			})
		)

		const result = await client.get("test:function:hello")
		console.log("✅ Stored and retrieved function metadata:", JSON.parse(result))

		// Test return value storage
		await client.set("test:return:123", JSON.stringify({ message: "Hello World!" }), { EX: 300 })
		const returnValue = await client.get("test:return:123")
		console.log("✅ Stored and retrieved return value:", JSON.parse(returnValue))

		// Test pub/sub
		const subscriber = client.duplicate()
		await subscriber.connect()

		await subscriber.subscribe("test:return-pubsub:123", (message) => {
			console.log("✅ Received pub/sub message:", JSON.parse(message))
			subscriber.disconnect()
		})

		await client.publish("test:return-pubsub:123", JSON.stringify({ test: "pubsub works!" }))

		// Cleanup
		await client.del("test:function:hello")
		await client.del("test:return:123")

		setTimeout(async () => {
			await client.disconnect()
			console.log("✅ Redis test completed successfully!")
		}, 100)
	} catch (error) {
		console.error("❌ Redis test failed:", error)
		if (client.isOpen) {
			await client.disconnect()
		}
	}
}

if (require.main === module) {
	testRedis()
}

module.exports = { testRedis }
