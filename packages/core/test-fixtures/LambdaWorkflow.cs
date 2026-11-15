/**
 * Test fixture: the workflow passed to WrapAsync is a lambda.
 */

using Amazon.Lambda.Core;
using Amazon.Lambda.DurableExecution;

public class Function
{
    public Task<DurableExecutionInvocationOutput> Handler(
        DurableExecutionInvocationInput input, ILambdaContext context)
        => DurableFunction.WrapAsync<object, string>(async (evt, durable) =>
        {
            await durable.StepAsync(async (_, _) => 1, name: "lambda-step");
            await durable.WaitAsync(TimeSpan.FromSeconds(5), name: "lambda-wait");
            return "ok";
        }, input, context);
}
