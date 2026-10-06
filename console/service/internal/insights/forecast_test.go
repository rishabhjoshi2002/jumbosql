package insights

import (
	"math"
	"testing"
	"time"
)

var t0 = time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)

func day(d float64) time.Time { return t0.Add(time.Duration(d * 24 * float64(time.Hour))) }

func near(a, b, eps float64) bool { return math.Abs(a-b) <= eps }

func TestLinearFitAndForecast(t *testing.T) {
	// 10 GB growing 0.5 GB / day for 20 days
	var pts []Point
	for d := 0; d <= 20; d++ {
		pts = append(pts, Point{T: day(float64(d)), V: 10e9 + 0.5e9*float64(d)})
	}
	fit, ok := LinearFit(pts)
	if !ok || !near(fit.Slope, 0.5e9, 1) || !near(fit.R2, 1, 1e-9) || fit.Confidence() != "high" {
		t.Fatalf("fit = %+v", fit)
	}
	now := day(20)
	if d := fit.DaysUntil(25e9, now); !near(d, 10, 1e-6) {
		t.Fatalf("days until 25 GB = %v", d)
	}
	f := MakeForecast(pts, 30, now)
	if !near(f.In30Days, 20e9+15e9, 1) || !f.HasForecast || len(f.Line) != 2 {
		t.Fatalf("forecast = %+v", f)
	}
	// shrinking never forecasts below zero, and never "reaches" a higher limit
	shrink := []Point{{day(0), 10}, {day(1), 5}, {day(2), 1}}
	f = MakeForecast(shrink, 30, day(2))
	if f.In30Days != 0 {
		t.Fatalf("shrinking forecast = %v", f.In30Days)
	}
	fit, _ = LinearFit(shrink)
	if fit.DaysUntil(100, day(2)) != -1 {
		t.Fatal("a shrinking series never reaches the limit")
	}
	if _, ok := LinearFit(pts[:1]); ok {
		t.Fatal("one point is not a trend")
	}
}

func TestRatesSkipResetsAndGaps(t *testing.T) {
	c := []Point{
		{t0, 100},
		{t0.Add(10 * time.Second), 200},  // 10/s
		{t0.Add(20 * time.Second), 50},   // reset -> skipped
		{t0.Add(30 * time.Second), 150},  // 10/s
		{t0.Add(2 * time.Hour), 1000000}, // gap -> skipped
	}
	r := Rates(c, time.Hour)
	if len(r) != 2 || r[0].V != 10 || r[1].V != 10 {
		t.Fatalf("rates = %+v", r)
	}
}

func TestDownsampleAndPercentile(t *testing.T) {
	var pts []Point
	for i := 0; i < 1000; i++ {
		pts = append(pts, Point{T: t0.Add(time.Duration(i) * time.Minute), V: float64(i % 100)})
	}
	d := Downsample(pts, 100)
	if len(d) > 100 || len(d) < 90 {
		t.Fatalf("downsampled to %d points", len(d))
	}
	if p := Percentile(pts, 95); p != 94 {
		t.Fatalf("p95 = %v", p)
	}
	if Percentile(nil, 95) != 0 || Last(nil) != 0 {
		t.Fatal("empty series")
	}
}
