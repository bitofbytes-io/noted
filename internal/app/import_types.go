package app

import "time"

type PageEdit struct {
	ID           string      `json:"id"`
	SourceID     string      `json:"sourceId"`
	Page         int         `json:"page"`
	Angle        float64     `json:"angle,omitempty"`
	Rotation     int         `json:"rotation,omitempty"`
	OutputWidth  float64     `json:"outputWidth,omitempty"` // physical canvas in PDF points
	OutputHeight float64     `json:"outputHeight,omitempty"`
	Scale        float64     `json:"scale,omitempty"`
	X            float64     `json:"x,omitempty"`
	Y            float64     `json:"y,omitempty"`
	Crop         []float64   `json:"crop,omitempty"`    // normalized left,top,right,bottom in original displayed page
	Corners      [][]float64 `json:"corners,omitempty"` // normalized clockwise photo corners
}
type EditManifest struct {
	Version int        `json:"version"`
	Pages   []PageEdit `json:"pages"`
}
type ImportAsset struct {
	ID         string    `json:"id"`
	Filename   string    `json:"filename"`
	MIME       string    `json:"mime"`
	Size       int64     `json:"size"`
	Checksum   string    `json:"checksum"`
	PageCount  int       `json:"pageCount"`
	Width      int       `json:"width"`
	Height     int       `json:"height"`
	CreatedAt  time.Time `json:"createdAt"`
	StorageKey string    `json:"-"`
}
type ImportDraft struct {
	ID              string        `json:"id"`
	PieceID         *string       `json:"pieceId"`
	Revision        int64         `json:"revision"`
	BaseRevision    int64         `json:"-"`
	Metadata        PieceInput    `json:"metadata"`
	Manifest        EditManifest  `json:"manifest"`
	InitialManifest EditManifest  `json:"initialManifest"`
	Sources         []ImportAsset `json:"sources"`
	Finalized       bool          `json:"finalized"`
	UpdatedAt       time.Time     `json:"updatedAt"`
	MaxFileBytes    int64         `json:"maxFileBytes"`
}
type CreateImport struct {
	PieceID   string `json:"pieceId"`
	SourceURL string `json:"sourceUrl"`
}
type UpdateImport struct {
	Revision int64        `json:"revision"`
	Metadata PieceInput   `json:"metadata"`
	Manifest EditManifest `json:"manifest"`
}
