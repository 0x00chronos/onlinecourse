package database

import (
	"context"
	"errors"
	"log/slog"
	"net/url"
	"os"
	"path/filepath"
	"time"

	"gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	"onlinecourse/internal/config"
	"onlinecourse/internal/model"
)

func Open(c config.Database, log *slog.Logger) (*gorm.DB, error) {
	var dialector gorm.Dialector
	switch c.Driver {
	case "sqlite":
		if err := os.MkdirAll(filepath.Dir(c.SQLite.Path), 0750); err != nil {
			return nil, err
		}
		u := url.URL{Scheme: "file", Path: c.SQLite.Path}
		dialector = sqlite.Open(u.String() + "?_foreign_keys=on&_journal_mode=WAL&_busy_timeout=5000")
	case "mysql":
		dialector = mysql.Open(c.MySQL.DSN)
	case "postgres", "pgsql":
		dialector = postgres.Open(c.Postgres.DSN)
	default:
		return nil, errors.New("unsupported database driver")
	}
	db, err := gorm.Open(dialector, &gorm.Config{Logger: &sqlLogger{log: log.With("component", "database"), slow: time.Duration(c.SlowQueryMS) * time.Millisecond}, NowFunc: func() time.Time { return time.Now().UTC() }})
	if err != nil {
		return nil, err
	}
	pool, err := db.DB()
	if err != nil {
		return nil, err
	}
	pool.SetMaxOpenConns(c.MaxOpenConns)
	pool.SetMaxIdleConns(c.MaxIdleConns)
	// Serialize SQLite writes; foreign key and WAL settings apply to every connection.
	if c.Driver == "sqlite" {
		pool.SetMaxOpenConns(1)
		pool.SetMaxIdleConns(1)
	}
	pool.SetConnMaxLifetime(time.Duration(c.ConnMaxLifetimeSeconds) * time.Second)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := pool.PingContext(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	if err := db.WithContext(ctx).AutoMigrate(&model.Course{}, &model.Question{}, &model.Contribution{}); err != nil {
		pool.Close()
		return nil, err
	}
	log.Info("数据库连接与表迁移完成", "component", "database", "driver", c.Driver)
	return db, nil
}

type sqlLogger struct {
	log  *slog.Logger
	slow time.Duration
}

func (l *sqlLogger) LogMode(logger.LogLevel) logger.Interface { return l }
func (l *sqlLogger) Info(ctx context.Context, msg string, args ...interface{}) {
	l.log.DebugContext(ctx, "数据库事件", "event", msg)
}
func (l *sqlLogger) Warn(ctx context.Context, msg string, args ...interface{}) {
	l.log.WarnContext(ctx, "数据库警告", "event", msg)
}
func (l *sqlLogger) Error(ctx context.Context, msg string, args ...interface{}) {
	l.log.ErrorContext(ctx, "数据库错误", "event", msg)
}

// Do not interpolate question content, user names or credentials into SQL logs.
func (l *sqlLogger) ParamsFilter(ctx context.Context, sql string, params ...interface{}) (string, []interface{}) {
	return sql, nil
}
func (l *sqlLogger) Trace(ctx context.Context, begin time.Time, fc func() (string, int64), err error) {
	elapsed := time.Since(begin)
	level := slog.LevelDebug
	if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
		level = slog.LevelError
	} else if elapsed > l.slow {
		level = slog.LevelWarn
	}
	if !l.log.Enabled(ctx, level) {
		return
	}
	_, rows := fc()
	// Database error details can contain values. Log only the error category here.
	l.log.Log(ctx, level, "SQL执行", "duration_ms", elapsed.Milliseconds(), "rows", rows, "failed", err != nil && !errors.Is(err, gorm.ErrRecordNotFound))
}
