package main

import (
	"github.com/aws/aws-durable-execution-sdk-go/durable"
)

type Event struct {
	VIP bool
}

func handler(ctx durable.Context, event Event) (string, error) {
	_, err := durable.Parallel(ctx, "outer", []durable.Branch[string]{
		{
			Name: "nested",
			Func: func(branch durable.Context) (string, error) {
				if _, err := durable.Parallel(branch, "inner", []durable.Branch[int]{
					{Name: "a", Func: func(c durable.Context) (int, error) {
						return durable.Step(c, "a", func(sc durable.StepContext) (int, error) { return 1, nil })
					}},
					{Name: "b", Func: func(c durable.Context) (int, error) {
						return durable.Step(c, "b", func(sc durable.StepContext) (int, error) { return 2, nil })
					}},
				}); err != nil {
					return "", err
				}
				return durable.Step(branch, "tail", func(sc durable.StepContext) (string, error) {
					return "done", nil
				})
			},
		},
		{
			Name: "gated",
			Func: func(branch durable.Context) (string, error) {
				if _, err := durable.Invoke[string](branch, "first", "Fn", "input"); err != nil {
					return "", err
				}
				if event.VIP {
					if _, err := durable.Step(branch, "vip", func(sc durable.StepContext) (string, error) {
						return "vip", nil
					}); err != nil {
						return "", err
					}
				}
				return "ok", nil
			},
		},
	})
	if err != nil {
		return "", err
	}

	return durable.Step(ctx, "after", func(sc durable.StepContext) (string, error) {
		return "after", nil
	})
}

func main() {
	durable.Start(handler)
}
