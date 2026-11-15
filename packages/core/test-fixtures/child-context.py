from aws_durable_execution_sdk_python import DurableContext, durable_execution, with_retry
from aws_durable_execution_sdk_python.config import Duration
from aws_durable_execution_sdk_python.context import durable_with_child_context


@durable_with_child_context
def process_order(ctx: DurableContext, order_id: str) -> dict:
    ctx.step(lambda _: order_id, name="validate")
    return ctx.step(lambda _: order_id, name="reserve")


def charge_flow(ctx: DurableContext, attempt: int) -> dict:
    ctx.step(lambda _: attempt, name="charge")
    ctx.wait(Duration.from_seconds(1), name="settle")
    return {}


@durable_execution
def handler(event: dict, context: DurableContext) -> dict:
    context.run_in_child_context(
        process_order(event["order_id"]),
        name="process-order",
    )
    context.run_in_child_context(lambda child: child.step(lambda _: 1, name="inline-step"), name="inline")
    context.run_in_child_context(lambda child: len(event), name="plain")
    result = with_retry(
        context,
        func=charge_flow,
        config=None,
        name="charge-payment",
    )
    context.step(lambda _: result, name="done")
    return result
