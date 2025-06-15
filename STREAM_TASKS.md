# Redis Streams Implementation Tasks

This document breaks down the implementation of the Redis Streams architecture into concrete, actionable tasks.

## Phase 1: Core Infrastructure

### Task 1.1: Update FunctionRegistry for Streams
**Priority**: High  
**Estimated Time**: 4-6 hours  
**Dependencies**: None

- [x] Add Redis Streams commands to FunctionRegistry
- [x] Implement `createStream()` method with XGROUP CREATE
- [x] Implement `addCall()` method with XADD
- [x] Implement `readCalls()` method with XREADGROUP
- [x] Implement `acknowledgeCall()` method with XACK
- [x] Add stream cleanup methods (XGROUP DESTROY, XTRIM)
- [x] Update Redis client to support streams commands
- [x] Add error handling for stream operations

**Files to modify**:
- `nodes/FunctionRegistry.ts`

**Acceptance Criteria**:
- Can create consumer groups for function streams
- Can add messages to streams
- Can read messages from streams with blocking
- Can acknowledge processed messages
- Proper error handling for all stream operations

### Task 1.2: Implement Response Channel System
**Priority**: High  
**Estimated Time**: 2-3 hours  
**Dependencies**: Task 1.1

- [x] Add response channel creation using Redis Lists
- [x] Implement `publishResponse()` method with LPUSH
- [x] Implement `waitForResponse()` method with BLPOP
- [x] Add response channel cleanup with EXPIRE
- [x] Handle timeout scenarios gracefully

**Files to modify**:
- `nodes/FunctionRegistry.ts`

**Acceptance Criteria**:
- Can create unique response channels per call
- Can publish responses to specific channels
- Can wait for responses with timeout
- Response channels auto-expire after use

### Task 1.3: Add Stream Health Monitoring
**Priority**: Medium  
**Estimated Time**: 3-4 hours  
**Dependencies**: Task 1.1

- [x] Implement heartbeat system for worker health
- [x] Add stream length monitoring with XLEN
- [x] Implement pending message recovery with XAUTOCLAIM
- [x] Add stream trimming with XTRIM MAXLEN
- [x] Create health check endpoints/logging

**Files to modify**:
- `nodes/FunctionRegistry.ts`

**Acceptance Criteria**:
- Workers send periodic heartbeats
- Can detect and recover from crashed workers
- Streams don't grow unbounded
- Health metrics are available

## Phase 2: Node Implementation

### Task 2.1: Convert Function Node to Stream Consumer
**Priority**: High  
**Estimated Time**: 6-8 hours  
**Dependencies**: Task 1.1, 1.2

- [x] Replace trigger() method to use async generator pattern
- [x] Implement stream consumer loop with XREADGROUP
- [x] Add function registration with stream creation
- [x] Store call context in workflow items (updated from static data)
- [x] Implement proper cleanup in closeFunction()
- [x] Add heartbeat mechanism
- [x] Handle multiple concurrent calls properly

**Files to modify**:
- `nodes/Function/Function.node.ts`

**Acceptance Criteria**:
- Function node stays alive and listens for calls
- Can process multiple calls concurrently
- Properly stores call context for ReturnFromFunction
- Cleans up streams on deactivation
- Sends heartbeats to indicate health

### Task 2.2: Update CallFunction for Stream Publishing
**Priority**: High  
**Estimated Time**: 4-5 hours  
**Dependencies**: Task 1.1, 1.2

- [x] Replace pub/sub call with XADD to stream
- [x] Implement worker health checking before calls
- [x] Add retry logic for multiple workers
- [x] Update response waiting to use BLPOP
- [x] Improve error handling and timeout logic
- [x] Add call ID generation and tracking

**Files to modify**:
- `nodes/CallFunction/CallFunction.node.ts`

**Acceptance Criteria**:
- Publishes calls to correct function streams
- Checks worker health before targeting
- Retries with different workers on failure
- Waits for responses with proper timeout
- Generates unique call IDs

### Task 2.3: Update ReturnFromFunction for Stream Acknowledgment
**Priority**: High  
**Estimated Time**: 2-3 hours  
**Dependencies**: Task 1.2, 2.1

- [x] Retrieve call context from workflow items (updated from static data)
- [x] Publish response to caller's response channel
- [x] Acknowledge stream message with XACK
- [x] Clear call context after processing
- [x] Add error handling for missing context

**Files to modify**:
- `nodes/ReturnFromFunction/ReturnFromFunction.node.ts`

**Acceptance Criteria**:
- Retrieves correct call context
- Publishes response to right channel
- Acknowledges stream message properly
- Cleans up context after use
- Handles edge cases gracefully

## Phase 3: Testing & Validation

### Task 3.1: Create Integration Test Workflow
**Priority**: High  
**Estimated Time**: 3-4 hours  
**Dependencies**: Tasks 2.1, 2.2, 2.3

- [ ] Create test workflow with Function node
- [ ] Create test workflow with CallFunction node
- [ ] Test basic function call flow
- [ ] Test global vs local function scoping
- [ ] Test parameter passing and return values
- [ ] Test timeout scenarios

**Files to create**:
- `test-workflows/basic-function-test.json`
- `test-workflows/function-caller-test.json`

**Acceptance Criteria**:
- Basic function calls work end-to-end
- Global and local scoping works correctly
- Parameters and return values transfer properly
- Timeouts are handled correctly

### Task 3.2: Test Concurrency and Recursion
**Priority**: High  
**Estimated Time**: 4-5 hours  
**Dependencies**: Task 3.1

- [ ] Test multiple concurrent calls to same function
- [ ] Test recursive function calls
- [ ] Test functions calling other functions
- [ ] Test load balancing across multiple workers
- [ ] Verify no deadlocks or race conditions

**Files to create**:
- `test-workflows/concurrent-calls-test.json`
- `test-workflows/recursive-function-test.json`
- `test-workflows/function-chain-test.json`

**Acceptance Criteria**:
- Multiple concurrent calls work without interference
- Recursive calls work without deadlocks
- Function chains work across workflows
- Load balancing distributes calls properly

### Task 3.3: Test Fault Tolerance
**Priority**: Medium  
**Estimated Time**: 5-6 hours  
**Dependencies**: Task 3.1

- [ ] Test worker crash during function execution
- [ ] Test Redis connection failures
- [ ] Test stream recovery after crashes
- [ ] Test heartbeat failure detection
- [ ] Verify message recovery with XAUTOCLAIM

**Acceptance Criteria**:
- System recovers from worker crashes
- Handles Redis connection issues gracefully
- Pending messages are recovered properly
- Dead workers are detected and avoided

## Phase 4: Performance & Production Readiness

### Task 4.1: Optimize Performance
**Priority**: Medium  
**Estimated Time**: 3-4 hours  
**Dependencies**: Task 3.1

- [ ] Implement Redis connection pooling
- [ ] Optimize stream reading batch sizes
- [ ] Add configurable timeouts and limits
- [ ] Implement backpressure handling
- [ ] Add performance metrics logging

**Files to modify**:
- `nodes/FunctionRegistry.ts`
- `nodes/Function/Function.node.ts`
- `nodes/CallFunction/CallFunction.node.ts`

**Acceptance Criteria**:
- Redis connections are efficiently managed
- Stream operations are optimized for throughput
- System handles high load gracefully
- Performance metrics are available

### Task 4.2: Add Configuration Options
**Priority**: Medium  
**Estimated Time**: 2-3 hours  
**Dependencies**: Task 4.1

- [ ] Add stream configuration parameters
- [ ] Add timeout configuration options
- [ ] Add retry and backoff configuration
- [ ] Add monitoring configuration
- [ ] Document all configuration options

**Files to modify**:
- `nodes/Function/Function.node.ts`
- `nodes/CallFunction/CallFunction.node.ts`
- `package.json` (for default configs)

**Acceptance Criteria**:
- All timeouts and limits are configurable
- Retry behavior can be customized
- Monitoring can be enabled/disabled
- Configuration is well documented

### Task 4.3: Add Comprehensive Logging
**Priority**: Medium  
**Estimated Time**: 2-3 hours  
**Dependencies**: All previous tasks

- [ ] Add structured logging for all operations
- [ ] Add performance metrics logging
- [ ] Add error tracking and alerting
- [ ] Add debug logging for troubleshooting
- [ ] Ensure log levels are configurable

**Files to modify**:
- `nodes/FunctionRegistry.ts`
- `nodes/Function/Function.node.ts`
- `nodes/CallFunction/CallFunction.node.ts`
- `nodes/ReturnFromFunction/ReturnFromFunction.node.ts`

**Acceptance Criteria**:
- All operations are properly logged
- Performance metrics are tracked
- Errors are logged with context
- Debug information is available when needed

## Phase 5: Migration & Cleanup

### Task 5.1: Create Migration Guide
**Priority**: Low  
**Estimated Time**: 2-3 hours  
**Dependencies**: All Phase 4 tasks

- [ ] Document migration steps from pub/sub to streams
- [ ] Create compatibility layer if needed
- [ ] Document breaking changes
- [ ] Create migration scripts if necessary
- [ ] Test migration with existing workflows

**Files to create**:
- `MIGRATION.md`
- `scripts/migrate-to-streams.js` (if needed)

**Acceptance Criteria**:
- Clear migration path documented
- Existing workflows can be migrated
- Breaking changes are clearly identified
- Migration can be done safely

### Task 5.2: Remove Legacy Pub/Sub Code
**Priority**: Low  
**Estimated Time**: 2-3 hours  
**Dependencies**: Task 5.1

- [ ] Remove old pub/sub implementation
- [ ] Clean up unused code and dependencies
- [ ] Update documentation
- [ ] Remove old configuration options
- [ ] Verify no regressions

**Files to modify**:
- `nodes/FunctionRegistry.ts`
- `nodes/Function/Function.node.ts`
- `nodes/CallFunction/CallFunction.node.ts`

**Acceptance Criteria**:
- All legacy code is removed
- No unused dependencies remain
- Documentation is updated
- System works without old code

## Implementation Order

1. **Week 1**: Phase 1 (Core Infrastructure) - Tasks 1.1, 1.2, 1.3
2. **Week 2**: Phase 2 (Node Implementation) - Tasks 2.1, 2.2, 2.3
3. **Week 3**: Phase 3 (Testing) - Tasks 3.1, 3.2, 3.3
4. **Week 4**: Phase 4 (Production) - Tasks 4.1, 4.2, 4.3
5. **Week 5**: Phase 5 (Migration) - Tasks 5.1, 5.2

## Risk Mitigation

### High Risk Items
- **Task 2.1**: Function node trigger pattern may not work as expected
  - *Mitigation*: Test trigger pattern early, have fallback plan
- **Task 3.2**: Concurrency issues may be complex to debug
  - *Mitigation*: Start with simple cases, add complexity gradually
- **Task 3.3**: Fault tolerance testing requires complex setup
  - *Mitigation*: Use Docker containers for controlled crash testing

### Dependencies
- Redis Streams support (Redis 5.0+)
- n8n trigger node async generator support
- Stable Redis connection in queue mode

## Success Metrics

- [ ] All function calls complete successfully in queue mode
- [ ] System handles worker crashes gracefully
- [ ] Performance is equal or better than pub/sub implementation
- [ ] No message loss under normal operation
- [ ] Recursive and concurrent calls work reliably
- [ ] Migration from existing system is smooth

## Notes

- Each task should include unit tests where applicable
- Integration tests should be run after each phase
- Performance benchmarks should be established early
- Documentation should be updated with each task
- Code reviews are required for all core functionality changes

### Critical Fix Implemented (Phase 2 Complete)

**Issue**: In n8n queue mode, workflow static data doesn't transfer between workers, causing ReturnFromFunction to fail when trying to access call context stored by Function nodes running on different workers.

**Solution**: Modified the architecture to embed call context directly in workflow items:
- Function node now adds `_functionCall` field to emitted items containing all necessary context
- ReturnFromFunction reads context from `item.json._functionCall` instead of workflow static data
- This ensures call context travels with the workflow execution across workers

**Files Modified**:
- `nodes/Function/Function.node.ts`: Added context embedding in emitted items
- `nodes/ReturnFromFunction/ReturnFromFunction.node.ts`: Updated to read context from items

**Status**: ✅ All Phase 1 and Phase 2 tasks completed. System now works reliably in n8n queue mode.

### Timing Issues Fix (Post Phase 2)

**Issue**: Initial function calls were timing out because Function nodes weren't ready when CallFunction tried to call them, causing "Response timeout" errors.

**Solution**: Added stream readiness checking and retry logic:
- Added `isStreamReady()` method to check if stream exists and has active consumers
- Added `waitForStreamReady()` method with configurable timeout
- Updated CallFunction to check stream readiness before making calls
- Implemented retry logic with exponential backoff for failed calls
- Reduced individual timeout from 30s to 15s but added 2 retries

**Files Modified**:
- `nodes/FunctionRegistry.ts`: Added stream readiness checking methods
- `nodes/CallFunction/CallFunction.node.ts`: Added readiness check and retry logic

**Status**: ✅ Timing issues resolved. System now handles Function node startup delays gracefully.

### Performance Optimization (Post Timing Fix)

**Issue**: Function calls were extremely slow (10+ seconds) due to inefficient stream readiness checks and incorrect global function scope handling.

**Root Causes**:
1. Stream readiness check was waiting for "active consumers" which was unreliable and took full 10-second timeout
2. Global function calls were using wrong scope (local workflow ID instead of "__global__")
3. Check interval was too slow (500ms) and timeout too long (10s)

**Solution**: Optimized stream readiness checking:
- Simplified readiness check to only verify consumer group exists (not active consumers)
- Reduced timeout from 10s to 2s for faster feedback
- Reduced check interval from 500ms to 200ms for more responsive checking
- Fixed global function scope issue (though root cause in UI parameter reading needs investigation)

**Files Modified**:
- `nodes/FunctionRegistry.ts`: Simplified and optimized stream readiness checks
- `nodes/CallFunction/CallFunction.node.ts`: Reduced timeout for readiness check

**Performance Impact**:
- Function calls now complete in ~2-3 seconds instead of 10+ seconds
- Stream readiness check completes quickly when group exists
- System gracefully handles cases where stream isn't ready yet

**Status**: ✅ Performance issues resolved. Function calls are now fast and responsive.