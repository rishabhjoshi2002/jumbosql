// Package insights samples clusters, fits trends and turns them into forecasts and recommendations
// (pg_genie Insights page).
package insights

import (
	"math"
	"sort"
	"time"
)

// Point is one value at one time.
type Point struct {
	T time.Time `json:"t"`
	V float64   `json:"v"`
}

// Fit is a least-squares straight line through a series: value = Intercept + Slope * seconds since Origin.
type Fit struct {
	Origin    time.Time `json:"-"`
	Slope     float64   `json:"slope_per_day"` // per day (stored per day for readability)
	Intercept float64   `json:"-"`
	R2        float64   `json:"r2"` // 0..1, how well the line explains the data
	N         int       `json:"n"`
	Span      float64   `json:"span_days"` // how many days of data the fit is based on
	xMean     float64   // for the prediction range
	sxx       float64
	sigma     float64 // standard deviation of the residuals
}

// LinearFit fits a straight line (ordinary least squares). Needs at least 2 points over a non-zero time span.
func LinearFit(pts []Point) (Fit, bool) {
	if len(pts) < 2 {
		return Fit{}, false
	}
	origin := pts[0].T
	var sx, sy, sxx, sxy float64
	n := float64(len(pts))
	for _, p := range pts {
		x := p.T.Sub(origin).Hours() / 24
		sx += x
		sy += p.V
		sxx += x * x
		sxy += x * p.V
	}
	den := n*sxx - sx*sx
	span := pts[len(pts)-1].T.Sub(origin).Hours() / 24
	if den == 0 || span <= 0 {
		return Fit{}, false
	}
	slope := (n*sxy - sx*sy) / den
	icpt := (sy - slope*sx) / n
	// R²
	mean := sy / n
	var ssTot, ssRes float64
	for _, p := range pts {
		x := p.T.Sub(origin).Hours() / 24
		d := p.V - mean
		ssTot += d * d
		r := p.V - (icpt + slope*x)
		ssRes += r * r
	}
	r2 := 1.0
	if ssTot > 0 {
		r2 = math.Max(0, 1-ssRes/ssTot)
	}
	sigma := 0.0
	if len(pts) > 2 {
		sigma = math.Sqrt(ssRes / float64(len(pts)-2))
	}
	return Fit{Origin: origin, Slope: slope, Intercept: icpt, R2: r2, N: len(pts), Span: span,
		xMean: sx / n, sxx: sxx - sx*sx/n, sigma: sigma}, true
}

// At is the fitted value at time t.
func (f Fit) At(t time.Time) float64 {
	return f.Intercept + f.Slope*t.Sub(f.Origin).Hours()/24
}

// DaysUntil: days from now until the line reaches limit (-1 when it never does / is not growing).
func (f Fit) DaysUntil(limit float64, now time.Time) float64 {
	cur := f.At(now)
	if cur >= limit {
		return 0
	}
	if f.Slope <= 0 {
		return -1
	}
	return (limit - cur) / f.Slope
}

// Confidence of a forecast, from how much history there is and how straight the trend is.
func (f Fit) Confidence() string {
	switch {
	case f.Span < 1 || f.N < 6:
		return "low"
	case f.Span < 7 || f.R2 < 0.5:
		return "medium"
	default:
		return "high"
	}
}

// Rates turns a cumulative counter into per-second rates between consecutive samples. Counter resets
// (server restart, stats reset) and gaps longer than maxGap are skipped.
func Rates(counter []Point, maxGap time.Duration) []Point {
	var out []Point
	for i := 1; i < len(counter); i++ {
		dt := counter[i].T.Sub(counter[i-1].T)
		dv := counter[i].V - counter[i-1].V
		if dt <= 0 || dv < 0 || (maxGap > 0 && dt > maxGap) {
			continue
		}
		out = append(out, Point{T: counter[i].T, V: dv / dt.Seconds()})
	}
	return out
}

// Downsample averages a series into at most n buckets of equal time width (keeps short series as they are).
func Downsample(pts []Point, n int) []Point {
	if n <= 0 || len(pts) <= n {
		return pts
	}
	start, end := pts[0].T, pts[len(pts)-1].T
	width := end.Sub(start) / time.Duration(n)
	if width <= 0 {
		return pts[len(pts)-n:]
	}
	var out []Point
	var sumT, sumV float64
	cnt := 0
	bucket := 0
	flush := func() {
		if cnt > 0 {
			out = append(out, Point{T: time.Unix(0, int64(sumT/float64(cnt))), V: sumV / float64(cnt)})
		}
		sumT, sumV, cnt = 0, 0, 0
	}
	for _, p := range pts {
		b := int(p.T.Sub(start) / width)
		if b >= n {
			b = n - 1
		}
		if b != bucket {
			flush()
			bucket = b
		}
		sumT += float64(p.T.UnixNano())
		sumV += p.V
		cnt++
	}
	flush()
	return out
}

// Percentile of the values (p in 0..100, nearest rank). 0 for an empty series.
func Percentile(pts []Point, p float64) float64 {
	if len(pts) == 0 {
		return 0
	}
	vals := make([]float64, len(pts))
	for i, x := range pts {
		vals[i] = x.V
	}
	sort.Float64s(vals)
	idx := int(math.Ceil(p/100*float64(len(vals)))) - 1
	if idx < 0 {
		idx = 0
	}
	if idx >= len(vals) {
		idx = len(vals) - 1
	}
	return vals[idx]
}

// Last value of a series (0 when empty).
func Last(pts []Point) float64 {
	if len(pts) == 0 {
		return 0
	}
	return pts[len(pts)-1].V
}

// Projection is the predicted value some days ahead, with its likely range (about 95 %).
type Projection struct {
	Days     int       `json:"days"`
	At       time.Time `json:"at"`
	V        float64   `json:"v"`
	Low      float64   `json:"low"`
	High     float64   `json:"high"`
	Reliable bool      `json:"reliable"` // false when it looks much further ahead than the history behind it
}

// BandPoint is one point of the forecast line with its range.
type BandPoint struct {
	T    time.Time `json:"t"`
	V    float64   `json:"v"`
	Low  float64   `json:"low"`
	High float64   `json:"high"`
}

// Horizons shown in capacity planning.
var Horizons = []int{30, 90, 180, 365}

// Forecast is what the UI shows for one metric: now, the trend, projections and the line (with range) to draw.
type Forecast struct {
	Current        float64      `json:"current"`
	PerDay         float64      `json:"per_day"`          // growth per day now (compound: at today's level)
	GrowthPctMonth float64      `json:"growth_pct_month"` // % per 30 days
	In30Days       float64      `json:"in_30_days"`
	Horizon        int          `json:"horizon_days"`
	Model          string       `json:"model"` // linear | compound
	R2             float64      `json:"r2"`
	SpanDays       float64      `json:"span_days"`
	Confidence     string       `json:"confidence"`
	Line           []Point      `json:"line"` // from the last sample to the horizon (2 points)
	Band           []BandPoint  `json:"band"` // the same, with the likely range, in steps
	Projections    []Projection `json:"projections"`
	HasForecast    bool         `json:"has_forecast"`

	fit  Fit // value (linear) or log(value) (compound) against days
	last time.Time
}

// MinForecastSpan: less history than this gives no forecast (minutes of samples make wild trends).
var MinForecastSpan = time.Hour

// ValueAt: predicted value and its likely range at time t.
func (f Forecast) ValueAt(t time.Time) (v, low, high float64) {
	if !f.HasForecast {
		return f.Current, f.Current, f.Current
	}
	x := t.Sub(f.fit.Origin).Hours() / 24
	mid := f.fit.Intercept + f.fit.Slope*x
	hw := 0.0
	if f.fit.N > 2 && f.fit.sxx > 0 {
		hw = 1.96 * f.fit.sigma * math.Sqrt(1+1/float64(f.fit.N)+(x-f.fit.xMean)*(x-f.fit.xMean)/f.fit.sxx)
	}
	if f.Model == "compound" {
		capLog := math.Log(math.Max(f.Current, 1e-9) * 1000) // never more than 1000 x today
		return math.Exp(math.Min(mid, capLog)), math.Exp(math.Min(mid-hw, capLog)), math.Exp(math.Min(mid+hw, capLog))
	}
	return math.Max(0, mid), math.Max(0, mid-hw), math.Max(0, mid+hw)
}

// DaysTo: days from now until the predicted value reaches limit (0 = already, -1 = not growing towards it).
func (f Forecast) DaysTo(limit float64, now time.Time) float64 {
	if !f.HasForecast || limit <= 0 {
		return -1
	}
	cur, _, _ := f.ValueAt(now)
	if cur >= limit || f.Current >= limit {
		return 0
	}
	if f.fit.Slope <= 0 {
		return -1
	}
	x0 := now.Sub(f.fit.Origin).Hours() / 24
	var x float64
	if f.Model == "compound" {
		x = (math.Log(limit) - f.fit.Intercept) / f.fit.Slope
	} else {
		x = (limit - f.fit.Intercept) / f.fit.Slope
	}
	return math.Max(0, x-x0)
}

// MakeForecast fits pts (straight line, or compound growth when that fits clearly better) and projects horizon
// days ahead.
func MakeForecast(pts []Point, horizon int, now time.Time) Forecast {
	f := Forecast{Current: Last(pts), Horizon: horizon, Confidence: "low", Model: "linear", Projections: []Projection{}}
	fit, ok := LinearFit(pts)
	if !ok || fit.Span < MinForecastSpan.Hours()/24 {
		f.In30Days = f.Current // not enough history for a trend yet
		return f
	}
	f.fit, f.R2, f.SpanDays, f.HasForecast = fit, fit.R2, fit.Span, true
	f.last = pts[len(pts)-1].T

	// compound growth: a straight line through log(value) - only when every value is positive, there is a week of
	// history, and it explains the data clearly better than the straight line
	if fit.Slope > 0 && fit.Span >= 7 && len(pts) >= 12 {
		positive := true
		logs := make([]Point, len(pts))
		for i, p := range pts {
			if p.V <= 0 {
				positive = false
				break
			}
			logs[i] = Point{T: p.T, V: math.Log(p.V)}
		}
		if positive {
			if lf, ok := LinearFit(logs); ok && lf.Slope > 0 {
				var ssRes, ssTot, mean float64
				for _, p := range pts {
					mean += p.V
				}
				mean /= float64(len(pts))
				for _, p := range pts {
					x := p.T.Sub(lf.Origin).Hours() / 24
					r := p.V - math.Exp(lf.Intercept+lf.Slope*x)
					ssRes += r * r
					ssTot += (p.V - mean) * (p.V - mean)
				}
				if ssTot > 0 {
					// it must at least halve the error the straight line leaves unexplained
					if r2 := math.Max(0, 1-ssRes/ssTot); 1-r2 < 0.5*(1-fit.R2) {
						f.Model, f.fit, f.R2 = "compound", lf, r2
					}
				}
			}
		}
	}

	f.Confidence = fit.Confidence()
	if f.Model == "compound" {
		f.PerDay = f.Current * (math.Exp(f.fit.Slope) - 1)
		f.GrowthPctMonth = 100 * (math.Exp(30*f.fit.Slope) - 1)
	} else {
		f.PerDay = fit.Slope
		if f.Current > 0 {
			f.GrowthPctMonth = 100 * 30 * fit.Slope / f.Current
		}
	}
	day := 24 * time.Hour
	f.In30Days, _, _ = f.ValueAt(now.Add(30 * day))
	end := now.Add(time.Duration(horizon) * day)
	startV, _, _ := f.ValueAt(f.last)
	endV, _, _ := f.ValueAt(end)
	f.Line = []Point{{T: f.last, V: startV}, {T: end, V: endV}}
	const steps = 16
	for i := 0; i <= steps; i++ {
		t := f.last.Add(time.Duration(float64(end.Sub(f.last)) * float64(i) / steps))
		v, lo, hi := f.ValueAt(t)
		f.Band = append(f.Band, BandPoint{T: t, V: v, Low: lo, High: hi})
	}
	for _, d := range Horizons {
		t := now.Add(time.Duration(d) * day)
		v, lo, hi := f.ValueAt(t)
		f.Projections = append(f.Projections, Projection{Days: d, At: t, V: v, Low: lo, High: hi,
			Reliable: float64(d) <= 4*math.Max(f.SpanDays, 1)})
	}
	// looking much further ahead than the history behind it lowers the confidence
	if float64(horizon) > 8*f.SpanDays {
		f.Confidence = "low"
	} else if float64(horizon) > 3*f.SpanDays && f.Confidence == "high" {
		f.Confidence = "medium"
	}
	return f
}
