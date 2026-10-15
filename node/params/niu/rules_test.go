package niu

import (
	"math/big"
	"testing"
)

func TestIssuanceBoundariesAndCeiling(t *testing.T) {
	for _, tc := range []struct {
		height uint64
		want   string
	}{
		{0, "0"}, {1, "1000000000000000000000"},
		{1050000, "1000000000000000000000"}, {1050001, "500000000000000000000"},
		{72450001, "1"}, {73500001, "0"},
	} {
		if got := Subsidy(new(big.Int).SetUint64(tc.height)).String(); got != tc.want {
			t.Fatalf("height %d: %s != %s", tc.height, got, tc.want)
		}
	}
	total := new(big.Int)
	for era := uint64(0); era < 70; era++ {
		total.Add(total, new(big.Int).Mul(Subsidy(new(big.Int).SetUint64(era*HalvingInterval+1)), new(big.Int).SetUint64(HalvingInterval)))
	}
	if total.String() != "2099999999999999999969550000" {
		t.Fatal("unexpected total", total)
	}
	if Enabled(nil) || Enabled(big.NewInt(1)) || !Enabled(big.NewInt(ChainID)) {
		t.Fatal("network isolation failed")
	}
}

func TestDifficultyBoundaries(t *testing.T) {
	parent := big.NewInt(2048000)
	for _, tc := range []struct {
		elapsed uint64
		want    int64
	}{
		{1, 2049000}, {41, 2049000}, {42, 2048000}, {83, 2048000}, {84, 2047000}, {4200, 1949000},
		{^uint64(0), 1949000},
	} {
		if got := Difficulty(tc.elapsed, 0, parent); got.Cmp(big.NewInt(tc.want)) != 0 {
			t.Fatalf("delta %d got %s want %d", tc.elapsed, got, tc.want)
		}
	}
	if parent.Int64() != 2048000 {
		t.Fatal("mutated parent")
	}
	if Difficulty(100000, 0, big.NewInt(131072)).Int64() != 131072 {
		t.Fatal("minimum violated")
	}
}
