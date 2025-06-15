// Bootstrap Redis configuration from environment variables
require("./dist/nodes/redisBootstrap")

module.exports = {
	nodes: [
		require("./dist/nodes/ConfigureFunctions/ConfigureFunctions.node"),
		require("./dist/nodes/Function/Function.node"),
		require("./dist/nodes/CallFunction/CallFunction.node"),
		require("./dist/nodes/ReturnFromFunction/ReturnFromFunction.node"),
	],
}
