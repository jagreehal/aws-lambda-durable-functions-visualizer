use aws_durable_execution_sdk as durable;
use durable::Branch;

async fn handler(
    event: serde_json::Value,
    ctx: durable::DurableContext,
) -> Result<serde_json::Value, durable::BoxError> {
    let processed = ctx
        .map(vec![1, 2, 3], |child, item: u32, _idx| async move {
            child.step(|_| async move { Ok(item * 2) }).name("double").await?;
            Ok(item)
        })
        .name("process-items")
        .await?;

    let branches = vec![
        Branch::new("audit", |ctx| async move {
            ctx.step(|_| async { Ok(1) }).name("write-audit").await.map_err(Into::into)
        }),
        Branch::new("notify", |c| notify(c)),
        Branch::new("ship", ship),
        Branch::new("bill", |c| async move { bill(c).await }),
    ];
    ctx.parallel(branches).name("fan-out").await?;

    ctx.step(|_| async { Ok(0) }).name("done").await?;
    Ok(serde_json::json!({ "processed": processed.len() }))
}

async fn notify(ctx: durable::DurableContext) -> Result<(), durable::BoxError> {
    ctx.step(|_| async { Ok(()) }).name("send-email").await?;
    Ok(())
}

async fn ship(ctx: durable::DurableContext) -> Result<(), durable::BoxError> {
    ctx.wait(Duration::from_secs(5)).name("cool-off").await?;
    ship(ctx).await
}

async fn bill(c: durable::DurableContext) -> Result<(), durable::BoxError> {
    c.step(|_| async { Ok(()) }).name("charge").await?;
    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), lambda_runtime::Error> {
    durable::run(handler).await
}
