/**
 * Test fixture: parallel branches built before the ParallelAsync call,
 * including target-typed constructors and a lambda held in a variable.
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
        Func<IDurableContext, CancellationToken, Task<object>> audit = async (ctx, _) =>
        {
            await ctx.StepAsync(async (_, _) => 1, name: "write-audit");
            return null;
        };

        var branches = new[]
        {
            new DurableBranch<object>("reserve", async (ctx, _) =>
            {
                await ctx.StepAsync(async (_, _) => 1, name: "reserve-stock");
                return null;
            }),
            new DurableBranch<object>("audit", audit),
        };

        await ctx.ParallelAsync(branches, name: "prepare");

        var checks = new List<DurableBranch<object>>
        {
            new("fraud", async (c, _) => await c.InvokeAsync<object, object>("FraudFn", input, name: "fraud-check")),
            new("noop", async (_, _) => null),
        };

        await ctx.ParallelAsync(checks, name: "verify");
        return new TestResult();
    }
}

public class TestEvent { }
public class TestResult { }
