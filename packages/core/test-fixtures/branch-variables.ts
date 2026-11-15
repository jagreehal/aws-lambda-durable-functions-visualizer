import { withDurableExecution, type DurableContext } from '@aws/durable-execution-sdk-js'

async function reserveStock(ctx: DurableContext) {
  await ctx.step('reserve', async () => 1)
}

export const handler = withDurableExecution(async (event: { items: string[] }, context: DurableContext) => {
  const branches = [
    async (ctx: DurableContext) => { await ctx.step('charge', async () => 1) },
    reserveStock,
  ]
  await context.parallel('prepare', branches)

  const shipItem = async (ctx: DurableContext, item: string) => {
    await ctx.step('ship', async () => item)
  }
  await context.map('ship-all', event.items, shipItem)

  await context.step('notify', async () => 0)
})
