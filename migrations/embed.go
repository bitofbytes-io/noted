package migrations

import "embed"

// FS contains the complete binder schema.
//
//go:embed *.sql
var FS embed.FS
