# Redis Queue Mode Architecture

## Overview

Redis queue mode enables Function nodes to work across multiple n8n worker processes in a distributed environment. Functions registered on any worker are discoverable and callable from all other workers through Redis Streams and metadata storage.

## Architecture Diagram

```mermaid
graph TB
    subgraph "Redis Server"
        subgraph "Metadata Storage"
            FM[Function Metadata<br/>function:meta:worker:name]
            FS[Function Sets<br/>function:functionName]
            GC[Global Config<br/>function:global_config]
        end
        
        subgraph "Redis Streams"
            S1[Stream: function:stream:scope:name]
            CG1[Consumer Group: group:name]
        end
        
        subgraph "Response Channels"
            RC[Response Lists<br/>function:response:callId]
        end
    end
    
    subgraph "n8n Main Process"
        subgraph "Workflow Designer"
            CF[ConfigureFunctions Node]
        end
        CF -->|Store Config| GC
    end
    
    subgraph "n8n Worker 1"
        subgraph "Workflow A"
            F1[Function: 'Process Order']
            CF1[CallFunction]
        end
        FR1[FunctionRegistry]
        F1 -->|Register| FR1
        FR1 -->|Store Metadata| FM
        FR1 -->|Add to Set| FS
        FR1 -->|Create Stream| S1
        FR1 -->|Consume| S1
    end
    
    subgraph "n8n Worker 2"
        subgraph "Workflow B"
            CF2[CallFunction: 'Process Order']
            RF2[ReturnFromFunction]
        end
        FR2[FunctionRegistry]
        CF2 -->|Discover| FR2
        FR2 -->|Check Workers| FS
        FR2 -->|Add Call| S1
        FR2 -->|Wait Response| RC
    end
    
    S1 -->|Message| FR1
    FR1 -->|Publish Response| RC
```

## Component Architecture

### 1. Bootstrap & Configuration

```mermaid
sequenceDiagram
    participant ENV as Environment
    participant B as redisBootstrap
    participant FF as FunctionRegistryFactory
    participant FR as FunctionRegistry
    participant R as Redis
    
    Note over ENV: QUEUE_BULL_REDIS_HOST=redis<br/>QUEUE_BULL_REDIS_PORT=6379
    
    ENV->>B: Read queue env vars
    B->>FF: setRedisConfig(config)
    B->>FF: setQueueMode(true)
    
    Note over FF: Auto-bootstrap on module load
    FF->>FR: getInstance()
    FR->>R: Connect with config
    R-->>FR: Connection established
```

### 2. Function Registration (Stream-Based)

```mermaid
sequenceDiagram
    participant F as Function Node
    participant FR as FunctionRegistry
    participant R as Redis
    participant S as Stream Consumer
    
    F->>FR: registerFunction(name, scope, params)
    FR->>R: XGROUP CREATE stream:key group:name
    FR->>R: HSET function:meta:worker:name
    FR->>R: SADD function:functionName workerId
    FR->>R: Start heartbeat timer
    
    FR->>S: Start consumer loop
    loop Stream Consumer
        S->>R: XREADGROUP (blocking)
        R-->>S: Messages
        S->>F: Process function call
        F->>S: Return result
        S->>R: LPUSH response:channel
        S->>R: XACK message
    end
```

### 3. Function Discovery & Call Flow

```mermaid
sequenceDiagram
    participant CF as CallFunction Node
    participant FR as FunctionRegistry
    participant R as Redis
    participant W as Worker with Function
    
    CF->>FR: callFunction(name, params)
    FR->>R: SMEMBERS function:functionName
    R-->>FR: [worker1, worker2]
    
    loop Check Workers Health
        FR->>R: HGET function:meta:worker:name lastHeartbeat
        R-->>FR: timestamp
        FR->>FR: Check if healthy (< 30s old)
    end
    
    FR->>R: XADD stream:key call data
    FR->>R: BLPOP response:channel (timeout: 15s)
    
    Note over W: Consumer processes message
    W->>R: LPUSH response:channel result
    
    R-->>FR: Response data
    FR-->>CF: Function result
```

### 4. Stream Processing Details

```mermaid
graph LR
    subgraph "Redis Streams"
        S[Stream: function:stream:scope:name]
        S --> M1[Message 1: Call Data]
        S --> M2[Message 2: Call Data]
        S --> M3[Message 3: Call Data]
    end
    
    subgraph "Consumer Group"
        CG[group:functionName]
        C1[Consumer: worker1]
        C2[Consumer: worker2]
    end
    
    M1 -->|Claimed by| C1
    M2 -->|Claimed by| C2
    M3 -->|Pending| CG
    
    subgraph "Message Structure"
        MD["{<br/>callId: 'call-123',<br/>functionName: 'Process',<br/>params: {...},<br/>inputItem: {...},<br/>responseChannel: 'function:response:call-123'<br/>}"]
    end
```

## Data Structures

### Redis Keys Structure

```
# Function Metadata (Hash)
function:meta:{workerId}:{functionName}
  - functionName: string
  - executionId: string (scope)
  - nodeId: string
  - parameters: JSON string
  - workerId: string
  - lastHeartbeat: timestamp

# Function Worker Sets (Set)
function:{functionName}
  - Contains worker IDs that have this function

# Function Streams (Stream)
function:stream:{scope}:{functionName}
  - Stream of function call requests

# Response Channels (List)
function:response:{callId}
  - Temporary list for response delivery

# Global Configuration (String)
function:global_config
  - JSON with queue mode settings
```

### Message Formats

#### Stream Message (Function Call)
```json
{
  "callId": "call-1234567890-abc123",
  "functionName": "ProcessOrder",
  "params": {
    "orderId": "12345",
    "action": "validate"
  },
  "inputItem": {
    "json": { "data": "..." },
    "binary": {}
  },
  "responseChannel": "function:response:call-1234567890-abc123",
  "timeout": "30000",
  "timestamp": "1234567890"
}
```

#### Response Message
```json
{
  "callId": "call-1234567890-abc123",
  "success": true,
  "data": {
    "processed": true,
    "result": "..."
  },
  "timestamp": 1234567890
}
```

## Worker Lifecycle

### 1. Worker Startup

```mermaid
graph TD
    A[Worker Process Start] --> B[Load n8n-nodes-function]
    B --> C[FunctionRegistryFactory Bootstrap]
    C --> D{QUEUE_BULL_REDIS_HOST exists?}
    D -->|Yes| E[Configure Redis]
    E --> F[Set Queue Mode = true]
    D -->|No| G[Skip Redis Config]
    F --> H[Worker Ready]
    G --> H
```

### 2. Function Activation

```mermaid
stateDiagram-v2
    [*] --> Inactive
    Inactive --> Registering: Workflow Activated
    Registering --> CreatingStream: Register Function
    CreatingStream --> StartingConsumer: Create Redis Stream
    StartingConsumer --> Active: Start Consumer Loop
    Active --> Heartbeating: Every 10s
    Heartbeating --> Active: Update lastHeartbeat
    Active --> Unregistering: Workflow Deactivated
    Unregistering --> CleaningUp: Stop Consumer
    CleaningUp --> Inactive: Remove from Redis
```

### 3. Health Monitoring

```mermaid
sequenceDiagram
    participant F as Function Node
    participant H as Heartbeat Timer
    participant R as Redis
    participant CF as CallFunction (Other Worker)
    
    F->>H: Start heartbeat interval
    loop Every 10 seconds
        H->>R: HSET lastHeartbeat = now()
    end
    
    CF->>R: HGET lastHeartbeat
    R-->>CF: timestamp
    CF->>CF: Check age < 30s
    alt Healthy
        CF->>CF: Include in available workers
    else Unhealthy
        CF->>CF: Exclude from available workers
    end
```

## High Availability Features

### 1. Automatic Failover
- Workers continuously heartbeat to Redis
- Unhealthy workers (>30s without heartbeat) are automatically excluded
- Function calls only routed to healthy workers

### 2. Message Reliability
- Redis Streams ensure at-least-once delivery
- Consumer groups prevent message loss
- Unacknowledged messages can be reclaimed

### 3. Retry Mechanism
```mermaid
graph TD
    A[CallFunction] --> B[Add to Stream]
    B --> C[Wait for Response]
    C --> D{Response Received?}
    D -->|Yes| E[Return Result]
    D -->|No - Timeout| F{Retry Count < 3?}
    F -->|Yes| G[Wait 2s]
    G --> B
    F -->|No| H[Return Error]
```

## Configuration

### Environment Variables (Auto-detected)
```bash
# Standard n8n queue mode variables
QUEUE_BULL_REDIS_HOST=redis
QUEUE_BULL_REDIS_PORT=6379
QUEUE_BULL_REDIS_DB=0
QUEUE_BULL_REDIS_USER=
QUEUE_BULL_REDIS_PASSWORD=
QUEUE_BULL_REDIS_SSL=false

# n8n queue mode flag
EXECUTIONS_MODE=queue
```

### ConfigureFunctions Node
- Stores global configuration in Redis
- Allows runtime Redis configuration changes
- Settings persist across all workers

## Performance Characteristics

### Latency
- **Function Discovery**: ~1-5ms (Redis SMEMBERS)
- **Stream Write**: ~1-2ms (XADD)
- **Response Wait**: ~5-20ms (includes processing)
- **Total Call Overhead**: ~10-30ms

### Throughput
- **Concurrent Functions**: Unlimited (Redis memory bound)
- **Calls/Second**: ~1000-5000 per function (depends on Redis)
- **Workers/Function**: Recommended 2-10 for redundancy

### Resource Usage
- **Redis Memory**: ~1KB per function registration
- **Stream Memory**: ~500 bytes per pending call
- **Network**: Minimal (binary protocol)

## Monitoring & Debugging

### Key Metrics to Monitor
```redis
# Active functions
KEYS function:meta:*

# Function workers
SMEMBERS function:{functionName}

# Pending messages
XPENDING function:stream:{scope}:{functionName} {groupName}

# Stream length
XLEN function:stream:{scope}:{functionName}
```

### Debug Logging
```bash
# Enable debug logs
export NODE_ENV=development
export N8N_LOG_LEVEL=debug

# Key log prefixes
🚀 Bootstrap operations
🎯 FunctionRegistry operations
🌊 Stream operations
🔧 CallFunction operations
⚙️ ConfigureFunctions operations
```

### Common Issues & Solutions

1. **"Function not found"**
   - Check worker health: `HGET function:meta:worker:name lastHeartbeat`
   - Verify function registered: `KEYS function:meta:*:functionName`
   - Check Redis connectivity

2. **Slow Function Calls**
   - Monitor stream length: `XLEN`
   - Check pending messages: `XPENDING`
   - Verify worker count is sufficient

3. **Workers Not Discovering Functions**
   - Ensure all workers use same Redis
   - Check `QUEUE_BULL_REDIS_*` variables
   - Verify bootstrap logs show Redis config

## Best Practices

### 1. Function Design
- Keep functions stateless
- Use unique, descriptive names
- Implement proper error handling
- Return serializable data only

### 2. Scaling
- Run 2-3 workers per critical function
- Monitor stream lengths
- Implement stream trimming for high-volume functions
- Use function scope to limit discovery overhead

### 3. Redis Configuration
```redis
# Recommended Redis settings
maxmemory-policy allkeys-lru
timeout 0
tcp-keepalive 60
```

### 4. Production Deployment
- Use Redis persistence (RDB/AOF)
- Configure Redis replication
- Monitor Redis memory usage
- Implement alerting for worker health

## Security Considerations

1. **Network Security**
   - Use Redis AUTH (password)
   - Enable SSL/TLS for Redis connections
   - Restrict Redis network access

2. **Data Security**
   - Avoid sensitive data in function parameters
   - Implement parameter validation
   - Use short TTLs for response channels

3. **Resource Limits**
   - Set max stream length
   - Implement function call rate limiting
   - Monitor for infinite loops

## Migration Guide

### From In-Memory to Queue Mode
1. Set `EXECUTIONS_MODE=queue`
2. Configure `QUEUE_BULL_REDIS_*` variables
3. Deploy ConfigureFunctions node
4. Restart all n8n instances
5. Functions automatically use Redis

### Rollback to In-Memory
1. Set `EXECUTIONS_MODE=regular`
2. Remove Redis environment variables
3. Restart n8n
4. Functions revert to in-memory mode