import { Icon, ICredentialType, INodeProperties } from "n8n-workflow"

export const FUNCTIONS_REDIS_INFO = {
	credentialsName: "functionsRedis",
}

// eslint-disable-next-line n8n-nodes-base/cred-class-name-unsuffixed
export class FunctionsRedisCredentials implements ICredentialType {
	name = FUNCTIONS_REDIS_INFO.credentialsName
	// eslint-disable-next-line n8n-nodes-base/cred-class-field-display-name-missing-api
	displayName = "Functions Redis"
	description = "Redis connection for n8n Functions"
	icon: Icon = "fa:database"

	properties: INodeProperties[] = [
		{
			type: "notice",
			displayName: "Use this credential to connect Functions to Redis for queue mode or cross-workflow sharing",
			name: "notice",
			default: "",
		},
		{
			displayName: "Host",
			name: "host",
			type: "string",
			default: "redis",
			description: "Redis server hostname or IP address",
			required: true,
		},
		{
			displayName: "Port",
			name: "port",
			type: "number",
			default: 6379,
			description: "Redis server port",
			required: true,
		},
		{
			displayName: "Database Number",
			name: "database",
			type: "number",
			default: 0,
			description: "Redis database number to use",
		},
		{
			displayName: "User",
			name: "user",
			type: "string",
			default: "",
			description: "Redis username (leave blank for password-only auth)",
		},
		{
			displayName: "Password",
			name: "password",
			type: "string",
			typeOptions: {
				password: true,
			},
			default: "",
			description: "Redis password (leave blank if no authentication required)",
		},
		{
			displayName: "SSL",
			name: "ssl",
			type: "boolean",
			default: false,
			description: "Whether to use SSL/TLS connection",
		},
	]
}

export interface FunctionsRedisCredentialsData {
	host: string
	port: number
	database: number
	user: string
	password: string
	ssl: boolean
}
