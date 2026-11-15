import software.amazon.lambda.durable.DurableContext;
import software.amazon.lambda.durable.DurableHandler;
import software.amazon.lambda.durable.model.ParallelResult;

public class TryParallel extends DurableHandler<Void, ParallelResult> {
    // Some docs examples name the entry method `handle` instead of `handleRequest`
    @Override
    public ParallelResult handle(Void input, DurableContext context) {
        try (var outer = context.parallel("outer")) {
            outer.branch("group-a", ParallelResult.class, ctx -> {
                try (var inner = ctx.parallel("inner-a")) {
                    inner.branch("a1", String.class, c -> c.step("a1", String.class, s -> "a1"));
                    inner.branch("a2", String.class, c -> c.step("a2", String.class, s -> "a2"));
                    return inner.get();
                }
            });
            outer.branch("group-b", ParallelResult.class, ctx -> ctx.step("b", String.class, s -> "b"));
            context.step("inside-try", String.class, s -> "t");
            return outer.get();
        }
    }
}
