package io.coincraft.kyobo.gateway.controller;

import io.coincraft.kyobo.gateway.dto.*;
import io.coincraft.kyobo.gateway.service.InternalLedgerService;
import io.coincraft.kyobo.gateway.service.AuditLogService;
import io.coincraft.kyobo.gateway.client.CoreBankingClient;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

/**
 * 내부망 Node.js issuer-service로부터 오는 REST 요청을 처리한다.
 *
 * 보안: 이 엔드포인트는 내부망 IP에서만 접근 가능 (방화벽 레벨에서 제한)
 * 인증: mTLS 또는 내부망 공유 시크릿 헤더 (X-Internal-Secret)
 */
@Slf4j
@RestController
@RequestMapping("/api/internal")
@RequiredArgsConstructor
public class BlockchainGatewayController {

    private final InternalLedgerService ledgerService;
    private final AuditLogService auditLogService;
    private final CoreBankingClient coreBankingClient;

    /**
     * 사용자 계정 정보 조회 (KYC 상태 + 지갑 주소 포함)
     * issuer-service가 NFT 발행 전 호출
     */
    @GetMapping("/users/{userId}")
    public ResponseEntity<UserAccountResponse> getUserAccount(@PathVariable String userId) {
        Object account = coreBankingClient.getUserAccount(userId);
        if (account == null) {
            log.warn("[Gateway] getUserAccount: Core Banking stub — userId={}", userId);
            return ResponseEntity.notFound().build();
        }
        return ResponseEntity.ok((UserAccountResponse) account);
    }

    /**
     * NFT 보유 현황 기록
     * issuer-service가 on-chain Transfer 이벤트 확정 후 호출
     * 이 데이터는 교보 Oracle DB에 영구 보관됨
     */
    @PostMapping("/users/{userId}/nft-holdings")
    public ResponseEntity<Void> recordNftHolding(
            @PathVariable String userId,
            @Valid @RequestBody NftHoldingRequest request) {
        log.info("[NFT Holding] userId={}, tokenId={}, txHash={}", userId, request.tokenId(), request.onChainTx());
        ledgerService.recordNftHolding(userId, request);
        return ResponseEntity.ok().build();
    }

    /**
     * 감사 로그 기록 (append-only)
     * issuer-service의 모든 상태 변경 시 호출
     * ISMS-P §A.9 접근 제어 + 가상자산이용자보호법 §15 거래 기록 보존
     */
    @PostMapping("/audit-log")
    public ResponseEntity<Void> recordAuditLog(@Valid @RequestBody AuditLogRequest request) {
        auditLogService.log(request);
        return ResponseEntity.ok().build();
    }

    /**
     * Core Banking 리워드 알림
     * NFT 발행 완료 후 포인트/혜택 지급을 Core Banking에 요청
     */
    @PostMapping("/rewards/notify")
    public ResponseEntity<Void> notifyReward(@Valid @RequestBody RewardNotificationRequest request) {
        log.info("[Gateway] notifyReward: userId={} policyId={} tokenId={}", request.userId(), request.policyId(), request.tokenId());
        coreBankingClient.notifyReward(request.userId(), request.policyId(), request.tokenId());
        return ResponseEntity.ok().build();
    }

    /**
     * 헬스체크 (Kubernetes liveness probe)
     */
    @GetMapping("/health")
    public ResponseEntity<String> health() {
        return ResponseEntity.ok("OK");
    }
}
