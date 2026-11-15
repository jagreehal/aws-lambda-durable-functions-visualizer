import { withDurableExecution } from '@aws/durable-execution-sdk-js'
export const handler = withDurableExecution(async (event, context) => {
  await context.parallel('outer', [
    async (ctx) => { await ctx.parallel('inner', [ async (c) => c.step('a', async () => 1), async (c) => c.step('b', async () => 2) ]); await ctx.step('tail', async () => 0) },
    { name: 'gated', func: async (ctx) => { await ctx.invoke('first', 'Fn'); if (event.vip) { await ctx.step('vip', async () => 1) } } },
  ])
  await context.step('after', async () => 4)
})
