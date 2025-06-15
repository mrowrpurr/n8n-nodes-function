# 🧠 n8n-nodes-function

Blueprint-style function system for [n8n](https://n8n.io), inspired by Unreal Engine 5.

Define reusable logic blocks with [`Function`](./nodes/Function), call them with [`CallFunction`](./nodes/CallFunction), and return values with [`ReturnFromFunction`](./nodes/ReturnFromFunction).

<img alt="Workflow using functions" src="screenshots/workflow-with-function.png" width="600" />

## 📦 Features

- 🧱 **Define reusable logic** with named [`Function`](./nodes/Function/Function.node.ts) nodes
- 📞 **Call functions** with dynamic parameters using [`CallFunction`](./nodes/CallFunction/CallFunction.node.ts)
- 🔁 **Return values cleanly** using [`ReturnFromFunction`](./nodes/ReturnFromFunction/ReturnFromFunction.node.ts)
- 🧬 **Nested function calls** - functions can call other functions with isolated return values
- 🌍 **Global functions** - share logic across workflows

## ℹ️ Gotchas

> 👋 Hey `n8n` team devs, feel free to steal the ideas here and build this into `n8n`.
>
> If `n8n` had built-in support for functions, we could fix some of these limitations.

- 🟢 Functions only work on `Active` workflows.

- 🔃 To detect changes to new/existing `Function` nodes, toggle the workflow off/on.
  > _The `Call Function` and `Return from Function` do not require toggle workflow after changes._
  > _But function names/params from `Function` nodes require toggling the active state._
  > _It's not an intentional choice, it's just a limitation of how trigger nodes work in `n8n`._

- ▶️ Functions appear as separate `Executions`.
  > _Again, this is not an intentional choice, it's just how `n8n` works with trigger nodes._
  
- ✅ Queue mode (_now supported!_)
  > **Queue mode is now supported!** The function registry automatically uses Redis when queue mode is detected.
  >
  > Use the [`Configure Functions`](./nodes/ConfigureFunctions) node to set up Redis connection details.
  >
  > Functions are stored in Redis and shared across all n8n worker processes.

## 🛠️ Installation

<img alt="Install Community Node" src="screenshots/install-node.png" width="400" />

## 🔧 Queue Mode Setup

For n8n instances running in **queue mode**, functions now work seamlessly across multiple worker processes using Redis.

### Automatic Detection
The function registry automatically detects queue mode and switches to Redis-backed storage.

### Manual Configuration
Use the **Configure Functions** node to explicitly set Redis connection details:

1. Add a [`Configure Functions`](./nodes/ConfigureFunctions) node to your workflow
2. Set **Function Registry Mode** to "Redis (Queue Mode)"
3. Configure your **Redis Host** (default: `redis`)
4. Optionally test the connection
5. Activate the workflow

### Redis Requirements
- Redis server accessible by all n8n processes
- Default connection: `redis://redis:6379`
- Functions are stored with 5-minute expiry for return values
- Cross-process function calls via Redis pub/sub

### Environment Variables
The system automatically detects queue mode via `EXECUTIONS_MODE=queue` but you can also manually enable Redis mode using the Configure Functions node.
