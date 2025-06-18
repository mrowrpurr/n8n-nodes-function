import { INodeType, INodeTypeDescription, ITriggerFunctions, ITriggerResponse, NodeConnectionType } from "n8n-workflow"

export class TestTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: "Test Trigger",
		name: "testTrigger",
		icon: "fa:bug",
		group: ["trigger"],
		version: 1,
		description: "A simple trigger node to test lifecycle events on workflow save",
		defaults: {
			name: "Test Trigger",
		},
		inputs: [],
		outputs: [NodeConnectionType.Main],
		credentials: [],
		triggerPanel: {
			header: "",
			executionsHelp: {
				inactive: "Test trigger will log lifecycle events when workflow is saved.",
				active: "Test trigger is active and logging lifecycle events.",
			},
			activationHint: "Once you save the workflow, this trigger will log when it starts/stops.",
		},
		properties: [
			{
				displayName: "Test Message",
				name: "testMessage",
				type: "string",
				default: "Test trigger is running",
				description: "Message to include in lifecycle logs",
			},
		],
	}

	async trigger(this: ITriggerFunctions): Promise<ITriggerResponse> {
		const testMessage = this.getNodeParameter("testMessage") as string
		const nodeId = this.getNode().id
		const workflowId = this.getWorkflow().id || "unknown"
		const timestamp = new Date().toISOString()

		console.log(`🧪🧪🧪 TEST TRIGGER: STARTING - ${timestamp}`)
		console.log(`🧪🧪🧪 TEST TRIGGER: Node ID: ${nodeId}`)
		console.log(`🧪🧪🧪 TEST TRIGGER: Workflow ID: ${workflowId}`)
		console.log(`🧪🧪🧪 TEST TRIGGER: Message: ${testMessage}`)
		console.log(`🧪🧪🧪 TEST TRIGGER: Process PID: ${process.pid}`)

		// Set up a simple interval to emit data every 30 seconds
		const interval = setInterval(() => {
			const now = new Date().toISOString()
			console.log(`🧪🧪🧪 TEST TRIGGER: HEARTBEAT - ${now}`)

			this.emit([
				[
					{
						json: {
							message: testMessage,
							timestamp: now,
							nodeId,
							workflowId,
							pid: process.pid,
						},
					},
				],
			])
		}, 30000)

		// Log initial startup complete
		console.log(`🧪🧪🧪 TEST TRIGGER: STARTUP COMPLETE - ${new Date().toISOString()}`)

		return {
			closeFunction: async () => {
				const shutdownTime = new Date().toISOString()
				console.log(`🧪🧪🧪 TEST TRIGGER: SHUTDOWN STARTING - ${shutdownTime}`)
				console.log(`🧪🧪🧪 TEST TRIGGER: Node ID: ${nodeId}`)
				console.log(`🧪🧪🧪 TEST TRIGGER: Workflow ID: ${workflowId}`)
				console.log(`🧪🧪🧪 TEST TRIGGER: Process PID: ${process.pid}`)

				// Clear the interval
				if (interval) {
					clearInterval(interval)
					console.log(`🧪🧪🧪 TEST TRIGGER: Interval cleared`)
				}

				// Add a small delay to see timing
				await new Promise((resolve) => setTimeout(resolve, 100))

				console.log(`🧪🧪🧪 TEST TRIGGER: SHUTDOWN COMPLETE - ${new Date().toISOString()}`)
			},
		}
	}
}
