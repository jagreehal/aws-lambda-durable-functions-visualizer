/**
 * Test fixture: WrapAsync with nested generic arguments and a class-qualified
 * method group, an expression-bodied workflow, and child contexts.
 */

using Amazon.Lambda.Core;
using Amazon.Lambda.DurableExecution;

public class Function
{
    public Task<DurableExecutionInvocationOutput> Handler(
        DurableExecutionInvocationInput input, ILambdaContext context)
        => DurableFunction.WrapAsync<object, IReadOnlyList<string>>(
            Workflows.RunAsync, input, context);
}

public static class Workflows
{
    public static Task<IReadOnlyList<string>> RunAsync(object input, IDurableContext ctx)
        => ctx.RunInChildContextAsync(
            async (child, _) =>
            {
                await child.StepAsync(async (_, _) => 1, name: "inner-a");
                await child.WaitAsync(TimeSpan.FromSeconds(1), name: "inner-wait");
                await child.RunInChildContextAsync(Helper, name: "helper");
                await child.RunInChildContextAsync(async (_, _) => { await Task.CompletedTask; return 0; }, name: "empty");
                return (IReadOnlyList<string>)new[] { "ok" };
            },
            name: "process");

    private static async Task<int> Helper(IDurableContext helperCtx, CancellationToken ct)
    {
        return await helperCtx.StepAsync(async (_, _) => 2, name: "helper-step");
    }
}
