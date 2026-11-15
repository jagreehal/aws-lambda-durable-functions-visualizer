/**
 * Test fixture: a parallel whose branches contain durable calls,
 * including a nested parallel.
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
        await ctx.ParallelAsync(
            new[]
            {
                new DurableBranch<object>("first", async (branchCtx, _) =>
                {
                    await branchCtx.ParallelAsync(
                        new[]
                        {
                            new DurableBranch<object>("inner-a", async (c, _) => await c.StepAsync(async (_, _) => 1, name: "a")),
                            new DurableBranch<object>("inner-b", async (c, _) => await c.StepAsync(async (_, _) => 2, name: "b")),
                        },
                        name: "inner");
                    await branchCtx.StepAsync(async (_, _) => 0, name: "tail");
                    return null;
                }),
                new DurableBranch<object>("gated", async (branchCtx, _) =>
                {
                    await branchCtx.InvokeAsync<object, object>("Fn", input, name: "first-invoke");
                    if (input.Vip)
                    {
                        await branchCtx.StepAsync(async (_, _) => 1, name: "vip");
                    }
                    return null;
                }),
            },
            name: "outer");

        await ctx.StepAsync(async (_, _) => 4, name: "after");
        return new TestResult();
    }
}

public class TestEvent { public bool Vip { get; set; } }
public class TestResult { }
