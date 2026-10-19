package app

import (
	"context"
	"regexp"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

// searchFoldVersion changes whenever foldSearch or searchTerms does, so the API
// refolds every piece's search_text once on its next start (see
// RefoldSearchText).
const searchFoldVersion = 2

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

// catalogues are the opus and catalogue abbreviations that join the number
// after them, mapped to the form search keeps: "Op. 28" and "opus 28" are op28,
// "K. 545" and "KV 545" k545, and "No. 4" and "Nr. 4" no4.
var catalogues = map[string]string{
	"op": "op", "opus": "op", "no": "no", "nr": "no",
	"bwv": "bwv", "k": "k", "kv": "k", "hob": "hob", "d": "d", "l": "l", "s": "s",
	"hwv": "hwv", "rv": "rv", "bb": "bb", "woo": "woo", "sz": "sz",
}

// germanKeys are the German note names that name a key before dur or moll:
// cis-moll is C♯ minor, Es-Dur E♭ major, h-moll B minor and b-moll B♭ minor.
var germanKeys = map[string]string{
	"c": "c", "d": "d", "e": "e", "f": "f", "g": "g", "a": "a", "h": "b", "b": "b flat",
	"cis": "c sharp", "dis": "d sharp", "eis": "e sharp", "fis": "f sharp",
	"gis": "g sharp", "ais": "a sharp", "his": "b sharp",
	"ces": "c flat", "des": "d flat", "es": "e flat", "fes": "f flat", "ges": "g flat", "as": "a flat",
}

var germanModes = map[string]string{"dur": "major", "moll": "minor"}

var (
	catalogueNumber = regexp.MustCompile(`^[0-9]+[a-z]?$`)
	gluedCatalogue  = regexp.MustCompile(`^([a-z]+)([0-9]+[a-z]?)$`)
	// "Op. 28/4": a short number straight after an opus is its number within it.
	opusPart     = regexp.MustCompile(`^[0-9]{1,3}$`)
	romanNumeral = regexp.MustCompile(`^[ivxl]+$`)
	englishFlat  = regexp.MustCompile(`^[a-g]b$`)
)

// searchTerms are the words search matches for a text: its fold, with
// catalogue numbers and keys written one way however they were typed.
// "Op. 28 No. 4" and "op28/4" are both op28 no4, "KV 545" is k545,
// "Hob. XVI:52" hobxvi52, and "cis-moll", "C# minor" and "c-sharp minor" are
// all c sharp minor. Each word of a search is one of these terms. The web
// app's searchTerms in web/src/app/core/search.ts is the same function; both
// are tested against testdata/search-fold-vectors.json.
func searchTerms(text string) []string {
	words := []string{}
	for _, word := range strings.Fields(foldSearch(text)) {
		if parts := gluedCatalogue.FindStringSubmatch(word); parts != nil && catalogues[parts[1]] != "" {
			words = append(words, parts[1], parts[2])
		} else {
			words = append(words, word)
		}
	}
	at := func(i int) string {
		if i < len(words) {
			return words[i]
		}
		return ""
	}
	terms := []string{}
	for i := 0; i < len(words); i++ {
		word, next := words[i], at(i+1)
		catalogue := catalogues[word]
		switch {
		case catalogue == "hob" && romanNumeral.MatchString(next) && catalogueNumber.MatchString(at(i+2)):
			terms = append(terms, catalogue+next+at(i+2))
			i += 2
		case catalogue != "" && catalogueNumber.MatchString(next):
			terms = append(terms, catalogue+next)
			i++
			if catalogue == "op" && opusPart.MatchString(at(i+1)) {
				terms = append(terms, "no"+at(i+1))
				i++
			}
		case germanKeys[word] != "" && germanModes[next] != "":
			terms = append(terms, strings.Fields(germanKeys[word]+" "+germanModes[next])...)
			i++
		case englishFlat.MatchString(word) && (next == "major" || next == "minor"):
			// "Bb major" is B♭ major.
			terms = append(terms, word[:1], "flat", next)
			i++
		default:
			terms = append(terms, word)
		}
	}
	return terms
}

// searchIndex is the search text stored for a text: its fold, then any of its
// search terms the fold lacks. "Prelude Op. 28 No. 4" is stored as "prelude op
// 28 no 4 op28 no4", so searches for "op28/4" and for "op" both find it.
func searchIndex(text string) string {
	folded := foldSearch(text)
	seen := map[string]bool{}
	for _, word := range strings.Fields(folded) {
		seen[word] = true
	}
	index := folded
	for _, term := range searchTerms(text) {
		if !seen[term] {
			seen[term] = true
			index += " " + term
		}
	}
	return index
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
