from aws_durable_execution_sdk_python import DurableContext, durable_execution
from aws_durable_execution_sdk_python.config import Duration, ParallelBranch


def other_workflow(ctx: DurableContext) -> None:
    branches = [lambda c: c.step(lambda sc: {}, name="wrong-function")]
    ctx.parallel(branches)


def make_charger(region: str):
    def run(ctx: DurableContext) -> dict:
        return ctx.step(lambda sc: region, name="charge-region")
    return run


def third(ctx: DurableContext) -> dict:
    return ctx.step(lambda sc: {}, name="third")


@durable_execution
def handler(event: dict, context: DurableContext) -> dict:
    def stale(ctx: DurableContext) -> None:
        branches = [lambda c: c.step(lambda sc: {}, name="wrong-nested")]

    branches = [lambda ctx: ctx.step(lambda sc: {}, name="first")]
    branches.append(lambda ctx: ctx.step(lambda sc: {}, name="second"))
    branches.extend([third])
    branches += [ParallelBranch(func=lambda ctx: ctx.wait(Duration.from_seconds(1), name="fourth"), name="fourth")]
    context.parallel(branches, name="built-up")

    regions = event["regions"]
    context.parallel([ParallelBranch(func=make_charger(r)) for r in regions], name="per-region")
    context.parallel([lambda ctx, r=r: ctx.step(lambda sc: r, name="ship-region") for r in regions], name="lambda-comp")
    context.parallel(list(map(make_charger, regions)), name="mapped")
    context.parallel([build_branch(r) for r in regions], name="opaque")
    return {"ok": True}
