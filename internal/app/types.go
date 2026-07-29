package app

import "time"

type User struct {
	ID          string `json:"id"`
	Email       string `json:"email"`
	DisplayName string `json:"displayName"`
	AvatarURL   string `json:"avatarUrl,omitempty"`
}

type PDF struct {
	OriginalFilename string    `json:"originalFilename"`
	SizeBytes        int64     `json:"sizeBytes"`
	ChecksumSHA256   string    `json:"checksumSha256"`
	PageCount        int       `json:"pageCount"`
	UploadedAt       time.Time `json:"uploadedAt"`
	ContentURL       string    `json:"contentUrl"`
}

type Piece struct {
	ID           string    `json:"id"`
	Title        string    `json:"title"`
	Composer     string    `json:"composer"`
	Favorite     bool      `json:"favorite"`
	SourceURL    string    `json:"sourceUrl"`
	ListeningURL string    `json:"listeningUrl"`
	Notes        string    `json:"notes"`
	CreatedAt    time.Time `json:"createdAt"`
	UpdatedAt    time.Time `json:"updatedAt"`
	PDF          *PDF      `json:"pdf"`
}

type PieceInput struct {
	Title        string `json:"title"`
	Composer     string `json:"composer"`
	Favorite     bool   `json:"favorite"`
	SourceURL    string `json:"sourceUrl"`
	ListeningURL string `json:"listeningUrl"`
	Notes        string `json:"notes"`
}

type PiecePatch struct {
	Title        *string `json:"title"`
	Composer     *string `json:"composer"`
	Favorite     *bool   `json:"favorite"`
	SourceURL    *string `json:"sourceUrl"`
	ListeningURL *string `json:"listeningUrl"`
	Notes        *string `json:"notes"`
}

type ReaderState struct {
	PieceID        string    `json:"pieceId"`
	Mode           string    `json:"mode"`
	LastPage       int       `json:"lastPage"`
	ScrollPosition float64   `json:"scrollPosition"`
	Zoom           float64   `json:"zoom"`
	ScrollSpeed    float64   `json:"scrollSpeed"`
	ScrollPaused   bool      `json:"scrollPaused"`
	UpdatedAt      time.Time `json:"updatedAt"`
}
