package httpapi

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"gorm.io/gorm"
	"onlinecourse/internal/bank"
	"onlinecourse/internal/config"
	"onlinecourse/internal/model"
	"onlinecourse/internal/web"
)

type API struct {
	store *bank.Store
	cfg   config.Server
	log   *slog.Logger
}
type requestIDKey struct{}

func New(store *bank.Store, cfg config.Server, log *slog.Logger) http.Handler {
	a := &API{store: store, cfg: cfg, log: log}
	mux := http.NewServeMux()
	mux.Handle("GET /{$}", web.Handler())
	mux.Handle("GET /assets/", web.Handler())
	mux.Handle("GET /userscripts/chaoxing-questionbank.user.js", web.Handler())
	mux.HandleFunc("GET /healthz", a.health)
	mux.HandleFunc("GET /api/v1/courses", a.listCourses)
	mux.HandleFunc("POST /api/v1/courses", a.createCourse)
	mux.HandleFunc("POST /api/v1/questions/batch", a.upload)
	mux.HandleFunc("POST /api/v1/questions/search", a.search)
	mux.HandleFunc("GET /api/v1/questions", a.listQuestions)
	mux.HandleFunc("GET /api/v1/questions/{id}", a.getQuestion)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { a.fail(w, r, 404, "not_found", "接口不存在") })
	return a.middleware(mux)
}

func (a *API) health(w http.ResponseWriter, r *http.Request) {
	pool, err := a.store.DB.DB()
	if err == nil {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		err = pool.PingContext(ctx)
	}
	if err != nil {
		a.fail(w, r, 503, "database_unavailable", "数据库不可用")
		return
	}
	writeJSON(w, 200, map[string]string{"status": "ok"})
}

func (a *API) createCourse(w http.ResponseWriter, r *http.Request) {
	var in bank.CourseInput
	if !a.decode(w, r, &in) {
		return
	}
	course, created, err := a.store.CreateCourse(r.Context(), in)
	if err != nil {
		a.handleError(w, r, err)
		return
	}
	status := 200
	if created {
		status = 201
	}
	a.log.InfoContext(r.Context(), "课程已记录", "component", "course", "request_id", requestID(r), "course_id", course.ID, "created", created)
	writeJSON(w, status, map[string]any{"data": course, "created": created})
}

func (a *API) listCourses(w http.ResponseWriter, r *http.Request) {
	page, size, ok := a.pagination(w, r)
	if !ok {
		return
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if utf8.RuneCountInString(q) > 500 {
		a.fail(w, r, 400, "validation_error", "q 最多 500 字")
		return
	}
	db := a.store.DB.WithContext(r.Context()).Model(&model.Course{})
	if q != "" {
		db = db.Where("name LIKE ? ESCAPE '!'", bank.ContainsPattern(q))
	}
	if platform := bank.Normalize(r.URL.Query().Get("platform")); platform != "" {
		db = db.Where("platform = ?", platform)
	}
	var total int64
	if err := db.Count(&total).Error; err != nil {
		a.handleError(w, r, err)
		return
	}
	courses := []model.Course{}
	if err := db.Order("id DESC").Offset((page - 1) * size).Limit(size).Find(&courses).Error; err != nil {
		a.handleError(w, r, err)
		return
	}
	writeJSON(w, 200, map[string]any{"data": courses, "total": total, "page": page, "page_size": size})
}

func (a *API) upload(w http.ResponseWriter, r *http.Request) {
	var in bank.BatchInput
	if !a.decode(w, r, &in) {
		return
	}
	items, err := a.store.Upload(r.Context(), in)
	if err != nil {
		a.handleError(w, r, err)
		return
	}
	newQuestions, newContributions := 0, 0
	for _, item := range items {
		if item.QuestionCreated {
			newQuestions++
		}
		if item.ContributionCreated {
			newContributions++
		}
	}
	a.log.InfoContext(r.Context(), "题库批量上传完成", "component", "question", "request_id", requestID(r), "course_id", in.CourseID, "received", len(items), "new_questions", newQuestions, "new_contributions", newContributions)
	writeJSON(w, 200, map[string]any{"data": items, "received": len(items), "new_questions": newQuestions, "new_contributions": newContributions})
}

func (a *API) search(w http.ResponseWriter, r *http.Request) {
	var in bank.SearchInput
	if !a.decode(w, r, &in) {
		return
	}
	v, err := a.store.Search(r.Context(), in)
	if err != nil {
		a.handleError(w, r, err)
		return
	}
	match := "none"
	if v != nil {
		match = "exact"
	}
	a.log.DebugContext(r.Context(), "题库搜索完成", "component", "search", "request_id", requestID(r), "course_id", in.CourseID, "match", match)
	writeJSON(w, 200, map[string]any{"match": match, "data": v})
}

func (a *API) getQuestion(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseUint(r.PathValue("id"), 10, 64)
	if err != nil || id == 0 {
		a.fail(w, r, 400, "validation_error", "id 必须是正整数")
		return
	}
	v, err := a.store.Get(r.Context(), id)
	if err != nil {
		a.handleError(w, r, err)
		return
	}
	writeJSON(w, 200, map[string]any{"data": v})
}

func (a *API) listQuestions(w http.ResponseWriter, r *http.Request) {
	page, size, ok := a.pagination(w, r)
	if !ok {
		return
	}
	db := a.store.DB.WithContext(r.Context()).Model(&model.Question{})
	if raw := r.URL.Query().Get("course_id"); raw != "" {
		id, err := strconv.ParseUint(raw, 10, 64)
		if err != nil || id == 0 {
			a.fail(w, r, 400, "validation_error", "course_id 必须是正整数")
			return
		}
		db = db.Where("course_id = ?", id)
	}
	if kind := r.URL.Query().Get("type"); kind != "" {
		if kind != "single" && kind != "multiple" {
			a.fail(w, r, 400, "validation_error", "type 仅支持 single 或 multiple")
			return
		}
		db = db.Where("type = ?", kind)
	}
	if q := strings.TrimSpace(r.URL.Query().Get("q")); q != "" {
		if utf8.RuneCountInString(q) > 500 {
			a.fail(w, r, 400, "validation_error", "q 最多 500 字")
			return
		}
		db = db.Where("normalized_stem LIKE ? ESCAPE '!'", bank.ContainsPattern(q))
	}
	var total int64
	if err := db.Count(&total).Error; err != nil {
		a.handleError(w, r, err)
		return
	}
	questions := []model.Question{}
	if err := db.Preload("Contributions", func(db *gorm.DB) *gorm.DB { return db.Order("id ASC") }).Order("id DESC").Offset((page - 1) * size).Limit(size).Find(&questions).Error; err != nil {
		a.handleError(w, r, err)
		return
	}
	views := make([]bank.QuestionView, 0, len(questions))
	for _, q := range questions {
		v, err := bank.View(q, nil)
		if err != nil {
			a.handleError(w, r, err)
			return
		}
		views = append(views, v)
	}
	writeJSON(w, 200, map[string]any{"data": views, "total": total, "page": page, "page_size": size})
}

func (a *API) pagination(w http.ResponseWriter, r *http.Request) (int, int, bool) {
	parse := func(name string, fallback, max int) (int, bool) {
		raw := r.URL.Query().Get(name)
		if raw == "" {
			return fallback, true
		}
		n, err := strconv.Atoi(raw)
		return n, err == nil && n > 0 && n <= max
	}
	page, validPage := parse("page", 1, 10000)
	size, validSize := parse("page_size", 20, 100)
	if !validPage || !validSize {
		a.fail(w, r, 400, "validation_error", "page 范围 1–10000，page_size 范围 1–100")
		return 0, 0, false
	}
	return page, size, true
}

func (a *API) decode(w http.ResponseWriter, r *http.Request, dst any) bool {
	media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/json" {
		a.fail(w, r, 415, "unsupported_media_type", "Content-Type 必须为 application/json")
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, a.cfg.MaxBodyBytes)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	err = d.Decode(dst)
	if err == nil {
		var extra any
		if e := d.Decode(&extra); e != io.EOF {
			if e == nil {
				err = errors.New("multiple JSON values")
			} else {
				err = e
			}
		}
	}
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			a.fail(w, r, 413, "body_too_large", "请求体超过大小限制")
		} else {
			a.fail(w, r, 400, "invalid_json", "JSON 格式错误、包含未知字段或多余内容")
		}
		return false
	}
	return true
}

func (a *API) handleError(w http.ResponseWriter, r *http.Request, err error) {
	var validation *bank.ValidationError
	switch {
	case errors.As(err, &validation):
		a.fail(w, r, 400, "validation_error", validation.Message)
	case errors.Is(err, gorm.ErrRecordNotFound):
		a.fail(w, r, 404, "not_found", "课程或题目不存在")
	case errors.Is(err, context.DeadlineExceeded):
		a.fail(w, r, 504, "timeout", "请求处理超时")
	default:
		a.log.ErrorContext(r.Context(), "题库操作失败", "component", "database", "request_id", requestID(r))
		a.fail(w, r, 500, "internal_error", "服务端处理失败，请通过 request_id 查询日志")
	}
}
func (a *API) fail(w http.ResponseWriter, r *http.Request, status int, code, message string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": message, "request_id": requestID(r)}})
}
func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func requestID(r *http.Request) string {
	id, _ := r.Context().Value(requestIDKey{}).(string)
	return id
}

type responseWriter struct {
	http.ResponseWriter
	status int
}

func (w *responseWriter) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
		w.ResponseWriter.WriteHeader(status)
	}
}
func (w *responseWriter) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(200)
	}
	return w.ResponseWriter.Write(b)
}
func (w *responseWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (a *API) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		var token [16]byte
		if _, err := rand.Read(token[:]); err != nil {
			writeJSON(w, 500, map[string]string{"error": "request ID generation failed"})
			return
		}
		id := hex.EncodeToString(token[:])
		ctx, cancel := context.WithTimeout(context.WithValue(r.Context(), requestIDKey{}, id), time.Duration(a.cfg.WriteTimeoutSeconds)*time.Second)
		defer cancel()
		r = r.WithContext(ctx)
		rw := &responseWriter{ResponseWriter: w}
		rw.Header().Set("X-Request-ID", id)
		rw.Header().Set("X-Content-Type-Options", "nosniff")
		if strings.HasPrefix(r.URL.Path, "/api/") {
			rw.Header().Set("Cache-Control", "no-store")
		}
		defer func() {
			if recovered := recover(); recovered != nil {
				a.log.Error("请求处理异常", "component", "http", "request_id", id)
				if rw.status == 0 {
					a.fail(rw, r, 500, "internal_error", "服务端异常")
				}
			}
			status := rw.status
			if status == 0 {
				status = 200
			}
			level := slog.LevelInfo
			if status >= 500 {
				level = slog.LevelError
			} else if status >= 400 {
				level = slog.LevelWarn
			}
			a.log.Log(r.Context(), level, "HTTP请求", "component", "http", "request_id", id, "method", r.Method, "path", r.URL.Path, "status", status, "duration_ms", time.Since(start).Milliseconds())
		}()
		if origin := r.Header.Get("Origin"); origin != "" {
			rw.Header().Add("Vary", "Origin")
			// Browser POST requests can include Origin even for the embedded UI.
			// Cross-origin deployments behind a proxy still use allowed_origins.
			scheme := "http"
			if r.TLS != nil {
				scheme = "https"
			}
			allowed := origin == scheme+"://"+r.Host
			for _, candidate := range a.cfg.AllowedOrigins {
				if candidate == "*" || candidate == origin {
					allowed = true
					break
				}
			}
			if !allowed {
				a.fail(rw, r, 403, "origin_denied", "当前 Origin 未获允许")
				return
			}
			rw.Header().Set("Access-Control-Allow-Origin", origin)
			rw.Header().Set("Access-Control-Expose-Headers", "X-Request-ID")
			if r.Method == http.MethodOptions {
				rw.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
				rw.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
				rw.Header().Set("Access-Control-Max-Age", "600")
				rw.WriteHeader(204)
				return
			}
		}
		if r.URL.Path == "/api/v1" || strings.HasPrefix(r.URL.Path, "/api/v1/") {
			expected := "Bearer " + a.cfg.APIKey
			if strings.TrimSpace(a.cfg.APIKey) == "" || subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte(expected)) != 1 {
				rw.Header().Set("WWW-Authenticate", "Bearer")
				a.fail(rw, r, 401, "unauthorized", "缺少或无效的 Bearer Token")
				return
			}
		}
		next.ServeHTTP(rw, r)
	})
}
