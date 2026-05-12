package io.coincraft.kyobo.gateway.client;

import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestTemplate;

/**
 * 교보생명 Core Banking WAS 클라이언트
 *
 * 이 클라이언트는 교보 내부망의 기존 Java WAS와 통신한다.
 * REST API 명세는 교보DTS로부터 수신 후 구현한다.
 *
 * TODO 항목:
 *   1. 교보DTS Core Banking REST API 명세 수신
 *   2. 인증 방식 확인 (OAuth2 / mTLS / API Key)
 *   3. 각 메서드 구체 구현
 *   4. 장애 시 fallback 정책 결정 (알림 or 큐잉)
 */
@Slf4j
@Component
public class CoreBankingClient {

    @Value("${kyobo.core-banking.base-url}")
    private String baseCoBankingUrl;

    private final RestTemplate restTemplate = new RestTemplate();

    /**
     * 사용자 계정 정보 + KYC 상태 조회
     * @param userId 교보생명 내부 사용자 ID
     */
    public Object getUserAccount(String userId) {
        // Phase 2: 교보DTS Core Banking API spec 수신 후 아래 구현으로 교체
        // ResponseEntity<UserAccountDto> response = restTemplate.getForEntity(
        //     baseCoBankingUrl + "/api/users/" + userId, UserAccountDto.class);
        // return response.getBody();
        log.warn("[CoreBankingClient] getUserAccount not connected — stub response for userId={}", userId);
        return null;
    }

    /**
     * NFT 발행 완료 후 리워드 지급 요청
     * 포인트 적립 / 혜택 발행 등 교보 내부 보상 시스템 연동
     */
    public void notifyReward(String userId, String policyId, Long tokenId) {
        // Phase 2: 교보DTS Core Banking 리워드 API spec 수신 후 아래 구현으로 교체
        // restTemplate.postForEntity(
        //     baseCoBankingUrl + "/api/rewards/notify",
        //     new RewardRequest(userId, policyId, tokenId), Void.class);
        log.warn("[CoreBankingClient] notifyReward not connected — stub for userId={} policyId={} tokenId={}", userId, policyId, tokenId);
    }
}
