import { withDurableExecution } from '@aws/durable-execution-sdk-js'
export const handler = withDurableExecution(async (event, context) => {
  await context.map('each', event.items, async (ctx, item) => { await ctx.step('charge', async () => 1) })
})
