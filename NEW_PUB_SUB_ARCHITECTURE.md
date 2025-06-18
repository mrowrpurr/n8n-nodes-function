# Efficient Redis Streams + Pub/Sub Architecture

## The Problem We're Solving

### Current Issue: Aggressive Polling
- **Every Function node** polls Redis streams every 100ms when idle
- **1,000 Function nodes** = 10,000 Redis operations/second when idle
- **Scaling bottleneck:** System becomes unusable at 500+ Function nodes
- **Resource waste:** 99.9% of polls return empty when system is idle

### User Requirements
- **Instant responsiveness:** Function calls must process in <100ms
- **Frequent saves:** Users save workflows 10+ times per minute
- **Reliable delivery:** Function calls must never be lost
- **Scalability:** Must support 1,000+ Function nodes

## The Solution: Hybrid Streams + Pub/Sub

### Architecture Overview
```
CallFunction Node                Function Node
     │                               │
     ├─── XADD ────────► Redis ◄──── XREADGROUP (30s block)
     │                 Streams       │
     └─── PUBLISH ──► Redis Pub/Sub ─┴─ INSTANT WAKE-UP
                                     
Workflow Save ──► Shutdown Pub/Sub ──► INSTANT RESTART
```

### Key Components

#### 1. **Redis Streams (Reliability Layer)**
- **Purpose:** Guaranteed message delivery, exactly-once processing
- **Usage:** Same as current - XADD, XREADGROUP, XACK
- **Change:** Increase `BLOCK_TIME` from 100ms to 30 seconds
- **Result:** 99.7% reduction in idle Redis traffic

#### 2. **Pub/Sub (Efficiency Layer)**
- **Purpose:** Instant wake-up notifications
- **Channels:**
  - `n8n-nodes-function:wake:${functionName}:${workflowId}` - Function call notifications
  - `n8n-nodes-function:shutdown:${functionName}:${workflowId}` - Restart notifications

#### 3. **Dual Listening Pattern**
```typescript
await Promise.race([
    client.xReadGroup(..., { BLOCK: 30000 }), // Long efficient blocks
    pubSubWakeUpPromise                        // Instant notifications
])
```

## Implementation Tasks

### Phase 1: Add Wake-Up Notifications ⭐ HIGH IMPACT
- [ ] **1.1** Add wake-up pub/sub to CallFunction execution path
- [ ] **1.2** Add wake-up listener to Function node consumer loop  
- [ ] **1.3** Test: Function calls still process instantly
- [ ] **1.4** Increase BLOCK_TIME to 30 seconds
- [ ] **1.5** Verify: 99.7% reduction in idle Redis traffic

### Phase 2: Add Shutdown Notifications ⭐ HIGH IMPACT  
- [ ] **2.1** Add shutdown pub/sub to Function node restart sequence
- [ ] **2.2** Add shutdown listener to Function node consumer loop
- [ ] **2.3** Test: Workflow saves restart Function nodes instantly
- [ ] **2.4** Test: Frequent saves (10/minute) work perfectly

### Phase 3: Optimization & Monitoring 🔧 NICE TO HAVE
- [ ] **3.1** Add Redis traffic monitoring/metrics
- [ ] **3.2** Add pub/sub delivery metrics  
- [ ] **3.3** Consider progressive backoff (100ms → 30s when idle)
- [ ] **3.4** Add Redis connection health monitoring

## Technical Implementation Details

### File Changes Required

#### **ConsumerLifecycleManager.ts**
```typescript
// Current
const result = await this.client.xReadGroup(..., { BLOCK: 100 })

// New  
const result = await Promise.race([
    this.client.xReadGroup(..., { BLOCK: 30000 }),
    this.waitForWakeUpNotification()
])
```

#### **CallFunction/CallFunction.node.ts**
```typescript
// Add after XADD
await client.xAdd(streamKey, "*", messageData)

// NEW: Add wake-up notification
await this.notificationManager.publishWakeUp(functionName, workflowId)
```

#### **Function/Function.node.ts**
```typescript
// Add to shutdown sequence
await this.notificationManager.publishShutdown(functionName, workflowId)
```

### New Notification Types

#### **Wake-Up Notifications**
- **Trigger:** CallFunction adds message to stream
- **Channel:** `n8n-nodes-function:wake:${functionName}:${workflowId}`
- **Payload:** `{ type: "function_call", timestamp: Date.now() }`
- **Result:** Function node wakes up instantly to process

#### **Shutdown Notifications**  
- **Trigger:** Workflow save, Function node restart
- **Channel:** `n8n-nodes-function:shutdown:${functionName}:${workflowId}`
- **Payload:** `{ type: "restart_required", timestamp: Date.now() }`
- **Result:** Function node shuts down instantly

## Performance Improvements

### Before (Current State)
```
Scenario: 1,000 Function nodes, system idle
Redis Traffic: 10,000 operations/second
CPU Usage: Constant Redis processing
Network: Constant Redis protocol traffic
Scaling Limit: ~500 Function nodes before bottleneck
```

### After (New Architecture)
```
Scenario: 1,000 Function nodes, system idle  
Redis Traffic: ~33 operations/second (99.7% reduction)
CPU Usage: Minimal Redis processing
Network: Minimal Redis protocol traffic
Scaling Limit: 10,000+ Function nodes easily supported
```

### User Experience
- **Function call latency:** 0ms (same as current, instant pub/sub)
- **Workflow save latency:** 0ms (same as current, instant pub/sub)
- **Reliability:** 100% (same as current, streams guarantee delivery)

## Risk Mitigation

### Reliability Safeguards
1. **Stream persistence:** Messages never lost even if pub/sub fails
2. **Fallback polling:** 30-second polling ensures eventual processing
3. **Graceful degradation:** System works even if pub/sub completely fails
4. **Existing infrastructure:** All current stream logic remains unchanged

### Rollback Plan
- Change `BLOCK_TIME` back to 100ms
- Disable pub/sub notifications  
- System reverts to current behavior

## Success Metrics

### Primary Goals
- [ ] **99%+ reduction** in idle Redis traffic
- [ ] **0ms function call latency** (maintained)
- [ ] **0ms workflow save latency** (maintained)
- [ ] **Support 1,000+ Function nodes** without performance degradation

### Monitoring Points
- Redis operations per second (should drop 99%+ when idle)
- Function call response times (should remain <100ms)
- Workflow save response times (should remain <100ms)
- Memory usage (should remain stable)
- Connection count (should remain stable)

## Future Enhancements

### Progressive Backoff (Optional)
- Start with 100ms blocks for instant responsiveness
- Increase to 30s blocks after period of inactivity
- Best of both worlds: instant + efficient

### Pub/Sub Clustering (Optional)
- Redis Cluster support for pub/sub
- Horizontal scaling of notification system
- Multi-region support

---

## Implementation Priority

**Phase 1** gives us 99.7% efficiency improvement with minimal risk.
**Phase 2** completes the user experience optimization.
**Phase 3** adds monitoring and fine-tuning.

This architecture scales n8n Function nodes from hundreds to thousands while maintaining perfect user experience and 100% reliability.