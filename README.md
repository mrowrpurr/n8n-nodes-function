# Function n8n Nodes

Blueprint-style local functions for n8n workflows. Define reusable functions within your workflow and call them from anywhere on the same canvas.

## Overview

This package provides two nodes:

- **Function**: A trigger node that defines a callable function with parameters
- **Call Function**: A regular node that invokes Function nodes within the same workflow

Inspired by UE5 Blueprint functions, these nodes allow you to create modular, reusable logic within a single workflow without needing separate sub-workflows.

## Install `n8n-nodes-function`

> Requires self-hosted n8n

```bash
npm install n8n-nodes-function
```

Or install via the n8n UI:

1. Go to **Settings** → **Community Nodes**
2. Enter `n8n-nodes-function`
3. Click **Install**

## How it works

### 1. Define a Function

Add a **Function** node to your workflow. This is a trigger node that:

- Defines the function name
- Specifies input parameters with types and default values
- Acts as the entry point when the function is called

**Function Node Properties:**
- **Function Name**: Unique identifier for the function
- **Parameters**: Define name, type, required/optional, default values, and descriptions

**Supported Parameter Types:**
- String
- Number  
- Boolean
- Object
- Array

### 2. Build Function Logic

Connect nodes to the Function node's output to define what the function does. When called:

1. The Function node receives parameters as `$json.locals.parameterName`
2. Downstream nodes can access these parameters
3. The function executes until completion
4. Results are returned to the caller

### 3. Call the Function

Use a **Call Function** node anywhere in your workflow to invoke a Function:

**Call Function Node Properties:**
- **Function Name**: Must match a Function node in the same workflow
- **Parameter Mode**: Choose between individual parameters or JSON object
- **Parameters**: Specify values to pass to the function

**Parameter Modes:**
- **Individual Parameters**: Define each parameter separately in the UI
- **JSON Object**: Pass all parameters as a single JSON expression

## Example Workflow

```
Manual Trigger → Call Function ("calculateTotal") → Display Result
                      ↓
Function ("calculateTotal") → Math Operations → Set Output
```

### Function Definition
- **Name**: `calculateTotal`
- **Parameters**:
  - `items` (Array, required): List of items to calculate
  - `taxRate` (Number, optional, default: 0.1): Tax percentage

### Call Function
- **Function Name**: `calculateTotal`  
- **Parameters**:
  - `items`: `[{"price": 10}, {"price": 20}]`
  - `taxRate`: `0.15`

## Key Features

### Local Scope
Functions operate within the same workflow canvas, making them:
- Fast to execute (no sub-workflow overhead)
- Easy to debug and visualize
- Able to share workflow context

### Type Safety
Parameters support type definitions to catch errors early:
- Required vs optional parameters
- Type validation (string, number, boolean, object, array)
- Default values for optional parameters

### Reusability
Define once, call multiple times:
- Reduce code duplication
- Maintain consistency across workflow branches
- Easy to update logic in one place

## Advanced Usage

### Nested Function Calls
Functions can call other functions within the same workflow:

```
Function A → Call Function B → Continue Logic
Function B → Processing → Return
```

### Conditional Logic
Combine with Switch/IF nodes for dynamic function calling:

```
Manual Trigger → Switch → Call Function ("processTypeA")
                      → Call Function ("processTypeB")
```

### Error Handling
Functions inherit the workflow's error handling:
- Use try/catch patterns with IF nodes
- Set error outputs from Function nodes
- Handle failures in calling nodes

## Current Limitations

⚠️ **Note**: This is an initial implementation. The core function calling mechanism is still being developed.

Currently implemented:
- ✅ Function node UI and parameter definition
- ✅ Call Function node UI and parameter passing
- ⚠️ Function execution mechanism (in development)

The nodes will show placeholder results until the full execution engine is implemented.

## Roadmap

1. **Core Execution Engine**: Implement actual function triggering and result passing
2. **Local Variable Management**: Proper `$json.locals` handling and cleanup
3. **Function Discovery**: Auto-populate function names in Call Function dropdown
4. **Advanced Features**: 
   - Return value types
   - Multiple output branches
   - Async function support
   - Cross-workflow function calls

## Contributing

This is an open-source project. Contributions welcome!

## License

MIT License
