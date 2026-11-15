package com.example;

import software.amazon.lambda.durable.DurableContext;
import software.amazon.lambda.durable.DurableHandler;

public class NestedParallel extends DurableHandler<Order, String> {

    @Override
    protected String handleRequest(Order order, DurableContext ctx) {
        var outer = ctx.parallel("outer");
        outer.branch("first", String.class, branchCtx -> {
            var inner = branchCtx.parallel("inner");
            inner.branch("a", Integer.class, c -> c.step("a", Integer.class, s -> 1));
            inner.branch("b", Integer.class, c -> c.step("b", Integer.class, s -> 2));
            inner.get();
            return branchCtx.step("tail", String.class, s -> "done");
        });
        outer.branch("gated", String.class, branchCtx -> {
            branchCtx.invoke("first", "Fn", order, String.class);
            if (order.isVip()) {
                branchCtx.step("vip", String.class, s -> "vip");
            }
            return "ok";
        });
        outer.get();

        ctx.step("after", String.class, s -> "after");
        return "done";
    }
}
