package rawdb

import (
	"github.com/ethereum/go-ethereum/ethdb"
	"testing"
)

type niuBoundedAncients struct {
	ethdb.Reader
	bound, count uint64
}

func (db *niuBoundedAncients) Ancients() (uint64, error) { return 100, nil }
func (db *niuBoundedAncients) AncientRange(_ string, _ uint64, count, maxBytes uint64) ([][]byte, error) {
	db.count = count
	db.bound = maxBytes
	return nil, nil
}
func TestNIUHeaderRangeMemoryBound(t *testing.T) {
	db := new(niuBoundedAncients)
	ReadHeaderRange(db, 99, ^uint64(0))
	if db.bound != 2*1024*1024 || db.count != 100 {
		t.Fatalf("unbounded freezer read: count=%d bytes=%d", db.count, db.bound)
	}
}
