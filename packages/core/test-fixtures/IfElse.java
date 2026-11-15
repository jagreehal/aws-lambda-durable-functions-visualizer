package com.example;

import software.amazon.lambda.durable.DurableContext;
import software.amazon.lambda.durable.DurableHandler;

public class IfElse extends DurableHandler<Event, String> {

    @Override
    public String handleRequest(Event event, DurableContext context) {
        if (event.isVip()) {
            context.step("fast-track", Integer.class, s -> 1);
        } else {
            context.step("queue", Integer.class, s -> 2);
            context.step("notify-wait", Integer.class, s -> 3);
        }

        if (event.getTier().equals("gold")) {
            context.step("gold", Integer.class, s -> 1);
        } else if (event.getTier().equals("silver")) {
            context.step("silver", Integer.class, s -> 2);
        } else {
            context.step("bronze", Integer.class, s -> 3);
            return "bronze";
        }

        if (event.isSkip()) {
            // nothing durable here
        } else {
            context.step("only-else", Integer.class, s -> 4);
        }

        for (var order : event.getOrders()) {
            if (order.isRush()) {
                context.step("rush", Integer.class, s -> 5);
            } else {
                context.step("standard", Integer.class, s -> 6);
            }
        }

        context.step("finish", Integer.class, s -> 5);
        return "done";
    }
}
