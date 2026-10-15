package mutations

import (
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/params/niu"
	"github.com/ethereum/go-ethereum/params/types/goethereum"
	"math/big"
	"testing"
)

func TestNIUHasNoUncleIssuance(t *testing.T) {
	config := &goethereum.ChainConfig{ChainID: big.NewInt(niu.ChainID)}
	for _, height := range []int64{0, 1, 1050000, 1050001, 73500001} {
		reward, uncles := GetRewards(config, &types.Header{Number: big.NewInt(height)}, []*types.Header{{Number: big.NewInt(height - 1)}})
		if reward.ToBig().Cmp(niu.Subsidy(big.NewInt(height))) != 0 || len(uncles) != 1 || !uncles[0].IsZero() {
			t.Fatal("unexpected NIU rewards", height, reward, uncles)
		}
	}
}
