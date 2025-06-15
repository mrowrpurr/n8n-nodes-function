# Configure Functions Guide

This guide explains how to use the new **Functions Redis Credentials** and **Configure Functions** node to set up Redis-backed function sharing in n8n.

## Overview

The Function system now supports two modes:
- **In-Memory Mode**: Functions are stored locally in each n8n process (default)
- **Redis Mode**: Functions are stored in Redis and can be shared across multiple n8n processes (queue mode)

## Setup

### 1. Create Redis Credentials (Optional)

1. Go to **Settings** → **Credentials** in n8n
2. Click **Add Credential**
3. Search for "Functions Redis" and select it
4. Fill in your Redis connection details:
   - **Host**: Redis server hostname (default: `redis`)
   - **Port**: Redis server port (default: `6379`)
   - **Database Number**: Redis database to use (default: `0`)
   - **User**: Redis username (optional)
   - **Password**: Redis password (optional)
   - **SSL**: Enable SSL/TLS connection (default: `false`)
5. Save the credential

### 2. Add Configure Functions Node

1. Create a new workflow or edit an existing one
2. Add the **Configure Functions** node (found in the Trigger category)
3. Configure the node:
   - **Use Redis**: Enable to use Redis mode, disable for in-memory mode
   - **Test Connection**: Enable to test Redis connection when workflow activates
4. If using Redis mode, select your Redis credential (or leave blank to use defaults)
5. Save and activate the workflow

## How It Works

### In-Memory Mode (Default)
- Functions are stored locally in each n8n process
- Functions can only be called within the same workflow execution
- No Redis connection required
- Fastest performance for single-process setups

### Redis Mode
- Functions are stored in Redis using streams and metadata
- Functions can be called across different workflows and n8n processes
- Supports n8n queue mode with multiple workers
- Enables cross-workflow function sharing
- Requires Redis server

### Configuration Process

When the Configure Functions node activates:

1. **Redis Mode**: 
   - Configures the global FunctionRegistry to use Redis
   - Sets up Redis connection with provided credentials
   - Optionally tests the connection
   - Emits configuration status

2. **In-Memory Mode**:
   - Uses default in-memory function storage
   - No Redis connection required
   - Emits configuration status

## Usage Examples

### Basic Redis Setup
```
[Configure Functions] → [Function] → [CallFunction]
```

1. Configure Functions: Use Redis = true, select Redis credential
2. Function: Define your function (will be stored in Redis)
3. CallFunction: Call the function (can be in same or different workflow)

### Multi-Workflow Setup
```
Workflow A: [Configure Functions] → [Function]
Workflow B: [Configure Functions] → [CallFunction]
```

Both workflows need Configure Functions nodes with the same Redis settings.

## Troubleshooting

### Connection Issues
- Verify Redis server is running and accessible
- Check Redis credentials (host, port, password)
- Enable "Test Connection" to verify setup
- Check n8n logs for Redis connection errors

### Function Not Found
- Ensure Configure Functions node is activated in both workflows
- Verify Redis configuration is identical across workflows
- Check that Function node has been executed before CallFunction

### Performance Issues
- Redis mode has slightly higher latency than in-memory mode
- Consider Redis server location and network latency
- Monitor Redis server performance and memory usage

## Advanced Configuration

### Redis Connection Settings
The Redis client uses these optimized settings:
- **Connect Timeout**: 100ms
- **Command Timeout**: 100ms
- **Reconnect Strategy**: Exponential backoff (50ms to 500ms)

### Function Storage
- **Metadata**: Stored as Redis hashes with 1-hour expiry
- **Function Calls**: Use Redis streams for reliable delivery
- **Responses**: Use Redis lists with 1-minute expiry
- **Heartbeats**: Worker health checks every 10 seconds

## Migration

### From In-Memory to Redis
1. Add Configure Functions node to existing workflows
2. Set Use Redis = true and configure credentials
3. Activate workflows - existing functions will be re-registered in Redis

### From Redis to In-Memory
1. Update Configure Functions nodes: Use Redis = false
2. Activate workflows - functions will use in-memory storage
3. Redis data will expire automatically

## Best Practices

1. **Use one Configure Functions node per workflow** that uses Function/CallFunction nodes
2. **Keep Redis credentials consistent** across all workflows
3. **Monitor Redis memory usage** in production environments
4. **Use Redis mode for queue mode** and cross-workflow sharing
5. **Use in-memory mode for single-process** setups for best performance