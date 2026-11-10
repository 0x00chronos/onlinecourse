package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"onlinecourse/internal/bank"
	"onlinecourse/internal/config"
	"onlinecourse/internal/database"
	"onlinecourse/internal/httpapi"
)

func main() { os.Exit(run()) }

func run() int {
	configPath := flag.String("config", "config.yaml", "YAML 配置文件路径")
	flag.Parse()
	cfg, err := config.Load(*configPath)
	if err != nil {
		slog.Error("配置加载失败", "component", "config", "error", err)
		return 1
	}
	var level slog.Level
	_ = level.UnmarshalText([]byte(cfg.Log.Level))
	opts := &slog.HandlerOptions{Level: level}
	var handler slog.Handler = slog.NewTextHandler(os.Stdout, opts)
	if cfg.Log.Format == "json" {
		handler = slog.NewJSONHandler(os.Stdout, opts)
	}
	log := slog.New(handler)
	db, err := database.Open(cfg.Database, log)
	if err != nil {
		log.Error("数据库初始化失败，请检查配置与连接", "component", "database", "driver", cfg.Database.Driver)
		return 1
	}
	pool, err := db.DB()
	if err != nil {
		log.Error("无法获取数据库连接池", "component", "database")
		return 1
	}
	defer pool.Close()
	srv := &http.Server{Addr: cfg.Server.Address, Handler: httpapi.New(&bank.Store{DB: db}, cfg.Server, log), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: time.Duration(cfg.Server.ReadTimeoutSeconds) * time.Second, WriteTimeout: time.Duration(cfg.Server.WriteTimeoutSeconds) * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 1 << 20, ErrorLog: slog.NewLogLogger(handler, slog.LevelError)}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	listener, err := net.Listen("tcp", cfg.Server.Address)
	if err != nil {
		log.Error("HTTP端口监听失败", "component", "server", "error", err)
		return 1
	}
	serverErrors := make(chan error, 1)
	go func() { serverErrors <- srv.Serve(listener) }()
	log.Info("题库服务启动", "component", "server", "address", listener.Addr().String(), "driver", cfg.Database.Driver, "auth_enabled", cfg.Server.APIKey != "")
	select {
	case err := <-serverErrors:
		if !errors.Is(err, http.ErrServerClosed) {
			log.Error("HTTP服务启动失败", "component", "server", "error", err)
			return 1
		}
	case <-ctx.Done():
		log.Info("正在关闭题库服务", "component", "server")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), time.Duration(cfg.Server.ShutdownTimeoutSeconds)*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			_ = srv.Close()
			log.Error("服务关闭超时", "component", "server")
			return 1
		}
	}
	log.Info("题库服务已停止", "component", "server")
	return 0
}
