# Function Call Recovery Mechanism

## Overview

This document describes the recovery mechanism implemented to handle the issue where Function node triggers stop working after saving workflows in n8n queue mode.

## Problem Description

In n8n queue mode, when a workflow containing Function nodes is saved (Ctrl+S), the Function node consumer loop exits prematurely. This causes:

1. **First function call after restart**: Works fine
2. **After saving workflow**: Consumer processes orphaned messages then exits
3. **Subsequent function calls**: Hang forever because no consumer is processing the Redis stream
4. **After canceling and retrying**: Works again (consumer restarts)

## Root Cause

The issue occurs because:
- Function node triggers run in the main n8n process (not in workers)
- When saving a workflow, n8n deactivates and reactivates the Function trigger properly
- **However, the consumer loop exits prematurely after processing orphaned messages**
- The consumer loop was not properly handling NOGROUP errors and empty message arrays
- Health checks still show workers as "healthy" because heartbeats haven't expired
- CallFunction nodes add messages to Redis streams but no consumer processes them

## Recovery Mechanism Components

### 1. Consumer Loop Fixes (Function.node.ts & FunctionRegistry.ts)

#### Enhanced Error Handling in `readCallsInstant()`
- **NOGROUP Error Recovery**: When streams are recreated, properly handle NOGROUP errors
- **Stream Stabilization**: Add delays after stream recreation to let Redis stabilize
- **Continuous Operation**: Always return empty arrays instead of throwing errors to keep consumer loop running
- **Better Logging**: Detailed logging to track exactly where issues occur

#### Improved Consumer Loop Logic
- **Loop Continuation**: Explicit `continue` statements to ensure loop doesn't exit prematurely
- **State Checking**: Enhanced logging of `isActive` and `consumerActive` states
- **Error Recovery**: Better error handling with longer delays to prevent tight error loops
- **Exit Logging**: Clear logging when and why the consumer loop exits

#### Control Signal Monitoring
- **Enhanced Control Subscriber**: Better logging of stop signals and control channels
- **Premature Exit Detection**: Track when control signals are received unexpectedly

### 2. Detection Methods (FunctionRegistry.ts)

#### `hasActiveConsumers(streamKey, groupName)`
- Checks if there are any active consumers for a Redis stream
- Considers consumers active if seen within last 60 seconds
- Returns boolean indicating if active consumers exist

#### `hasHealthyWorkers(functionName)`
- Checks all workers for a function and validates their health
- Returns count of total workers vs healthy workers
- Uses 30-second timeout for health checks

#### `detectMissingConsumer(functionName, scope)`
- Comprehensive check to determine if a function needs recovery
- Checks stream existence, active consumers, and healthy workers
- Returns recovery status and reason

#### `cleanupStaleWorkers(functionName, maxAgeMs)`
- Removes stale worker metadata from Redis
- Cleans up workers that haven't sent heartbeats within timeout
- Returns count of cleaned workers

#### `attemptFunctionRecovery(functionName, scope)`
- Attempts to recover a function by recreating streams and clearing orphaned messages
- Prepares the Redis infrastructure for function restart
- Note: Cannot restart the actual Function trigger (that's n8n's responsibility)

### 2. CallFunction Recovery (CallFunction.node.ts)

When CallFunction detects no healthy workers:

1. **Cleanup Phase**: Remove stale worker metadata
2. **Detection Phase**: Check if function needs recovery
3. **Recovery Phase**: Attempt to fix Redis infrastructure
4. **Verification Phase**: Wait and check for healthy workers again
5. **Error Handling**: Provide helpful error messages if recovery fails

#### Recovery Flow
```
No Healthy Workers Found
         ↓
Clean Up Stale Workers
         ↓
Detect Missing Consumer
         ↓
Attempt Function Recovery
         ↓
Wait 2 seconds
         ↓
Check for Healthy Workers Again
         ↓
Success or Detailed Error Message
```

### 3. Function Node Monitoring (Function.node.ts)

#### Recovery Check Interval
- Runs every 30 seconds while Function consumer is active
- Monitors for stuck consumers or pending messages
- Logs issues for debugging but doesn't interfere with running consumers
- Automatically cleans up when consumer stops

#### Proactive Monitoring
- Detects when consumers become inactive
- Identifies potential issues before they cause hangs
- Provides diagnostic information for troubleshooting

## Error Messages

The recovery mechanism provides detailed error messages to help users understand and resolve issues:

### Successful Recovery
```
🚨 RECOVERY: Recovery successful! Found healthy workers: X
```

### Recovery Failed
```
Function 'FunctionName' has no healthy workers available. Recovery attempted but failed. 
This usually means the Function node trigger is not running. Try saving the workflow again or 
deactivating and reactivating the workflow containing the Function node.
```

### No Recovery Needed
```
Function 'FunctionName' has no healthy workers available. [Specific reason]
```

## Usage

The recovery mechanism is automatic and requires no user intervention. When a CallFunction node detects missing consumers:

1. It automatically attempts recovery
2. Provides clear feedback about the process
3. Gives actionable advice if recovery fails

## Limitations

### What the Recovery Mechanism CAN Do:
- Detect when Function triggers have stopped
- Clean up stale Redis metadata
- Recreate Redis streams and consumer groups
- Clear orphaned messages
- Provide detailed diagnostic information

### What the Recovery Mechanism CANNOT Do:
- Restart the actual Function node trigger (this is n8n's responsibility)
- Force n8n to reactivate workflows
- Fix the underlying n8n trigger lifecycle bug

## Workarounds for Users

If recovery fails, users can try:

1. **Save the workflow again** (Ctrl+S) - sometimes triggers restart
2. **Deactivate and reactivate** the workflow containing the Function node
3. **Restart n8n** if the issue persists
4. **Check n8n logs** for trigger activation messages

## Future Improvements

Potential enhancements to consider:

1. **Trigger Health API**: Add endpoint to check trigger status
2. **Force Trigger Restart**: API to manually restart specific triggers
3. **Automatic Workflow Reactivation**: Detect and fix trigger issues automatically
4. **Enhanced Monitoring**: More detailed trigger lifecycle tracking
5. **Graceful Degradation**: Fallback mechanisms when triggers fail

## Monitoring and Debugging

### Log Messages to Watch For:

#### Successful Function Start:
```
🔄 RESTART: Starting stream-based trigger setup
🔄 RESTART: Function node is being activated/reactivated
```

#### Recovery Attempts:
```
🚨 RECOVERY: No healthy workers found, attempting recovery...
🚨 RECOVERY: Function needs recovery - [reason]
```

#### Recovery Success:
```
🚨 RECOVERY: Recovery successful! Found healthy workers: X
```

#### Monitoring:
```
🔍 RECOVERY: Recovery check interval started
🔍 RECOVERY: Function consumer may be stuck - [reason]
```

This recovery mechanism significantly improves the reliability of function calls in n8n queue mode by automatically detecting and attempting to fix common issues caused by the trigger lifecycle bug.