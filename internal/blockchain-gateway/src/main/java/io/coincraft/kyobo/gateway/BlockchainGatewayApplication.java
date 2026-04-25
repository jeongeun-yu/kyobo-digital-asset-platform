package io.coincraft.kyobo.gateway;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * 교보생명 내부망 블록체인 게이트웨이
 *
 * 역할:
 *   - DMZ Node.js issuer-service로부터 블록체인 이벤트 수신
 *   - 영구 금융 원장 기록 (user_nft_holdings, audit_log) — Oracle DB
 *   - 교보 Core Banking WAS로 리워드 알림 전달
 *   - 사용자 KYC 상태 조회 (Core Banking에서 위임)
 *
 * 네트워크 위치: 교보생명 내부망 (DMZ와 방화벽 분리)
 * 포트: 8080 (내부망 전용, 외부 노출 없음)
 */
@SpringBootApplication
public class BlockchainGatewayApplication {
    public static void main(String[] args) {
        SpringApplication.run(BlockchainGatewayApplication.class, args);
    }
}
