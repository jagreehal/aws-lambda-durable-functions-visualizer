package com.example;

import java.time.Duration;
import software.amazon.lambda.durable.DurableContext;
import software.amazon.lambda.durable.DurableFuture;
import software.amazon.lambda.durable.DurableHandler;
import software.amazon.lambda.durable.config.WithRetryConfig;

public class ChildContexts extends DurableHandler<Order, String> {

    @Override
    public String handleRequest(Order order, DurableContext context) {
        var validation = context.runInChildContextAsync("validation", String.class, child -> {
            var prepared = child.step("prepare", String.class, s -> "p");
            child.wait("settle", Duration.ofSeconds(5));
            var adjusted = child.runInChildContext(
                    "nested",
                    String.class,
                    nested -> nested.step("lookup", String.class, s -> prepared));
            return adjusted;
        });
        var viaRef = context.runInChildContext("by-ref", String.class, this::shipping);
        var plain = context.runInChildContext("plain", String.class, child -> "nothing durable");
        var charged = context.withRetry(
                "charge",
                (attempt, ctx) -> ctx.invoke("charge-" + attempt, "payment-fn", order, String.class),
                WithRetryConfig.builder().build());
        DurableFuture.allOf(validation);
        return context.step("finish", String.class, s -> "done");
    }

    private String shipping(DurableContext sc) {
        return sc.step("ship", String.class, s -> "s");
    }
}
