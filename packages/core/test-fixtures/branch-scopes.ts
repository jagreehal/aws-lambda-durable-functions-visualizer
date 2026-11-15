import { withDurableExecution, type DurableContext } from '@aws/durable-execution-sdk-js'

// Same name as the handler's list, in another function: must not be picked up
function unrelated() {
  const branches = [async (ctx: DurableContext) => { await ctx.step('wrong', async () => 0) }]
  return branches
}

export const handler = withDurableExecution(async (event: { vip: boolean; regions: string[] }, context: DurableContext) => {
  const branches = [async (ctx: DurableContext) => { await ctx.step('first', async () => 1) }]
  branches.push(async (ctx: DurableContext) => { await ctx.step('pushed', async () => 2) })
  if (event.vip) {
    await context.parallel('fan-out', branches)
  }

  const perRegion = event.regions.map((region) => async (ctx: DurableContext) => {
    await ctx.step(`deploy-${region}`, async () => region)
  })
  await context.parallel('regions', perRegion)
})
