package app

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

const suggestionLimit = 8
const suggestionMaxQueryBytes = 200
const suggestionMaxTerms = 8

var ErrSuggestionsThrottled = errors.New("similar-match requests are arriving too quickly")

func fuzzyTerm(term string) bool {
	if utf8.RuneCountInString(term) < 4 {
		return false
	}
	for _, r := range term {
		if !unicode.IsLetter(r) {
			return false
		}
	}
	return true
}

func suggestionTerms(query string) ([]string, error) {
	if !utf8.ValidString(query) || len(query) > suggestionMaxQueryBytes {
		return nil, invalid("search must contain at most 200 bytes of valid text")
	}
	terms := searchTerms(query)
	if len(terms) > suggestionMaxTerms {
		return nil, invalid("similar matches support at most 8 search terms")
	}
	return terms, nil
}

// suggestionQuery keeps every original term mandatory and excludes full exact
// matches before limiting. One-to-one PDF/reader joins cannot duplicate a piece.
func suggestionQuery(owner string, options ListOptions) (string, []any, error) {
	terms, err := suggestionTerms(options.Query)
	if err != nil {
		return "", nil, err
	}
	args := []any{owner}
	where := []string{"p.user_id=$1"}
	exacts := []string{}
	scores := []string{}
	eligible := false
	for _, term := range terms {
		args = append(args, "%"+likeEscape(term)+"%")
		exact := fmt.Sprintf(`p.search_text LIKE $%d ESCAPE '\'`, len(args))
		exacts = append(exacts, exact)
		if !fuzzyTerm(term) {
			where = append(where, exact)
			continue
		}
		eligible = true
		variants := []string{term}
		// This named transliteration pair scores only 0.4/0.3889 in raw pg_trgm.
		// Expand the query only; never rewrite identity, display or exact search.
		switch term {
		case "tchaikovsky":
			variants = append(variants, "tschaikowsky")
		case "tschaikowsky":
			variants = append(variants, "tchaikovsky")
		}
		choices := []string{exact}
		similarities := []string{}
		for _, variant := range variants {
			args = append(args, variant)
			parameter := fmt.Sprintf("$%d", len(args))
			choices = append(choices, parameter+" <% p.search_text")
			similarities = append(similarities, "word_similarity("+parameter+",p.search_text)")
		}
		where = append(where, "("+strings.Join(choices, " OR ")+")")
		scores = append(scores, "CASE WHEN "+exact+" THEN 1 ELSE GREATEST("+strings.Join(similarities, ",")+") END")
	}
	if !eligible {
		return "", nil, nil
	}
	where = append(where, "NOT ("+strings.Join(exacts, " AND ")+")")
	if options.Favorite != nil {
		args = append(args, *options.Favorite)
		where = append(where, fmt.Sprintf("p.favorite=$%d", len(args)))
	}
	if options.Statuses != nil {
		for _, status := range options.Statuses {
			if !validStatus(status) {
				return "", nil, invalid("invalid status")
			}
		}
		args = append(args, options.Statuses)
		where = append(where, fmt.Sprintf("p.status=ANY($%d::text[])", len(args)))
	}
	args = append(args, suggestionLimit)
	query := `SELECT p.id,p.title,p.composer,p.aliases,p.favorite,p.status,p.listening_url,
 f.page_count,r.updated_at,p.created_at,p.search_text FROM ` + pieceTables + ` WHERE ` + strings.Join(where, " AND ") + `
 ORDER BY (` + strings.Join(scores, " + ") + `) DESC, ` + titleOrder + fmt.Sprintf(" LIMIT $%d", len(args))
	return query, args, nil
}

// SuggestPieces is additive to local exact search. The operator threshold and
// statement timeout are transaction-local, including on cancellation/rollback.
func (s *Service) SuggestPieces(ctx context.Context, owner string, options ListOptions) ([]PieceSummary, error) {
	query, args, err := suggestionQuery(owner, options)
	if err != nil {
		return nil, err
	}
	result := []PieceSummary{}
	if query == "" {
		return result, nil
	}
	if !s.suggestions.allow(owner) {
		return nil, ErrSuggestionsThrottled
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // Read-only transaction cleanup also resets local settings.
	if _, err := tx.Exec(ctx, `SELECT set_config('pg_trgm.word_similarity_threshold','0.6',true), set_config('statement_timeout','1500ms',true), set_config('lock_timeout','500ms',true)`); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var p PieceSummary
		var pages *int
		if err := rows.Scan(&p.ID, &p.Title, &p.Composer, &p.Aliases, &p.Favorite, &p.Status, &p.ListeningURL, &pages, &p.LastPlayedAt, &p.CreatedAt, &p.SearchText); err != nil {
			return nil, err
		}
		if pages != nil {
			p.PDF = &SummaryPDF{PageCount: *pages, ContentURL: "/api/pieces/" + p.ID + "/pdf"}
		}
		result = append(result, p)
	}
	return result, rows.Err()
}
