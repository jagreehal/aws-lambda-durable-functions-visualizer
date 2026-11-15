package main

import (
	"github.com/aws/aws-durable-execution-sdk-go/durable"
)

type Event struct {
	VIP  bool
	Tier string
	Skip bool
}


func handler(ctx durable.Context, event Event) (string, error) {
	if event.VIP {
		durable.Step(ctx, "fast-track", func(_ durable.StepContext) (int, error) { return 1, nil })
	} else {
		durable.Step(ctx, "queue", func(_ durable.StepContext) (int, error) { return 2, nil })
		durable.Step(ctx, "notify-wait", func(_ durable.StepContext) (int, error) { return 3, nil })
	}

	if event.Tier == "gold" {
		durable.Step(ctx, "gold", func(_ durable.StepContext) (int, error) { return 1, nil })
	} else if event.Tier == "silver" {
		durable.Step(ctx, "silver", func(_ durable.StepContext) (int, error) { return 2, nil })
	} else {
		durable.Step(ctx, "bronze", func(_ durable.StepContext) (int, error) { return 3, nil })
		return "bronze", nil
	}

	if event.Skip {
		// nothing durable here
	} else {
		durable.Step(ctx, "only-else", func(_ durable.StepContext) (int, error) { return 4, nil })
	}

	for i := 0; i < 2; i++ {
		if i == 0 {
			durable.Step(ctx, "first", func(_ durable.StepContext) (int, error) { return 0, nil })
		} else {
			durable.Step(ctx, "later", func(_ durable.StepContext) (int, error) { return i, nil })
		}
	}

	durable.Step(ctx, "finish", func(_ durable.StepContext) (int, error) { return 5, nil })
	return "done", nil
}

func main() { durable.Start(handler) }
