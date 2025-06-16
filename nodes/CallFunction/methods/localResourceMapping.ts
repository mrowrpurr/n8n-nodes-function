import type { ILocalLoadOptionsFunctions, ResourceMapperFields } from "n8n-workflow"
import { getFunctionRegistry } from "../../FunctionRegistryFactory"
import { functionRegistryLogger as logger } from "../../Logger"

export async function getFunctionParametersForMapper(this: ILocalLoadOptionsFunctions): Promise<ResourceMapperFields> {
	logger.log("🔧 CallFunction: Loading function parameters for resource mapper")

	// Get the workflow node context to access parameters
	const context = await this.getWorkflowNodeContext("n8n-nodes-function.callFunction")
	if (!context) {
		return {
			fields: [],
			emptyFieldsNotice: "Unable to access node context for parameter loading.",
		}
	}

	const functionName = context.getNodeParameter("functionName", 0) as string
	const workflowSelector = context.getNodeParameter("workflowId", 0) as any

	logger.log("🔧 CallFunction: Function name:", functionName)
	logger.log("🔧 CallFunction: Workflow selector:", workflowSelector)

	if (!functionName || functionName === "__no_workflow_selected__" || functionName === "__no_functions__" || functionName === "__activate_workflow__") {
		return {
			fields: [],
			emptyFieldsNotice: "Please select a valid function first to see its parameters.",
		}
	}

	// Extract the actual workflow ID from the selector object
	let workflowId: string = ""
	if (workflowSelector && typeof workflowSelector === "object" && workflowSelector.value) {
		workflowId = workflowSelector.value
	} else if (typeof workflowSelector === "string") {
		workflowId = workflowSelector
	}

	if (!workflowId) {
		return {
			fields: [],
			emptyFieldsNotice: "Please select a workflow first to see function parameters.",
		}
	}

	const registry = await getFunctionRegistry()
	const parameters = await registry.getFunctionParameters(functionName, workflowId)

	logger.log("🔧 CallFunction: Found parameters for mapper:", parameters)

	// Convert function parameters to resource mapper fields
	const fields = parameters.map((param) => ({
		id: param.name,
		displayName: param.name,
		required: param.required || false,
		defaultMatch: param.required || false, // Auto-select required parameters
		canBeUsedToMatch: false,
		display: true,
		type: param.type as any, // Convert to FieldType
		description: param.description || `${param.type} parameter${param.required ? " (required)" : ""}`,
	}))

	// Provide helpful message when no parameters are found
	let emptyFieldsNotice: string | undefined
	if (fields.length === 0) {
		emptyFieldsNotice = `The selected function "${functionName}" doesn't require any parameters. You can call it directly without providing inputs.`
	}

	return { fields, emptyFieldsNotice }
}
