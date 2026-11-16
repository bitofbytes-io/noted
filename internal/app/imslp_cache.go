package app

import "time"

type imslpCacheEntry struct {
	key     string
	works   []IMSLPWork
	expires time.Time
}

func (s *imslpSearcher) cached(key string) ([]IMSLPWork, bool) {
	now := s.cfg.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	element := s.entries[key]
	if element == nil {
		return nil, false
	}
	entry := element.Value.(*imslpCacheEntry)
	if !now.Before(entry.expires) {
		s.cache.Remove(element)
		delete(s.entries, key)
		return nil, false
	}
	s.cache.MoveToFront(element)
	return entry.works, true
}

func (s *imslpSearcher) store(key string, works []IMSLPWork) {
	ttl := s.cfg.CacheTTL
	if len(works) == 0 {
		ttl = s.cfg.NegativeTTL
	}
	entry := &imslpCacheEntry{key: key, works: works, expires: s.cfg.Now().Add(ttl)}
	s.mu.Lock()
	defer s.mu.Unlock()
	if element := s.entries[key]; element != nil {
		element.Value = entry
		s.cache.MoveToFront(element)
		return
	}
	s.entries[key] = s.cache.PushFront(entry)
	for s.cache.Len() > s.cfg.CacheSize {
		oldest := s.cache.Back()
		s.cache.Remove(oldest)
		delete(s.entries, oldest.Value.(*imslpCacheEntry).key)
	}
}
