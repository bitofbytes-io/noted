package assets

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLocalStoreUsesOpaqueKeysAndRejectsTraversal(t *testing.T) {
	store, err := NewLocalStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	object, err := store.Save(context.Background(), strings.NewReader("%PDF-fixture"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(object.Key, "fixture") || object.Size != 12 {
		t.Fatalf("unexpected object: %#v", object)
	}
	if _, err := store.Open(context.Background(), "../../etc/passwd"); err == nil {
		t.Fatal("expected traversal key to be rejected")
	}
	reader, err := store.Open(context.Background(), object.Key)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	body, _ := io.ReadAll(reader)
	if string(body) != "%PDF-fixture" {
		t.Fatalf("unexpected stored body %q", body)
	}
}

func TestLocalStoreCheckFailsWhenObjectsDirectoryIsGone(t *testing.T) {
	root := t.TempDir()
	store, err := NewLocalStore(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Check(context.Background()); err != nil {
		t.Fatalf("check on a fresh store: %v", err)
	}
	// An unmounted volume leaves only the empty mount point behind.
	if err := os.RemoveAll(filepath.Join(root, "objects")); err != nil {
		t.Fatal(err)
	}
	if err := store.Check(context.Background()); err == nil {
		t.Fatal("expected check to fail without the objects directory")
	}
}
