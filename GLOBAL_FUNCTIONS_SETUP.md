# Global Functions Setup Guide

## Problem
Global functions aren't appearing in CallFunction dropdowns because the system is using in-memory mode instead of Redis mode.

## Solution
To enable global functions across workflows, you need to use Redis mode:

### Step 1: Configure Redis Mode
1. **Open the workflow** that contains the ConfigureFunctions node
2. **Edit the ConfigureFunctions node**:
   - Change "Function Registry Mode" from "In-Memory (Default)" to "Redis (Queue Mode)"
   - Set "Redis Host" to "redis" (or your Redis server hostname)
   - Set "Redis Port" to 6379 (or your Redis port)
   - Optionally enable "Test Connection" to verify Redis connectivity
3. **Save the workflow**
4. **Activate the workflow** (this will configure the system to use Redis mode)

### Step 2: Verify Global Functions
1. **Activate the workflow** containing your global Function nodes
2. **In another workflow**, add a CallFunction node
3. **Check the "Global Function" checkbox** in the CallFunction node
4. **Open the "Function Name" dropdown** - you should now see your global functions

### Expected Logs
When Redis mode is enabled, you should see:
```
🏭 FunctionRegistryFactory: Queue mode enabled = true
🏭 FunctionRegistryFactory: Using Redis-backed FunctionRegistry
```

Instead of:
```
🏭 FunctionRegistryFactory: Queue mode enabled = false
🏭 FunctionRegistryFactory: Using in-memory FunctionRegistry
```

## Why This Is Needed
- **In-Memory Mode**: Each workflow has its own separate function registry
- **Redis Mode**: All workflows share the same Redis-backed function registry
- **Global Functions**: Only work when all workflows can access the same registry (Redis mode)

## Current Status
Your system is currently in in-memory mode, which is why global functions aren't visible across workflows.