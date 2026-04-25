package io.coincraft.kyobo.gateway.repository;

import io.coincraft.kyobo.gateway.entity.NftHolding;
import org.springframework.data.jpa.repository.JpaRepository;
import java.util.Optional;

public interface NftHoldingRepository extends JpaRepository<NftHolding, Long> {
    boolean existsByTokenIdAndContractAddrAndChainId(Long tokenId, String contractAddr, Integer chainId);
    Optional<NftHolding> findByTokenIdAndContractAddrAndChainIdAndReleasedAtIsNull(
        Long tokenId, String contractAddr, Integer chainId);
}
