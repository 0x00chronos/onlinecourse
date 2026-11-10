package model

import "time"

// Identity hashes make uniqueness consistent across database collations.
type Course struct {
	ID         uint64    `gorm:"primaryKey" json:"id"`
	Identity   string    `gorm:"size:64;not null;uniqueIndex" json:"-"`
	Platform   string    `gorm:"size:100;not null" json:"platform"`
	ExternalID string    `gorm:"size:200;not null" json:"external_id"`
	Name       string    `gorm:"size:300;not null" json:"name"`
	CreatedAt  time.Time `json:"created_at"`
	UpdatedAt  time.Time `json:"updated_at"`
}

type Question struct {
	ID             uint64         `gorm:"primaryKey" json:"id"`
	CourseID       uint64         `gorm:"not null;uniqueIndex:idx_question_identity,priority:1;index" json:"course_id"`
	Fingerprint    string         `gorm:"size:64;not null;uniqueIndex:idx_question_identity,priority:2" json:"-"`
	Type           string         `gorm:"size:16;not null" json:"type"`
	Stem           string         `gorm:"type:text;not null" json:"stem"`
	NormalizedStem string         `gorm:"type:text;not null" json:"-"`
	OptionsJSON    string         `gorm:"type:text;not null" json:"-"`
	Course         Course         `gorm:"constraint:OnDelete:RESTRICT" json:"-"`
	Contributions  []Contribution `json:"-"`
	CreatedAt      time.Time      `json:"created_at"`
	UpdatedAt      time.Time      `json:"updated_at"`
}

// Empty answer arrays record question-only uploads; they never become candidates.
type Contribution struct {
	ID         uint64    `gorm:"primaryKey" json:"id"`
	QuestionID uint64    `gorm:"not null;index" json:"question_id"`
	Identity   string    `gorm:"size:64;not null;uniqueIndex" json:"-"`
	Username   string    `gorm:"size:100;not null" json:"username"`
	SourceURL  string    `gorm:"type:text;not null" json:"source_url"`
	AnswerJSON string    `gorm:"type:text;not null" json:"-"`
	CreatedAt  time.Time `json:"created_at"`
}
