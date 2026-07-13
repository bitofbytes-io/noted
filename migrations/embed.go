package migrations

import "embed"

// FS contains the versioned schema used by the API and migration command.
//
//go:embed *.sql
var FS embed.FS
