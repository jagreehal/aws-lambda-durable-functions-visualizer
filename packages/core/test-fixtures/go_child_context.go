package main

import (
	"time"

	"github.com/aws/aws-durable-execution-sdk-go/durable"
)

func charge(c durable.Context, attempt int) (string, error) {
	return durable.Invoke[string](c, "charge-card", "payments", attempt)
}

func handler(ctx durable.Context, _ any) (string, error) {
	if _, err := durable.RunInChildContext(ctx, "validate", func(child durable.Context) (string, error) {
		if _, err := durable.Step(child, "check-stock", func(_ durable.StepContext) (string, error) { return "ok", nil }); err != nil {
			return "", err
		}
		return "", durable.Wait(child, "settle", time.Second)
	}); err != nil {
		return "", err
	}

	task := durable.Go(ctx, "background", func(childCtx durable.Context) (string, error) {
		return durable.Step(childCtx, "bg-step", func(_ durable.StepContext) (string, error) { return "bg", nil })
	})
	idle := durable.Go(ctx, "idle", func(childCtx durable.Context) (string, error) {
		return "nothing durable", nil
	})
	if _, err := durable.All(ctx, "join", []*durable.Future[string]{task, idle}); err != nil {
		return "", err
	}

	if _, err := durable.Retry(ctx, "charge", charge, durable.NoRetry()); err != nil {
		return "", err
	}

	// An immediately invoked func literal runs in place.
	err := func() error {
		_, err := durable.Step(ctx, "in-place", func(_ durable.StepContext) (string, error) { return "", nil })
		return err
	}()
	return "", err
}

func main() { durable.Start(handler) }
