package metrics

import (
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
)

// RegisterPool exports the PostgreSQL pool's Stat() on every scrape.
func (m *Metrics) RegisterPool(pool *pgxpool.Pool) error {
	return m.registry.Register(newPoolCollector(pool.Stat))
}

type poolMetric struct {
	desc      *prometheus.Desc
	valueType prometheus.ValueType
	value     func(*pgxpool.Stat) float64
}

type poolCollector struct {
	stat    func() *pgxpool.Stat
	metrics []poolMetric
}

func newPoolCollector(stat func() *pgxpool.Stat) *poolCollector {
	gauge := func(name, help string, value func(*pgxpool.Stat) float64) poolMetric {
		return poolMetric{prometheus.NewDesc("pgxpool_"+name, help, nil, nil), prometheus.GaugeValue, value}
	}
	counter := func(name, help string, value func(*pgxpool.Stat) float64) poolMetric {
		return poolMetric{prometheus.NewDesc("pgxpool_"+name, help, nil, nil), prometheus.CounterValue, value}
	}
	return &poolCollector{stat: stat, metrics: []poolMetric{
		gauge("acquired_conns", "Connections currently acquired from the pool.",
			func(s *pgxpool.Stat) float64 { return float64(s.AcquiredConns()) }),
		gauge("idle_conns", "Idle connections in the pool.",
			func(s *pgxpool.Stat) float64 { return float64(s.IdleConns()) }),
		gauge("constructing_conns", "Connections being opened.",
			func(s *pgxpool.Stat) float64 { return float64(s.ConstructingConns()) }),
		gauge("total_conns", "All connections in the pool.",
			func(s *pgxpool.Stat) float64 { return float64(s.TotalConns()) }),
		gauge("max_conns", "Maximum size of the pool.",
			func(s *pgxpool.Stat) float64 { return float64(s.MaxConns()) }),
		counter("acquires_total", "Successful connection acquires.",
			func(s *pgxpool.Stat) float64 { return float64(s.AcquireCount()) }),
		counter("acquire_duration_seconds_total", "Time spent acquiring connections.",
			func(s *pgxpool.Stat) float64 { return s.AcquireDuration().Seconds() }),
		counter("empty_acquires_total", "Acquires that waited because the pool had no idle connection.",
			func(s *pgxpool.Stat) float64 { return float64(s.EmptyAcquireCount()) }),
		counter("empty_acquire_wait_seconds_total", "Time acquires spent waiting for a connection.",
			func(s *pgxpool.Stat) float64 { return s.EmptyAcquireWaitTime().Seconds() }),
		counter("canceled_acquires_total", "Acquires canceled by their context.",
			func(s *pgxpool.Stat) float64 { return float64(s.CanceledAcquireCount()) }),
		counter("new_conns_total", "Connections opened.",
			func(s *pgxpool.Stat) float64 { return float64(s.NewConnsCount()) }),
		counter("max_lifetime_destroys_total", "Connections closed for reaching their maximum lifetime.",
			func(s *pgxpool.Stat) float64 { return float64(s.MaxLifetimeDestroyCount()) }),
		counter("max_idle_destroys_total", "Connections closed for reaching their maximum idle time.",
			func(s *pgxpool.Stat) float64 { return float64(s.MaxIdleDestroyCount()) }),
	}}
}

func (c *poolCollector) Describe(descs chan<- *prometheus.Desc) {
	for _, metric := range c.metrics {
		descs <- metric.desc
	}
}

func (c *poolCollector) Collect(metrics chan<- prometheus.Metric) {
	stat := c.stat()
	for _, metric := range c.metrics {
		metrics <- prometheus.MustNewConstMetric(metric.desc, metric.valueType, metric.value(stat))
	}
}
