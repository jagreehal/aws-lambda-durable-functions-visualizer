import os

from aws_durable_execution_sdk_python import DurableContext, durable_execution

VIP_ENABLED = os.environ.get("VIP_ENABLED") == "1"


def check_stock(ctx: DurableContext) -> dict:
    return ctx.step(lambda sc: {"in_stock": True}, name="check-stock")


def reserve_items(ctx: DurableContext) -> dict:
    return ctx.step(lambda sc: {"reserved": True}, name="reserve-items")


def prepare_inventory(ctx: DurableContext) -> dict:
    ctx.parallel([check_stock, reserve_items], name="inventory-checks")
    return ctx.step(lambda sc: {}, name="tail")


def charge_customer(ctx: DurableContext) -> dict:
    ctx.invoke(function_name="payments", payload={}, name="charge")
    if VIP_ENABLED:
        ctx.step(lambda sc: {}, name="vip-perk")
    return {}


@durable_execution
def handler(event: dict, context: DurableContext) -> dict:
    context.parallel(
        [prepare_inventory, charge_customer],
        name="fulfil-order",
    )
    context.step(lambda sc: {}, name="after")
    return {"ok": True}
