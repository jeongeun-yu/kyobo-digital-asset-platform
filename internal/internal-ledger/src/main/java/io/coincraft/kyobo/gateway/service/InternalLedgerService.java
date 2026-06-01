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
 * 내부망 Node.js issuer-service의 호출을 받아 영구 금융 원장에 기록한다.
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
     * on-chain Transfer(from=0x0) 이벤트 확정 후 내부망 issuer-service에서 호출
     */
    @Transactional
    public void recordNftHolding(String userId, NftHoldingRequest request) {
        nftHoldingRepository
            .findByUserIdAndTokenIdAndContractAddrAndChainId(
                userId, request.tokenId(), request.contractAddr(), request.chainId())
            .ifPresentOrElse(
                existing -> {
                    long before = existing.getAmount();
                    existing.addAmount(request.amount(), request.onChainTx());
                    String afterJson = String.format(
                        "{\"userId\":\"%s\",\"tokenId\":%d,\"contractAddr\":\"%s\",\"chainId\":%d,\"amount\":%d,\"onChainTx\":\"%s\"}",
                        userId, request.tokenId(), request.contractAddr(), request.chainId(),
                        existing.getAmount(), request.onChainTx());
                    String beforeJson = String.format(
                        "{\"userId\":\"%s\",\"tokenId\":%d,\"contractAddr\":\"%s\",\"chainId\":%d,\"amount\":%d}",
                        userId, request.tokenId(), request.contractAddr(), request.chainId(), before);
                    auditLogService.log("system", "CREDITED", "NftHolding",
                        request.contractAddr() + ":" + request.tokenId(), beforeJson, afterJson);
                    log.info("[Ledger] NFT 보유량 누적: userId={}, tokenId={}, {}→{}", userId, request.tokenId(), before, existing.getAmount());
                },
                () -> {
                    NftHolding holding = NftHolding.of(
                        userId,
                        request.tokenId(),
                        request.contractAddr(),
                        request.chainId(),
                        request.amount(),
                        request.acquiredAt(),
                        request.onChainTx()
                    );
                    nftHoldingRepository.save(holding);
                    String afterJson = String.format(
                        "{\"userId\":\"%s\",\"tokenId\":%d,\"contractAddr\":\"%s\",\"chainId\":%d,\"amount\":%d,\"onChainTx\":\"%s\"}",
                        userId, request.tokenId(), request.contractAddr(), request.chainId(), request.amount(), request.onChainTx());
                    auditLogService.log("system", "CREDITED", "NftHolding",
                        request.contractAddr() + ":" + request.tokenId(), null, afterJson);
                    log.info("[Ledger] NFT 보유 기록 완료: userId={}, tokenId={}", userId, request.tokenId());
                }
            );
    }

    /**
     * NFT 소각/이전 기록
     * on-chain Transfer(to=0x0 or to=other) 이벤트 확정 후 내부망 issuer-service에서 호출
     */
    @Transactional
    public void releaseNftHolding(String userId, Long tokenId, String contractAddr, Integer chainId) {
        nftHoldingRepository
            .findByUserIdAndTokenIdAndContractAddrAndChainIdAndReleasedAtIsNull(userId, tokenId, contractAddr, chainId)
            .ifPresent(holding -> {
                holding.release();
                String stateJson = String.format(
                    "{\"userId\":\"%s\",\"tokenId\":%d,\"contractAddr\":\"%s\",\"chainId\":%d,\"onChainTx\":\"%s\"}",
                    holding.getUserId(), holding.getTokenId(), holding.getContractAddr(),
                    holding.getChainId(), holding.getOnChainTx());
                auditLogService.log("system", "NFT_RELEASED", "NftHolding",
                    contractAddr + ":" + tokenId, stateJson, stateJson);
            });
    }
}
