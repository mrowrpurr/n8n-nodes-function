# Lightweight closeFunction Fix - COMPLETED

## Problem
Our Function node's `closeFunction` was doing too much, making it non-restartable:
- Unregistering workers from registry
- Marking workers as unhealthy
- Complex cleanup sequences
- **Result:** After workflow saves, CallFunction couldn't find healthy workers

## Root Cause Analysis
From `N8N_ACTUAL_LIFECYCLE_INFO.md` research:
- n8n calls `closeFunction` during workflow structure changes (like adding CallFunction nodes)
- Official Redis trigger has lightweight `closeFunction` that only closes connections
- Our `closeFunction` was permanently killing workers instead of clean shutdown

## The Fix
Changed `closeFunction` to be lightweight like Redis trigger:

### Before (Broken):
```typescript
// Unregister current worker immediately
await registry.unregisterWorker(workerId, functionName)

// Clean up stale workers
const cleanedCount = await registry.cleanupStaleWorkers(functionName)

// Complex shutdown coordination with delays
await new Promise((resolve) => setTimeout(resolve, 100))
```

### After (Fixed):
```typescript
// Stop health updates
if (healthUpdateInterval) {
    clearInterval(healthUpdateInterval)
    healthUpdateInterval = null
}

// Stop lifecycle manager
if (lifecycleManager) {
    await lifecycleManager.stop()
}

// DON'T unregister workers or clean registry
// Worker stays registered as healthy for restart
```

## Key Changes
1. **Removed worker unregistration** - keeps worker available in registry
2. **Removed stale worker cleanup** - prevents removing healthy workers
3. **Removed complex shutdown delays** - simple, fast shutdown
4. **Added detailed logging** - track when trigger()/closeFunction() are called

## Expected Behavior
1. User creates workflow with Function node → Works
2. User adds CallFunction node → n8n calls `closeFunction` 
3. **Function node shuts down cleanly but worker stays registered**
4. CallFunction finds healthy worker immediately → Works
5. No more timeouts or hanging calls

## Logging Added
- Track when `trigger()` is called (workflow activation/restart)
- Track when `closeFunction()` is called (workflow changes/deactivation)
- Track worker registration status
- Clear separation between startup and shutdown events

## Files Modified
- `nodes/Function/Function.node.ts` - Lightweight closeFunction implementation

## Test Plan
1. Create workflow with Function node
2. Add CallFunction node and save
3. Check logs for clean shutdown without worker unregistration
4. Verify CallFunction can immediately find healthy worker
5. No more 30-second timeouts or hanging calls