use aws_durable_execution_sdk as durable;
use durable::Branch;

fn split(event: &serde_json::Value) -> (Vec<Branch>, usize) {
    let extra = vec![Branch::new("decoy", |c| async move {
        c.step(|_| async { Ok(()) }).name("decoy-step").await.map_err(Into::into)
    })];
    (extra, 1)
}

async fn handler(
    event: serde_json::Value,
    ctx: durable::DurableContext,
) -> Result<serde_json::Value, durable::BoxError> {
    let items: Vec<String> = vec!["a".into(), "b".into()];
    let (extra, _count) = split(&event);
    let branches = vec![Branch::new("stale", |c| async move {
        c.step(|_| async { Ok(()) }).name("stale-step").await.map_err(Into::into)
    })];
    let mut branches = vec![Branch::new("first", |c| async move {
        c.step(|_| async { Ok(1) }).name("first-step").await.map_err(Into::into)
    })];
    {
        let branches = vec![Branch::new("sibling", |c| async move {
            c.step(|_| async { Ok(()) }).name("sibling-step").await.map_err(Into::into)
        })];
        drop(branches);
    }
    branches.push(Branch::new("pushed", |c| async move {
        c.step(|_| async { Ok(2) }).name("pushed-step").await.map_err(Into::into)
    }));
    branches.extend(vec![Branch::new("extended", |c| async move {
        c.wait(Duration::from_secs(1)).name("extended-wait").await.map_err(Into::into)
    })]);

    if event["fan_out"].as_bool().unwrap_or(true) {
        ctx.parallel(branches).name("scoped").await?;
    }

    let generated: Vec<_> = items
        .iter()
        .map(|item| Branch::new(format!("item-{item}"), |c| async move {
            c.step(|_| async { Ok(()) }).name("per-item").await.map_err(Into::into)
        }))
        .collect();
    ctx.parallel(generated).name("generated").await?;

    ctx.parallel(extra).name("unresolved").await?;

    ctx.map(items.iter().map(|s| s.len()).collect::<Vec<_>>(), |child, len: usize, _idx| async move {
        child.step(|_| async move { Ok(len) }).name("measure").await?;
        Ok(len)
    })
    .name("measure-all")
    .await?;

    Ok(serde_json::json!({}))
}

#[tokio::main]
async fn main() -> Result<(), lambda_runtime::Error> {
    durable::run(handler).await
}
