package app

import (
	"context"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

// searchFoldVersion changes whenever foldSearch does, so the API refolds every
// piece's search_text once on its next start (see RefoldSearchText).
const searchFoldVersion = 1

// foldLeftovers are letters that keep no combining mark to strip, and the
// accidentals, which become words so "C#" finds "C♯".
var foldLeftovers = strings.NewReplacer(
	"ø", "o", "ł", "l", "ß", "ss", "æ", "ae", "œ", "oe", "đ", "d", "ð", "d", "þ", "th",
	"ı", "i", "ς", "σ",
	"♯", " sharp ", "#", " sharp ", "♭", " flat ",
)

// foldSearch is the library's search form of a text: without accents, lower
// case, with every run of other characters a single space. A title such as
// "Dvořák: Humoresque Op.101/7" folds to "dvorak humoresque op 101 7". The web
// app's fold in web/src/app/core/search.ts is the same function; both are
// tested against testdata/search-fold-vectors.json.
func foldSearch(text string) string {
	text = foldLeftovers.Replace(strings.ToLower(norm.NFKD.String(text)))
	var folded strings.Builder
	gap := false
	for _, r := range text {
		switch {
		case unicode.Is(unicode.M, r):
		case unicode.IsLetter(r) || unicode.IsNumber(r):
			if gap && folded.Len() > 0 {
				folded.WriteByte(' ')
			}
			gap = false
			folded.WriteRune(r)
		default:
			gap = true
		}
	}
	return folded.String()
}

// searchTokens are the words of a search, each of which a piece must contain.
func searchTokens(query string) []string {
	return strings.Fields(foldSearch(query))
}

// likeEscape makes every character of a LIKE pattern literal, for ESCAPE '\'.
var likeEscape = strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace

// RefoldSearchText refolds every piece's search text if foldSearch changed
// since it was last stored. The API runs it once on start; concurrent starts
// wait on the state row, so only one does the work.
func (s *Service) RefoldSearchText(ctx context.Context) (int, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	var version int
	if err = tx.QueryRow(ctx, `SELECT fold_version FROM search_index_state WHERE id FOR UPDATE`).Scan(&version); err != nil {
		return 0, err
	}
	if version == searchFoldVersion {
		return 0, nil
	}
	rows, err := tx.Query(ctx, `SELECT id, title, composer, aliases, notes FROM pieces FOR UPDATE`)
	if err != nil {
		return 0, err
	}
	ids, texts := []string{}, []string{}
	for rows.Next() {
		var id string
		var input PieceInput
		if err = rows.Scan(&id, &input.Title, &input.Composer, &input.Aliases, &input.Notes); err != nil {
			rows.Close()
			return 0, err
		}
		ids, texts = append(ids, id), append(texts, searchText(input))
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return 0, err
	}
	if _, err = tx.Exec(ctx, `
		UPDATE pieces p SET search_text=folded.text
		FROM unnest($1::uuid[], $2::text[]) AS folded(id, text)
		WHERE p.id=folded.id`, ids, texts); err != nil {
		return 0, err
	}
	if _, err = tx.Exec(ctx, `UPDATE search_index_state SET fold_version=$1 WHERE id`, searchFoldVersion); err != nil {
		return 0, err
	}
	return len(ids), tx.Commit(ctx)
}
