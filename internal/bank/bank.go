package bank

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"onlinecourse/internal/model"
)

type ValidationError struct{ Message string }

func (e *ValidationError) Error() string { return e.Message }
func invalid(message string) error       { return &ValidationError{message} }

type Store struct{ DB *gorm.DB }
type CourseInput struct {
	Platform   string `json:"platform"`
	ExternalID string `json:"external_id"`
	Name       string `json:"name"`
}
type Option struct {
	Key  string `json:"key"`
	Text string `json:"text"`
}
type QuestionInput struct {
	Type           string   `json:"type"`
	Stem           string   `json:"stem"`
	Options        []Option `json:"options"`
	CorrectAnswers []string `json:"correct_answers,omitempty"`
}
type ContributorInput struct {
	Username  string `json:"username"`
	SourceURL string `json:"source_url"`
}
type BatchInput struct {
	CourseID    uint64           `json:"course_id"`
	Contributor ContributorInput `json:"contributor"`
	Questions   []QuestionInput  `json:"questions"`
}
type SearchInput struct {
	CourseID uint64   `json:"course_id"`
	Type     string   `json:"type"`
	Stem     string   `json:"stem"`
	Options  []Option `json:"options"`
}
type BatchItem struct {
	QuestionID          uint64 `json:"question_id"`
	QuestionCreated     bool   `json:"question_created"`
	ContributionCreated bool   `json:"contribution_created"`
}
type Attribution struct {
	Username    string    `json:"username"`
	SourceURL   string    `json:"source_url"`
	SubmittedAt time.Time `json:"submitted_at"`
}
type AnswerCandidate struct {
	AnswerKeys   []string      `json:"answer_keys"`
	AnswerTexts  []string      `json:"answer_texts"`
	SupportCount int           `json:"support_count"`
	Contributors []Attribution `json:"contributors"`
}
type QuestionView struct {
	ID               uint64            `json:"id"`
	CourseID         uint64            `json:"course_id"`
	Type             string            `json:"type"`
	Stem             string            `json:"stem"`
	Options          []Option          `json:"options"`
	AnswerCandidates []AnswerCandidate `json:"answer_candidates"`
	HasAnswer        bool              `json:"has_answer"`
	Conflict         bool              `json:"conflict"`
	Contributors     []Attribution     `json:"contributors"`
	CreatedAt        time.Time         `json:"created_at"`
}

func Normalize(s string) string { return strings.Join(strings.Fields(norm.NFC.String(s)), " ") }
func hash(v any) string {
	data, _ := json.Marshal(v)
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}
func bounded(s string, max int) bool {
	return s != "" && utf8.ValidString(s) && utf8.RuneCountInString(s) <= max
}

func (s *Store) CreateCourse(ctx context.Context, in CourseInput) (model.Course, bool, error) {
	in.Platform, in.Name, in.ExternalID = Normalize(in.Platform), Normalize(in.Name), Normalize(in.ExternalID)
	if !bounded(in.Platform, 100) || !bounded(in.Name, 300) || utf8.RuneCountInString(in.ExternalID) > 200 {
		return model.Course{}, false, invalid("platform/name 必填，长度上限分别为 100/300；external_id 上限 200")
	}
	identityKind, identityValue := "external_id", in.ExternalID
	if identityValue == "" {
		identityKind, identityValue = "name", in.Name
	}
	c := model.Course{Identity: hash([]string{in.Platform, identityKind, identityValue}), Platform: in.Platform, Name: in.Name, ExternalID: in.ExternalID}
	db := s.DB.WithContext(ctx)
	result := db.Clauses(clause.OnConflict{DoNothing: true}).Create(&c)
	if result.Error != nil {
		return c, false, result.Error
	}
	created := result.RowsAffected > 0
	if err := db.Where("identity = ?", c.Identity).First(&c).Error; err != nil {
		return c, false, err
	}
	return c, created, nil
}

func normalizeQuestion(in QuestionInput) (model.Question, []string, error) {
	if in.Type != "single" && in.Type != "multiple" {
		return model.Question{}, nil, invalid("type 仅支持 single 或 multiple")
	}
	stem := Normalize(in.Stem)
	if !bounded(stem, 10000) || len(in.Options) < 2 || len(in.Options) > 26 {
		return model.Question{}, nil, invalid("stem 必填且最多 10000 字；选项数量必须为 2–26")
	}
	options := make([]Option, len(in.Options))
	keys, texts := map[string]string{}, map[string]bool{}
	canonical := make([]string, len(in.Options))
	for i, opt := range in.Options {
		opt.Key, opt.Text = strings.TrimSpace(opt.Key), Normalize(opt.Text)
		if !bounded(opt.Key, 32) || !bounded(opt.Text, 5000) {
			return model.Question{}, nil, invalid("选项 key/text 必填且长度分别不能超过 32/5000")
		}
		if _, ok := keys[opt.Key]; ok {
			return model.Question{}, nil, invalid("选项 key 不能重复")
		}
		if texts[opt.Text] {
			return model.Question{}, nil, invalid("选项文本规范化后不能重复，无法可靠匹配答案")
		}
		keys[opt.Key], texts[opt.Text] = opt.Text, true
		options[i], canonical[i] = opt, opt.Text
	}
	if in.Type == "single" && len(in.CorrectAnswers) > 1 {
		return model.Question{}, nil, invalid("单选题最多一个正确答案")
	}
	answers := make([]string, 0, len(in.CorrectAnswers))
	seen := map[string]bool{}
	for _, key := range in.CorrectAnswers {
		answer, ok := keys[strings.TrimSpace(key)]
		if !ok {
			return model.Question{}, nil, invalid("correct_answers 必须引用现有选项 key")
		}
		if seen[answer] {
			return model.Question{}, nil, invalid("correct_answers 不能重复")
		}
		seen[answer] = true
		answers = append(answers, answer)
	}
	sort.Strings(canonical)
	sort.Strings(answers)
	optionsJSON, _ := json.Marshal(options)
	return model.Question{Type: in.Type, Stem: stem, NormalizedStem: stem, OptionsJSON: string(optionsJSON), Fingerprint: hash([]any{in.Type, stem, canonical})}, answers, nil
}

func (s *Store) Upload(ctx context.Context, in BatchInput) ([]BatchItem, error) {
	if in.CourseID == 0 || len(in.Questions) < 1 || len(in.Questions) > 100 {
		return nil, invalid("course_id 必填；每批 1–100 道题")
	}
	in.Contributor.Username = Normalize(in.Contributor.Username)
	in.Contributor.SourceURL = strings.TrimSpace(in.Contributor.SourceURL)
	if !bounded(in.Contributor.Username, 100) || !bounded(in.Contributor.SourceURL, 2048) {
		return nil, invalid("contributor.username/source_url 必填且长度分别不能超过 100/2048")
	}
	u, err := url.Parse(in.Contributor.SourceURL)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil {
		return nil, invalid("source_url 必须是无用户名密码的 http(s) URL")
	}
	// Validate the entire batch before writing anything.
	questions, answers := make([]model.Question, len(in.Questions)), make([][]string, len(in.Questions))
	for i, input := range in.Questions {
		q, a, err := normalizeQuestion(input)
		if err != nil {
			return nil, invalid(fmt.Sprintf("questions[%d]: %s", i, err))
		}
		q.CourseID = in.CourseID
		questions[i], answers[i] = q, a
	}
	items := make([]BatchItem, 0, len(questions))
	err = s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var course model.Course
		if err := tx.First(&course, in.CourseID).Error; err != nil {
			return err
		}
		for i, q := range questions {
			result := tx.Omit("Course", "Contributions").Clauses(clause.OnConflict{DoNothing: true}).Create(&q)
			if result.Error != nil {
				return result.Error
			}
			created := result.RowsAffected > 0
			if err := tx.Where("course_id = ? AND fingerprint = ?", q.CourseID, q.Fingerprint).First(&q).Error; err != nil {
				return err
			}
			encoded, _ := json.Marshal(answers[i])
			contribution := model.Contribution{QuestionID: q.ID, Username: in.Contributor.Username, SourceURL: in.Contributor.SourceURL, AnswerJSON: string(encoded)}
			contribution.Identity = hash([]string{strconv.FormatUint(q.ID, 10), contribution.Username, contribution.SourceURL, contribution.AnswerJSON})
			result = tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&contribution)
			if result.Error != nil {
				return result.Error
			}
			items = append(items, BatchItem{q.ID, created, result.RowsAffected > 0})
		}
		return nil
	})
	return items, err
}

func (s *Store) Search(ctx context.Context, in SearchInput) (*QuestionView, error) {
	if in.CourseID == 0 {
		return nil, invalid("course_id 必填")
	}
	q, _, err := normalizeQuestion(QuestionInput{Type: in.Type, Stem: in.Stem, Options: in.Options})
	if err != nil {
		return nil, err
	}
	err = s.DB.WithContext(ctx).Preload("Contributions", func(db *gorm.DB) *gorm.DB { return db.Order("id ASC") }).Where("course_id = ? AND fingerprint = ?", in.CourseID, q.Fingerprint).First(&q).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	// Return keys from the caller's current page rather than the original upload.
	view, err := View(q, in.Options)
	return &view, err
}

func (s *Store) Get(ctx context.Context, id uint64) (QuestionView, error) {
	var q model.Question
	if err := s.DB.WithContext(ctx).Preload("Contributions", func(db *gorm.DB) *gorm.DB { return db.Order("id ASC") }).First(&q, id).Error; err != nil {
		return QuestionView{}, err
	}
	return View(q, nil)
}

func View(q model.Question, currentOptions []Option) (QuestionView, error) {
	options := currentOptions
	if options == nil {
		if err := json.Unmarshal([]byte(q.OptionsJSON), &options); err != nil {
			return QuestionView{}, err
		}
	}
	v := QuestionView{ID: q.ID, CourseID: q.CourseID, Type: q.Type, Stem: q.Stem, Options: options, CreatedAt: q.CreatedAt, AnswerCandidates: []AnswerCandidate{}, Contributors: []Attribution{}}
	byText := map[string]Option{}
	for _, opt := range options {
		byText[Normalize(opt.Text)] = opt
	}
	groups := map[string]*AnswerCandidate{}
	supporters := map[string]map[string]bool{}
	for _, c := range q.Contributions {
		a := Attribution{c.Username, c.SourceURL, c.CreatedAt}
		v.Contributors = append(v.Contributors, a)
		var answers []string
		if err := json.Unmarshal([]byte(c.AnswerJSON), &answers); err != nil {
			return v, err
		}
		if len(answers) == 0 {
			continue
		}
		g := groups[c.AnswerJSON]
		if g == nil {
			g = &AnswerCandidate{AnswerKeys: []string{}, AnswerTexts: []string{}, Contributors: []Attribution{}}
			// Preserve current page option order, including multiple choice answers.
			answerSet := map[string]bool{}
			for _, answer := range answers {
				if _, ok := byText[answer]; !ok {
					return v, errors.New("stored answer does not match question options")
				}
				answerSet[answer] = true
			}
			for _, opt := range options {
				if answerSet[Normalize(opt.Text)] {
					g.AnswerKeys = append(g.AnswerKeys, opt.Key)
					g.AnswerTexts = append(g.AnswerTexts, opt.Text)
				}
			}
			groups[c.AnswerJSON], supporters[c.AnswerJSON] = g, map[string]bool{}
		}
		g.Contributors = append(g.Contributors, a)
		supporters[c.AnswerJSON][c.Username] = true
		g.SupportCount = len(supporters[c.AnswerJSON])
	}
	// Stable ordering makes API results deterministic even when support counts tie.
	groupKeys := make([]string, 0, len(groups))
	for key := range groups {
		groupKeys = append(groupKeys, key)
	}
	sort.Slice(groupKeys, func(i, j int) bool {
		a, b := groups[groupKeys[i]], groups[groupKeys[j]]
		if a.SupportCount != b.SupportCount {
			return a.SupportCount > b.SupportCount
		}
		return groupKeys[i] < groupKeys[j]
	})
	for _, key := range groupKeys {
		v.AnswerCandidates = append(v.AnswerCandidates, *groups[key])
	}
	v.HasAnswer, v.Conflict = len(groups) > 0, len(groups) > 1
	return v, nil
}

// Escape literal wildcard characters for portable SQL LIKE queries.
func ContainsPattern(s string) string {
	r := strings.NewReplacer("!", "!!", "%", "!%", "_", "!_")
	return "%" + r.Replace(Normalize(s)) + "%"
}
