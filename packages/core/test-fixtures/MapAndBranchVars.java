package com.example;

import java.util.function.Function;
import software.amazon.lambda.durable.DurableContext;
import software.amazon.lambda.durable.DurableHandler;
import software.amazon.lambda.durable.config.Duration;
import software.amazon.lambda.durable.config.MapConfig;

public class MapAndBranchVars extends DurableHandler<Order, String> {

    private final Function<DurableContext, String> fieldBranch = fc -> fc.step("from-field", String.class, s -> "f");

    @Override
    protected String handleRequest(Order order, DurableContext ctx) {
        Function<DurableContext, String> audit = ac -> {
            ac.step("audit-step", String.class, s -> "a");
            return ac.invoke("audit-fn", "Fn", order, String.class);
        };
        var p = ctx.parallel("fan-out");
        p.branch("audit", String.class, audit);
        p.branch("field", String.class, fieldBranch);
        p.branch("ref", String.class, this::notifyCustomer);
        p.get();

        var results = ctx.map("per-item", order.getItems(), String.class, (item, index, mc) -> {
            mc.step("validate-item", String.class, s -> "v");
            if (item.isFragile()) {
                mc.wait("settle", Duration.ofSeconds(5));
            }
            return "ok";
        }, MapConfig.builder().maxConcurrency(2).build());

        var plain = ctx.map("no-durable", order.getItems(), String.class, (item, index, mc) -> item.toString());

        var viaRef = ctx.map("by-ref", order.getItems(), String.class, this::processItem);

        ctx.step("done", String.class, s -> "done");
        return "done";
    }

    private String notifyCustomer(DurableContext nc) {
        return nc.step("notify", String.class, s -> "n");
    }

    private String processItem(Item item, int index, DurableContext pc) {
        return pc.step("process", String.class, s -> "p");
    }
}
