use aws_durable_execution_sdk as durable;
use durable::Branch;

async fn handler(
    event: serde_json::Value,
    ctx: durable::DurableContext,
) -> Result<serde_json::Value, durable::BoxError> {
    ctx.parallel(vec![
        Branch::new("prepare", |outer| async move {
            outer
                .parallel(vec![
                    Branch::new("a", |c| async move {
                        c.step(|_| async { Ok(1) }).name("a").await.map_err(Into::into)
                    }),
                    Branch::new("b", |c| async move {
                        c.step(|_| async { Ok(2) }).name("b").await.map_err(Into::into)
                    }),
                ])
                .name("inner")
                .await?;
            outer.step(|_| async { Ok(0) }).name("tail").await?;
            Ok(())
        }),
        Branch::new("gated", |ctx| async move {
            ctx.invoke("fulfillment", serde_json::json!({})).name("first").await?;
            if event["vip"].as_bool().unwrap_or(false) {
                ctx.step(|_| async { Ok(1) }).name("vip").await?;
            }
            Ok(())
        }),
    ])
    .name("outer")
    .await?;

    ctx.step(|_| async { Ok(4) }).name("after").await?;
    Ok(serde_json::json!({}))
}

#[tokio::main]
async fn main() -> Result<(), lambda_runtime::Error> {
    durable::run(handler).await
}
