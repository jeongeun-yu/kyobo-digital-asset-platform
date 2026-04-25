package io.coincraft.kyobo.gateway.service;

import io.coincraft.kyobo.gateway.dto.NftHoldingRequest;
import io.coincraft.kyobo.gateway.entity.NftHolding;
import io.coincraft.kyobo.gateway.repository.NftHoldingRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * 내부망 영구 원장 서비스
 *
 * DMZ Node.js issuer-service의 호출을 받아 영구 금융 원장에 기록한다.
 * 모든 쓰기 작업은 AuditLogService를 통해 감사 추적된다.
 *
 * DB: 교보 내부망 Oracle (운영) / PostgreSQL (개발)
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class InternalLedgerService {

    private final NftHoldingRepository nftHoldingRepository;
    private final AuditLogService auditLogService;

    /**
     * NFT 취득 기록
     * on-chain Transfer(from=0x0) 이벤트 확정 후 DMZ에서 호출
     */
    @Transactional
    public void recordNftHolding(String userId, NftHoldingRequest request) {
        // 중복 방지: 동일 (tokenId, contractAddr, chainId) 이미 존재 시 skip
        boolean alreadyExists = nftHoldingRepository
            .existsByTokenIdAndContractAddrAndChainId(
                request.tokenId(), request.contractAddr(), request.chainId());

        if (alreadyExists) {
            log.warn("[Ledger] 이미 기록된 NFT 보유: tokenId={}, tx={}", request.tokenId(), request.onChainTx());
            return;
        }

        NftHolding holding = NftHolding.of(
            userId,
            request.tokenId(),
            request.contractAddr(),
            request.chainId(),
            request.acquiredAt(),
            request.onChainTx()
        );
        nftHoldingRepository.save(holding);

        auditLogService.log("system", "NFT_ACQUIRED", "NftHolding",
            request.contractAddr() + ":" + request.tokenId(),
            null, holding.toString());

        log.info("[Ledger] NFT 보유 기록 완료: userId={}, tokenId={}", userId, request.tokenId());
    }

    /**
     * NFT 소각/이전 기록
     * on-chain Transfer(to=0x0 or to=other) 이벤트 확정 후 DMZ에서 호출
     */
    @Transactional
    public void releaseNftHolding(Long tokenId, String contractAddr, Integer chainId) {
        nftHoldingRepository
            .findByTokenIdAndContractAddrAndChainIdAndReleasedAtIsNull(tokenId, contractAddr, chainId)
            .ifPresent(holding -> {
                holding.release();
                auditLogService.log("system", "NFT_RELEASED", "NftHolding",
                    contractAddr + ":" + tokenId, holding.toString(), holding.toString());
            });
    }
}
