---
name: durable-workflow-pr-diagram
description: Show an AWS Lambda durable function's workflow diagram on every pull request, or keep one in a README, using ldfviz in GitHub Actions. Use when someone wants reviewers to see how a durable handler's steps, branches and waits look (or changed) without running it.
---

# Put a durable workflow diagram in pull requests

`ldfviz --mermaid` prints a Mermaid flowchart, and GitHub renders a `mermaid` fence in Markdown, job summaries and comments. No AWS credentials or deployment are needed: the handler is parsed, not run.

## Draw it in the job summary

Create `.github/workflows/workflow-diagram.yml`, with `paths` and the handler path set to the repository's own:

```yaml
name: Workflow diagram
on:
  pull_request:
    paths: ["src/handlers/**"]
permissions:
  contents: read
jobs:
  diagram:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 24
      - name: Draw the handler
        run: |
          {
            echo '```mermaid'
            npx --yes aws-lambda-durable-functions-visualizer src/handlers/order.ts --mermaid
            echo '```'
          } >> "$GITHUB_STEP_SUMMARY"
```

For several handlers, repeat the `npx` line per file with a heading (`echo '### order'`) above each fence. Pin a version (`aws-lambda-durable-functions-visualizer@0.1.0`) to keep diagrams stable across releases.

## Keep one in a README

Write the Mermaid into the README between two markers and regenerate it when the handler changes:

```markdown
<!-- workflow:start -->
<!-- workflow:end -->
```

```shell
npx aws-lambda-durable-functions-visualizer src/handlers/order.ts --mermaid -o workflow.mmd
```

Replace the text between the markers with a `mermaid` fence holding `workflow.mmd`, by hand or in a script. A CI step that runs the same command and fails on `git diff --exit-code` catches a stale diagram.

## Check your work

Open the pull request's **Checks → Workflow diagram → Summary** and confirm the chart draws. A failed step with "No ... call found" means the file has no durable entry point: check the path, and see the `draw-durable-workflow` skill for entry points and known limits. `--direction LR` suits long, narrow workflows.
