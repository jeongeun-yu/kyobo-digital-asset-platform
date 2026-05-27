package io.coincraft.kyobo.gateway.client;

import io.coincraft.kyobo.gateway.dto.UserAccountResponse;
import jakarta.annotation.PostConstruct;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestTemplate;

import java.util.HashMap;
import java.util.Map;

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
 *
 * 데모 모드 (DEMO_MODE=true):
 *   Core Banking 미연결 상태에서 데모·강의용으로 사용.
 *   DEMO_USERS 환경변수에 "userId:walletAddr,..." 형식으로 사용자를 등록하면
 *   getUserAccount()가 해당 정보를 반환한다.
 */
@Slf4j
@Component
public class CoreBankingClient {

    @Value("${kyobo.core-banking.base-url}")
    private String baseCoBankingUrl;

    @Value("${kyobo.demo.mode:false}")
    private boolean demoMode;

    // "demo-user-001:0xAddr1,demo-user-002:0xAddr2,..." 형식
    @Value("${kyobo.demo.users:}")
    private String demoUsersConfig;

    private final RestTemplate restTemplate = new RestTemplate();
    private final Map<String, String> demoUserWallets = new HashMap<>();

    @PostConstruct
    public void init() {
        if (demoMode && !demoUsersConfig.isBlank()) {
            for (String entry : demoUsersConfig.split(",")) {
                String[] parts = entry.split(":", 2);
                if (parts.length == 2) {
                    demoUserWallets.put(parts[0].trim(), parts[1].trim());
                }
            }
            log.info("[CoreBankingClient] 데모 모드 활성화 — 등록 사용자 수: {}", demoUserWallets.size());
        }
    }

    /**
     * 사용자 계정 정보 + KYC 상태 조회
     * @param userId 교보생명 내부 사용자 ID
     */
    public Object getUserAccount(String userId) {
        if (demoMode) {
            String wallet = demoUserWallets.get(userId);
            if (wallet != null) {
                log.info("[CoreBankingClient] 데모 사용자 조회 userId={} wallet={}", userId, wallet);
                return new UserAccountResponse(userId, wallet, "BASIC", true);
            }
            log.warn("[CoreBankingClient] 데모 모드: 미등록 userId={}", userId);
            return null;
        }
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
        if (demoMode) {
            log.info("[CoreBankingClient] 데모 모드 notifyReward (no-op) userId={} policyId={} tokenId={}", userId, policyId, tokenId);
            return;
        }
        // Phase 2: 교보DTS Core Banking 리워드 API spec 수신 후 아래 구현으로 교체
        // restTemplate.postForEntity(
        //     baseCoBankingUrl + "/api/rewards/notify",
        //     new RewardRequest(userId, policyId, tokenId), Void.class);
        log.warn("[CoreBankingClient] notifyReward not connected — stub for userId={} policyId={} tokenId={}", userId, policyId, tokenId);
    }
}
