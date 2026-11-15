/**
 * Test fixture: parallel branches from collections built with .Add/.AddRange,
 * a class field, LINQ Select, and scope rules for resolving variables.
 */

using Amazon.Lambda.Core;
using Amazon.Lambda.DurableExecution;

namespace TestFunction;

public class Function
{
    private static readonly DurableBranch<object>[] SharedChecks =
    {
        new("shared", async (c, _) => await c.StepAsync(async (_, _) => 1, name: "shared-step")),
    };

    // Same-named locals in another method must not be picked up by Workflow.
    private void Unrelated(IDurableContext ctx)
    {
        var orphan = new[] { new DurableBranch<object>("wrong-orphan", async (c, _) => await c.StepAsync(async (_, _) => 1, name: "wrong")) };
        var branches = new[] { new DurableBranch<object>("wrong-branches", async (c, _) => null) };
    }

    public Task<DurableExecutionInvocationOutput> Handler(
        DurableExecutionInvocationInput input, ILambdaContext context)
        => DurableFunction.WrapAsync<TestEvent, TestResult>(Workflow, input, context);

    private async Task<TestResult> Workflow(TestEvent input, IDurableContext ctx)
    {
        var branches = new List<DurableBranch<object>>();
        branches.Add(new DurableBranch<object>("first", async (ctx, _) =>
        {
            await ctx.StepAsync(async (_, _) => 1, name: "first-step");
            return null;
        }));
        branches.AddRange(new[]
        {
            new DurableBranch<object>("second", async (c, _) => await c.StepAsync(async (_, _) => 2, name: "second-step")),
        });
        if (input.Extra)
        {
            branches.Add(new("third", async (c, _) => await c.StepAsync(async (_, _) => 3, name: "third-step")));
        }
        await ctx.ParallelAsync(branches, name: "built");

        await ctx.ParallelAsync(SharedChecks, name: "from-field");

        await ctx.ParallelAsync(orphan, name: "orphan");

        await ctx.ParallelAsync(
            input.Regions.Select(r => new DurableBranch<object>($"sync-{r}", async (rc, _) =>
            {
                await rc.StepAsync(async (_, _) => r, name: "sync");
                return null;
            })).ToArray(),
            name: "per-region");

        await ctx.ParallelAsync(
            new[] { new DurableBranch<object>("only", async (c, _) => await c.StepAsync(async (_, _) => 1, name: "only-step")) },
            name: "tight",
            config: new("not-a-branch", async (_, _) => null));

        return new TestResult();
    }
}

public class TestEvent { public bool Extra { get; set; } public List<string> Regions { get; set; } = new(); }
public class TestResult { }
