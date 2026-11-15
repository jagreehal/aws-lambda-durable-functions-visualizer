# aws-lambda-durable-functions-visualizer

## 0.1.0

### Minor Changes

- Initial release. Draws AWS Lambda durable function handlers in TypeScript/JavaScript, Python, Java, C# (.NET), Rust and Go as Autovisualizer MachineJSON (the default), Mermaid or a JSON workflow graph, and opens them in the browser with `--open`.
  - Steps, invokes, waits, callbacks, parallel and map branches (inline, same-file functions, variables in scope, built-up and generated lists), nested parallels, child contexts, retries, promise combinators, `if` / `else if` / `else` and loops, with each primitive's configuration.
  - MachineJSON states are named after their steps and tagged with Autovisualizer's flowchart shapes and colours.
  - Commands: `aws-lambda-durable-functions-visualizer` and `ldfviz`.
