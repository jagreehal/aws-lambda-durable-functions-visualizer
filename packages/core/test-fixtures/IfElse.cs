/**
 * Test fixture: if / else / else-if chains (mirrors if-else.ts), in K&R,
 * Allman and braceless styles.
 */

using Amazon.Lambda.Core;
using Amazon.Lambda.DurableExecution;

namespace TestFunction;

public class Function
{
    public Task<DurableExecutionInvocationOutput> Handler(
        DurableExecutionInvocationInput input, ILambdaContext context)
        => DurableFunction.WrapAsync<TestEvent, string>(Workflow, input, context);

    private async Task<string> Workflow(TestEvent input, IDurableContext ctx)
    {
        if (input.Vip) {
            await ctx.StepAsync(async (_, _) => 1, name: "fast-track");
        } else {
            await ctx.StepAsync(async (_, _) => 2, name: "queue");
            await ctx.StepAsync(async (_, _) => 3, name: "notify-wait");
        }

        if (input.Tier == "gold")
        {
            await ctx.StepAsync(async (_, _) => 1, name: "gold");
        }
        else if (input.Tier == "silver")
            await ctx.StepAsync(async (_, _) => 2, name: "silver");
        else
        {
            await ctx.StepAsync(async (_, _) => 3, name: "bronze");
            return "bronze";
        }

        if (input.Skip)
        {
            // nothing durable here
        }
        else
        {
            await ctx.StepAsync(async (_, _) => 4, name: "only-else");
        }

        await ctx.StepAsync(async (_, _) => 5, name: "finish");
        return "done";
    }
}

public class TestEvent { public bool Vip { get; set; } public string Tier { get; set; } = ""; public bool Skip { get; set; } }
