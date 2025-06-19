# Fix Summary for n8n Call Function Intermittent Failures

## Issues Fixed

### 1. Function Nodes Not Sending Default Responses
**Problem**: Function nodes only sent responses when ReturnFromFunction was used, causing 15-second timeouts.

**Fix**: Added code in `Function.node.ts` (lines 426-441) to:
- Wait 50ms to see if ReturnFromFunction will handle the response
- Send a default response if no ReturnFromFunction is detected
- Mark response as sent to prevent duplicates

### 2. Stream Consumer Accumulation
**Problem**: Editing Function nodes created new stream consumers without cleaning up old ones, causing messages to be consumed by dead consumers.

**Fix**: Added consumer tracking in `FunctionRegistry.ts`:
- `registerConsumer()` - Track active consumers
- `stopConsumer()` - Mark consumers as inactive
- `isConsumerActive()` - Check consumer status
- Function node now stops existing consumers before creating new ones

### 3. Stream Readiness Timeout Too Short
**Problem**: CallFunction only waited 500ms for stream consumers to be ready, causing first calls to fail.

**Fix**: Increased timeout in `CallFunction.node.ts` from 500ms to 3000ms (line 544).

### 4. Missing Response Tracking
**Problem**: No way to know if a response was already sent by ReturnFromFunction.

**Fix**: Added methods in `FunctionRegistry.ts`:
- `markResponseSent()` - Mark that a response was sent
- `isResponseSent()` - Check if response was already sent
- ReturnFromFunction now marks responses as sent

## Testing the Fixes

1. **Test Default Response**: Create a Function without ReturnFromFunction - should no longer timeout
2. **Test Edit Scenario**: Edit a Function node and re-run - should not accumulate delays
3. **Test First Call**: Call a function immediately after activation - should work with 3s timeout
4. **Test With ReturnFromFunction**: Should still work correctly and not send duplicate responses

## Key Changes by File

### FunctionRegistry.ts
- Added consumer tracking map and methods
- Added response sent tracking with Redis keys
- Improved stream cleanup with pending message handling

### Function.node.ts
- Check for existing consumers and stop them before creating new ones
- Send default response after 50ms if no ReturnFromFunction
- Properly acknowledge all messages (not just errors)

### CallFunction.node.ts
- Increased stream readiness timeout from 500ms to 3000ms
- Updated diagnostic messages

### ReturnFromFunction.node.ts
- Mark response as sent before publishing to prevent duplicates

## Diagnostic Logging

All fixes include diagnostic logging with "🔍 DIAGNOSTIC:" prefix to help verify the fixes are working:
- Consumer lifecycle events
- Response sending decisions
- Stream readiness checks
- Worker health status

Search logs for "DIAGNOSTIC" to see the fix behavior in action.