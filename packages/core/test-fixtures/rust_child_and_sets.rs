use aws_durable_execution_sdk as durable;

async fn handler(
    _event: serde_json::Value,
    ctx: durable::DurableContext,
) -> Result<(), durable::BoxError> {
    let validated = ctx
        .run_in_child_context(|child| async move {
            let a = child.step(|_| async { Ok(1) }).name("validate").await?;
            child.wait(Duration::from_secs(1)).name("settle").await?;
            Ok(a)
        })
        .name("process-order")
        .await?;

    let quiet = ctx
        .run_in_child_context(
            |_child| async move { Ok(42) },
        )
        .name("no-durable")
        .await?;

    let charged = ctx
        .with_retry(move |child, attempt| {
            let request = attempt + 1;
            async move { Ok(child.step(move |_| async move { Ok(request) }).name("charge").await?) }
        })
        .name("charge-with-retry")
        .await?;

    let pair = ctx
        .parallel([
            durable::Branch::unnamed(|c| async move {
                Ok(c.step(|_| async { Ok("a".to_owned()) }).name("a").await?)
            }),
            durable::Branch::unnamed(|c| async move {
                Ok(c.step(|_| async { Ok("b".to_owned()) }).name("b").await?)
            }),
        ])
        .name("pair")
        .await?;

    let mut set = durable::BranchSet::new();
    let count = set.add("count", |child| async move {
        Ok(child.step(|_| async { Ok(7u32) }).name("count-step").await?)
    });
    let status = set.add_with_serdes("status", StatusSerdes, |child| async move {
        Ok(child.step(|_| async { Ok("ready".to_owned()) }).name("status-step").await?)
    });
    ctx.parallel_mixed(set).name("mixed").await?;
    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), lambda_runtime::Error> {
    durable::run(handler).await
}
