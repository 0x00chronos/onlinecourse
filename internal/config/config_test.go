package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadDefaultsAndRelativePath(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte("server:\n  api_key: test-token\ndatabase:\n  sqlite:\n    path: data/test.db\n"), 0600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Database.SQLite.Path != filepath.Join(filepath.Dir(path), "data", "test.db") || cfg.Server.MaxBodyBytes <= 0 {
		t.Fatal("defaults or relative path incorrect")
	}
}

func TestRejectInvalidConfig(t *testing.T) {
	for i, body := range []string{"server:\n  typo: 1\n", "database:\n  driver: oracle\n", "server:\n  max_body_bytes: -1\n", "log:\n  level: noisy\n", "database:\n  max_idle_conns: 999\n", "database:\n  driver: mysql\n", "log: {}\n---\nlog: {}\n"} {
		t.Run(strings.Repeat("x", i+1), func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "config.yaml")
			if strings.HasPrefix(body, "server:\n") {
				body = strings.Replace(body, "server:\n", "server:\n  api_key: test-token\n", 1)
			} else {
				body = "server:\n  api_key: test-token\n" + body
			}
			if err := os.WriteFile(path, []byte(body), 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := Load(path); err == nil {
				t.Fatal("invalid configuration was accepted")
			}
		})
	}
}

func TestPostgresAlias(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte("server:\n  api_key: test-token\ndatabase:\n  driver: pgsql\n  postgres:\n    dsn: 'host=localhost dbname=test'\n"), 0600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil || cfg.Database.Driver != "postgres" {
		t.Fatal("pgsql alias failed", err)
	}
}

func TestTokenIsMandatory(t *testing.T) {
	for _, body := range []string{"log: {}\n", "server:\n  api_key: ''\n", "server:\n  api_key: '   '\n", "server:\n  api_key: 'has space'\n"} {
		path := filepath.Join(t.TempDir(), "config.yaml")
		if err := os.WriteFile(path, []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := Load(path); err == nil {
			t.Fatal("missing/invalid Token was accepted")
		}
	}
}
