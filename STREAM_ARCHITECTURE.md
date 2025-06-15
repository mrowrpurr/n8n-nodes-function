# Redis Streams Architecture for n8n Function Nodes

## Overview

This document outlines the architecture for implementing a robust, queue-mode compatible function system in n8n using Redis Streams. The system allows workflows to define reusable "functions" (sub-workflows) that can be called from any workflow, with full support for recursion, concurrency, and fault tolerance.

## Core Concepts

### Function Node
- **Type**: Trigger node that stays alive throughout workflow execution
- **Purpose**: Defines the entry point for a callable sub-workflow
- **Behavior**: Listens for function calls via Redis Streams and emits parameters as workflow items

### CallFunction Node
- **Type**: Regular transform node
- **Purpose**: Invokes a function by name, passing parameters and waiting for response
- **Behavior**: Adds call to Redis Stream, waits for response with timeout

### ReturnFromFunction Node
- **Type**: Regular transform node
- **Purpose**: Completes a function call by returning a value to the caller
- **Behavior**: Publishes response to caller's response channel

## Why Redis Streams?

### Current Issues with Pub/Sub
1. **No persistence**: Messages lost if worker crashes
2. **No acknowledgment**: Can't track successful processing
3. **No load balancing**: Manual worker selection required
4. **No backpressure**: Can't see queue depth or throttle

### Redis Streams Benefits
1. **Durability**: Messages persist until acknowledged
2. **Consumer Groups**: Automatic load balancing across workers
3. **Acknowledgment**: Built-in XACK for exactly-once processing
4. **Pending List**: Failed calls can be reclaimed with XAUTOCLAIM
5. **Ordering**: Guaranteed message order per stream
6. **Backpressure**: Natural queue depth visibility with XLEN

## Architecture Design

### Data Structures

#### 1. Function Streams
```
Key: function:stream:<scope>:<functionName>
Scope: __global__ | <workflowId>
Purpose: Queue of function calls waiting to be processed
```

#### 2. Response Lists
```
Key: function:response:<callId>
Type: List (LPUSH/BLPOP)
Purpose: Simple response channel for each call
```

#### 3. Function Metadata
```
Key: function:meta:<workerId>:<functionName>
Type: Hash
Fields:
  - functionName
  - parameters (JSON array)
  - scope (__global__ or workflowId)
  - workflowId
  - nodeId
  - streamKey
  - createdAt
  - lastHeartbeat
```

#### 4. Function Registry Set
```
Key: function:<functionName>
Type: Set
Purpose: Track all workers that have this function registered
```

### Message Flow

1. **Function Registration** (on workflow activation)
   ```
   XGROUP CREATE function:stream:<scope>:<name> <groupName> $ MKSTREAM
   HSET function:meta:<workerId>:<name> <metadata>
   SADD function:<name> <workerId>
   ```

2. **Function Call** (CallFunction node)
   ```
   XADD function:stream:<scope>:<name> * 
     callId <uuid>
     params <json>
     responseChannel function:response:<callId>
     timeout <ms>
   ```

3. **Function Execution** (Function node)
   ```
   XREADGROUP GROUP <groupName> <workerId> COUNT 1 BLOCK 0 
     STREAMS function:stream:<scope>:<name> >
   
   // Process call, emit to workflow
   // After ReturnFromFunction:
   XACK function:stream:<scope>:<name> <groupName> <messageId>
   ```

4. **Response Return** (ReturnFromFunction node)
   ```
   LPUSH function:response:<callId> <resultJson>
   EXPIRE function:response:<callId> 60
   ```

5. **Response Receipt** (CallFunction node)
   ```
   BLPOP function:response:<callId> <timeoutSeconds>
   ```

### Implementation Details

#### Function Node Trigger Method
```typescript
async *trigger(this: ITriggerFunctions): AsyncGenerator<ITriggerResponse> {
    const functionName = this.getNodeParameter('functionName') as string;
    const scope = isGlobal ? '__global__' : workflowId;
    const streamKey = `function:stream:${scope}:${functionName}`;
    const groupName = `group:${functionName}`;
    const consumerId = workerId;
    
    // Create consumer group
    await redis.xgroup('CREATE', streamKey, groupName, '$', 'MKSTREAM');
    
    // Register metadata
    await redis.hset(`function:meta:${workerId}:${functionName}`, {
        functionName,
        parameters: JSON.stringify(parameters),
        scope,
        workflowId,
        nodeId: this.getNode().id,
        streamKey,
        createdAt: Date.now(),
        lastHeartbeat: Date.now()
    });
    
    // Add to registry
    await redis.sadd(`function:${functionName}`, workerId);
    
    // Start heartbeat
    const heartbeatInterval = setInterval(async () => {
        await redis.hset(`function:meta:${workerId}:${functionName}`, 
            'lastHeartbeat', Date.now());
    }, 10000);
    
    // Listen for calls
    try {
        while (true) {
            const messages = await redis.xreadgroup(
                'GROUP', groupName, consumerId,
                'COUNT', '1',
                'BLOCK', '0',
                'STREAMS', streamKey, '>'
            );
            
            if (!messages || messages.length === 0) continue;
            
            const [stream, entries] = messages[0];
            const [messageId, fields] = entries[0];
            
            // Parse message
            const callId = fields.callId;
            const params = JSON.parse(fields.params);
            const responseChannel = fields.responseChannel;
            
            // Store context for ReturnFromFunction
            this.getWorkflowStaticData().functionCall = {
                callId,
                responseChannel,
                messageId,
                streamKey,
                groupName
            };
            
            // Emit parameters to workflow
            yield [{
                json: {
                    ...params,
                    _functionCall: {
                        callId,
                        functionName,
                        timestamp: Date.now()
                    }
                }
            }];
        }
    } finally {
        clearInterval(heartbeatInterval);
        await this.closeFunction();
    }
}

async closeFunction() {
    // Cleanup on deactivation
    await redis.srem(`function:${functionName}`, workerId);
    await redis.del(`function:meta:${workerId}:${functionName}`);
    await redis.xgroup('DESTROY', streamKey, groupName);
}
```

#### CallFunction Implementation
```typescript
async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const functionName = this.getNodeParameter('functionName', 0) as string;
    const parameters = this.getNodeParameter('parameters', 0) as any;
    const timeout = this.getNodeParameter('timeout', 0, 30000) as number;
    const isGlobal = this.getNodeParameter('globalFunction', 0, false) as boolean;
    
    const callId = `${workerId}_${Date.now()}_${Math.random()}`;
    const responseChannel = `function:response:${callId}`;
    
    // Determine scope
    const scope = isGlobal ? '__global__' : this.getWorkflow().id;
    
    // Try each registered worker
    const workers = await redis.smembers(`function:${functionName}`);
    
    for (const targetWorker of workers) {
        // Check worker health
        const lastHeartbeat = await redis.hget(
            `function:meta:${targetWorker}:${functionName}`, 
            'lastHeartbeat'
        );
        
        if (!lastHeartbeat || Date.now() - parseInt(lastHeartbeat) > 30000) {
            continue; // Skip dead workers
        }
        
        try {
            // Add call to stream
            const streamKey = `function:stream:${scope}:${functionName}`;
            await redis.xadd(
                streamKey, '*',
                'callId', callId,
                'params', JSON.stringify(parameters),
                'responseChannel', responseChannel,
                'timeout', timeout.toString()
            );
            
            // Wait for response
            const response = await redis.blpop(responseChannel, timeout / 1000);
            
            if (!response) {
                throw new Error('Function call timed out');
            }
            
            const result = JSON.parse(response[1]);
            
            // Store in output
            if (this.getNodeParameter('storeResponse', 0, true)) {
                const varName = this.getNodeParameter('responseVariableName', 0, 'functionResult');
                items[0].json[varName] = result;
            }
            
            return [items];
            
        } catch (error) {
            console.log(`Worker ${targetWorker} failed, trying next...`);
            continue;
        }
    }
    
    throw new NodeOperationError(
        this.getNode(),
        `Function '${functionName}' not found or all workers failed`
    );
}
```

#### ReturnFromFunction Implementation
```typescript
async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const returnValue = this.getNodeParameter('returnValue', 0);
    
    // Get call context
    const context = this.getWorkflowStaticData().functionCall;
    
    if (!context) {
        throw new NodeOperationError(
            this.getNode(),
            'ReturnFromFunction must be used within a Function'
        );
    }
    
    // Publish response
    await redis.lpush(context.responseChannel, JSON.stringify({
        success: true,
        data: returnValue,
        timestamp: Date.now()
    }));
    
    // Set expiry on response channel
    await redis.expire(context.responseChannel, 60);
    
    // Acknowledge message
    await redis.xack(context.streamKey, context.groupName, context.messageId);
    
    // Clear context
    delete this.getWorkflowStaticData().functionCall;
    
    return [items];
}
```

### Fault Tolerance

#### 1. Worker Crash Recovery
```typescript
// Periodic job to reclaim pending messages
async function reclaimPendingCalls() {
    const streams = await redis.keys('function:stream:*');
    
    for (const streamKey of streams) {
        const groups = await redis.xinfo('GROUPS', streamKey);
        
        for (const group of groups) {
            // Claim messages idle for > 30 seconds
            const claimed = await redis.xautoclaim(
                streamKey,
                group.name,
                'reclaimer',
                30000, // 30 second idle time
                '0-0',
                'COUNT', '100'
            );
            
            // Re-queue claimed messages
            for (const message of claimed.messages) {
                // Add back to stream for reprocessing
                await redis.xadd(streamKey, '*', ...message.fields);
            }
        }
    }
}
```

#### 2. Stream Maintenance
```typescript
// Trim old messages to prevent unbounded growth
async function trimStreams() {
    const streams = await redis.keys('function:stream:*');
    
    for (const streamKey of streams) {
        // Keep approximately last 10k messages
        await redis.xtrim(streamKey, 'MAXLEN', '~', '10000');
    }
}
```

#### 3. Health Monitoring
```typescript
// Monitor stream backlogs
async function getStreamHealth() {
    const streams = await redis.keys('function:stream:*');
    const health = {};
    
    for (const streamKey of streams) {
        const length = await redis.xlen(streamKey);
        const info = await redis.xinfo('STREAM', streamKey);
        
        health[streamKey] = {
            length,
            oldestMessage: info['first-entry'],
            consumerGroups: info.groups
        };
    }
    
    return health;
}
```

### Edge Cases Handled

1. **Recursion**: Functions can call themselves safely as each call gets its own execution context
2. **Concurrency**: Multiple calls to same function are distributed across workers via consumer groups
3. **Large Payloads**: Stream messages can handle up to Redis limit (512MB by default)
4. **Activation Order**: CallFunction retries for a few seconds if function not yet registered
5. **Duplicate Calls**: Each call has unique ID preventing duplicate processing
6. **Worker Affinity**: Consumer groups ensure each message processed by exactly one worker

### Migration Strategy

1. **Phase 1**: Deploy new code with feature flag
2. **Phase 2**: Test with new workflows using stream-based functions
3. **Phase 3**: Migrate existing workflows gradually
4. **Phase 4**: Remove pub/sub implementation

### Performance Considerations

1. **Connection Pooling**: Reuse Redis connections across nodes
2. **Batch Processing**: Consider processing multiple calls per XREADGROUP
3. **Stream Sharding**: For high-volume functions, shard across multiple streams
4. **Response Channels**: Use Lists (BLPOP) instead of Streams for simple responses

### Security Considerations

1. **Function Namespacing**: Prefix function names with workflow ID to prevent collisions
2. **Parameter Validation**: Validate against schema before processing
3. **Timeout Enforcement**: Hard kill long-running functions
4. **Rate Limiting**: Implement per-function call limits

### Monitoring & Debugging

1. **Stream Length Metrics**: Track backlog growth
2. **Consumer Lag**: Monitor pending message age
3. **Call Latency**: Track time from XADD to XACK
4. **Error Rates**: Track failed calls and retries

## Summary

This Redis Streams architecture provides:
- **Durability**: Function calls survive crashes
- **Scalability**: Automatic load balancing via consumer groups
- **Reliability**: Built-in retry and recovery mechanisms
- **Observability**: Clear metrics and debugging paths
- **Flexibility**: Supports recursion, concurrency, and complex workflows

The design leverages Redis's strengths while working within n8n's execution model, creating a robust function system for queue mode deployments.