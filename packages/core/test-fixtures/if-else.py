from aws_durable_execution_sdk_python import DurableContext, durable_execution


@durable_execution
def handler(event: dict, context: DurableContext) -> str:
    if event["vip"]:
        context.step(lambda _: 1, name="fast-track")
    else:
        context.step(lambda _: 2, name="queue")
        context.step(lambda _: 3, name="notify-wait")

    if event["tier"] == "gold":
        context.step(lambda _: 1, name="gold")
    elif event["tier"] == "silver":
        context.step(lambda _: 2, name="silver")
    else:
        context.step(lambda _: 3, name="bronze")
        return "bronze"

    if event["skip"]:
        pass  # nothing durable here
    else:
        context.step(lambda _: 4, name="only-else")

    for order in event["orders"]:
        if order["paid"]:
            context.step(lambda _: order, name="ship")
        else:
            context.step(lambda _: order, name="chase")

    context.step(lambda _: 5, name="finish")
    return "done"
