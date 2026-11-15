---
name: draw-durable-workflow
description: Draw an AWS Lambda durable function handler (TypeScript/JavaScript, Python, Java, C#, Rust or Go) as a diagram with ldfviz, without deploying or running it. Use when someone wants to see, explain or check the workflow a durable handler defines (steps, invokes, waits, callbacks, parallel and map branches, child contexts, retries, if/else, loops), or wants it as Mermaid or XState MachineJSON.
---

# Draw a durable function workflow

`ldfviz` reads a handler file, finds the durable entry point and draws every durable call. It parses the code and never imports or runs it, so the handler's own toolchain and AWS credentials aren't needed. Node.js 20 or later.

```shell
npx aws-lambda-durable-functions-visualizer <handler file> [flags]
```

Installed globally (`npm install -g aws-lambda-durable-functions-visualizer`), the same command is `ldfviz`.

## Pick an output

| Want | Flags |
| --- | --- |
| An interactive diagram in the browser | `--open` |
| A diagram for Markdown (GitHub, Notion, docs) | `--mermaid`, plus `-d LR` for left to right |
| XState MachineJSON for Autovisualizer or other tools | none (the default), or `--json` |
| Nodes, edges, source lines and config as JSON | `--graph` |
| Save the output | `-o <file>` |

`--open` writes a self-contained page and launches the browser. In a shell with no browser (CI, SSH, an agent sandbox), set `BROWSER=none` and it prints the page path instead. `-n <name>` renames the workflow.

## Entry points it looks for

| Language | Entry point |
| --- | --- |
| TypeScript / JavaScript | `withDurableExecution(handler)`, inline or a named function; an exported `handler` wins when there are several |
| Python | `@durable_execution` |
| Java | a class extending `DurableHandler` |
| C# | `DurableFunction.WrapAsync<TIn, TOut>(...)` or a `[DurableExecution]` method |
| Rust | `durable::run(handler)`, `run_with_options` or `wrap` |
| Go | `durable.Start(handler)` or `durable.Wrap` |

A "No ... call found" error (exit code 1) means the file isn't a durable handler, or the handler is wrapped in another file. Point it at the file that calls the wrapper.

## Explain the diagram

To describe the workflow to someone, read `--graph` rather than the picture: each node has a `kind`, a `label`, its `sourceLine` and any config; parallel and map nodes hold their `branches`, each with its own `nodes`. Shapes in the drawing follow the kind: steps are green rectangles, invokes amber trapezoids, parallel and map purple hexagons, waits and callbacks red circles, conditions indigo diamonds, child contexts and retries teal subroutines, and loop bodies sit in a dashed box. A branch that returns goes straight to End.

## When a call is missing

Count the durable calls in the source and compare them with the nodes in `--graph`. A gap is usually one of the known limits, not a bug:

- **Code in another file.** Helpers, branch functions and workflows imported from elsewhere are not followed. Run the tool on that file too, or move the helper into the handler's file.
- **Code chosen at runtime.** A strategy object's method, or a branch list passed in as a parameter or returned by a function.
- **Other control flow.** `switch`, `match`, ternaries, `break`, `continue`, and loops through callbacks such as `forEach` or `.map` (a `.map` that builds a branch list is shown as one "each item" branch).
- **Several handlers in one file.** Only one is drawn. Split them, or rely on the exported `handler`.

If none of these explain it, the parser missed a shape it should read: report it with the smallest handler that reproduces it at https://github.com/jagreehal/aws-lambda-durable-functions-visualizer/issues.

The diagram shows every path the code allows, not what one execution did.
