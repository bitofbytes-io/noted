package app

import (
	"reflect"
	"strings"
	"testing"
)

func TestParseIMSLPSearchKeepsRankedWorkPages(t *testing.T) {
	// The shape IMSLP's MediaWiki 1.18 returns: pages keyed by id in title order,
	// rank only in list=search, and a ranked redirect collapsed onto its target.
	body := `{"query-continue":{"search":{"sroffset":10}},"query":{
		"search":[
			{"ns":0,"title":"Clair de Lune (Debussy, Claude)"},
			{"ns":0,"title":"'Who are We?' from Psalm 8 (Ludtke, William G.)"},
			{"ns":0,"title":"Debussy"},
			{"ns":0,"title":"Clair de lune (Debussy, Claude)"},
			{"ns":0,"title":"F\u00eates galantes (Debussy, Claude)"}
		],
		"redirects":[{"from":"Clair de Lune (Debussy, Claude)","to":"Clair de lune (Debussy, Claude)"}],
		"pages":{
			"104":{"pageid":104,"ns":0,"title":"'Who are We?' from Psalm 8 (Ludtke, William G.)","fullurl":"\/\/imslp.org\/wiki\/'Who_are_We?'_from_Psalm_8_(Ludtke,_William_G.)"},
			"101":{"pageid":101,"ns":0,"title":"Clair de lune (Debussy, Claude)","fullurl":"\/\/imslp.org\/wiki\/Clair_de_lune_(Debussy,_Claude)"},
			"105":{"pageid":105,"ns":0,"title":"Debussy","fullurl":"\/\/imslp.org\/wiki\/Debussy"},
			"106":{"pageid":106,"ns":0,"title":"Elsewhere (Example, Ada)","fullurl":"\/\/evil.example\/wiki\/Elsewhere_(Example,_Ada)"},
			"103":{"pageid":103,"ns":0,"title":"F\u00eates galantes (Debussy, Claude)","fullurl":"\/\/imslp.org\/wiki\/F%C3%AAtes_galantes_(Debussy,_Claude)"},
			"-1":{"ns":0,"title":"Gone (Example, Ada)","missing":"","fullurl":"\/\/imslp.org\/wiki\/Gone_(Example,_Ada)"}
		}}}`
	works, err := parseIMSLPSearch(strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	want := []IMSLPWork{
		{Title: "Clair de lune", Composer: "Debussy, Claude", URL: "https://imslp.org/wiki/Clair_de_lune_(Debussy,_Claude)"},
		{Title: "'Who are We?' from Psalm 8", Composer: "Ludtke, William G.", URL: "https://imslp.org/wiki/'Who_are_We%3F'_from_Psalm_8_(Ludtke,_William_G.)"},
		{Title: "Fêtes galantes", Composer: "Debussy, Claude", URL: "https://imslp.org/wiki/F%C3%AAtes_galantes_(Debussy,_Claude)"},
	}
	if !reflect.DeepEqual(works, want) {
		t.Fatalf("parsed works:\n got %+v\nwant %+v", works, want)
	}
	for _, work := range works {
		if !validIMSLPWorkURL(work.URL) {
			t.Fatalf("untrusted work URL %q", work.URL)
		}
	}

	// A newer MediaWiki honours formatversion=2: a page array ranked by index.
	current := `{"batchcomplete":true,"query":{"pages":[
		{"ns":0,"title":"Suite bergamasque (Debussy, Claude)","index":2,"fullurl":"https://imslp.org/wiki/Suite_bergamasque_(Debussy,_Claude)"},
		{"ns":0,"title":"Clair de lune (Debussy, Claude)","index":1,"fullurl":"//imslp.org/wiki/Clair_de_lune_(Debussy,_Claude)"},
		{"ns":14,"title":"Category:Debussy (Debussy, Claude)","index":3,"fullurl":"//imslp.org/wiki/Category:Debussy"}
	]}}`
	works, err = parseIMSLPSearch(strings.NewReader(current))
	if err != nil || len(works) != 2 || works[0].Title != "Clair de lune" || works[1].Title != "Suite bergamasque" {
		t.Fatalf("formatversion=2 reply: %+v, %v", works, err)
	}

	for _, empty := range []string{`{"batchcomplete":true}`, `{"query":{"search":[]}}`} {
		works, err := parseIMSLPSearch(strings.NewReader(empty))
		if err != nil || works == nil || len(works) != 0 {
			t.Fatalf("no-hit response %s: %+v, %v", empty, works, err)
		}
	}
	for _, bad := range []string{`<html>`, `{"error":{"code":"badparam"}}`, `{"query":{"pages":"x"}}`} {
		if _, err := parseIMSLPSearch(strings.NewReader(bad)); err == nil {
			t.Fatalf("accepted %s", bad)
		}
	}
}

func TestCanonicalIMSLPWorkURLPreservesQuestionMarkInTitle(t *testing.T) {
	url, ok := canonicalIMSLPWorkURL("https://imslp.org/wiki/'Who_are_We?'_from_Psalm_8_(Ludtke,_William_G.)")
	if !ok || !strings.Contains(url, "We%3F'") || !validIMSLPWorkURL(url) {
		t.Fatalf("wiki title was not preserved: %q, valid=%v", url, ok)
	}
}
