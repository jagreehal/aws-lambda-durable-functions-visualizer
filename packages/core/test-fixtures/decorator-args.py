from aws_durable_execution_sdk_python import DurableContext, durable_execution


@durable_execution(
    plugins=[create_otel_plugin_factory(mode="invocation")],
)
def handler(event: dict, context: DurableContext) -> dict:
    context.step(lambda _: event["id"], name="fetch")
    prompt = f"""Summarise this:
{event["text"]}
Reply in one line."""
    context.step(lambda _: prompt, name="summarise")
    return {"ok": True}
