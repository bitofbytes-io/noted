package assets

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"

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
}

type LocalStore struct {
	root string
}

var keyPattern = regexp.MustCompile(`^[0-9a-f]{2}/[0-9a-f-]{36}\.pdf$`)

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
	return &LocalStore{root: absolute}, nil
}

func (s *LocalStore) Save(_ context.Context, source io.Reader) (Object, error) {
	temp, err := os.CreateTemp(filepath.Join(s.root, "temporary"), "upload-*")
	if err != nil {
		return Object{}, fmt.Errorf("create temporary asset: %w", err)
	}
	tempName := temp.Name()
	defer os.Remove(tempName)

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
	key := id[:2] + "/" + id + ".pdf"
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
	file, err := os.Open(path)
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

func (s *LocalStore) path(key string) (string, error) {
	if !keyPattern.MatchString(key) {
		return "", fmt.Errorf("invalid storage key")
	}
	return filepath.Join(s.root, "objects", filepath.FromSlash(key)), nil
}
