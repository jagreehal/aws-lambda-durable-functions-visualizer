from aws_durable_execution_sdk_python import DurableContext, ParallelBranch, durable_execution
from aws_durable_execution_sdk_python.context import durable_parallel_branch


def task_a(ctx: DurableContext) -> str:
    return ctx.step(lambda _: "a", name="run-a")


@durable_parallel_branch(name="task-c")
def task_c(ctx: DurableContext) -> str:
    return ctx.step(lambda _: "c", name="run-c")


@durable_execution
def handler(event: dict, context: DurableContext) -> list:
    context.parallel(
        [
            # A plain callable, then a positional ParallelBranch func
            task_a,
            ParallelBranch(task_a, name="task-b"),
            # A decorated branch named by its decorator
            task_c(),
            # Two lambdas with the same text keep their own lines
            lambda ctx: ctx.step(
                lambda _: 1, name="same"
            ),
            lambda ctx: ctx.step(
                lambda _: 2, name="same"
            ),
        ],
        name="process",
    )
    return context.map(
        inputs=event["items"],
        func=lambda ctx, item, index, _: ctx.step(lambda _: item, name="per-item"),
        name="items",
    ).get_results()
