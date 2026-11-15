package main

import (
	"time"

	"github.com/aws/aws-durable-execution-sdk-go/durable"
)

func handler(ctx durable.Context, _ any) (string, error) {
	compute := durable.NewTypedBranch("compute", func(ctx durable.Context) (int, error) {
		return durable.Step(ctx, "compute-value", func(_ durable.StepContext) (int, error) { return 1, nil })
	})
	timer := durable.NewTypedBranch("timer", func(ctx durable.Context) (int, error) {
		return 0, durable.Wait(ctx, "short-timer", time.Second)
	})
	if _, err := durable.ParallelMixed(ctx, "mixed", []durable.AnyBranch{compute, timer}); err != nil {
		return "", err
	}

	branch := func(name, fill string) durable.Branch[string] {
		return durable.Branch[string]{Name: name, Func: func(ctx durable.Context) (string, error) {
			return durable.Step(ctx, "fill", func(durable.StepContext) (string, error) { return fill, nil })
		}}
	}
	if _, err := durable.Parallel(ctx, "made", []durable.Branch[string]{
		branch("a", "x"),
		branch("b", "y"),
	}, durable.WithMaxConcurrency(2)); err != nil {
		return "", err
	}
	return "done", nil
}

func main() { durable.Start(handler) }
