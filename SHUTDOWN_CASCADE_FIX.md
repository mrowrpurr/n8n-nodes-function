# Shutdown Cascade Fix Implementation

## Problem Summary
Workers are creating a cascade of shutdowns because new workers receive and act on shutdown messages intended for previous workers, causing rapid restart loops.

## Root Cause
1. Worker A publishes shutdown message and exits
2. Worker B starts and subscribes to shutdown channel
3. Worker B receives Worker A's shutdown message (still in Redis pub/sub buffer)
4. Worker B treats it as "I must stop" and publishes its own shutdown
5. Worker C starts, receives Worker B's message, repeats cycle

## Solution: Hash-Based Sequence Deduplication

### Redis Schema
```
n8n:shutdown:sequences → HASH {
  "{workflowId}:{functionName}": "42",
  "{workflowId2}:{functionName2}": "17"
}

n8n:shutdown:lastHandled → HASH {
  "{workerId1}": "42", 
  "{workerId2}": "17"
}
```

### Implementation Tasks

#### Phase 1: Enhanced Shutdown Payload
- [x] **1.1** Modify NotificationManager.publishShutdown() to include:
  - originWorkerId (UUID of publisher)
  - shutdownSeq (monotonic sequence from Redis hash)
  - timestamp (for debugging)
- [x] **1.2** Update WorkerCoordinator to manage sequence increments via HINCRBY
- [x] **1.3** Test: Shutdown messages contain all required fields

#### Phase 2: Deduplication Logic
- [x] **2.1** Add sequence checking in ConsumerLifecycleManager shutdown handler
- [x] **2.2** Implement originWorkerId self-filtering (ignore own messages)
- [x] **2.3** Implement sequence-based deduplication using Redis hash
- [x] **2.4** Add logging for discarded duplicate messages
- [x] **2.5** Test: Duplicate messages are properly ignored

#### Phase 3: Proper Unsubscribe Ordering
- [x] **3.1** Move unsubscribe BEFORE publish in ConsumerLifecycleManager.stop()
- [x] **3.2** Add try/finally to ensure unsubscribe always happens
- [x] **3.3** Add setImmediate drain after unsubscribe
- [x] **3.4** Test: No listener overlap during restart

#### Phase 4: Belt-and-Suspenders Guards
- [x] **4.1** Add minimum lifetime check (refuse shutdown if uptime < 1000ms)
- [ ] **4.2** Add debounce check (refuse if last shutdown < 1000ms ago)
- [x] **4.3** Test: Guards prevent rapid restart loops

#### Phase 5: Integration Testing
- [ ] **5.1** Test: 20 rapid workflow saves in 2 seconds
- [ ] **5.2** Verify: Exactly one shutdown per save
- [ ] **5.3** Verify: Zero lost function calls
- [x] **5.4** Verify: pnpm build passes

### Files to Modify
- `nodes/NotificationManager.ts` - Enhanced publishShutdown payload
- `nodes/WorkerCoordinator.ts` - Sequence management
- `nodes/ConsumerLifecycleManager.ts` - Deduplication logic
- `nodes/Function/Function.node.ts` - Unsubscribe ordering + guards

### Success Criteria
- No shutdown cascades in logs
- Exactly one effective shutdown per workflow save
- Zero function call message loss
- Clean pnpm build
- 99% idle traffic reduction maintained
- 0ms save latency maintained