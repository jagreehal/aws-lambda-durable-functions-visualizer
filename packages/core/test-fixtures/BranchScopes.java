package com.example;

import java.util.function.Function;
import software.amazon.lambda.durable.DurableContext;
import software.amazon.lambda.durable.DurableHandler;

public class BranchScopes extends DurableHandler<Order, String> {

    private void unrelated() {
        Function<DurableContext, String> lateField = xc -> xc.step("wrong-local", String.class, s -> "w");
        Function<DurableContext, String> shared = xc -> xc.step("wrong-shared", String.class, s -> "w");
    }

    @Override
    protected String handleRequest(Order order, DurableContext ctx) {
        Function<DurableContext, String> shared = sc -> sc.step("outer-shared", String.class, s -> "o");
        Function<DurableContext, String> byRef = this::refHelper;
        var p = ctx.parallel("scoped");
        if (order.isVip()) {
            p.branch("shared", String.class, shared);
        }
        p.branch("by-ref", String.class, byRef);
        p.branch("late-field", String.class, lateField);
        for (var region : order.getRegions()) {
            p.branch("region-" + region, String.class, rc -> {
                rc.step("deploy", String.class, s -> "d");
                return "ok";
            });
        }
        p.get();

        ctx.step("after", String.class, s -> "a");
        return "done";
    }

    private String refHelper(DurableContext hc) {
        return hc.step("via-ref-var", String.class, s -> "r");
    }

    private final Function<DurableContext, String> lateField = fc -> fc.step("right-field", String.class, s -> "f");
}
