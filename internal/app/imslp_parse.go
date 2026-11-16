package app

import (
	"encoding/json"
	"errors"
	"io"
	"math"
	"regexp"
	"sort"
	"strings"
)

// IMSLP work pages are titled "Work title (Last, First)", the same rule the
// Prepare screen uses for a pasted work link.
var imslpWorkTitle = regexp.MustCompile(`^(.*?)\s*\(([^()]+, [^()]+)\)$`)

// imslpWorkName splits a work page title into the work and its composer
// ("Last, First"). Pages not titled that way are not works.
func imslpWorkName(title string) (work, composer string, ok bool) {
	match := imslpWorkTitle.FindStringSubmatch(title)
	if match == nil || strings.TrimSpace(match[1]) == "" {
		return "", "", false
	}
	return strings.TrimSpace(match[1]), strings.TrimSpace(match[2]), true
}

type imslpPage struct {
	NS      int             `json:"ns"`
	Title   string          `json:"title"`
	Index   int             `json:"index"`
	FullURL string          `json:"fullurl"`
	Missing json.RawMessage `json:"missing"`
}

// parseIMSLPSearch reads one combined list=search + generator=search reply.
// IMSLP runs MediaWiki 1.18, which ignores formatversion=2: pages arrive as an
// object keyed by page id and sorted by title, with no index field. The
// list=search rows carry IMSLP's rank, and redirects map a ranked redirect
// title onto the page that generator=search collapsed it into.
func parseIMSLPSearch(body io.Reader) ([]IMSLPWork, error) {
	var payload struct {
		Error json.RawMessage `json:"error"`
		Query *struct {
			Search []struct {
				Title string `json:"title"`
			} `json:"search"`
			Redirects []struct {
				From string `json:"from"`
				To   string `json:"to"`
			} `json:"redirects"`
			Pages json.RawMessage `json:"pages"`
		} `json:"query"`
	}
	if err := json.NewDecoder(body).Decode(&payload); err != nil {
		return nil, errors.New("invalid IMSLP search JSON")
	}
	if len(payload.Error) > 0 {
		return nil, errors.New("IMSLP search API error")
	}
	works := []IMSLPWork{}
	if payload.Query == nil || len(payload.Query.Pages) == 0 {
		return works, nil
	}
	var pages []imslpPage
	if err := json.Unmarshal(payload.Query.Pages, &pages); err != nil {
		var byID map[string]imslpPage
		if err := json.Unmarshal(payload.Query.Pages, &byID); err != nil {
			return nil, errors.New("invalid IMSLP search pages")
		}
		for _, page := range byID {
			pages = append(pages, page)
		}
	}
	redirects := map[string]string{}
	for _, redirect := range payload.Query.Redirects {
		redirects[redirect.From] = redirect.To
	}
	rank := map[string]int{}
	for position, hit := range payload.Query.Search {
		title := hit.Title
		if target, ok := redirects[title]; ok {
			title = target
		}
		if _, seen := rank[title]; !seen {
			rank[title] = position + 1
		}
	}
	order := func(page imslpPage) int {
		if page.Index > 0 {
			return page.Index
		}
		if position, ok := rank[page.Title]; ok {
			return position
		}
		return math.MaxInt
	}
	sort.SliceStable(pages, func(i, j int) bool {
		if order(pages[i]) != order(pages[j]) {
			return order(pages[i]) < order(pages[j])
		}
		return pages[i].Title < pages[j].Title
	})
	seen := map[string]bool{}
	for _, page := range pages {
		title, composer, isWork := imslpWorkName(page.Title)
		if page.NS != 0 || len(page.Missing) > 0 || !isWork {
			continue
		}
		raw := page.FullURL
		if strings.HasPrefix(raw, "//") {
			raw = "https:" + raw
		}
		workURL, valid := canonicalIMSLPWorkURL(raw)
		if !valid || seen[workURL] {
			continue
		}
		seen[workURL] = true
		works = append(works, IMSLPWork{Title: title, Composer: composer, URL: workURL})
	}
	return works, nil
}
