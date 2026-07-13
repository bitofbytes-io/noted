package assets

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var opaqueKeyPattern = regexp.MustCompile(`^(pdf|musicxml)/[0-9a-f-]{36}$`)

type StoredObject struct {
	Key      string
	Size     int64
	Checksum string
}

type ObjectInfo struct {
	Key  string
	Size int64
}

type AssetStore interface {
	Put(ctx context.Context, key string, src io.Reader) (StoredObject, error)
	Open(ctx context.Context, key string) (io.ReadCloser, ObjectInfo, error)
	Delete(ctx context.Context, key string) error
	Exists(ctx context.Context, key string) (bool, error)
}

type FilesystemStore struct {
	root string
}

func NewFilesystemStore(root string) (*FilesystemStore, error) {
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("resolve asset root: %w", err)
	}
	for _, dir := range []string{"temporary", "originals/pdf", "originals/musicxml"} {
		if err := os.MkdirAll(filepath.Join(abs, dir), 0o750); err != nil {
			return nil, fmt.Errorf("create asset directory: %w", err)
		}
	}
	return &FilesystemStore{root: abs}, nil
}

func (s *FilesystemStore) Put(ctx context.Context, key string, src io.Reader) (StoredObject, error) {
	finalPath, err := s.path(key)
	if err != nil {
		return StoredObject{}, err
	}
	tmp, err := os.CreateTemp(filepath.Join(s.root, "temporary"), "upload-*")
	if err != nil {
		return StoredObject{}, fmt.Errorf("create temporary upload: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)

	hash := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(tmp, hash), &contextReader{ctx: ctx, reader: src})
	closeErr := tmp.Close()
	if copyErr != nil {
		return StoredObject{}, fmt.Errorf("store upload: %w", copyErr)
	}
	if closeErr != nil {
		return StoredObject{}, fmt.Errorf("close upload: %w", closeErr)
	}
	if err := os.Rename(tmpName, finalPath); err != nil {
		return StoredObject{}, fmt.Errorf("finalize upload: %w", err)
	}
	return StoredObject{Key: key, Size: written, Checksum: hex.EncodeToString(hash.Sum(nil))}, nil
}

func (s *FilesystemStore) Open(_ context.Context, key string) (io.ReadCloser, ObjectInfo, error) {
	path, err := s.path(key)
	if err != nil {
		return nil, ObjectInfo{}, err
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, ObjectInfo{}, err
	}
	info, err := file.Stat()
	if err != nil {
		file.Close()
		return nil, ObjectInfo{}, err
	}
	return file, ObjectInfo{Key: key, Size: info.Size()}, nil
}

func (s *FilesystemStore) Delete(_ context.Context, key string) error {
	path, err := s.path(key)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func (s *FilesystemStore) Exists(_ context.Context, key string) (bool, error) {
	path, err := s.path(key)
	if err != nil {
		return false, err
	}
	_, err = os.Stat(path)
	if err == nil {
		return true, nil
	}
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return false, err
}

func (s *FilesystemStore) path(key string) (string, error) {
	if !opaqueKeyPattern.MatchString(key) {
		return "", fmt.Errorf("unsafe asset key")
	}
	path := filepath.Join(s.root, "originals", filepath.FromSlash(key))
	rel, err := filepath.Rel(s.root, path)
	if err != nil || strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
		return "", fmt.Errorf("asset key escapes storage root")
	}
	return path, nil
}

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r *contextReader) Read(p []byte) (int, error) {
	select {
	case <-r.ctx.Done():
		return 0, r.ctx.Err()
	default:
		return r.reader.Read(p)
	}
}
