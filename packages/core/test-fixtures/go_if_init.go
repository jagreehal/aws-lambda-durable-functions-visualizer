package main

import (
	"strings"

	"github.com/aws/aws-durable-execution-sdk-go/durable"
)

type Event struct {
	Tier string
}

func handler(ctx durable.Context, event Event) (string, error) {
	// Init with a durable call (a func literal holding a `;` in a string), then else
	if _, err := durable.Step(ctx, "charge", func(_ durable.StepContext) (string, error) {
		return "a;b", nil
	}); err != nil {
		durable.Step(ctx, "refund", func(_ durable.StepContext) (int, error) { return 1, nil })
	} else {
		durable.Step(ctx, "receipt", func(_ durable.StepContext) (int, error) { return 2, nil })
		return "paid", nil
	}

	// Init without a durable call
	if tier := strings.ToLower(event.Tier); tier == "gold" {
		durable.Step(ctx, "gold", func(_ durable.StepContext) (int, error) { return 1, nil })
	} else if n := len(tier); n > 3 {
		durable.Step(ctx, "long-tier", func(_ durable.StepContext) (int, error) { return 2, nil })
	} else if v, err := durable.Step(ctx, "lookup", func(_ durable.StepContext) (string, error) { return "x;y", nil }); err == nil && v != "" {
		durable.Step(ctx, "found", func(_ durable.StepContext) (int, error) { return 3, nil })
	}

	// Error handling only: the call is kept, no condition
	if err := durable.Wait(ctx, "pause", 0); err != nil {
		return "", err
	}

	durable.Step(ctx, "finish", func(_ durable.StepContext) (int, error) { return 5, nil })
	return "done", nil
}

func main() { durable.Start(handler) }
