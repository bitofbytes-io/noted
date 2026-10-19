package app

import (
	"regexp"
	"slices"
	"strings"

	"golang.org/x/text/collate"
	"golang.org/x/text/language"
)

var (
	// "(arr. Liszt)" or "[attrib.]" says nothing about whose piece it is.
	composerAsides = regexp.MustCompile(`\([^)]*\)|\[[^\]]*\]`)
	// Of "Rodgers & Hammerstein" or "Lennon/McCartney", the first name files the piece.
	composerJoins = regexp.MustCompile(`(?i)\s+(?:&|and)\s+|\s*[/;+]\s*`)
)

// Name suffixes that come after a surname, compared without their dot.
var composerSuffixes = []string{"jr", "sr", "ii", "iii", "iv"}

// composerSurname is the surname a piece is filed under: the last word of the
// first composer named ("Johann Sebastian Bach", "Ludwig van Beethoven"), or
// what comes before a comma ("Bach, J. S."). Suffixes such as "Jr." and asides
// in brackets are skipped. It is empty when no composer is set.
func composerSurname(composer string) string {
	name := composerAsides.ReplaceAllString(composer, " ")
	name = composerJoins.Split(strings.TrimSpace(name), 2)[0]
	if head, tail, found := strings.Cut(name, ","); found && !isComposerSuffix(tail) {
		// "Bach, Johann Sebastian": the surname comes first.
		if words := strings.Fields(head); len(words) > 0 {
			return strings.Join(words, " ")
		}
	} else if found {
		// "Harry Connick, Jr."
		name = head
	}
	words := strings.Fields(name)
	for len(words) > 1 && isComposerSuffix(words[len(words)-1]) {
		words = words[:len(words)-1]
	}
	if len(words) == 0 {
		return ""
	}
	return strings.Trim(words[len(words)-1], ".,")
}

func isComposerSuffix(word string) bool {
	return slices.Contains(composerSuffixes, strings.ToLower(strings.Trim(word, " .,")))
}

// sortByComposer orders pieces by composer surname, then the composer's full
// name (so C. P. E. Bach and J. S. Bach stay apart), keeping the existing
// order within one composer. Case and accents are ignored, so Dvořák files
// with D. Pieces without a composer go last.
func sortByComposer(pieces []Piece) {
	collator := collate.New(language.Und, collate.Loose)
	slices.SortStableFunc(pieces, func(a, b Piece) int {
		aSurname, bSurname := composerSurname(a.Composer), composerSurname(b.Composer)
		if (aSurname == "") != (bSurname == "") {
			if aSurname == "" {
				return 1
			}
			return -1
		}
		if order := collator.CompareString(aSurname, bSurname); order != 0 {
			return order
		}
		return collator.CompareString(strings.TrimSpace(a.Composer), strings.TrimSpace(b.Composer))
	})
}
