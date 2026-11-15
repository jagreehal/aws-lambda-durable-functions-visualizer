package main

import (
	"github.com/aws/aws-durable-execution-sdk-go/durable"
)

type Shipper struct{}

func (s *Shipper) pack(c durable.Context) (string, error) {
	return durable.Step(c, "pack", func(sc durable.StepContext) (string, error) { return "packed", nil })
}

func handler(ctx durable.Context, items []string) (string, error) {
	s := &Shipper{}

	label := func(c durable.Context) (string, error) {
		return durable.Step(c, "label", func(sc durable.StepContext) (string, error) { return "l", nil })
	}

	branches := []durable.Branch[string]{
		{Name: "make-label", Func: label},
		{Name: "pack-box", Func: s.pack},
		{Name: "track", Func: func(c durable.Context) (string, error) {
			return durable.Step(c, "tracking", func(sc durable.StepContext) (string, error) { return "t", nil })
		}},
	}

	if _, err := durable.Parallel(ctx, "ship", branches); err != nil {
		return "", err
	}

	var more = []durable.Branch[string]{
		{Name: "notify", Func: func(c durable.Context) (string, error) {
			return durable.Step(c, "notify", func(sc durable.StepContext) (string, error) { return "n", nil })
		}},
	}
	if _, err := durable.Parallel(ctx, "after-ship", more); err != nil {
		return "", err
	}

	reserve := func(c durable.Context, item string, index int) (string, error) {
		return durable.Step(c, "reserve-item", func(sc durable.StepContext) (string, error) { return item, nil })
	}
	if _, err := durable.Map(ctx, "reserve", items, reserve); err != nil {
		return "", err
	}

	return durable.Step(ctx, "done", func(sc durable.StepContext) (string, error) { return "ok", nil })
}

func main() {
	durable.Start(handler)
}
