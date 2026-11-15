import { withDurableExecution, type DurableContext } from '@aws/durable-execution-sdk-js'

export const handler = withDurableExecution(async (event: { vip: boolean; tier: string; skip: boolean }, context: DurableContext) => {
  if (event.vip) {
    await context.step('fast-track', async () => 1)
  } else {
    await context.step('queue', async () => 2)
    await context.step('notify-wait', async () => 3)
  }

  if (event.tier === 'gold') {
    await context.step('gold', async () => 1)
  } else if (event.tier === 'silver') {
    await context.step('silver', async () => 2)
  } else {
    await context.step('bronze', async () => 3)
    return 'bronze'
  }

  if (event.skip) {
    // nothing durable here
  } else {
    await context.step('only-else', async () => 4)
  }

  await context.step('finish', async () => 5)
})
