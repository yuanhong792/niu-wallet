package ethash

import (
	"github.com/ethereum/go-ethereum/consensus"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/params/niu"
	"github.com/ethereum/go-ethereum/params/types/ctypes"
	"github.com/ethereum/go-ethereum/params/types/goethereum"
	"math/big"
	"testing"
)

type niuTestChain struct{ consensus.ChainReader }

func (niuTestChain) Config() ctypes.ChainConfigurator {
	return &goethereum.ChainConfig{ChainID: big.NewInt(niu.ChainID)}
}

func TestNIURejectsUnclesBeforeFakeSealBypass(t *testing.T) {
	engine := NewFullFaker()
	defer engine.Close()
	chain := niuTestChain{}
	header := &types.Header{Number: big.NewInt(1)}
	block := types.NewBlockWithHeader(header).WithBody(nil, []*types.Header{{Number: big.NewInt(0)}})
	if err := engine.VerifyUncles(chain, block); err == nil {
		t.Fatal("accepted uncle-bearing NIU block")
	}
	if _, err := engine.FinalizeAndAssemble(chain, header, nil, nil, block.Uncles(), nil, nil); err == nil {
		t.Fatal("assembled uncle-bearing NIU block")
	}
	if err := engine.VerifyUncles(chain, types.NewBlockWithHeader(header)); err != nil {
		t.Fatal(err)
	}
}
