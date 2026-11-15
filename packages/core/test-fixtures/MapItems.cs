/**
 * Test fixture: MapAsync item functions that contain durable calls,
 * as an inline lambda and as a method group.
 */

using Amazon.Lambda.Core;
using Amazon.Lambda.DurableExecution;

namespace TestFunction;

public class Function
{
    public Task<DurableExecutionInvocationOutput> Handler(
        DurableExecutionInvocationInput input, ILambdaContext context)
        => DurableFunction.WrapAsync<TestEvent, TestResult>(Workflow, input, context);

    private async Task<TestResult> Workflow(TestEvent input, IDurableContext ctx)
    {
        var charged = await ctx.MapAsync<string, int>(
            input.Orders,
            async (ctx, item, idx, items, _) =>
            {
                await ctx.StepAsync(async (_, _) => idx, name: "charge");
                await ctx.WaitAsync(TimeSpan.FromSeconds(1), name: "cool-down");
                return idx;
            },
            name: "charge-all");

        var shipped = await ctx.MapAsync<string, int>(input.Orders, ShipItem, name: "ship-all");

        await ctx.StepAsync(async (_, _) => 0, name: "done");
        return new TestResult();
    }

    private async Task<int> ShipItem(IDurableContext itemCtx, string item, int idx, IReadOnlyList<string> items, CancellationToken ct)
    {
        return await itemCtx.StepAsync(async (_, _) => idx, name: "ship");
    }
}

public class TestEvent { public List<string> Orders { get; set; } = new(); }
public class TestResult { }
