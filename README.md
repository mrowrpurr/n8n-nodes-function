# `n8n` Functions

<img alt="Workflow using functions" src="screenshots/workflow-with-function.png" width="600" />

# 🧠 n8n-nodes-function

Blueprint-style function system for [n8n](https://n8n.io), inspired by Unreal Engine 5.

Define reusable logic blocks with [`Function`](./nodes/Function), call them with [`CallFunction`](./nodes/CallFunction), and return values with [`ReturnFromFunction`](./nodes/ReturnFromFunction).

## 📦 Features

- 🧱 **Define reusable logic** with named [`Function`](./nodes/Function/Function.node.ts) nodes
- 📞 **Call functions** with dynamic parameters using [`CallFunction`](./nodes/CallFunction/CallFunction.node.ts)
- 🔁 **Return values cleanly** using [`ReturnFromFunction`](./nodes/ReturnFromFunction/ReturnFromFunction.node.ts)
- 🧬 **Nested function calls** - functions can call other functions with isolated return values
- 🌍 **Global functions** - share logic across workflows

## ℹ️ Gotchas

- 🟢 Functions only work on `Active` workflows.
- 🔃 To detect changes to new/existing `Function` nodes, toggle the workflow off/on.
  > _The `Call Function` and `Return from Function` do not require toggle workflow after changes._  
  > _But function names/params from `Function` nodes require toggling the active state._  
  > _It's not an intentional choice, it's just a limitation of how trigger nodes work in `n8n`._

## 🛠️ Installation

<img alt="Install Community Node" src="screenshots/install-node.png" width="400" />
