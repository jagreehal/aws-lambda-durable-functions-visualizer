from aws_durable_execution_sdk_python import DurableContext, durable_execution
from aws_durable_execution_sdk_python.config import ParallelBranch


def notify_warehouse(ctx: DurableContext) -> dict:
    return ctx.step(lambda sc: {}, name="notify-warehouse")


AUDIT_BRANCHES = [notify_warehouse, lambda ctx: ctx.step(lambda sc: {}, name="audit-log")]


@durable_execution
def handler(event: dict, context: DurableContext) -> dict:
    def ship(ctx: DurableContext) -> dict:
        ctx.step(lambda sc: {}, name="ship")
        return ctx.wait(Duration.from_seconds(5), name="ship-delay")

    def unused_helper(ctx: DurableContext) -> dict:
        return ctx.step(lambda sc: {}, name="never-called")

    branches = [
        ParallelBranch(func=lambda ctx: ctx.step(lambda sc: {}, name="reserve"), name="reserve"),
        ship,
    ]
    context.step(lambda sc: {}, name="start")
    context.parallel(branches, name="fulfil")

    handle_item = lambda ctx, item, idx, items: ctx.step(lambda sc: item, name="handle-item")
    context.map(event["items"], handle_item, name="per-item")

    context.parallel(functions=AUDIT_BRANCHES, name="audit")
    return {"ok": True}
