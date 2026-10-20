package assets

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"sync"

	"github.com/google/uuid"
)

type Object struct {
	Key      string
	Size     int64
	Checksum string
}

type ReadSeekCloser interface {
	io.Reader
	io.Seeker
	io.Closer
}

type Store interface {
	Save(context.Context, io.Reader) (Object, error)
	Open(context.Context, string) (ReadSeekCloser, error)
	Delete(context.Context, string) error
	// Check reports whether the store's backing storage is reachable.
	Check(context.Context) error
}

type LocalStore struct {
	root string
	// stat is os.Stat; tests replace it to simulate a hung mount.
	stat func(string) (os.FileInfo, error)

	checkMu sync.Mutex
	check   *storeCheck // the stat in flight, shared by every Check that arrives meanwhile
}

type storeCheck struct {
	done chan struct{}
	err  error
}

var keyPattern = regexp.MustCompile(`^[0-9a-f]{2}/[0-9a-f-]{36}\.(pdf|bin)$`)

func NewLocalStore(root string) (*LocalStore, error) {
	if root == "" {
		return nil, fmt.Errorf("asset root is required")
	}
	absolute, err := filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("resolve asset root: %w", err)
	}
	if err := os.MkdirAll(filepath.Join(absolute, "objects"), 0o750); err != nil {
		return nil, fmt.Errorf("create asset root: %w", err)
	}
	if err := os.MkdirAll(filepath.Join(absolute, "temporary"), 0o750); err != nil {
		return nil, fmt.Errorf("create temporary root: %w", err)
	}
	return &LocalStore{root: absolute, stat: os.Stat}, nil
}

func (s *LocalStore) Save(_ context.Context, source io.Reader) (Object, error) {
	temp, err := os.CreateTemp(filepath.Join(s.root, "temporary"), "upload-*")
	if err != nil {
		return Object{}, fmt.Errorf("create temporary asset: %w", err)
	}
	tempName := temp.Name()
	defer func() {
		if err := os.Remove(tempName); err != nil && !os.IsNotExist(err) {
			slog.Warn("removing temporary asset failed")
		}
	}()

	hash := sha256.New()
	size, copyErr := io.Copy(io.MultiWriter(temp, hash), source)
	closeErr := temp.Close()
	if copyErr != nil {
		return Object{}, fmt.Errorf("write asset: %w", copyErr)
	}
	if closeErr != nil {
		return Object{}, fmt.Errorf("close asset: %w", closeErr)
	}
	id := uuid.NewString()
	key := id[:2] + "/" + id + ".bin"
	destination := filepath.Join(s.root, "objects", filepath.FromSlash(key))
	if err := os.MkdirAll(filepath.Dir(destination), 0o750); err != nil {
		return Object{}, fmt.Errorf("create asset directory: %w", err)
	}
	if err := os.Rename(tempName, destination); err != nil {
		return Object{}, fmt.Errorf("commit asset: %w", err)
	}
	return Object{Key: key, Size: size, Checksum: hex.EncodeToString(hash.Sum(nil))}, nil
}

func (s *LocalStore) Open(_ context.Context, key string) (ReadSeekCloser, error) {
	path, err := s.path(key)
	if err != nil {
		return nil, err
	}
	file, err := os.Open(path) // #nosec G304 -- s.path validates an opaque key with no traversal beneath the configured asset root.
	if err != nil {
		return nil, err
	}
	return file, nil
}

func (s *LocalStore) Delete(_ context.Context, key string) error {
	path, err := s.path(key)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// Check stats the objects directory, which NewLocalStore created, so an
// unmounted asset volume fails even when its empty mount point remains. A hung
// mount can block the stat indefinitely, so the caller's context bounds the
// wait. Callers share one stat in flight, so repeated probes against a hung
// mount leave at most one blocked goroutine rather than one per probe.
func (s *LocalStore) Check(ctx context.Context) error {
	s.checkMu.Lock()
	check := s.check
	if check == nil {
		check = &storeCheck{done: make(chan struct{})}
		s.check = check
		go func() {
			info, err := s.stat(filepath.Join(s.root, "objects"))
			if err == nil && !info.IsDir() {
				err = fmt.Errorf("asset objects path is not a directory")
			}
			check.err = err
			s.checkMu.Lock()
			s.check = nil
			s.checkMu.Unlock()
			close(check.done)
		}()
	}
	s.checkMu.Unlock()
	select {
	case <-check.done:
		return check.err
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *LocalStore) path(key string) (string, error) {
	if !keyPattern.MatchString(key) {
		return "", fmt.Errorf("invalid storage key")
	}
	return filepath.Join(s.root, "objects", filepath.FromSlash(key)), nil
}
