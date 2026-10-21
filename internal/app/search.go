package app

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

// searchFoldVersion changes whenever foldSearch or searchTerms does, so the API
// refolds every piece's search_text once on its next start (see
// RefoldSearchText).
const searchFoldVersion = 3

// ErrSearchFoldVersionAhead prevents an older API from replacing a newer index.
var ErrSearchFoldVersionAhead = errors.New("search fold version is newer than this API")

// foldLeftovers are letters that keep no combining mark to strip, and the
// accidentals, which become words so "C#" finds "C♯".
var foldLeftovers = strings.NewReplacer(
	"ø", "o", "ł", "l", "ß", "ss", "æ", "ae", "œ", "oe", "đ", "d", "ð", "d", "þ", "th",
	"ı", "i", "ς", "σ",
	"♯", " sharp ", "#", " sharp ", "♭", " flat ",
)

// Normalize number signs before NFKD turns º into an ordinary o.
func normalizedSearch(text string) string {
	text = strings.NewReplacer("N°", "no ", "n°", "no ", "Nº", "no ", "nº", "no ").Replace(text)
	return foldLeftovers.Replace(strings.ToLower(norm.NFKD.String(text)))
}

// foldSearch is the library's search form of a text: without accents, lower
// case, with every run of other characters a single space. A title such as
// "Dvořák: Humoresque Op.101/7" folds to "dvorak humoresque op 101 7". The web
// app's fold in web/src/app/core/search.ts is the same function; both are
// tested against testdata/search-fold-vectors.json.
func foldSearch(text string) string {
	text = normalizedSearch(text)
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
	searchWord   = regexp.MustCompile(`[\p{L}\p{N}\p{M}]+`)
	musicalKey   = regexp.MustCompile(`^[a-g](?:sharp|flat)?(?:major|minor)$|^[a-g](?:sharp|flat)$`)
)

// searchTerms are the words search matches for a text: its fold, with
// catalogue numbers and keys written one way however they were typed.
// "Op. 28 No. 4" and "op28/4" are both op28 no4, "KV 545" is k545,
// "Hob. XVI:52" hobxvi52, and "cis-moll", "C# minor" and "c-sharp minor" are
// all csharpminor. Each word of a search is one of these terms. The web
// app's searchTerms in web/src/app/core/search.ts is the same function; both
// are tested against testdata/search-fold-vectors.json.
//
// A search keeps a bare number after an opus as typed: while "op 10 1833" is
// typed, "op 10 18" must still find Op. 10 (1833). The stored text has both
// forms of "op28/4", so the search "op28 4" still finds it.
func searchTerms(text string) []string {
	return catalogueTerms(text, false)
}

// catalogueTerms are searchTerms, with a 1–3 digit number straight after an
// opus read as its number within it ("Op. 28/4" is op28 no4) when opusParts.
func catalogueTerms(text string, opusParts bool) []string {
	words, shortAllowed := []string{}, []bool{}
	normalized := normalizedSearch(text)
	// Keep punctuation until catalogue recognition: a possessive's s is not S.
	for _, span := range searchWord.FindAllStringIndex(normalized, -1) {
		word := foldSearch(normalized[span[0]:span[1]])
		allowed := strings.TrimSpace(normalized[:span[0]]) == "" || strings.HasPrefix(normalized[span[1]:], ".")
		if parts := gluedCatalogue.FindStringSubmatch(word); parts != nil && catalogues[parts[1]] != "" && (!shortCatalogue(parts[1]) || allowed) {
			words = append(words, parts[1], parts[2])
			shortAllowed = append(shortAllowed, allowed, false)
		} else {
			words = append(words, word)
			shortAllowed = append(shortAllowed, allowed)
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
		if shortCatalogue(word) && !shortAllowed[i] {
			catalogue = ""
		}
		switch {
		case catalogue == "hob" && romanNumeral.MatchString(next) && catalogueNumber.MatchString(at(i+2)):
			terms = append(terms, catalogue+next+at(i+2))
			i += 2
		case catalogue != "" && catalogueNumber.MatchString(next):
			terms = append(terms, catalogue+next)
			i++
			if opusParts && catalogue == "op" && opusPart.MatchString(at(i+1)) {
				terms = append(terms, "no"+at(i+1))
				i++
			}
		case germanKeys[word] != "" && germanModes[next] != "":
			terms = append(terms, strings.ReplaceAll(germanKeys[word], " ", "")+germanModes[next])
			i++
		case englishFlat.MatchString(word):
			mode := ""
			if next == "major" || next == "minor" {
				mode = next
				i++
			}
			terms = append(terms, word[:1]+"flat"+mode)
		case len(word) == 1 && strings.Contains("abcdefg", word) && (next == "sharp" || next == "flat"):
			key := word + next
			i++
			if at(i+1) == "major" || at(i+1) == "minor" || at(i+1) == "m" {
				mode := at(i + 1)
				if mode == "m" {
					mode = "minor"
				}
				key += mode
				i++
			}
			terms = append(terms, key)
		case len(word) == 1 && strings.Contains("abcdefg", word) && (next == "major" || next == "minor"):
			terms = append(terms, word+next)
			i++
		default:
			terms = append(terms, word)
		}
	}
	return terms
}

func shortCatalogue(word string) bool { return word == "s" || word == "d" || word == "l" }

// searchIndex parses fields independently before combining their raw folds and
// canonical terms. Field boundaries never turn a trailing Op. into Op. 24.
func searchIndex(fields ...string) string {
	folds, terms := []string{}, []string{}
	for _, field := range fields {
		if folded := foldSearch(field); folded != "" {
			folds = append(folds, folded)
		}
		terms = append(terms, catalogueTerms(field, true)...)
	}
	index := strings.Join(folds, " ")
	seen := map[string]bool{}
	for _, word := range strings.Fields(index) {
		seen[word] = true
	}
	for _, term := range terms {
		if !seen[term] {
			seen[term] = true
			if index != "" {
				index += " "
			}
			index += term
		}
	}
	return index
}

func isKeyTerm(term string) bool { return musicalKey.MatchString(term) }

// Keys match complete tokens; an accidental without a mode intentionally matches
// either mode while the user is typing. Other words retain substring search.
func matchesSearchTerm(index, term string) bool {
	if !isKeyTerm(term) {
		return strings.Contains(index, term)
	}
	for _, word := range strings.Fields(index) {
		if word == term || (!strings.HasSuffix(term, "major") && !strings.HasSuffix(term, "minor") && strings.HasPrefix(word, term)) {
			return true
		}
	}
	return false
}

func searchPattern(term string) (string, string) {
	if isKeyTerm(term) {
		suffix := " %"
		if !strings.HasSuffix(term, "major") && !strings.HasSuffix(term, "minor") {
			suffix = "%"
		}
		return "(' ' || p.search_text || ' ')", "% " + likeEscape(term) + suffix
	}
	return "p.search_text", "%" + likeEscape(term) + "%"
}

// Exact whole terms outrank catalogue prefixes, retaining the selected sort
// inside each group.
func exactTermRank(index string, terms []string) int {
	words := strings.Fields(index)
	rank := 0
	for _, term := range terms {
		if !slices.Contains(words, term) {
			rank++
		}
	}
	return rank
}

// likeEscape makes every character of a LIKE pattern literal, for ESCAPE '\'.
var likeEscape = strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace

// RefoldSearchText refolds every piece's search text if foldSearch changed
// since it was last stored. The API runs it once on start; concurrent starts
// wait on the state row, so only one does the work.
func (s *Service) RefoldSearchText(ctx context.Context) (int, error) {
	return s.refoldSearchText(ctx, false)
}

// ForceRefoldSearchText repairs rows last written by an older API after the
// startup version marker advanced. Run only after all old writers have drained.
func (s *Service) ForceRefoldSearchText(ctx context.Context) (int, error) {
	return s.refoldSearchText(ctx, true)
}

func (s *Service) refoldSearchText(ctx context.Context, force bool) (int, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // Best-effort transaction cleanup; keep the operation error and allow already-committed transactions.
	var version int
	if err = tx.QueryRow(ctx, `SELECT fold_version FROM search_index_state WHERE id FOR UPDATE`).Scan(&version); err != nil {
		return 0, err
	}
	if version > searchFoldVersion {
		return 0, fmt.Errorf("%w: %d", ErrSearchFoldVersionAhead, version)
	}
	if version == searchFoldVersion && !force {
		return 0, nil
	}
	rows, err := tx.Query(ctx, `SELECT id, title, composer, aliases, notes, opus, music_key FROM pieces FOR UPDATE`)
	if err != nil {
		return 0, err
	}
	ids, texts := []string{}, []string{}
	for rows.Next() {
		var id string
		var input PieceInput
		if err = rows.Scan(&id, &input.Title, &input.Composer, &input.Aliases, &input.Notes, &input.Opus, &input.MusicKey); err != nil {
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
