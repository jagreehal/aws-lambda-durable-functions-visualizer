use aws_durable_execution_sdk as durable;

async fn handler(
    event: serde_json::Value,
    ctx: durable::DurableContext,
) -> Result<String, durable::BoxError> {
    if event["vip"].as_bool().unwrap_or(false) {
        ctx.step(|_| async { Ok(1) }).name("fast-track").await?;
    } else {
        ctx.step(|_| async { Ok(2) }).name("queue").await?;
        ctx.step(|_| async { Ok(3) }).name("notify-wait").await?;
    }

    if tier == "gold" {
        ctx.step(|_| async { Ok(1) }).name("gold").await?;
    } else if tier == "silver" {
        ctx.step(|_| async { Ok(2) }).name("silver").await?;
    } else {
        ctx.step(|_| async { Ok(3) }).name("bronze").await?;
        return Ok("bronze".to_owned());
    }

    if skip {
        // nothing durable here
    } else {
        ctx.step(|_| async { Ok(4) }).name("only-else").await?;
    }

    if let Some(id) = event["id"].as_str() {
        ctx.step(|_| async { Ok(5) }).name("with-id").await?;
    } else {
        ctx.step(|_| async { Ok(6) }).name("without-id").await?;
    }

    for attempt in 0..2 {
        if attempt == 0 {
            ctx.step(|_| async { Ok(7) }).name("first-try").await?;
        } else {
            ctx.step(|_| async { Ok(8) }).name("retry-try").await?;
        }
    }

    ctx.step(|_| async { Ok(9) }).name("finish").await?;
    Ok("done".to_owned())
}

#[tokio::main]
async fn main() -> Result<(), lambda_runtime::Error> {
    durable::run(handler).await
}
