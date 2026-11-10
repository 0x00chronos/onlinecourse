package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"onlinecourse/internal/bank"
	"onlinecourse/internal/config"
	"onlinecourse/internal/database"
	"onlinecourse/internal/httpapi"
	"onlinecourse/internal/model"
)

const testToken = "test-token-for-integration"

func setup(t *testing.T) (*bank.Store, config.Server, *slog.Logger) {
	t.Helper()
	cfg, err := config.Load(filepath.Join("..", "..", "config.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	cfg.Database.SQLite.Path = filepath.Join(t.TempDir(), "bank.db")
	cfg.Server.APIKey = testToken
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	db, err := database.Open(cfg.Database, log)
	if err != nil {
		t.Fatal(err)
	}
	pool, _ := db.DB()
	t.Cleanup(func() { _ = pool.Close() })
	return &bank.Store{DB: db}, cfg.Server, log
}

func request(t *testing.T, h http.Handler, method, path string, body any, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	var data []byte
	if body != nil {
		var err error
		data, err = json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
	}
	r := httptest.NewRequest(method, path, bytes.NewReader(data))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Authorization", "Bearer "+testToken)
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}
func requireStatus(t *testing.T, w *httptest.ResponseRecorder, status int) {
	t.Helper()
	if w.Code != status {
		t.Fatalf("status %d, want %d: %s", w.Code, status, w.Body.String())
	}
	if w.Header().Get("X-Request-ID") == "" {
		t.Fatal("missing request ID")
	}
}
func decode[T any](t *testing.T, w *httptest.ResponseRecorder) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(w.Body.Bytes(), &v); err != nil {
		t.Fatal(err)
	}
	return v
}
func course(t *testing.T, h http.Handler) uint64 {
	t.Helper()
	in := bank.CourseInput{Platform: "测试网课", ExternalID: "go-101", Name: "Go 入门"}
	w := request(t, h, "POST", "/api/v1/courses", in, nil)
	requireStatus(t, w, 201)
	id := decode[struct{ Data model.Course }](t, w).Data.ID
	w = request(t, h, "POST", "/api/v1/courses", in, nil)
	requireStatus(t, w, 200)
	if decode[struct{ Data model.Course }](t, w).Data.ID != id {
		t.Fatal("course deduplication failed")
	}
	return id
}
func single() bank.QuestionInput {
	return bank.QuestionInput{Type: "single", Stem: "Go 的关键字是？", Options: []bank.Option{{Key: "A", Text: "func"}, {Key: "B", Text: "function"}}, CorrectAnswers: []string{"A"}}
}
func uploadInput(id uint64, questions ...bank.QuestionInput) bank.BatchInput {
	return bank.BatchInput{CourseID: id, Contributor: bank.ContributorInput{Username: "小明", SourceURL: "https://course.example/quiz/1"}, Questions: questions}
}

func TestUploadSearchAndAttribution(t *testing.T) {
	store, cfg, log := setup(t)
	h := httpapi.New(store, cfg, log)
	id := course(t, h)
	in := uploadInput(id, single())
	w := request(t, h, "POST", "/api/v1/questions/batch", in, nil)
	requireStatus(t, w, 200)
	first := decode[struct {
		NewQuestions     int `json:"new_questions"`
		NewContributions int `json:"new_contributions"`
		Data             []bank.BatchItem
	}](t, w)
	if first.NewQuestions != 1 || first.NewContributions != 1 {
		t.Fatal(w.Body.String())
	}
	w = request(t, h, "POST", "/api/v1/questions/batch", in, nil)
	requireStatus(t, w, 200)
	repeat := decode[struct {
		NewQuestions     int `json:"new_questions"`
		NewContributions int `json:"new_contributions"`
	}](t, w)
	if repeat.NewQuestions != 0 || repeat.NewContributions != 0 {
		t.Fatal("repeated uploads were counted")
	}
	lookup := bank.SearchInput{CourseID: id, Type: "single", Stem: " \nGo 的关键字是？\t", Options: []bank.Option{{Key: "A", Text: "function"}, {Key: "B", Text: " func "}}}
	w = request(t, h, "POST", "/api/v1/questions/search", lookup, nil)
	requireStatus(t, w, 200)
	result := decode[struct {
		Match string
		Data  bank.QuestionView
	}](t, w)
	if result.Match != "exact" || !result.Data.HasAnswer || result.Data.Conflict {
		t.Fatal(w.Body.String())
	}
	candidate := result.Data.AnswerCandidates[0]
	if len(candidate.AnswerKeys) != 1 || candidate.AnswerKeys[0] != "B" || candidate.Contributors[0].Username != "小明" || candidate.Contributors[0].SourceURL != in.Contributor.SourceURL {
		t.Fatal("answer remapping or attribution failed")
	}
	// Different URLs by the same user do not inflate the support count.
	in.Contributor.SourceURL = "https://course.example/quiz/2"
	requireStatus(t, request(t, h, "POST", "/api/v1/questions/batch", in, nil), 200)
	in.Contributor.Username = "小红"
	in.Questions[0].CorrectAnswers = []string{"B"}
	requireStatus(t, request(t, h, "POST", "/api/v1/questions/batch", in, nil), 200)
	w = request(t, h, "POST", "/api/v1/questions/search", lookup, nil)
	result = decode[struct {
		Match string
		Data  bank.QuestionView
	}](t, w)
	if !result.Data.Conflict || len(result.Data.AnswerCandidates) != 2 {
		t.Fatal("conflicting answers were overwritten")
	}
	for _, c := range result.Data.AnswerCandidates {
		if c.SupportCount != 1 {
			t.Fatal("duplicate user support was counted")
		}
	}
	// Changed options / wrong course must never produce an exact match.
	for _, changed := range []bank.SearchInput{
		{CourseID: id, Type: "single", Stem: lookup.Stem, Options: []bank.Option{{Key: "A", Text: "func"}, {Key: "B", Text: "def"}}},
		{CourseID: id + 100, Type: lookup.Type, Stem: lookup.Stem, Options: lookup.Options},
		{CourseID: id, Type: "multiple", Stem: lookup.Stem, Options: lookup.Options},
	} {
		w = request(t, h, "POST", "/api/v1/questions/search", changed, nil)
		requireStatus(t, w, 200)
		miss := decode[struct {
			Match string
			Data  *bank.QuestionView
		}](t, w)
		if miss.Match != "none" || miss.Data != nil {
			t.Fatal("unsafe match", w.Body.String())
		}
	}
	requireStatus(t, request(t, h, "GET", fmt.Sprintf("/api/v1/questions/%d", first.Data[0].QuestionID), nil, nil), 200)
	w = request(t, h, "GET", fmt.Sprintf("/api/v1/questions?course_id=%d&q=关键字&type=single&page_size=1", id), nil, nil)
	requireStatus(t, w, 200)
	if decode[struct{ Total int }](t, w).Total != 1 {
		t.Fatal(w.Body.String())
	}
	requireStatus(t, request(t, h, "GET", "/healthz", nil, nil), 200)
}

func TestMultipleChoiceAndQuestionOnly(t *testing.T) {
	store, cfg, log := setup(t)
	h := httpapi.New(store, cfg, log)
	id := course(t, h)
	multi := bank.QuestionInput{Type: "multiple", Stem: "选择偶数", Options: []bank.Option{{Key: "A", Text: "2"}, {Key: "B", Text: "3"}, {Key: "C", Text: "4"}}, CorrectAnswers: []string{"C", "A"}}
	noAnswer := single()
	noAnswer.CorrectAnswers = nil
	w := request(t, h, "POST", "/api/v1/questions/batch", uploadInput(id, multi, noAnswer), nil)
	requireStatus(t, w, 200)
	lookup := bank.SearchInput{CourseID: id, Type: "multiple", Stem: multi.Stem, Options: []bank.Option{{Key: "X", Text: "4"}, {Key: "Y", Text: "2"}, {Key: "Z", Text: "3"}}}
	w = request(t, h, "POST", "/api/v1/questions/search", lookup, nil)
	requireStatus(t, w, 200)
	v := decode[struct{ Data bank.QuestionView }](t, w).Data
	if got := v.AnswerCandidates[0].AnswerKeys; len(got) != 2 || got[0] != "X" || got[1] != "Y" {
		t.Fatal("multiple choice mapping failed", got)
	}
	lookup = bank.SearchInput{CourseID: id, Type: noAnswer.Type, Stem: noAnswer.Stem, Options: noAnswer.Options}
	w = request(t, h, "POST", "/api/v1/questions/search", lookup, nil)
	v = decode[struct{ Data bank.QuestionView }](t, w).Data
	if v.HasAnswer || len(v.AnswerCandidates) != 0 || len(v.Contributors) != 1 {
		t.Fatal("question-only upload produced an answer")
	}
	// A later answer enriches the existing question.
	w = request(t, h, "POST", "/api/v1/questions/batch", uploadInput(id, single()), nil)
	requireStatus(t, w, 200)
	if decode[struct {
		NewQuestions int `json:"new_questions"`
	}](t, w).NewQuestions != 0 {
		t.Fatal("answer enrichment duplicated question")
	}
}

func TestValidationAtomicityAndForeignKeys(t *testing.T) {
	store, cfg, log := setup(t)
	h := httpapi.New(store, cfg, log)
	id := course(t, h)
	valid := single()
	invalids := []bank.QuestionInput{
		{Type: "essay", Stem: valid.Stem, Options: valid.Options},
		{Type: "single", Stem: valid.Stem, Options: valid.Options, CorrectAnswers: []string{"A", "B"}},
		{Type: "multiple", Stem: valid.Stem, Options: valid.Options, CorrectAnswers: []string{"Z"}},
		{Type: "multiple", Stem: valid.Stem, Options: valid.Options, CorrectAnswers: []string{"A", "A"}},
		{Type: "single", Stem: valid.Stem, Options: []bank.Option{{Key: "A", Text: "a"}, {Key: "A", Text: "b"}}},
		{Type: "single", Stem: valid.Stem, Options: []bank.Option{{Key: "A", Text: "a  b"}, {Key: "B", Text: "a\nb"}}},
	}
	for _, bad := range invalids {
		requireStatus(t, request(t, h, "POST", "/api/v1/questions/batch", uploadInput(id, valid, bad), nil), 400)
	}
	var count int64
	store.DB.Model(&model.Question{}).Count(&count)
	if count != 0 {
		t.Fatal("failed batch left partial data")
	}
	requireStatus(t, request(t, h, "POST", "/api/v1/questions/batch", uploadInput(id+100, valid), nil), 404)
	var enabled int
	if err := store.DB.Raw("PRAGMA foreign_keys").Scan(&enabled).Error; err != nil || enabled != 1 {
		t.Fatal("foreign keys not enabled", err)
	}
	if err := store.DB.Create(&model.Contribution{QuestionID: 999, Identity: "orphan", Username: "x", SourceURL: "https://example.com", AnswerJSON: "[]"}).Error; err == nil {
		t.Fatal("orphan contribution accepted")
	}
	for _, path := range []string{"/api/v1/questions?page_size=0", "/api/v1/questions?course_id=bad", "/api/v1/questions/0"} {
		requireStatus(t, request(t, h, "GET", path, nil, nil), 400)
	}
	// % must be treated as a literal, not a SQL wildcard.
	w := request(t, h, "GET", "/api/v1/courses?q=%25", nil, nil)
	if decode[struct{ Total int }](t, w).Total != 0 {
		t.Fatal("LIKE wildcard escaping failed")
	}
}

func TestAuthCORSAndBodyLimits(t *testing.T) {
	store, cfg, log := setup(t)
	cfg.APIKey = "test-secret"
	cfg.AllowedOrigins = []string{"https://course.example"}
	cfg.MaxBodyBytes = 256
	h := httpapi.New(store, cfg, log)
	requireStatus(t, request(t, h, "GET", "/api/v1/courses", nil, nil), 401)
	auth := map[string]string{"Authorization": "Bearer test-secret"}
	requireStatus(t, request(t, h, "GET", "/api/v1/courses", nil, auth), 200)
	requireStatus(t, request(t, h, "GET", "/healthz", nil, nil), 200)
	requireStatus(t, request(t, h, "GET", "/api/v1/courses", nil, map[string]string{"Origin": "https://evil.example"}), 403)
	w := request(t, h, "OPTIONS", "/api/v1/questions/batch", nil, map[string]string{"Origin": "https://course.example", "Access-Control-Request-Method": "POST"})
	requireStatus(t, w, 204)
	if w.Header().Get("Access-Control-Allow-Origin") != "https://course.example" {
		t.Fatal("missing CORS origin")
	}
	requireStatus(t, request(t, h, "POST", "/api/v1/courses", map[string]any{"unknown": true}, auth), 400)
	requireStatus(t, request(t, h, "POST", "/api/v1/courses", bank.CourseInput{}, map[string]string{"Authorization": "Bearer test-secret", "Content-Type": "text/plain"}), 415)
	requireStatus(t, request(t, h, "POST", "/api/v1/courses", map[string]string{"name": string(bytes.Repeat([]byte("a"), 300))}, auth), 413)
	for _, body := range []string{`{"name":"x"} {"name":"y"}`, `{"name":`, `null`, `[]`} {
		r := httptest.NewRequest("POST", "/api/v1/courses", bytes.NewBufferString(body))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Authorization", "Bearer test-secret")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		requireStatus(t, w, 400)
	}
}

func TestMandatoryTokenForAllBusinessRoutes(t *testing.T) {
	store, cfg, log := setup(t)
	h := httpapi.New(store, cfg, log)
	for _, route := range []struct{ method, path string }{
		{"GET", "/api/v1"}, {"GET", "/api/v1/courses"}, {"POST", "/api/v1/courses"},
		{"GET", "/api/v1/questions"}, {"GET", "/api/v1/questions/1"},
		{"POST", "/api/v1/questions/batch"}, {"POST", "/api/v1/questions/search"},
	} {
		for _, authorization := range []string{"", "Bearer wrong-token", "Basic " + testToken} {
			w := request(t, h, route.method, route.path, nil, map[string]string{"Authorization": authorization})
			requireStatus(t, w, 401)
			if w.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("protected response was cacheable")
			}
		}
	}
	requireStatus(t, request(t, h, "GET", "/api/v1/courses?token="+testToken, nil, map[string]string{"Authorization": ""}), 401)
	requireStatus(t, request(t, h, "GET", "/api/v1/courses", nil, map[string]string{"Origin": "http://example.com"}), 200)
	// Even direct handler construction cannot silently turn off authentication.
	cfg.APIKey = ""
	h = httpapi.New(store, cfg, log)
	requireStatus(t, request(t, h, "GET", "/api/v1/courses", nil, map[string]string{"Authorization": "Bearer "}), 401)
}

func TestEmbeddedFrontendAndTokenRedaction(t *testing.T) {
	store, cfg, _ := setup(t)
	var logs bytes.Buffer
	log := slog.New(slog.NewTextHandler(&logs, nil))
	h := httpapi.New(store, cfg, log)
	for _, path := range []string{"/", "/assets/app.js", "/assets/app.css", "/assets/favicon.svg", "/userscripts/chaoxing-questionbank.user.js"} {
		w := request(t, h, "GET", path, nil, map[string]string{"Authorization": ""})
		requireStatus(t, w, 200)
		if strings.Contains(w.Body.String(), cfg.APIKey) {
			t.Fatal("frontend exposed server Token")
		}
		if w.Header().Get("Content-Security-Policy") == "" {
			t.Fatal("missing frontend content policy")
		}
	}
	requireStatus(t, request(t, h, "GET", "/assets/config.yaml", nil, nil), 404)
	requireStatus(t, request(t, h, "GET", "/api/v1/courses", nil, nil), 200)
	if strings.Contains(logs.String(), cfg.APIKey) {
		t.Fatal("Token was logged")
	}
}

func TestConcurrentDeduplication(t *testing.T) {
	store, _, _ := setup(t)
	c, _, err := store.CreateCourse(context.Background(), bank.CourseInput{Platform: "测试", Name: "并发测试"})
	if err != nil {
		t.Fatal(err)
	}
	in := uploadInput(c.ID, single())
	errors := make(chan error, 12)
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _, err := store.Upload(context.Background(), in); errors <- err }()
	}
	wg.Wait()
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatal(err)
		}
	}
	var questions, contributions int64
	store.DB.Model(&model.Question{}).Count(&questions)
	store.DB.Model(&model.Contribution{}).Count(&contributions)
	if questions != 1 || contributions != 1 {
		t.Fatalf("concurrent duplicate data: %d questions, %d contributions", questions, contributions)
	}
}
