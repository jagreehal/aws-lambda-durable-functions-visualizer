package main

import (
	"github.com/aws/aws-durable-execution-sdk-go/durable"
)

type Event struct {
	Regions []string
	Race    bool
}

type Mailer struct{}
type Printer struct{}

// Two types with the same method name: resolved by the receiver's type.
func (m *Mailer) send(c durable.Context) (string, error) {
	return durable.Step(c, "mail", func(sc durable.StepContext) (string, error) { return "m", nil })
}

func (p *Printer) send(c durable.Context) (string, error) {
	return durable.Step(c, "print", func(sc durable.StepContext) (string, error) { return "p", nil })
}

// Package-level; the handler's local `fallback` must not leak into report.
var fallback []durable.Branch[string]

func report(ctx durable.Context) (string, error) {
	return durable.Parallel(ctx, "report", fallback)
}

func handler(ctx durable.Context, event Event) (string, error) {
	m := &Mailer{}
	var p Printer

	branches := []durable.Branch[string]{
		{Name: "mail", Func: m.send},
	}
	branches = append(branches, durable.Branch[string]{Name: "print", Func: p.send})
	for _, region := range event.Regions {
		branches = append(branches, durable.Branch[string]{
			Name: region,
			Func: func(c durable.Context) (string, error) {
				return durable.Step(c, "ship-region", func(sc durable.StepContext) (string, error) { return region, nil })
			},
		})
	}
	if _, err := durable.Parallel(ctx, "fan-out", branches); err != nil {
		return "", err
	}

	racers := []durable.Branch[string]{
		{Name: "fast", Func: func(c durable.Context) (string, error) {
			return durable.Step(c, "fast-path", func(sc durable.StepContext) (string, error) { return "f", nil })
		}},
		{Name: "slow", Func: func(c durable.Context) (string, error) {
			return durable.Step(c, "slow-path", func(sc durable.StepContext) (string, error) { return "s", nil })
		}},
	}
	if _, err := durable.Parallel(ctx, "outer", []durable.Branch[string]{
		{Name: "race", Func: func(c durable.Context) (string, error) {
			if event.Race {
				winner, _, err := durable.Select(c, "pick", racers)
				return winner, err
			}
			return "", nil
		}},
	}); err != nil {
		return "", err
	}

	fallback := []durable.Branch[string]{
		{Name: "local-only", Func: func(c durable.Context) (string, error) {
			return durable.Step(c, "local", func(sc durable.StepContext) (string, error) { return "l", nil })
		}},
	}
	if _, err := durable.Parallel(ctx, "local", fallback); err != nil {
		return "", err
	}
	report(ctx)

	return durable.Step(ctx, "done", func(sc durable.StepContext) (string, error) { return "ok", nil })
}

func main() {
	durable.Start(handler)
}
