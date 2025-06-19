# Logging Patches to Confirm Hypothesis

Add these logging statements to confirm the root causes of intermittent Call Function failures.

## 1. Function.node.ts - Confirm Missing Response Issue

### Add after line 395 (after `this.emit([[outputItem]])`):
```javascript
// DIAGNOSTIC LOGGING: Check if we're sending a response
logger.log("🔍 DIAGNOSTIC: Function execution completed, checking response handling")
logger.log("🔍 DIAGNOSTIC: Response channel:", responseChannel)
logger.log("🔍 DIAGNOSTIC: Call ID:", callId)
logger.log("🔍 DIAGNOSTIC: Stream key:", streamKey)
logger.log("🔍 DIAGNOSTIC: About to send response: NO - Function node doesn't send success responses!")
logger.log("🔍 DIAGNOSTIC: This will cause CallFunction to timeout after 15 seconds")

// TODO: Add this code to fix the issue:
// await registry.publishResponse(responseChannel, {
//     success: true,
//     data: outputItem.json,
//     callId,
//     timestamp: Date.now(),
// })
// await registry.acknowledgeCall(streamKey, groupName, message.id)
// logger.log("🔍 DIAGNOSTIC: Response sent successfully")
```

### Add after line 412 (in error handling):
```javascript
logger.log("🔍 DIAGNOSTIC: Error occurred, sending error response")
logger.log("🔍 DIAGNOSTIC: This is the ONLY time Function sends responses!")
```

## 2. CallFunction.node.ts - Confirm Stream Readiness Issue

### Replace line 544-551 with:
```javascript
logger.log("🔍 DIAGNOSTIC: Checking if stream is ready")
logger.log("🔍 DIAGNOSTIC: Stream key:", streamKey)
logger.log("🔍 DIAGNOSTIC: Group name:", groupName)
logger.log("🔍 DIAGNOSTIC: Timeout: 500ms (THIS IS TOO SHORT!)")

const startTime = Date.now()
const isReady = await registry.waitForStreamReady(streamKey, groupName, 500) // 500ms timeout
const checkDuration = Date.now() - startTime

logger.log("🔍 DIAGNOSTIC: Stream ready check completed")
logger.log("🔍 DIAGNOSTIC: Is ready:", isReady)
logger.log("🔍 DIAGNOSTIC: Check duration:", checkDuration, "ms")

if (!isReady) {
    logger.warn("🔍 DIAGNOSTIC: Stream not ready after 500ms - this is likely why first calls fail!")
    logger.warn("🔍 DIAGNOSTIC: Function consumer might still be starting up")
    // Don't throw error immediately, try the call - it might work if function is just starting
} else {
    logger.log("🔍 DIAGNOSTIC: Stream is ready, proceeding with call")
}
```

### Add after line 566 (in retry loop):
```javascript
logger.log("🔍 DIAGNOSTIC: Waiting for response on channel:", currentResponseChannel)
logger.log("🔍 DIAGNOSTIC: Timeout: 15 seconds")
logger.log("🔍 DIAGNOSTIC: If Function doesn't have ReturnFromFunction, this WILL timeout!")
```

### Add in catch block around line 571:
```javascript
logger.log("🔍 DIAGNOSTIC: Response timeout or error occurred")
logger.log("🔍 DIAGNOSTIC: Error message:", error.message)
logger.log("🔍 DIAGNOSTIC: Is this 'Response timeout'?", error.message.includes("timeout"))
logger.log("🔍 DIAGNOSTIC: This confirms Function didn't send a response")
```

## 3. FunctionRegistry.ts - Confirm Response Timeout

### Add to waitForResponse() after line 322:
```javascript
logger.log("🔍 DIAGNOSTIC: Waiting for response with BLPOP")
logger.log("🔍 DIAGNOSTIC: Response channel:", responseChannel)
logger.log("🔍 DIAGNOSTIC: Timeout:", timeoutSeconds, "seconds")
const startWait = Date.now()
```

### Add after line 327 (when result is null):
```javascript
const waitDuration = Date.now() - startWait
logger.log("🔍 DIAGNOSTIC: BLPOP returned null after", waitDuration, "ms")
logger.log("🔍 DIAGNOSTIC: This means no response was received - Function didn't send one!")
```

## 4. FunctionRegistry.ts - Log Worker Health Checks

### Add to isWorkerHealthy() after line 385:
```javascript
logger.log("🔍 DIAGNOSTIC: Checking worker health")
logger.log("🔍 DIAGNOSTIC: Worker ID:", workerId)
logger.log("🔍 DIAGNOSTIC: Function name:", functionName)
logger.log("🔍 DIAGNOSTIC: Last heartbeat:", lastHeartbeat)
logger.log("🔍 DIAGNOSTIC: Current time:", Date.now())
logger.log("🔍 DIAGNOSTIC: Age:", age, "ms")
logger.log("🔍 DIAGNOSTIC: Max age allowed:", maxAgeMs, "ms")
logger.log("🔍 DIAGNOSTIC: Is healthy:", age <= maxAgeMs)
```

## 5. Function.node.ts - Log Consumer Startup

### Add after line 428 (after starting processStreamMessages):
```javascript
logger.log("🔍 DIAGNOSTIC: Stream consumer loop started asynchronously")
logger.log("🔍 DIAGNOSTIC: Consumer might not be ready immediately!")
logger.log("🔍 DIAGNOSTIC: This could cause first calls to fail")
```

### Add at the beginning of processStreamMessages (line 244):
```javascript
logger.log("🔍 DIAGNOSTIC: Stream consumer loop starting")
logger.log("🔍 DIAGNOSTIC: Stream key:", streamKey)
logger.log("🔍 DIAGNOSTIC: Group name:", groupName)
logger.log("🔍 DIAGNOSTIC: Consumer name:", consumerName)
```

### Add after first successful message read (after line 247):
```javascript
if (messages.length > 0) {
    logger.log("🔍 DIAGNOSTIC: Stream consumer is now fully operational!")
    logger.log("🔍 DIAGNOSTIC: First message received at:", new Date().toISOString())
}
```

## 6. ReturnFromFunction.node.ts - Confirm This Works

### Add after line 151:
```javascript
logger.log("🔍 DIAGNOSTIC: ReturnFromFunction sending success response")
logger.log("🔍 DIAGNOSTIC: Response channel:", callContext.responseChannel)
logger.log("🔍 DIAGNOSTIC: This WILL prevent CallFunction timeout")
```

## Expected Log Output Patterns

### When Function has NO ReturnFromFunction (will timeout):
```
🔍 DIAGNOSTIC: Function execution completed, checking response handling
🔍 DIAGNOSTIC: About to send response: NO - Function node doesn't send success responses!
🔍 DIAGNOSTIC: This will cause CallFunction to timeout after 15 seconds
...
🔍 DIAGNOSTIC: Waiting for response on channel: function:response:call-xxx
🔍 DIAGNOSTIC: Timeout: 15 seconds
🔍 DIAGNOSTIC: If Function doesn't have ReturnFromFunction, this WILL timeout!
...
🔍 DIAGNOSTIC: BLPOP returned null after 15000 ms
🔍 DIAGNOSTIC: This means no response was received - Function didn't send one!
```

### When Function HAS ReturnFromFunction (will work):
```
🔍 DIAGNOSTIC: ReturnFromFunction sending success response
🔍 DIAGNOSTIC: Response channel: function:response:call-xxx
🔍 DIAGNOSTIC: This WILL prevent CallFunction timeout
...
🔍 DIAGNOSTIC: Received response from function:response:call-xxx
```

### On First Call (stream not ready):
```
🔍 DIAGNOSTIC: Checking if stream is ready
🔍 DIAGNOSTIC: Timeout: 500ms (THIS IS TOO SHORT!)
🔍 DIAGNOSTIC: Stream ready check completed
🔍 DIAGNOSTIC: Is ready: false
🔍 DIAGNOSTIC: Check duration: 500 ms
🔍 DIAGNOSTIC: Stream not ready after 500ms - this is likely why first calls fail!
```

## How to Use These Logs

1. Add all the logging statements above to your code
2. Deploy to your Redis-backed n8n environment
3. Activate a workflow with a Function node
4. Try calling the function immediately (should see stream not ready)
5. Try calling a function WITHOUT ReturnFromFunction (should see timeout)
6. Try calling a function WITH ReturnFromFunction (should work)
7. Search logs for "DIAGNOSTIC" to see the confirmation of each hypothesis

The logs will clearly show:
- Whether Function sends responses (it doesn't unless ReturnFromFunction is used)
- Whether stream is ready on first call (often it's not with 500ms timeout)
- Exact timing of timeouts and responses
- Worker health check details