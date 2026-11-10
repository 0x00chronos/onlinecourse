package config

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

type Config struct {
	Server   Server   `yaml:"server"`
	Database Database `yaml:"database"`
	Log      Log      `yaml:"log"`
}

type Server struct {
	Address                string   `yaml:"address"`
	ReadTimeoutSeconds     int      `yaml:"read_timeout_seconds"`
	WriteTimeoutSeconds    int      `yaml:"write_timeout_seconds"`
	ShutdownTimeoutSeconds int      `yaml:"shutdown_timeout_seconds"`
	MaxBodyBytes           int64    `yaml:"max_body_bytes"`
	APIKey                 string   `yaml:"api_key"`
	AllowedOrigins         []string `yaml:"allowed_origins"`
}

type Database struct {
	Driver string `yaml:"driver"`
	SQLite struct {
		Path string `yaml:"path"`
	} `yaml:"sqlite"`
	MySQL struct {
		DSN string `yaml:"dsn"`
	} `yaml:"mysql"`
	Postgres struct {
		DSN string `yaml:"dsn"`
	} `yaml:"postgres"`
	MaxOpenConns           int `yaml:"max_open_conns"`
	MaxIdleConns           int `yaml:"max_idle_conns"`
	ConnMaxLifetimeSeconds int `yaml:"conn_max_lifetime_seconds"`
	SlowQueryMS            int `yaml:"slow_query_ms"`
}

type Log struct {
	Level  string `yaml:"level"`
	Format string `yaml:"format"`
}

func Load(path string) (Config, error) {
	c := Config{Server: Server{Address: "127.0.0.1:8080", ReadTimeoutSeconds: 15, WriteTimeoutSeconds: 30, ShutdownTimeoutSeconds: 10, MaxBodyBytes: 2 << 20}, Log: Log{Level: "info", Format: "text"}}
	c.Database.Driver = "sqlite"
	c.Database.SQLite.Path = "data/questionbank.db"
	c.Database.MaxOpenConns = 10
	c.Database.MaxIdleConns = 5
	c.Database.ConnMaxLifetimeSeconds = 3600
	c.Database.SlowQueryMS = 200
	f, err := os.Open(path)
	if err != nil {
		return c, fmt.Errorf("open config: %w", err)
	}
	defer f.Close()
	d := yaml.NewDecoder(f)
	d.KnownFields(true)
	if err := d.Decode(&c); err != nil {
		return c, fmt.Errorf("decode config: %w", err)
	}
	var extra any
	if err := d.Decode(&extra); err != io.EOF {
		return c, errors.New("config must contain exactly one YAML document")
	}
	if err := c.Validate(); err != nil {
		return c, err
	}
	if c.Database.Driver == "sqlite" && !filepath.IsAbs(c.Database.SQLite.Path) {
		abs, err := filepath.Abs(filepath.Join(filepath.Dir(path), c.Database.SQLite.Path))
		if err != nil {
			return c, err
		}
		c.Database.SQLite.Path = abs
	}
	return c, nil
}

func (c *Config) Validate() error {
	if strings.TrimSpace(c.Server.APIKey) == "" {
		return errors.New("server.api_key is required: configure a non-empty Bearer token")
	}
	if strings.ContainsAny(c.Server.APIKey, " \t\r\n") {
		return errors.New("server.api_key must not contain whitespace")
	}
	c.Database.Driver = strings.ToLower(strings.TrimSpace(c.Database.Driver))
	if c.Database.Driver == "pgsql" {
		c.Database.Driver = "postgres"
	}
	switch c.Database.Driver {
	case "sqlite":
		if strings.TrimSpace(c.Database.SQLite.Path) == "" {
			return errors.New("database.sqlite.path is required")
		}
	case "mysql":
		if strings.TrimSpace(c.Database.MySQL.DSN) == "" {
			return errors.New("database.mysql.dsn is required")
		}
	case "postgres":
		if strings.TrimSpace(c.Database.Postgres.DSN) == "" {
			return errors.New("database.postgres.dsn is required")
		}
	default:
		return errors.New("database.driver must be sqlite, mysql, postgres or pgsql")
	}
	if c.Server.Address == "" || c.Server.ReadTimeoutSeconds <= 0 || c.Server.WriteTimeoutSeconds <= 0 || c.Server.ShutdownTimeoutSeconds <= 0 || c.Server.MaxBodyBytes <= 0 {
		return errors.New("server address and positive timeouts/max_body_bytes are required")
	}
	if c.Database.MaxOpenConns <= 0 || c.Database.MaxIdleConns < 0 || c.Database.MaxIdleConns > c.Database.MaxOpenConns || c.Database.ConnMaxLifetimeSeconds <= 0 || c.Database.SlowQueryMS <= 0 {
		return errors.New("invalid database pool or slow query settings")
	}
	if c.Log.Format != "text" && c.Log.Format != "json" {
		return errors.New("log.format must be text or json")
	}
	switch c.Log.Level {
	case "debug", "info", "warn", "error":
	default:
		return errors.New("invalid log.level")
	}
	for _, origin := range c.Server.AllowedOrigins {
		if origin == "" || origin == "null" {
			return errors.New("allowed_origins must contain explicit origins or *")
		}
	}
	return nil
}
